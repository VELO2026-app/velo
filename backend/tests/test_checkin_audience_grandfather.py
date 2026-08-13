# Post-HTTP DB reads go through tests.helpers.fresh_get / fresh_execute
# (T-19 convention -- see the docstring there for the flake AND the lie it kills).
"""H-R2-8 (3.2, decision B): check-in for a CONFIRMED booking survives
audience NARROWING; a personal BLOCK still refuses it.

Post-state twins (DB rows, not just codes):
- narrowing after booking (PUBLIC -> STUDENTS; PUBLIC -> GROUPS with an
  empty target set; live removal from a target group) -> check-in
  CREATED;
- blocked_at coexisting with a CONFIRMED booking -> 403
  blocked_by_master, NO Checkin row (state built DIRECTLY: the live
  block flow cancels future bookings and would destroy the
  precondition -- probe the guard, not the flow);
- the live block FLOW twin -> booking cancelled -> check-in NotFound
  (documents the actual interplay: the 403 is defense in depth);
- neighbors intact: no booking + out of audience -> 404 (booking-first,
  no existence oracle); create_booking for a non-member without a
  booking -> 403 (audience alive for NEW acquisitions).

telegram_id band: 89660-89679 (issued for H-R2-8; admin pinned at
89679).

STRUCTURAL FACT (recorded in the report): a user holding a CONFIRMED
booking on the master IS a student, so the PUBLIC -> STUDENTS case was
green even pre-(B); PUBLIC -> GROUPS and group removal are the
discriminating flips. (T-20, 2026-08-13: the predicate was renamed
_is_student_clause -> _has_student_entitlement_clause and narrowed from
">=1 non-cancelled booking" to STUDENT_ENTITLEMENT_STATUSES =
{CONFIRMED, ATTENDED, NO_SHOW}. Every booking in this file is CONFIRMED,
so the structural fact above is unchanged.)
"""

import uuid
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.bookings.models import Booking, BookingStatus
from app.modules.diary.models import Checkin
from app.modules.masters.groups_models import MasterStudent
from app.modules.users.models import User, UserRole
from tests.helpers import (
    auth_headers,
    fresh_execute,
    full_cleanup_range,
    login_user,
    switch_self_to_master,
)

PRACTICES_URL = "/api/v1/practices"
BOOKINGS_URL = "/api/v1/bookings"
APPLY_URL = "/api/v1/masters/apply"
VERIFY_URL = "/api/v1/admin/masters/{user_id}/verify"
CHECKIN_URL = "/api/v1/practices/{practice_id}/checkin"
GROUPS_URL = "/api/v1/masters/me/groups"
BLOCK_URL = "/api/v1/masters/me/students/{student_id}/block"

_ADMIN_TID = 89679


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await _do_cleanup(db_session)
    yield
    await _do_cleanup(db_session)


async def _do_cleanup(session: AsyncSession) -> None:
    """Full ORM cleanup for the file's band 89660-89679."""
    await full_cleanup_range(session, 89660, 89679, delete_users=False)
    await session.commit()


def _valid_practice_body(**overrides: object) -> dict:
    base: dict = {
        "practice_type": "live",
        "direction": "meditation",
        "difficulty": "beginner",
        "title": "Grandfather Session",
        "description": "Guided breathwork session",
        # Inside the 24h check-in window from the start, and in the
        # future -- both the window gate and the confirmability gates
        # are honestly open.
        "scheduled_at": (
            datetime.now(UTC) + timedelta(hours=2)
        ).isoformat(),
        "duration_minutes": 60,
        "timezone": "Europe/Moscow",
        "max_participants": 10,
        "is_free": True,
        "price_cents": 0,
        "currency": "eur",
        "audience_kind": "public",
    }
    base.update(overrides)
    return base


