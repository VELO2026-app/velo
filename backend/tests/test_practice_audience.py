# =============================================================================
# VELO Backend -- Tests: Practice Audience (Master GROUPS P5, ПРОМТ №594)
# =============================================================================
#
# telegram_id range: 99300-99399
#
# ⚠ BACKEND-ONLY, UNPROVEN LOCALLY -- no Postgres reachable in this
# environment (see test_zoom_lifecycle.py's module docstring for the exact
# local blocker). Deferred to the deploy gate. Written to be read and to run
# in CI; never executed via pytest this session.
#
# Coverage (the shared predicate, practices/audience_service.py, exercised
# at its three enforcement points):
#   - GET /practices (list_public_practices): public visible to any
#     non-blocked viewer; students-only visible to a student of that
#     master, hidden from a stranger; groups visible to a member, hidden
#     from a non-member; a BLOCKED viewer sees none of the above regardless
#     of audience_kind.
#   - POST /practices/{id}/checkin (upsert_checkin): rejects a viewer who
#     holds an old CONFIRMED booking but is no longer in the practice's
#     (since-narrowed) audience -- the retroactive case create_booking's
#     own gate cannot catch.
#   - POST /bookings (create_booking): THE CARRIED SEAM (P1->P5) -- rejects
#     a blocked viewer AND a viewer outside the practice's audience.
#   - POST /practices (create_practice): group_ids must be the master's OWN
#     custom groups (rejects another master's group with 400); a valid
#     'groups' create returns audience_group_names.
#   - PATCH /practices/{id} (update_practice, ПРОМТ №596 FIX 3): the
#     audience-switching branch matrix -- switch to 'groups' (sets targets),
#     switch away (clears stale practice_audience_group rows), groups ->
#     different groups (replaces targets), re-send 'groups' without new
#     group_ids (reuses existing targets), reject another master's/unknown
#     group id.
#   - POST /waitlist/{id}/confirm (confirm_waitlist, ПРОМТ №596 FIX 4): the
#     OTHER booking-creation path enforces the identical gate as
#     create_booking.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.bookings.models import Booking, BookingStatus
from app.modules.masters.groups_models import (
    MasterGroup,
    MasterGroupMembership,
    MasterStudent,
)
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import (
    AudienceKind,
    Practice,
    PracticeAudienceGroup,
    PracticeStatus,
    PracticeType,
)
from app.modules.users.models import User, UserRole
from app.modules.waitlist.models import Waitlist, WaitlistStatus
from tests.helpers import auth_headers, full_cleanup_range, login_user

PRACTICES_URL = "/api/v1/practices"
BOOKINGS_URL = "/api/v1/bookings"
CHECKIN_URL = "/api/v1/practices/{practice_id}/checkin"
WAITLIST_CONFIRM_URL = "/api/v1/waitlist/{waitlist_id}/confirm"

_TID_MIN = 99300
_TID_MAX = 99399


# ===================================================================
# Cleanup
# ===================================================================


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


# ===================================================================
# Helpers
# ===================================================================


async def _make_verified_master(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int,
) -> dict:
    auth = await login_user(client, telegram_id=telegram_id, first_name="Master")
    user_id = auth["user"]["id"]
    user = await db_session.get(User, user_id)
    user.role = UserRole.MASTER
    await db_session.flush()
    db_session.add(
        MasterProfile(
            user_id=user_id,
            data={"account": {"status": "verified"}, "profile": {"bio": "m"}},
        )
    )
    await db_session.flush()
    return auth


async def _login(client: AsyncClient, telegram_id: int, first_name: str) -> str:
    auth = await login_user(client, telegram_id=telegram_id, first_name=first_name)
    return auth["user"]["id"]


