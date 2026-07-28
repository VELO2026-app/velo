# =============================================================================
# Test: Waitlist -- Join, Leave/Decline, Confirm (Phase 5.3)
# =============================================================================
#
# telegram_id ranges:
#   62001-62099 -- master users
#   62100-62199 -- regular users (waitlist participants)
#   62900-62999 -- admin users
# =============================================================================

import uuid
from collections.abc import AsyncGenerator
from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.waitlist.models import Waitlist
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, login_user, full_cleanup_range, switch_self_to_master

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
BOOKINGS_URL = "/api/v1/bookings"
PRACTICES_URL = "/api/v1/practices"
APPLY_URL = "/api/v1/masters/apply"
VERIFY_URL = "/api/v1/admin/masters/{user_id}/verify"
WAITLIST_JOIN_URL = "/api/v1/practices/{practice_id}/waitlist"
WAITLIST_URL = "/api/v1/waitlist"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """Clean all test data before/after each test (TD-032: ORM, no raw SQL)."""
    await _do_cleanup(db_session)
    yield
    await _do_cleanup(db_session)


async def _do_cleanup(session: AsyncSession) -> None:
    """Full ORM cleanup for telegram_id 62000-62999."""
    await full_cleanup_range(session, 62000, 62999, delete_users=False)
    await session.commit()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _valid_practice_body(**overrides: object) -> dict:
    """Return a valid CreatePracticeRequest body."""
    base = {
        "practice_type": "live",
        "direction": "meditation",
        "difficulty": "beginner",
        "title": "Waitlist Meditation",
        "description": "Session for waitlist testing",
        "scheduled_at": (
            datetime.now(timezone.utc) + timedelta(days=7)
        ).isoformat(),
        "duration_minutes": 60,
        "timezone": "Europe/Moscow",
        "max_participants": 1,
        "is_free": True,
        "price_cents": 0,
        "currency": "eur",
    }
    base.update(overrides)
    return base


def _valid_apply_body() -> dict:
    return {
        "profile": {
            "display_name": "WL Test Master",
            "email": "wlmaster@test.com",
        },
        "experience": {
            "methods": ["meditation"],
            "experience_years": 5,
            "bio": "Waitlist test master",
        },
        "documents": [],
    }


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int = 62001,
) -> dict:
    """Create user, apply, verify. Returns auth data."""
    auth = await login_user(
        client, telegram_id=telegram_id,
        first_name="Master",
    )
    await client.post(
        APPLY_URL,
        json=_valid_apply_body(),
        headers=auth_headers(auth["session_token"]),
    )

    admin_auth = await login_user(
        client, telegram_id=62900, first_name="Admin",
    )
    await db_session.execute(
        update(User)
        .where(User.telegram_id == 62900)
        .values(role=UserRole.ADMIN.value)
    )
    await db_session.commit()
    admin_auth = await login_user(
        client, telegram_id=62900, first_name="Admin",
    )

    user_id = auth["user"]["id"]
    verify_resp = await client.post(
        VERIFY_URL.format(user_id=user_id),
        json={},
        headers=auth_headers(admin_auth["session_token"]),
    )
    assert verify_resp.status_code == 200

    await switch_self_to_master(client, auth["session_token"])
    auth = await login_user(
        client, telegram_id=telegram_id,
        first_name="Master",
    )
    return auth


async def _create_scheduled_practice(
    client: AsyncClient,
    master_auth: dict,
    **overrides: object,
) -> str:
    """Create a practice and set status to scheduled."""
    body = _valid_practice_body(**overrides)
    resp = await client.post(
        PRACTICES_URL,
        json=body,
        headers=auth_headers(
            master_auth["session_token"],
        ),
    )
    assert resp.status_code == 201
    pid = resp.json()["id"]

    patch = await client.patch(
        f"{PRACTICES_URL}/{pid}",
        json={"status": "scheduled"},
        headers=auth_headers(
            master_auth["session_token"],
        ),
    )
    assert patch.status_code == 200
    return pid


