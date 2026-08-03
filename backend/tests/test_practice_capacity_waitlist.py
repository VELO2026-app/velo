"""H-R2 (3.3): relaxing max_participants hands freed seats to the waitlist.

Covers the top-up block at the end of update_practice:
- numeric raise -> EXACTLY (new - active - live holds) waiters notified;
- cap -> None -> every WAITING entry notified;
- negative twins: shrink-within-allowed / cap-less PATCH / dead practice
  -> ZERO process_waitlist effects;
- existing live NOTIFIED holds are counted as occupied and NEVER
  re-offered.

telegram_id band: 89620-89639 (issued for H-R2; admin pinned at 89639).
Cleanup goes through full_cleanup_range -- single call, single range.
"""

import uuid
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.events.models import OutboxEvent
from app.modules.practices.models import Practice
from app.modules.users.models import User, UserRole
from app.modules.waitlist.models import Waitlist
from tests.helpers import (
    auth_headers,
    full_cleanup_range,
    login_user,
    switch_self_to_master,
)

PRACTICES_URL = "/api/v1/practices"
BOOKINGS_URL = "/api/v1/bookings"
APPLY_URL = "/api/v1/masters/apply"
VERIFY_URL = "/api/v1/admin/masters/{user_id}/verify"
WAITLIST_JOIN_URL = "/api/v1/practices/{practice_id}/waitlist"

_ADMIN_TID = 89639


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await _do_cleanup(db_session)
    yield
    await _do_cleanup(db_session)


async def _do_cleanup(session: AsyncSession) -> None:
    """Full ORM cleanup for the file's band 89620-89639."""
    await full_cleanup_range(session, 89620, 89639, delete_users=False)
    await session.commit()


def _valid_practice_body(**overrides: object) -> dict:
    base: dict = {
        "practice_type": "live",
        "direction": "meditation",
        "difficulty": "beginner",
        "title": "Capacity Relaxation Session",
        "description": "Guided breathwork session",
        "scheduled_at": (
            datetime.now(UTC) + timedelta(days=7)
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
            "display_name": "Cap Master",
            "email": "capmaster@test.com",
        },
        "experience": {
            "methods": ["meditation"],
            "experience_years": 5,
            "bio": "Experienced practitioner",
        },
        "documents": [],
    }


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int,
) -> dict:
    """Create user, apply, verify (in-band admin), self-switch."""
    auth = await login_user(
        client, telegram_id=telegram_id, first_name="Master",
    )
    await client.post(
        APPLY_URL,
        json=_valid_apply_body(),
        headers=auth_headers(auth["session_token"]),
    )

    await login_user(client, telegram_id=_ADMIN_TID, first_name="Admin")
    await db_session.execute(
        update(User)
        .where(User.telegram_id == _ADMIN_TID)
        .values(role=UserRole.ADMIN.value)
    )
    await db_session.commit()
    admin_auth = await login_user(
        client, telegram_id=_ADMIN_TID, first_name="Admin",
    )

    verify_resp = await client.post(
        VERIFY_URL.format(user_id=auth["user"]["id"]),
        json={},
        headers=auth_headers(admin_auth["session_token"]),
    )
    assert verify_resp.status_code == 200

    await switch_self_to_master(client, auth["session_token"])
    return await login_user(
        client, telegram_id=telegram_id, first_name="Master",
    )


async def _scheduled_practice(
    client: AsyncClient, master_auth: dict, **overrides: object,
) -> str:
    resp = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(**overrides),
        headers=auth_headers(master_auth["session_token"]),
    )
    assert resp.status_code == 201
    pid = resp.json()["id"]
    patch = await client.patch(
        f"{PRACTICES_URL}/{pid}",
        json={"status": "scheduled"},
        headers=auth_headers(master_auth["session_token"]),
    )
    assert patch.status_code == 200
    return pid


async def _book(client: AsyncClient, pid: str, telegram_id: int) -> dict:
    user = await login_user(
        client, telegram_id=telegram_id, first_name="Filler",
    )
    resp = await client.post(
        BOOKINGS_URL,
        json={"practice_id": pid},
        headers=auth_headers(user["session_token"]),
    )
    assert resp.status_code == 201
    return {**user, "booking_id": resp.json()["id"]}