async def _create_practice(
    db_session: AsyncSession,
    master_id: str,
    *,
    audience_kind: str = AudienceKind.PUBLIC.value,
    scheduled_hours_from_now: float = 48,
    status: str = PracticeStatus.SCHEDULED.value,
) -> Practice:
    practice = Practice(
        master_id=master_id,
        title="Audience Test Practice",
        description="x",
        practice_type=PracticeType.LIVE.value,
        status=status,
        scheduled_at=datetime.now(UTC) + timedelta(hours=scheduled_hours_from_now),
        duration_minutes=60,
        timezone="UTC",
        max_participants=20,
        current_participants=0,
        is_free=True,
        price_cents=0,
        currency="eur",
        audience_kind=audience_kind,
    )
    db_session.add(practice)
    await db_session.flush()
    return practice


async def _confirmed_booking(
    db_session: AsyncSession, user_id: str, practice_id,
) -> Booking:
    booking = Booking(
        practice_id=practice_id, user_id=user_id, status=BookingStatus.CONFIRMED.value,
    )
    db_session.add(booking)
    await db_session.flush()
    return booking


async def _custom_group(
    db_session: AsyncSession, master_id: str, name: str = "VIP",
) -> MasterGroup:
    group = MasterGroup(master_id=master_id, name=name)
    db_session.add(group)
    await db_session.flush()
    return group


async def _add_group_member(
    db_session: AsyncSession, group_id, student_user_id: str,
) -> None:
    db_session.add(
        MasterGroupMembership(group_id=group_id, student_user_id=student_user_id)
    )
    await db_session.flush()


async def _target_group(db_session: AsyncSession, practice_id, group_id) -> None:
    db_session.add(PracticeAudienceGroup(practice_id=practice_id, group_id=group_id))
    await db_session.flush()


async def _block(
    db_session: AsyncSession, master_id: str, student_user_id: str,
) -> None:
    db_session.add(
        MasterStudent(
            master_id=master_id, student_user_id=student_user_id,
            blocked_at=datetime.now(UTC),
        )
    )
    await db_session.flush()


def _ids(resp_json: dict) -> set[str]:
    return {item["id"] for item in resp_json["items"]}


def _practice_body(**overrides: object) -> dict:
    """A valid CreatePracticeRequest body (mirrors test_practices.py's
    _valid_practice_body -- same required fields, own module)."""
    base: dict = {
        "practice_type": "live",
        "direction": "meditation",
        "difficulty": "beginner",
        "title": "Audience Create Test",
        "scheduled_at": (
            datetime.now(UTC) + timedelta(days=7)
        ).isoformat(),
        "duration_minutes": 60,
        "timezone": "UTC",
        "max_participants": 20,
        "is_free": True,
        "price_cents": 0,
        "currency": "eur",
    }
    base.update(overrides)
    return base


# ===================================================================
# Listing filter (GET /practices)
# ===================================================================


@pytest.mark.asyncio
async def test_public_practice_visible_to_any_non_blocked_viewer(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99301)
    practice = await _create_practice(
        db_session, master["user"]["id"], audience_kind=AudienceKind.PUBLIC.value,
    )
    await db_session.commit()

    viewer = await login_user(client, telegram_id=99302, first_name="Viewer")
    resp = await client.get(
        PRACTICES_URL, headers=auth_headers(viewer["session_token"]),
    )

    assert resp.status_code == 200
    assert str(practice.id) in _ids(resp.json())


@pytest.mark.asyncio
async def test_students_only_visible_to_a_student_hidden_from_stranger(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99303)
    master_id = master["user"]["id"]
    practice = await _create_practice(
        db_session, master_id, audience_kind=AudienceKind.STUDENTS.value,
    )
    # The student's "membership" is derived from ANY non-cancelled booking on
    # a DIFFERENT practice by this same master (groups_service.py's rule).
    other_practice = await _create_practice(
        db_session, master_id, scheduled_hours_from_now=1,
    )
    student_id = await _login(client, 99304, "Student")
    await _confirmed_booking(db_session, student_id, other_practice.id)
    stranger = await login_user(client, telegram_id=99305, first_name="Stranger")
    await db_session.commit()

    student_auth = await login_user(client, telegram_id=99304, first_name="Student")
    resp_student = await client.get(
        PRACTICES_URL, headers=auth_headers(student_auth["session_token"]),
    )
    resp_stranger = await client.get(
        PRACTICES_URL, headers=auth_headers(stranger["session_token"]),
    )

    assert str(practice.id) in _ids(resp_student.json())
    assert str(practice.id) not in _ids(resp_stranger.json())