async def _fill_practice(
    client: AsyncClient,
    practice_id: str,
    telegram_id: int,
) -> dict:
    """Book a user to fill the practice slot. Returns booking data."""
    user = await login_user(
        client, telegram_id=telegram_id, first_name="Filler",
    )
    resp = await client.post(
        BOOKINGS_URL,
        json={"practice_id": practice_id},
        headers=auth_headers(user["session_token"]),
    )
    assert resp.status_code == 201
    return {**user, "booking_id": resp.json()["id"]}


# ===================================================================
# POST /practices/{id}/waitlist -- join
# ===================================================================


@pytest.mark.asyncio
async def test_join_waitlist_success(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """User joins waitlist for a full practice: 201."""
    master = await _make_verified_master(client, db_session)
    pid = await _create_scheduled_practice(
        client, master, max_participants=1,
    )
    await _fill_practice(client, pid, telegram_id=62100)

    user = await login_user(
        client, telegram_id=62101, first_name="Waiter",
    )
    resp = await client.post(
        WAITLIST_JOIN_URL.format(practice_id=pid),
        headers=auth_headers(user["session_token"]),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["status"] == "waiting"
    assert data["position"] == 1
    assert data["practice_id"] == pid


@pytest.mark.asyncio
async def test_join_waitlist_blocked_user_rejected_at_entry(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A user blocked by the master must be rejected when JOINING the
    queue (403), not allowed to hold a slot until confirm. Closes the
    OTHER door into the waitlist (confirm_waitlist already gated)."""
    from datetime import UTC, datetime as _dt
    from uuid import UUID as _UUID

    from app.modules.masters.groups_models import MasterStudent

    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    pid = await _create_scheduled_practice(
        client, master, max_participants=1,
    )
    await _fill_practice(client, pid, telegram_id=62150)

    blocked = await login_user(
        client, telegram_id=62151, first_name="Blocked",
    )
    db_session.add(
        MasterStudent(
            master_id=_UUID(master_id),
            student_user_id=_UUID(blocked["user"]["id"]),
            blocked_at=_dt.now(UTC),
        )
    )
    await db_session.commit()

    resp = await client.post(
        WAITLIST_JOIN_URL.format(practice_id=pid),
        headers=auth_headers(blocked["session_token"]),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_join_waitlist_not_full(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Practice not full -- should book directly: 400."""
    master = await _make_verified_master(client, db_session)
    pid = await _create_scheduled_practice(
        client, master, max_participants=5,
    )

    user = await login_user(
        client, telegram_id=62102, first_name="Waiter",
    )
    resp = await client.post(
        WAITLIST_JOIN_URL.format(practice_id=pid),
        headers=auth_headers(user["session_token"]),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_join_waitlist_already_booked(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Already booked user cannot join waitlist: 409."""
    master = await _make_verified_master(client, db_session)
    pid = await _create_scheduled_practice(
        client, master, max_participants=2,
    )
    user = await login_user(
        client, telegram_id=62103, first_name="Booker",
    )
    headers = auth_headers(user["session_token"])

    # Book first.
    await client.post(
        BOOKINGS_URL,
        json={"practice_id": pid},
        headers=headers,
    )

    # Fill remaining slot.
    await _fill_practice(client, pid, telegram_id=62104)

    # Try to join waitlist.
    resp = await client.post(
        WAITLIST_JOIN_URL.format(practice_id=pid),
        headers=headers,
    )
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_join_waitlist_duplicate(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Joining waitlist twice gives 409."""
    master = await _make_verified_master(client, db_session)
    pid = await _create_scheduled_practice(
        client, master, max_participants=1,
    )
    await _fill_practice(client, pid, telegram_id=62105)

    user = await login_user(
        client, telegram_id=62106, first_name="Waiter",
    )
    headers = auth_headers(user["session_token"])

    resp1 = await client.post(
        WAITLIST_JOIN_URL.format(practice_id=pid),
        headers=headers,
    )
    assert resp1.status_code == 201

    resp2 = await client.post(
        WAITLIST_JOIN_URL.format(practice_id=pid),
        headers=headers,
    )
    assert resp2.status_code == 409


@pytest.mark.asyncio
async def test_join_waitlist_own_practice(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Master cannot join their own waitlist: 400."""
    master = await _make_verified_master(client, db_session)
    pid = await _create_scheduled_practice(
        client, master, max_participants=1,
    )
    await _fill_practice(client, pid, telegram_id=62107)

    resp = await client.post(
        WAITLIST_JOIN_URL.format(practice_id=pid),
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_join_waitlist_no_auth(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """No auth header: 401."""
    master = await _make_verified_master(client, db_session)
    pid = await _create_scheduled_practice(
        client, master, max_participants=1,
    )
    resp = await client.post(
        WAITLIST_JOIN_URL.format(practice_id=pid),
    )
    assert resp.status_code == 401


# ===================================================================
# DELETE /waitlist/{id} -- leave / decline
# ===================================================================


@pytest.mark.asyncio
async def test_leave_waitlist_success(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Leave waitlist: 200, status=left."""
    master = await _make_verified_master(client, db_session)
    pid = await _create_scheduled_practice(
        client, master, max_participants=1,
    )
    await _fill_practice(client, pid, telegram_id=62108)

    user = await login_user(
        client, telegram_id=62109, first_name="Waiter",
    )
    headers = auth_headers(user["session_token"])

    join_resp = await client.post(
        WAITLIST_JOIN_URL.format(practice_id=pid),
        headers=headers,
    )
    wid = join_resp.json()["id"]

    leave_resp = await client.delete(
        f"{WAITLIST_URL}/{wid}",
        headers=headers,
    )
    assert leave_resp.status_code == 200
    assert leave_resp.json()["status"] == "left"


@pytest.mark.asyncio
async def test_leave_waitlist_not_owner(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Cannot leave someone else's waitlist entry: 404."""
    master = await _make_verified_master(client, db_session)
    pid = await _create_scheduled_practice(
        client, master, max_participants=1,
    )
    await _fill_practice(client, pid, telegram_id=62110)

    user = await login_user(
        client, telegram_id=62111, first_name="Waiter",
    )
    join_resp = await client.post(
        WAITLIST_JOIN_URL.format(practice_id=pid),
        headers=auth_headers(user["session_token"]),
    )
    wid = join_resp.json()["id"]

    other = await login_user(
        client, telegram_id=62112, first_name="Other",
    )
    leave_resp = await client.delete(
        f"{WAITLIST_URL}/{wid}",
        headers=auth_headers(other["session_token"]),
    )
    assert leave_resp.status_code == 404


# ===================================================================
# POST /waitlist/{id}/confirm -- confirm spot
# ===================================================================


@pytest.mark.asyncio
async def test_confirm_waitlist_success(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Confirm waitlist spot: creates booking, status=confirmed."""
    master = await _make_verified_master(client, db_session)
    pid = await _create_scheduled_practice(
        client, master, max_participants=1,
    )
    filler = await _fill_practice(client, pid, telegram_id=62113)

    user = await login_user(
        client, telegram_id=62114, first_name="Waiter",
    )
    headers = auth_headers(user["session_token"])

    join_resp = await client.post(
        WAITLIST_JOIN_URL.format(practice_id=pid),
        headers=headers,
    )
    wid = join_resp.json()["id"]

    # Cancel filler to open a slot.
    await client.delete(
        f"{BOOKINGS_URL}/{filler['booking_id']}",
        headers=auth_headers(filler["session_token"]),
    )

    # Confirm.
    confirm_resp = await client.post(
        f"{WAITLIST_URL}/{wid}/confirm",
        headers=headers,
    )
    assert confirm_resp.status_code == 201
    data = confirm_resp.json()
    assert data["waitlist_entry"]["status"] == "converted"
    assert data["booking_id"] is not None


async def _notified_entry(client, db_session, master_tid, filler_tid, waiter_tid):
    """Drive a waitlist entry to NOTIFIED: fill a 1-slot practice, join
    the waitlist, cancel the filler (process_waitlist notifies the next).
    Returns (pid, wid, waiter_headers)."""
    master = await _make_verified_master(client, db_session, telegram_id=master_tid)
    pid = await _create_scheduled_practice(client, master, max_participants=1)
    filler = await _fill_practice(client, pid, telegram_id=filler_tid)
    waiter = await login_user(client, telegram_id=waiter_tid, first_name="Waiter")
    headers = auth_headers(waiter["session_token"])
    wid = (
        await client.post(
            WAITLIST_JOIN_URL.format(practice_id=pid), headers=headers,
        )
    ).json()["id"]
    await client.delete(
        f"{BOOKINGS_URL}/{filler['booking_id']}",
        headers=auth_headers(filler["session_token"]),
    )
    return pid, wid, headers


@pytest.mark.asyncio
async def test_confirm_waitlist_on_cancelled_practice_rejected(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A holder must not convert their offer into a charged booking on a
    practice the master has since cancelled (C4)."""
    from uuid import UUID as _UUID
    from sqlalchemy import update as _update

    from app.modules.practices.models import Practice, PracticeStatus

    pid, wid, headers = await _notified_entry(
        client, db_session, 62160, 62161, 62162,
    )
    await db_session.execute(
        _update(Practice)
        .where(Practice.id == _UUID(pid))
        .values(status=PracticeStatus.CANCELLED.value)
    )
    await db_session.commit()

    resp = await client.post(f"{WAITLIST_URL}/{wid}/confirm", headers=headers)
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_confirm_waitlist_on_started_practice_rejected(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A holder must not convert their offer once the practice has
    already started (C4) -- same time guard as create_booking."""
    from uuid import UUID as _UUID
    from datetime import UTC, datetime, timedelta
    from sqlalchemy import update as _update

    from app.modules.practices.models import Practice

    pid, wid, headers = await _notified_entry(
        client, db_session, 62163, 62164, 62165,
    )
    await db_session.execute(
        _update(Practice)
        .where(Practice.id == _UUID(pid))
        .values(scheduled_at=datetime.now(UTC) - timedelta(minutes=5))
    )
    await db_session.commit()

    resp = await client.post(f"{WAITLIST_URL}/{wid}/confirm", headers=headers)
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_confirm_waitlist_creates_zoom_registrant(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """C5: a user who gets in off the waitlist must be registered for
    the Zoom meeting, exactly like the direct create_booking path --
    otherwise they pay but never get a join link. With an ACTIVE
    meeting the registrant lands 'registered'."""
    from uuid import UUID as _UUID

    from app.modules.zoom.models import (
        ZoomMeeting,
        ZoomMeetingStatus,
        ZoomRegistrant,
    )

    master = await _make_verified_master(client, db_session)
    pid = await _create_scheduled_practice(
        client, master, max_participants=1,
    )
    # Publishing already created a ZoomMeeting row (E21 wiring), in a
    # pre-active status since no real Zoom call runs in tests. Drive it
    # to ACTIVE so the waitlist registrant lands 'registered' rather
    # than queued 'pending'.
    await db_session.execute(
        update(ZoomMeeting)
        .where(ZoomMeeting.practice_id == _UUID(pid))
        .values(
            status=ZoomMeetingStatus.ACTIVE.value,
            zoom_meeting_id="99887766",
        )
    )
    await db_session.commit()

    filler = await _fill_practice(client, pid, telegram_id=62130)
    user = await login_user(
        client, telegram_id=62131, first_name="Waiter",
    )
    headers = auth_headers(user["session_token"])

    wid = (
        await client.post(
            WAITLIST_JOIN_URL.format(practice_id=pid), headers=headers,
        )
    ).json()["id"]
    await client.delete(
        f"{BOOKINGS_URL}/{filler['booking_id']}",
        headers=auth_headers(filler["session_token"]),
    )
    confirm_resp = await client.post(
        f"{WAITLIST_URL}/{wid}/confirm", headers=headers,
    )
    assert confirm_resp.status_code == 201

    # A registrant row now exists for the converted user's booking.
    user_id = user["user"]["id"]
    registrant = (
        await db_session.execute(
            select(ZoomRegistrant).where(
                ZoomRegistrant.user_id == _UUID(user_id),
            )
        )
    ).scalar_one_or_none()
    assert registrant is not None
    assert registrant.status == "registered"


@pytest.mark.asyncio
async def test_confirm_waitlist_not_notified(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Cannot confirm if not in notified state: 400."""
    master = await _make_verified_master(client, db_session)
    pid = await _create_scheduled_practice(
        client, master, max_participants=1,
    )
    await _fill_practice(client, pid, telegram_id=62115)

    user = await login_user(
        client, telegram_id=62116, first_name="Waiter",
    )
    headers = auth_headers(user["session_token"])

    join_resp = await client.post(
        WAITLIST_JOIN_URL.format(practice_id=pid),
        headers=headers,
    )
    wid = join_resp.json()["id"]

    # Try to confirm without being notified.
    confirm_resp = await client.post(
        f"{WAITLIST_URL}/{wid}/confirm",
        headers=headers,
    )
    assert confirm_resp.status_code == 400


@pytest.mark.asyncio
async def test_confirm_waitlist_expired(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Cannot confirm after expiry: 400."""
    master = await _make_verified_master(client, db_session)
    pid = await _create_scheduled_practice(
        client, master, max_participants=1,
    )
    filler = await _fill_practice(client, pid, telegram_id=62117)

    user = await login_user(
        client, telegram_id=62118, first_name="Waiter",
    )
    headers = auth_headers(user["session_token"])

    join_resp = await client.post(
        WAITLIST_JOIN_URL.format(practice_id=pid),
        headers=headers,
    )
    wid = join_resp.json()["id"]

    # Cancel filler -> waiter notified.
    await client.delete(
        f"{BOOKINGS_URL}/{filler['booking_id']}",
        headers=auth_headers(filler["session_token"]),
    )

    # Force expire by setting expires_at to past.
    await db_session.execute(
        update(Waitlist)
        .where(Waitlist.id == wid)
        .values(
            expires_at=datetime.now(timezone.utc) - timedelta(hours=1),
        )
    )
    await db_session.commit()

    confirm_resp = await client.post(
        f"{WAITLIST_URL}/{wid}/confirm",
        headers=headers,
    )
    assert confirm_resp.status_code == 400


@pytest.mark.asyncio
async def test_confirm_waitlist_not_owner(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Cannot confirm someone else's waitlist entry: 404."""
    master = await _make_verified_master(client, db_session)
    pid = await _create_scheduled_practice(
        client, master, max_participants=1,
    )
    filler = await _fill_practice(client, pid, telegram_id=62119)

    user = await login_user(
        client, telegram_id=62120, first_name="Waiter",
    )
    join_resp = await client.post(
        WAITLIST_JOIN_URL.format(practice_id=pid),
        headers=auth_headers(user["session_token"]),
    )
    wid = join_resp.json()["id"]

    # Cancel filler -> waiter notified.
    await client.delete(
        f"{BOOKINGS_URL}/{filler['booking_id']}",
        headers=auth_headers(filler["session_token"]),
    )

    other = await login_user(
        client, telegram_id=62121, first_name="Other",
    )
    confirm_resp = await client.post(
        f"{WAITLIST_URL}/{wid}/confirm",
        headers=auth_headers(other["session_token"]),
    )
    assert confirm_resp.status_code == 404


@pytest.mark.asyncio
async def test_confirm_waitlist_nonexistent_id(
    client: AsyncClient,
) -> None:
    """Confirming a waitlist id that doesn't exist: 404, not a 500.

    W1 fix regression check: confirm_waitlist now does an unlocked peek
    for practice_id before locking anything, so a made-up id must still
    404 cleanly instead of raising on the peek.
    """
    user = await login_user(client, telegram_id=62122, first_name="Ghost")
    confirm_resp = await client.post(
        f"{WAITLIST_URL}/{uuid.uuid4()}/confirm",
        headers=auth_headers(user["session_token"]),
    )
    assert confirm_resp.status_code == 404


# ===================================================================
# Rejoin after leave
# ===================================================================


@pytest.mark.asyncio
async def test_rejoin_after_leave(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """User leaves then re-joins: new position, status=waiting."""
    master = await _make_verified_master(client, db_session)
    pid = await _create_scheduled_practice(
        client, master, max_participants=1,
    )
    await _fill_practice(client, pid, telegram_id=62122)

    user = await login_user(
        client, telegram_id=62123, first_name="Waiter",
    )
    headers = auth_headers(user["session_token"])

    # Join.
    join_resp = await client.post(
        WAITLIST_JOIN_URL.format(practice_id=pid),
        headers=headers,
    )
    assert join_resp.status_code == 201
    wid = join_resp.json()["id"]
    original_position = join_resp.json()["position"]

    # Leave.
    await client.delete(
        f"{WAITLIST_URL}/{wid}",
        headers=headers,
    )

    # Re-join.
    rejoin_resp = await client.post(
        WAITLIST_JOIN_URL.format(practice_id=pid),
        headers=headers,
    )
    assert rejoin_resp.status_code == 201
    data = rejoin_resp.json()
    assert data["status"] == "waiting"
    assert data["id"] == wid  # Same row, updated.
    assert data["position"] >= original_position


# ===================================================================
# Process waitlist (triggered by cancel_booking)
# ===================================================================


@pytest.mark.asyncio
async def test_cancel_booking_triggers_waitlist(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Cancelling a booking notifies the first waiting user."""
    master = await _make_verified_master(client, db_session)
    pid = await _create_scheduled_practice(
        client, master, max_participants=1,
    )
    filler = await _fill_practice(client, pid, telegram_id=62124)

    user = await login_user(
        client, telegram_id=62125, first_name="Waiter",
    )
    join_resp = await client.post(
        WAITLIST_JOIN_URL.format(practice_id=pid),
        headers=auth_headers(user["session_token"]),
    )
    assert join_resp.status_code == 201
    wid = join_resp.json()["id"]

    # Cancel filler's booking.
    await client.delete(
        f"{BOOKINGS_URL}/{filler['booking_id']}",
        headers=auth_headers(filler["session_token"]),
    )

    # Check waitlist entry is now notified.
    entry = await db_session.get(Waitlist, wid)
    await db_session.refresh(entry)
    assert entry.status == "notified"
    assert entry.notified_at is not None
    assert entry.expires_at is not None


# ===================================================================
# Position ordering
# ===================================================================


@pytest.mark.asyncio
async def test_position_ordering(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """First joiner gets position 1, second gets 2. First is notified."""
    master = await _make_verified_master(client, db_session)
    pid = await _create_scheduled_practice(
        client, master, max_participants=1,
    )
    filler = await _fill_practice(client, pid, telegram_id=62126)

    user1 = await login_user(
        client, telegram_id=62127, first_name="First",
    )
    user2 = await login_user(
        client, telegram_id=62128, first_name="Second",
    )

    # User1 joins first.
    resp1 = await client.post(
        WAITLIST_JOIN_URL.format(practice_id=pid),
        headers=auth_headers(user1["session_token"]),
    )
    assert resp1.status_code == 201
    assert resp1.json()["position"] == 1
    wid1 = resp1.json()["id"]

    # User2 joins second.
    resp2 = await client.post(
        WAITLIST_JOIN_URL.format(practice_id=pid),
        headers=auth_headers(user2["session_token"]),
    )
    assert resp2.status_code == 201
    assert resp2.json()["position"] == 2

    # Cancel filler -> user1 (position=1) gets notified, not user2.
    await client.delete(
        f"{BOOKINGS_URL}/{filler['booking_id']}",
        headers=auth_headers(filler["session_token"]),
    )

    entry1 = await db_session.get(Waitlist, wid1)
    await db_session.refresh(entry1)
    assert entry1.status == "notified"


# ===================================================================
# Decline triggers next notification
# ===================================================================


@pytest.mark.asyncio
async def test_decline_notifies_next(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """When notified user declines, next waiting user is notified."""
    master = await _make_verified_master(client, db_session)
    pid = await _create_scheduled_practice(
        client, master, max_participants=1,
    )
    filler = await _fill_practice(client, pid, telegram_id=62129)

    user1 = await login_user(
        client, telegram_id=62130, first_name="First",
    )
    user2 = await login_user(
        client, telegram_id=62131, first_name="Second",
    )

    # Both join waitlist.
    resp1 = await client.post(
        WAITLIST_JOIN_URL.format(practice_id=pid),
        headers=auth_headers(user1["session_token"]),
    )
    wid1 = resp1.json()["id"]

    resp2 = await client.post(
        WAITLIST_JOIN_URL.format(practice_id=pid),
        headers=auth_headers(user2["session_token"]),
    )
    wid2 = resp2.json()["id"]

    # Cancel filler -> user1 notified.
    await client.delete(
        f"{BOOKINGS_URL}/{filler['booking_id']}",
        headers=auth_headers(filler["session_token"]),
    )

    # User1 declines.
    await client.delete(
        f"{WAITLIST_URL}/{wid1}",
        headers=auth_headers(user1["session_token"]),
    )

    # User2 should now be notified.
    entry2 = await db_session.get(Waitlist, wid2)
    await db_session.refresh(entry2)
    assert entry2.status == "notified"


# ===================================================================
# Overbooking prevention (bugfix: capacity recheck in confirm)
# ===================================================================


@pytest.mark.asyncio
async def test_confirm_spot_taken_returns_to_waiting(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """When a concurrent booking takes the freed spot, confirm returns
    user to WAITING instead of overbooking.

    Scenario:
      1. Practice has 1 slot, filled by filler.
      2. Waiter joins waitlist.
      3. Filler cancels -> waiter gets notified.
      4. A new user books the freed slot (concurrent).
      5. Waiter tries confirm -> spot taken -> status=waiting, 400.
    """
    master = await _make_verified_master(client, db_session)
    pid = await _create_scheduled_practice(
        client, master, max_participants=1,
    )
    filler = await _fill_practice(client, pid, telegram_id=62140)

    waiter = await login_user(
        client, telegram_id=62141, first_name="Waiter",
    )
    waiter_headers = auth_headers(waiter["session_token"])

    # Waiter joins waitlist.
    join_resp = await client.post(
        WAITLIST_JOIN_URL.format(practice_id=pid),
        headers=waiter_headers,
    )
    assert join_resp.status_code == 201
    wid = join_resp.json()["id"]

    # Filler cancels -> waiter notified.
    await client.delete(
        f"{BOOKINGS_URL}/{filler['booking_id']}",
        headers=auth_headers(filler["session_token"]),
    )

    # Concurrent user takes the freed slot.
    sniper = await login_user(
        client, telegram_id=62142, first_name="Sniper",
    )
    book_resp = await client.post(
        BOOKINGS_URL,
        json={"practice_id": pid},
        headers=auth_headers(sniper["session_token"]),
    )
    assert book_resp.status_code == 201

    # Waiter tries to confirm -> spot taken, back to waiting.
    confirm_resp = await client.post(
        f"{WAITLIST_URL}/{wid}/confirm",
        headers=waiter_headers,
    )
    assert confirm_resp.status_code == 400
    assert "no longer available" in confirm_resp.json()["message"]

    # Verify entry is back to WAITING (committed, not rolled back).
    db_session.expire_all()
    entry = await db_session.get(Waitlist, wid)
    assert entry.status == "waiting"
    assert entry.notified_at is None
    assert entry.expires_at is None