def _valid_apply_body() -> dict:
    return {
        "profile": {
            "display_name": "GF Master",
            "email": "gfmaster@test.com",
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
        client, telegram_id=telegram_id, first_name="Student",
    )
    resp = await client.post(
        BOOKINGS_URL,
        json={"practice_id": pid},
        headers=auth_headers(user["session_token"]),
    )
    assert resp.status_code == 201
    return {**user, "booking_id": resp.json()["id"]}


async def _checkin(client: AsyncClient, pid: str, token: str):
    return await client.post(
        CHECKIN_URL.format(practice_id=pid),
        json={"mood": 4, "comment": "ready"},
        headers=auth_headers(token),
    )


async def _checkin_rows(
    session: AsyncSession, pid: str, user_id: str,
) -> int:
    session.expire_all()
    rows = (
        await session.execute(
            select(Checkin).where(
                Checkin.practice_id == uuid.UUID(pid),
                Checkin.user_id == uuid.UUID(user_id),
            )
        )
    ).scalars().all()
    return len(rows)


@pytest.mark.asyncio
async def test_narrow_to_students_after_booking_checkin_ok(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """PUBLIC -> STUDENTS after booking -> check-in created.

    NOTE: green even pre-(B) -- the CONFIRMED booking itself makes the
    holder a derived student. Kept as the done-when twin; the
    discriminating flips are the two GROUPS tests below.
    """
    master = await _make_verified_master(client, db_session, 89660)
    pid = await _scheduled_practice(client, master)
    student = await _book(client, pid, 89661)

    patch = await client.patch(
        f"{PRACTICES_URL}/{pid}",
        json={"audience_kind": "students"},
        headers=auth_headers(master["session_token"]),
    )
    assert patch.status_code == 200

    resp = await _checkin(client, pid, student["session_token"])
    assert resp.status_code in (200, 201)
    assert await _checkin_rows(db_session, pid, student["user"]["id"]) == 1


@pytest.mark.asyncio
async def test_narrow_to_groups_after_booking_checkin_ok(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """PUBLIC -> GROUPS (empty target set: nobody is a member) after
    booking -> check-in still created. THE discriminating flip: pre-(B)
    this was 403 not_in_audience."""
    master = await _make_verified_master(client, db_session, 89660)
    pid = await _scheduled_practice(client, master)
    student = await _book(client, pid, 89661)

    # groups requires a non-empty target set -- narrow onto a group the
    # booked student is NOT a member of (same discriminating flip:
    # pre-(B) this was 403 not_in_audience).
    group = await client.post(
        GROUPS_URL,
        json={"name": "Elsewhere"},
        headers=auth_headers(master["session_token"]),
    )
    assert group.status_code == 201
    patch = await client.patch(
        f"{PRACTICES_URL}/{pid}",
        json={"audience_kind": "groups", "group_ids": [group.json()["id"]]},
        headers=auth_headers(master["session_token"]),
    )
    assert patch.status_code == 200

    resp = await _checkin(client, pid, student["session_token"])
    assert resp.status_code in (200, 201)
    assert await _checkin_rows(db_session, pid, student["user"]["id"]) == 1


@pytest.mark.asyncio
async def test_removed_from_target_group_after_booking_checkin_ok(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Live 'выпадение из группы': member of the target group books,
    master removes them from the group -> check-in still created."""
    master = await _make_verified_master(client, db_session, 89660)
    m_headers = auth_headers(master["session_token"])

    group = await client.post(
        GROUPS_URL, json={"name": "Target"}, headers=m_headers,
    )
    assert group.status_code == 201
    gid = group.json()["id"]

    student = await login_user(
        client, telegram_id=89661, first_name="Student",
    )
    add = await client.post(
        f"{GROUPS_URL}/{gid}/members",
        json={"student_user_id": student["user"]["id"]},
        headers=m_headers,
    )
    assert add.status_code == 204

    pid = await _scheduled_practice(
        client, master, audience_kind="groups", group_ids=[gid],
    )
    booked = await client.post(
        BOOKINGS_URL,
        json={"practice_id": pid},
        headers=auth_headers(student["session_token"]),
    )
    assert booked.status_code == 201

    removed = await client.delete(
        f"{GROUPS_URL}/{gid}/members/{student['user']['id']}",
        headers=m_headers,
    )
    assert removed.status_code == 204

    resp = await _checkin(client, pid, student["session_token"])
    assert resp.status_code in (200, 201)
    assert await _checkin_rows(db_session, pid, student["user"]["id"]) == 1


@pytest.mark.asyncio
async def test_blocked_with_surviving_booking_checkin_403_no_row(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """blocked_at coexisting with a CONFIRMED booking -> 403
    blocked_by_master, NO Checkin row.

    State built DIRECTLY (H-R2 П-1 discipline: probe the guard, not the
    flow): the live block flow cancels future confirmed bookings, so it
    actively destroys this precondition -- see the flow twin below."""
    master = await _make_verified_master(client, db_session, 89660)
    pid = await _scheduled_practice(client, master)
    student = await _book(client, pid, 89661)

    db_session.add(
        MasterStudent(
            master_id=uuid.UUID(master["user"]["id"]),
            student_user_id=uuid.UUID(student["user"]["id"]),
            blocked_at=datetime.now(UTC),
        )
    )
    await db_session.commit()

    resp = await _checkin(client, pid, student["session_token"])
    assert resp.status_code == 403
    assert resp.json()["error"] == "blocked_by_master"
    assert await _checkin_rows(db_session, pid, student["user"]["id"]) == 0

    # The booking itself is untouched -- the block refuses the ACTION.
    db_session.expire_all()
    booking = (
        await db_session.execute(
            select(Booking).where(
                Booking.id == uuid.UUID(student["booking_id"])
            )
        )
    ).scalar_one()
    assert booking.status == BookingStatus.CONFIRMED.value


@pytest.mark.asyncio
async def test_live_block_flow_cancels_booking_checkin_404(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Flow twin: blocking via the API cancels+refunds the future
    booking, so check-in lands on booking-first NotFound -- the 403
    above is defense in depth, and this pins the interplay."""
    master = await _make_verified_master(client, db_session, 89660)
    pid = await _scheduled_practice(client, master)
    student = await _book(client, pid, 89661)

    block = await client.post(
        BLOCK_URL.format(student_id=student["user"]["id"]),
        headers=auth_headers(master["session_token"]),
    )
    assert block.status_code == 200
    assert block.json()["cancelled_bookings_count"] == 1

    resp = await _checkin(client, pid, student["session_token"])
    assert resp.status_code == 404
    assert await _checkin_rows(db_session, pid, student["user"]["id"]) == 0


@pytest.mark.asyncio
async def test_stranger_without_booking_checkin_404(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Booking-first preserved: an out-of-audience stranger with no
    booking gets NotFound (never a 403 existence oracle)."""
    master = await _make_verified_master(client, db_session, 89660)
    group = await client.post(
        GROUPS_URL,
        json={"name": "Members Only"},
        headers=auth_headers(master["session_token"]),
    )
    assert group.status_code == 201
    pid = await _scheduled_practice(
        client, master,
        audience_kind="groups", group_ids=[group.json()["id"]],
    )
    stranger = await login_user(
        client, telegram_id=89662, first_name="Stranger",
    )

    resp = await _checkin(client, pid, stranger["session_token"])
    assert resp.status_code == 404
    assert await _checkin_rows(db_session, pid, stranger["user"]["id"]) == 0


@pytest.mark.asyncio
async def test_create_booking_for_non_member_still_403(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Neighbor twin: the audience gate is fully alive for NEW
    acquisitions -- create_booking still 403s a non-member."""
    master = await _make_verified_master(client, db_session, 89660)
    group = await client.post(
        GROUPS_URL,
        json={"name": "Members Only"},
        headers=auth_headers(master["session_token"]),
    )
    assert group.status_code == 201
    pid = await _scheduled_practice(
        client, master,
        audience_kind="groups", group_ids=[group.json()["id"]],
    )
    outsider = await login_user(
        client, telegram_id=89662, first_name="Outsider",
    )

    resp = await client.post(
        BOOKINGS_URL,
        json={"practice_id": pid},
        headers=auth_headers(outsider["session_token"]),
    )
    assert resp.status_code == 403

    db_session.expire_all()
    bookings = (
        await fresh_execute(
            select(Booking).where(
                Booking.practice_id == uuid.UUID(pid),
                Booking.user_id == uuid.UUID(outsider["user"]["id"]),
            )
        )
    ).scalars().all()
    assert bookings == []