@pytest.mark.asyncio
async def test_groups_only_visible_to_a_member_hidden_from_non_member(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99306)
    master_id = master["user"]["id"]
    group = await _custom_group(db_session, master_id)
    practice = await _create_practice(
        db_session, master_id, audience_kind=AudienceKind.GROUPS.value,
    )
    await _target_group(db_session, practice.id, group.id)

    member_id = await _login(client, 99307, "Member")
    await _add_group_member(db_session, group.id, member_id)
    non_member = await login_user(client, telegram_id=99308, first_name="NonMember")
    await db_session.commit()

    member_auth = await login_user(client, telegram_id=99307, first_name="Member")
    resp_member = await client.get(
        PRACTICES_URL, headers=auth_headers(member_auth["session_token"]),
    )
    resp_non_member = await client.get(
        PRACTICES_URL, headers=auth_headers(non_member["session_token"]),
    )

    assert str(practice.id) in _ids(resp_member.json())
    assert str(practice.id) not in _ids(resp_non_member.json())


@pytest.mark.asyncio
async def test_blocked_viewer_sees_no_practices_of_that_master_regardless_of_audience(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99309)
    master_id = master["user"]["id"]
    public_practice = await _create_practice(
        db_session, master_id, audience_kind=AudienceKind.PUBLIC.value,
    )

    blocked_id = await _login(client, 99310, "Blocked")
    await _block(db_session, master_id, blocked_id)
    await db_session.commit()

    blocked_auth = await login_user(client, telegram_id=99310, first_name="Blocked")
    resp = await client.get(
        PRACTICES_URL, headers=auth_headers(blocked_auth["session_token"]),
    )

    assert str(public_practice.id) not in _ids(resp.json())


# ===================================================================
# Check-in gate (retroactive case -- covers a booking made before the
# audience was narrowed)
# ===================================================================


@pytest.mark.asyncio
async def test_checkin_rejects_a_viewer_no_longer_in_the_audience(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99311)
    master_id = master["user"]["id"]
    group = await _custom_group(db_session, master_id)
    # scheduled soon enough to be inside the check-in window.
    practice = await _create_practice(
        db_session, master_id,
        audience_kind=AudienceKind.GROUPS.value,
        scheduled_hours_from_now=1,
    )
    await _target_group(db_session, practice.id, group.id)

    # The user booked BEFORE the audience narrowed (or was simply never
    # added to the target group) -- still holds a real CONFIRMED booking.
    outsider_id = await _login(client, 99312, "Outsider")
    await _confirmed_booking(db_session, outsider_id, practice.id)
    await db_session.commit()

    outsider_auth = await login_user(client, telegram_id=99312, first_name="Outsider")
    resp = await client.post(
        CHECKIN_URL.format(practice_id=practice.id),
        json={"mood": 7},
        headers=auth_headers(outsider_auth["session_token"]),
    )

    assert resp.status_code == 403
    assert resp.json()["error"] == "not_in_audience"


# ===================================================================
# Booking-creation gate -- THE CARRIED SEAM (P1 -> P5)
# ===================================================================


@pytest.mark.asyncio
async def test_create_booking_rejects_a_blocked_viewer(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99313)
    master_id = master["user"]["id"]
    practice = await _create_practice(
        db_session, master_id, audience_kind=AudienceKind.PUBLIC.value,
    )
    blocked_id = await _login(client, 99314, "Blocked")
    await _block(db_session, master_id, blocked_id)
    await db_session.commit()

    blocked_auth = await login_user(client, telegram_id=99314, first_name="Blocked")
    resp = await client.post(
        BOOKINGS_URL,
        json={"practice_id": str(practice.id)},
        headers=auth_headers(blocked_auth["session_token"]),
    )

    assert resp.status_code == 403
    assert resp.json()["error"] == "blocked_by_master"