async def _join(client: AsyncClient, pid: str, telegram_id: int) -> dict:
    user = await login_user(
        client, telegram_id=telegram_id, first_name="Waiter",
    )
    resp = await client.post(
        WAITLIST_JOIN_URL.format(practice_id=pid),
        headers=auth_headers(user["session_token"]),
    )
    assert resp.status_code == 201
    return {**user, "waitlist_id": resp.json()["id"]}


async def _statuses(
    session: AsyncSession, pid: str, *user_ids: str,
) -> list[str]:
    session.expire_all()
    out: list[str] = []
    for uid in user_ids:
        entry = (
            await session.execute(
                select(Waitlist).where(
                    Waitlist.practice_id == uuid.UUID(pid),
                    Waitlist.user_id == uuid.UUID(uid),
                )
            )
        ).scalar_one()
        out.append(entry.status)
    return out


async def _spot_events_for(
    session: AsyncSession, user_id: str,
) -> int:
    rows = (
        await session.execute(
            select(OutboxEvent).where(
                OutboxEvent.payload["type"].astext
                == "waitlist.spot_available",
                OutboxEvent.payload["target_value"].astext == user_id,
            )
        )
    ).scalars().all()
    return len(rows)


@pytest.mark.asyncio
async def test_cap_raise_notifies_exactly_freed_seats(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """cap 1 -> 3 with 1 active and 3 WAITING: EXACTLY 2 notified
    (2 freed seats), exactly 2 spot_available events, third stays
    WAITING."""
    master = await _make_verified_master(client, db_session, 89620)
    pid = await _scheduled_practice(client, master, max_participants=1)
    await _book(client, pid, 89621)  # active = 1
    w1 = await _join(client, pid, 89622)
    w2 = await _join(client, pid, 89623)
    w3 = await _join(client, pid, 89624)

    patch = await client.patch(
        f"{PRACTICES_URL}/{pid}",
        json={"max_participants": 3},
        headers=auth_headers(master["session_token"]),
    )
    assert patch.status_code == 200

    s1, s2, s3 = await _statuses(
        db_session, pid,
        w1["user"]["id"], w2["user"]["id"], w3["user"]["id"],
    )
    assert (s1, s2, s3) == ("notified", "notified", "waiting")
    assert await _spot_events_for(db_session, w1["user"]["id"]) == 1
    assert await _spot_events_for(db_session, w2["user"]["id"]) == 1
    assert await _spot_events_for(db_session, w3["user"]["id"]) == 0


@pytest.mark.asyncio
async def test_cap_to_none_notifies_all_waiting(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """cap 1 -> None (no limit): every WAITING entry gets its offer."""
    master = await _make_verified_master(client, db_session, 89620)
    pid = await _scheduled_practice(client, master, max_participants=1)
    await _book(client, pid, 89621)
    w1 = await _join(client, pid, 89622)
    w2 = await _join(client, pid, 89623)

    patch = await client.patch(
        f"{PRACTICES_URL}/{pid}",
        json={"max_participants": None},
        headers=auth_headers(master["session_token"]),
    )
    assert patch.status_code == 200

    s1, s2 = await _statuses(
        db_session, pid, w1["user"]["id"], w2["user"]["id"],
    )
    assert (s1, s2) == ("notified", "notified")
    assert await _spot_events_for(db_session, w1["user"]["id"]) == 1
    assert await _spot_events_for(db_session, w2["user"]["id"]) == 1


@pytest.mark.asyncio
async def test_live_hold_occupies_seat_and_is_not_reoffered(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A live NOTIFIED hold counts as occupied: cap 1 -> 2 with one live
    hold and zero active frees exactly ONE seat -- the second waiter is
    notified, the holder is NOT offered again (still exactly one
    spot_available event for them)."""
    master = await _make_verified_master(client, db_session, 89620)
    pid = await _scheduled_practice(client, master, max_participants=1)
    filler = await _book(client, pid, 89621)
    w1 = await _join(client, pid, 89622)
    w2 = await _join(client, pid, 89623)

    # Cancellation frees the only seat -> w1 becomes a live NOTIFIED
    # hold (first spot_available for them).
    cancel = await client.delete(
        f"{BOOKINGS_URL}/{filler['booking_id']}",
        headers=auth_headers(filler["session_token"]),
    )
    assert cancel.status_code in (200, 204)
    s1, _ = await _statuses(
        db_session, pid, w1["user"]["id"], w2["user"]["id"],
    )
    assert s1 == "notified"

    patch = await client.patch(
        f"{PRACTICES_URL}/{pid}",
        json={"max_participants": 2},
        headers=auth_headers(master["session_token"]),
    )
    assert patch.status_code == 200

    s1, s2 = await _statuses(
        db_session, pid, w1["user"]["id"], w2["user"]["id"],
    )
    assert (s1, s2) == ("notified", "notified")
    # Holder NOT re-offered: still exactly one event.
    assert await _spot_events_for(db_session, w1["user"]["id"]) == 1
    assert await _spot_events_for(db_session, w2["user"]["id"]) == 1


@pytest.mark.asyncio
async def test_shrink_within_allowed_zero_calls(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Negative twin: lowering cap within the allowed floor is not a
    relaxation -- the queue is untouched."""
    master = await _make_verified_master(client, db_session, 89620)
    pid = await _scheduled_practice(client, master, max_participants=3)
    await _book(client, pid, 89621)
    await _book(client, pid, 89625)
    await _book(client, pid, 89626)  # full: 3/3
    w1 = await _join(client, pid, 89622)

    patch = await client.patch(
        f"{PRACTICES_URL}/{pid}",
        json={"max_participants": 3},
        headers=auth_headers(master["session_token"]),
    )
    assert patch.status_code == 200
    # And an actual shrink attempt below active is refused outright.
    shrink = await client.patch(
        f"{PRACTICES_URL}/{pid}",
        json={"max_participants": 2},
        headers=auth_headers(master["session_token"]),
    )
    assert shrink.status_code == 400

    (s1,) = await _statuses(db_session, pid, w1["user"]["id"])
    assert s1 == "waiting"
    assert await _spot_events_for(db_session, w1["user"]["id"]) == 0


@pytest.mark.asyncio
async def test_patch_without_cap_zero_calls(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Negative twin: a PATCH that never touches max_participants must
    not reach the top-up block at all."""
    master = await _make_verified_master(client, db_session, 89620)
    pid = await _scheduled_practice(client, master, max_participants=1)
    await _book(client, pid, 89621)
    w1 = await _join(client, pid, 89622)

    patch = await client.patch(
        f"{PRACTICES_URL}/{pid}",
        json={"title": "Renamed, capacity untouched"},
        headers=auth_headers(master["session_token"]),
    )
    assert patch.status_code == 200

    (s1,) = await _statuses(db_session, pid, w1["user"]["id"])
    assert s1 == "waiting"
    assert await _spot_events_for(db_session, w1["user"]["id"]) == 0


@pytest.mark.asyncio
async def test_cap_raise_on_dead_practice_zero_calls(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Negative twin (П-1 predicate): the FINAL picture decides -- a
    relaxed cap on a practice that is not confirmable (already started)
    hands out nothing.

    NOTE (recorded in the report): the literal "one PATCH raises the cap
    AND cancels" combination is unreachable via the API --
    scheduled -> cancelled is not a valid PATCH transition (the only
    path to cancelled is cancel_practice with refunds). The dead state
    is therefore pre-set by direct UPDATE (started), which exercises the
    exact same `relaxed and not confirmable -> zero` branch."""
    master = await _make_verified_master(client, db_session, 89620)
    pid = await _scheduled_practice(client, master, max_participants=1)
    await _book(client, pid, 89621)
    w1 = await _join(client, pid, 89622)

    await db_session.execute(
        update(Practice)
        .where(Practice.id == uuid.UUID(pid))
        .values(scheduled_at=datetime.now(UTC) - timedelta(minutes=5))
    )
    await db_session.commit()

    patch = await client.patch(
        f"{PRACTICES_URL}/{pid}",
        json={"max_participants": 5},
        headers=auth_headers(master["session_token"]),
    )
    assert patch.status_code == 200

    (s1,) = await _statuses(db_session, pid, w1["user"]["id"])
    assert s1 == "waiting"
    assert await _spot_events_for(db_session, w1["user"]["id"]) == 0