@pytest.mark.asyncio
async def test_create_booking_rejects_a_viewer_outside_the_audience(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99315)
    master_id = master["user"]["id"]
    practice = await _create_practice(
        db_session, master_id, audience_kind=AudienceKind.STUDENTS.value,
    )
    stranger = await login_user(client, telegram_id=99316, first_name="Stranger")
    await db_session.commit()

    resp = await client.post(
        BOOKINGS_URL,
        json={"practice_id": str(practice.id)},
        headers=auth_headers(stranger["session_token"]),
    )

    assert resp.status_code == 403
    assert resp.json()["error"] == "not_a_student"


# ===================================================================
# Create-practice audience (POST /practices)
# ===================================================================


@pytest.mark.asyncio
async def test_create_practice_rejects_another_masters_group(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    master_a = await _make_verified_master(client, db_session, 99317)
    master_b = await _make_verified_master(client, db_session, 99318)
    foreign_group = await _custom_group(db_session, master_b["user"]["id"])
    await db_session.commit()

    resp = await client.post(
        PRACTICES_URL,
        json=_practice_body(
            audience_kind=AudienceKind.GROUPS.value,
            group_ids=[str(foreign_group.id)],
        ),
        headers=auth_headers(master_a["session_token"]),
    )

    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_create_practice_with_own_groups_returns_group_names(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99319)
    group = await _custom_group(db_session, master["user"]["id"], name="Утро")
    await db_session.commit()

    resp = await client.post(
        PRACTICES_URL,
        json=_practice_body(
            audience_kind=AudienceKind.GROUPS.value,
            group_ids=[str(group.id)],
        ),
        headers=auth_headers(master["session_token"]),
    )

    assert resp.status_code == 201
    body = resp.json()
    assert body["audience_kind"] == "groups"
    assert body["audience_group_names"] == ["Утро"]


# ===================================================================
# Update-practice audience switching (ПРОМТ №596, FIX 3 -- previously
# untested branch matrix in update_practice, practices/service.py)
# ===================================================================


async def _target_group_ids(db_session: AsyncSession, practice_id) -> set:
    rows = (
        await db_session.execute(
            select(PracticeAudienceGroup.group_id).where(
                PracticeAudienceGroup.practice_id == practice_id,
            )
        )
    ).scalars().all()
    return set(rows)


@pytest.mark.asyncio
async def test_update_practice_switch_to_groups_sets_targets(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99320)
    headers = auth_headers(master["session_token"])
    group = await _custom_group(db_session, master["user"]["id"], name="Вечер")
    await db_session.commit()

    created = await client.post(PRACTICES_URL, json=_practice_body(), headers=headers)
    assert created.status_code == 201
    practice_id = created.json()["id"]
    assert created.json()["audience_kind"] == "public"

    resp = await client.patch(
        f"{PRACTICES_URL}/{practice_id}",
        json={"audience_kind": "groups", "group_ids": [str(group.id)]},
        headers=headers,
    )

    assert resp.status_code == 200
    assert resp.json()["audience_kind"] == "groups"
    assert resp.json()["audience_group_names"] == ["Вечер"]
    assert await _target_group_ids(db_session, practice_id) == {group.id}


@pytest.mark.asyncio
async def test_update_practice_switch_away_from_groups_clears_stale_targets(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99321)
    headers = auth_headers(master["session_token"])
    group = await _custom_group(db_session, master["user"]["id"], name="Утро")
    await db_session.commit()

    created = await client.post(
        PRACTICES_URL,
        json=_practice_body(
            audience_kind=AudienceKind.GROUPS.value, group_ids=[str(group.id)],
        ),
        headers=headers,
    )
    assert created.status_code == 201
    practice_id = created.json()["id"]
    assert await _target_group_ids(db_session, practice_id) == {group.id}

    # Switch away WITHOUT sending group_ids -- the stale row must be cleared,
    # not left dangling (it would otherwise resurrect on a later switch back).
    resp = await client.patch(
        f"{PRACTICES_URL}/{practice_id}",
        json={"audience_kind": "public"},
        headers=headers,
    )

    assert resp.status_code == 200
    assert resp.json()["audience_kind"] == "public"
    assert await _target_group_ids(db_session, practice_id) == set()


@pytest.mark.asyncio
async def test_update_practice_switch_groups_to_different_groups_replaces_targets(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99322)
    headers = auth_headers(master["session_token"])
    group_a = await _custom_group(db_session, master["user"]["id"], name="A")
    group_b = await _custom_group(db_session, master["user"]["id"], name="B")
    await db_session.commit()

    created = await client.post(
        PRACTICES_URL,
        json=_practice_body(
            audience_kind=AudienceKind.GROUPS.value, group_ids=[str(group_a.id)],
        ),
        headers=headers,
    )
    assert created.status_code == 201
    practice_id = created.json()["id"]
    assert await _target_group_ids(db_session, practice_id) == {group_a.id}

    resp = await client.patch(
        f"{PRACTICES_URL}/{practice_id}",
        json={"group_ids": [str(group_b.id)]},
        headers=headers,
    )

    assert resp.status_code == 200
    assert resp.json()["audience_group_names"] == ["B"]
    assert await _target_group_ids(db_session, practice_id) == {group_b.id}


@pytest.mark.asyncio
async def test_update_practice_reuses_existing_targets_when_group_ids_omitted(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """audience_kind='groups' sent WITHOUT group_ids in the same request is
    valid only because the practice already has target groups from before
    (service.py's existing_count check) -- confirms that branch, distinct
    from the "sets targets" / "replaces targets" cases above which DO send
    group_ids."""
    master = await _make_verified_master(client, db_session, 99323)
    headers = auth_headers(master["session_token"])
    group = await _custom_group(db_session, master["user"]["id"], name="Стабильная")
    await db_session.commit()

    created = await client.post(
        PRACTICES_URL,
        json=_practice_body(
            audience_kind=AudienceKind.GROUPS.value, group_ids=[str(group.id)],
        ),
        headers=headers,
    )
    practice_id = created.json()["id"]

    # Re-send audience_kind='groups' (e.g. alongside an unrelated field
    # change) WITHOUT group_ids -- must keep the existing target, not 400.
    resp = await client.patch(
        f"{PRACTICES_URL}/{practice_id}",
        json={"audience_kind": "groups", "title": "Renamed"},
        headers=headers,
    )

    assert resp.status_code == 200
    assert resp.json()["audience_group_names"] == ["Стабильная"]
    assert await _target_group_ids(db_session, practice_id) == {group.id}


@pytest.mark.asyncio
async def test_update_practice_group_ids_rejects_another_masters_group(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    master_a = await _make_verified_master(client, db_session, 99324)
    master_b = await _make_verified_master(client, db_session, 99325)
    headers_a = auth_headers(master_a["session_token"])
    foreign_group = await _custom_group(db_session, master_b["user"]["id"])
    await db_session.commit()

    created = await client.post(PRACTICES_URL, json=_practice_body(), headers=headers_a)
    practice_id = created.json()["id"]

    resp = await client.patch(
        f"{PRACTICES_URL}/{practice_id}",
        json={"audience_kind": "groups", "group_ids": [str(foreign_group.id)]},
        headers=headers_a,
    )

    assert resp.status_code == 400
    assert await _target_group_ids(db_session, practice_id) == set()


@pytest.mark.asyncio
async def test_update_practice_group_ids_rejects_unknown_id(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99326)
    headers = auth_headers(master["session_token"])
    await db_session.commit()

    created = await client.post(PRACTICES_URL, json=_practice_body(), headers=headers)
    practice_id = created.json()["id"]

    resp = await client.patch(
        f"{PRACTICES_URL}/{practice_id}",
        json={"audience_kind": "groups", "group_ids": [str(uuid4())]},
        headers=headers,
    )

    assert resp.status_code == 400


# ===================================================================
# Waitlist-confirmation gate (ПРОМТ №596, FIX 4) -- confirm_waitlist is the
# OTHER booking-creation path (waitlist/service.py); a HELD notification
# must not convert into a booking for a now-blocked/out-of-audience user
# any more than a fresh POST /bookings can.
# ===================================================================


async def _notified_waitlist_entry(
    db_session: AsyncSession, practice_id, user_id: str,
) -> Waitlist:
    """A NOTIFIED entry, constructed directly (bypassing join_waitlist,
    which a blocked/out-of-audience user could not legitimately reach in
    the first place) -- simulates the retroactive case: notified, THEN
    blocked, before tapping confirm."""
    entry = Waitlist(
        practice_id=practice_id,
        user_id=user_id,
        position=1,
        status=WaitlistStatus.NOTIFIED.value,
        joined_at=datetime.now(UTC),
        notified_at=datetime.now(UTC),
        expires_at=datetime.now(UTC) + timedelta(hours=1),
    )
    db_session.add(entry)
    await db_session.flush()
    return entry


@pytest.mark.asyncio
async def test_confirm_waitlist_rejects_a_blocked_viewer(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99327)
    master_id = master["user"]["id"]
    practice = await _create_practice(
        db_session, master_id, audience_kind=AudienceKind.PUBLIC.value,
    )
    blocked_auth = await login_user(client, telegram_id=99328, first_name="Blocked")
    blocked_id = blocked_auth["user"]["id"]
    entry = await _notified_waitlist_entry(db_session, practice.id, blocked_id)
    await _block(db_session, master_id, blocked_id)
    await db_session.commit()

    resp = await client.post(
        WAITLIST_CONFIRM_URL.format(waitlist_id=entry.id),
        headers=auth_headers(blocked_auth["session_token"]),
    )

    assert resp.status_code == 403
    assert resp.json()["error"] == "blocked_by_master"


@pytest.mark.asyncio
async def test_confirm_waitlist_rejects_a_viewer_outside_the_audience(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99329)
    master_id = master["user"]["id"]
    practice = await _create_practice(
        db_session, master_id, audience_kind=AudienceKind.STUDENTS.value,
    )
    stranger_auth = await login_user(client, telegram_id=99330, first_name="Stranger")
    entry = await _notified_waitlist_entry(
        db_session, practice.id, stranger_auth["user"]["id"],
    )
    await db_session.commit()

    resp = await client.post(
        WAITLIST_CONFIRM_URL.format(waitlist_id=entry.id),
        headers=auth_headers(stranger_auth["session_token"]),
    )

    assert resp.status_code == 403
    assert resp.json()["error"] == "not_a_student"


# ===================================================================
# Group rename while targeted by a 'groups' practice (ПРОМТ №596, FIX 5) --
# audience_group_names is resolved via a live JOIN (practices/service.py's
# group_names_for_practice), never cached/duplicated, so a rename must
# self-correct with no extra write on the practice side.
# ===================================================================


@pytest.mark.asyncio
async def test_rename_group_updates_targeting_practices_audience_group_names(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99331)
    headers = auth_headers(master["session_token"])
    group = await _custom_group(db_session, master["user"]["id"], name="Утро")
    await db_session.commit()

    created = await client.post(
        PRACTICES_URL,
        json=_practice_body(
            audience_kind=AudienceKind.GROUPS.value, group_ids=[str(group.id)],
        ),
        headers=headers,
    )
    assert created.status_code == 201
    practice_id = created.json()["id"]
    assert created.json()["audience_group_names"] == ["Утро"]

    rename = await client.patch(
        f"/api/v1/masters/me/groups/{group.id}",
        json={"name": "Утренняя практика"},
        headers=headers,
    )
    assert rename.status_code == 200

    detail = await client.get(f"{PRACTICES_URL}/{practice_id}", headers=headers)
    assert detail.status_code == 200
    assert detail.json()["audience_group_names"] == ["Утренняя практика"]
