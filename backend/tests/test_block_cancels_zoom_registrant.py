# =============================================================================
# VELO -- Tests: blocking a student cancels the Zoom registrants of the
# bookings the block cancels (BE-71)
# =============================================================================
#
# telegram_id band: 69700-69749.
#
# BAND PROVENANCE. free_windows(space=(60000, 99999)) on 2026-10-01 returned
# (69700, 79299) among its windows; 69700-69749 is also outside every
# BLIND_ZONE cleanup range (checked the same day).
#
# WHAT IS UNDER TEST
#
#   block_student cancels + refunds the student's FUTURE CONFIRMED bookings
#   on this master's practices. Until BE-71 it did so past the registrant:
#   the row stayed non-cancelled with a live join_url and a booking_id on a
#   dead booking. Now every such booking's registrant goes through the same
#   cancel_registrant_for_booking cancel_booking uses -- our row cancelled
#   whatever Zoom answers, a Zoom failure never failing the block.
#
# THE GRID, as reachable through the real services:
#   registrant: none (practice without ZoomMeeting) / pending (meeting not
#               active) / registered / create_failed (Zoom refused create)
#   Zoom cancel call: success / ZoomAPIError / not made (no registrant id)
#   bookings under the block: 0 / 1 / several, on different practices
#
# A registrant already `cancelled` under a still-CONFIRMED booking is not
# built here: no service produces it (the cancel only runs on cancellation).
#
# Every "cancelled" assertion has its pair: the other master's registrant,
# or the booking itself, stays as it was / is cancelled too.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.bookings.models import Booking, BookingStatus
from app.modules.bookings.service import create_booking
from app.modules.masters.groups_service import block_student
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice, PracticeStatus, PracticeType
from app.modules.users.models import User, UserRole
from app.modules.zoom import service as zoom_service
from app.modules.zoom.models import (
    ZoomMeeting,
    ZoomMeetingStatus,
    ZoomRegistrant,
    ZoomRegistrantStatus,
)
from app.modules.zoom.zoom_client import ZoomAPIError
from tests.helpers import full_cleanup_range, login_user

_TID_MIN = 69700
_TID_MAX = 69749


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _user(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int, *,
    master: bool = False,
) -> User:
    auth = await login_user(
        client, telegram_id=telegram_id, first_name=f"U{telegram_id}",
    )
    user = await db_session.get(User, UUID(auth["user"]["id"]))
    if master:
        user.role = UserRole.MASTER.value
        db_session.add(
            MasterProfile(
                user_id=user.id,
                data={
                    "account": {"status": "verified"},
                    "profile": {"display_name": "Master"},
                },
            )
        )
    await db_session.flush()
    return user


async def _practice(
    db_session: AsyncSession, master: User, *,
    meeting_status: str | None, hours_ahead: int = 3,
) -> Practice:
    """A bookable future practice. meeting_status None -> no ZoomMeeting row
    at all; otherwise a meeting in that status (ACTIVE -> booking registers
    the student with stub Zoom; not active -> the registrant stays pending)."""
    practice = Practice(
        master_id=master.id,
        title="Block cancels registrant",
        description="x",
        practice_type=PracticeType.LIVE.value,
        status=PracticeStatus.SCHEDULED.value,
        scheduled_at=datetime.now(UTC) + timedelta(hours=hours_ahead),
        duration_minutes=60,
        timezone="UTC",
        max_participants=10,
        current_participants=0,
        is_free=True,
        price_cents=0,
        currency="eur",
        data={},
    )
    db_session.add(practice)
    await db_session.flush()
    if meeting_status is not None:
        db_session.add(
            ZoomMeeting(
                practice_id=practice.id,
                zoom_meeting_id=str(700000000 + hours_ahead),
                zoom_meeting_uuid=f"uuid-be71-{practice.id}",
                status=meeting_status,
            )
        )
        await db_session.flush()
    return practice


async def _registrant_of(
    db_session: AsyncSession, booking: Booking,
) -> ZoomRegistrant | None:
    return (
        await db_session.execute(
            select(ZoomRegistrant).where(ZoomRegistrant.booking_id == booking.id)
        )
    ).scalar_one_or_none()


def _count_cancel_calls(
    monkeypatch: pytest.MonkeyPatch, *, fail_for: set[str] | None = None,
) -> list[str]:
    """Replace the Zoom-side cancel as the service sees it; returns the
    zoom_registrant_ids it was called with. fail_for: ids answered with
    ZoomAPIError instead."""
    calls: list[str] = []

    async def fake(
        *, zoom_meeting_id: str, zoom_registrant_id: str, email: str, action: str,
    ) -> None:
        assert action == "cancel"
        calls.append(zoom_registrant_id)
        if fail_for and zoom_registrant_id in fail_for:
            raise ZoomAPIError("stub refusal", status_code=500, body="x")

    monkeypatch.setattr(zoom_service, "update_registrant_status", fake)
    return calls


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_block_cancels_registrant_of_every_cancelled_booking(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Several bookings on different practices, one per registrant state:
    registered (one Zoom call), pending (no Zoom id -> no call), and a
    practice without a meeting (no row -> no-op). Every booking cancelled,
    every registrant cancelled, exactly one Zoom call."""
    master = await _user(client, db_session, 69700, master=True)
    student = await _user(client, db_session, 69701)
    registered_p = await _practice(
        db_session, master, meeting_status=ZoomMeetingStatus.ACTIVE.value,
        hours_ahead=3,
    )
    pending_p = await _practice(
        db_session, master,
        meeting_status=ZoomMeetingStatus.PENDING_CREATION.value, hours_ahead=4,
    )
    no_meeting_p = await _practice(
        db_session, master, meeting_status=None, hours_ahead=5,
    )
    b_registered = await create_booking(student, registered_p.id, session=db_session)
    b_pending = await create_booking(student, pending_p.id, session=db_session)
    b_no_meeting = await create_booking(student, no_meeting_p.id, session=db_session)
    await db_session.flush()

    r_registered = await _registrant_of(db_session, b_registered)
    r_pending = await _registrant_of(db_session, b_pending)
    assert r_registered.status == ZoomRegistrantStatus.REGISTERED.value
    assert r_registered.zoom_registrant_id
    assert r_pending.status == ZoomRegistrantStatus.PENDING.value
    assert r_pending.zoom_registrant_id is None
    assert await _registrant_of(db_session, b_no_meeting) is None

    calls = _count_cancel_calls(monkeypatch)
    result = await block_student(master.id, student.id, db_session)
    await db_session.flush()

    assert result["cancelled_bookings_count"] == 3
    for booking in (b_registered, b_pending, b_no_meeting):
        await db_session.refresh(booking)
        assert booking.status == BookingStatus.CANCELLED.value
    await db_session.refresh(r_registered)
    await db_session.refresh(r_pending)
    assert r_registered.status == ZoomRegistrantStatus.CANCELLED.value
    assert r_pending.status == ZoomRegistrantStatus.CANCELLED.value
    assert calls == [r_registered.zoom_registrant_id]


@pytest.mark.asyncio
async def test_zoom_refusal_still_cancels_ours_and_the_block_goes_through(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """SHORTAGE axis: Zoom answers one of two cancels with ZoomAPIError. Both of
    our rows are cancelled, both bookings cancelled, the block committed
    its blocked_at -- the failure is logged, never raised."""
    master = await _user(client, db_session, 69702, master=True)
    student = await _user(client, db_session, 69703)
    p1 = await _practice(
        db_session, master, meeting_status=ZoomMeetingStatus.ACTIVE.value,
        hours_ahead=3,
    )
    p2 = await _practice(
        db_session, master, meeting_status=ZoomMeetingStatus.ACTIVE.value,
        hours_ahead=6,
    )
    b1 = await create_booking(student, p1.id, session=db_session)
    b2 = await create_booking(student, p2.id, session=db_session)
    await db_session.flush()
    r1 = await _registrant_of(db_session, b1)
    r2 = await _registrant_of(db_session, b2)

    calls = _count_cancel_calls(monkeypatch, fail_for={r1.zoom_registrant_id})
    result = await block_student(master.id, student.id, db_session)
    await db_session.flush()

    assert result["blocked_at"] is not None
    assert result["cancelled_bookings_count"] == 2
    assert sorted(calls) == sorted([r1.zoom_registrant_id, r2.zoom_registrant_id])
    for booking, registrant in ((b1, r1), (b2, r2)):
        await db_session.refresh(booking)
        await db_session.refresh(registrant)
        assert booking.status == BookingStatus.CANCELLED.value
        assert registrant.status == ZoomRegistrantStatus.CANCELLED.value


@pytest.mark.asyncio
async def test_create_failed_registrant_is_cancelled_without_a_zoom_call(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Zoom refused the create at booking time -> create_failed, no Zoom id.
    The block cancels our row and makes no Zoom call for it."""
    master = await _user(client, db_session, 69704, master=True)
    student = await _user(client, db_session, 69705)
    practice = await _practice(
        db_session, master, meeting_status=ZoomMeetingStatus.ACTIVE.value,
    )

    async def refuse_create(**_: object) -> dict:
        raise ZoomAPIError("stub refusal", status_code=500, body="x")

    monkeypatch.setattr(zoom_service, "create_registrant", refuse_create)
    booking = await create_booking(student, practice.id, session=db_session)
    await db_session.flush()
    registrant = await _registrant_of(db_session, booking)
    assert registrant.status == ZoomRegistrantStatus.CREATE_FAILED.value
    assert registrant.zoom_registrant_id is None

    calls = _count_cancel_calls(monkeypatch)
    await block_student(master.id, student.id, db_session)
    await db_session.flush()
    await db_session.refresh(booking)
    await db_session.refresh(registrant)

    assert booking.status == BookingStatus.CANCELLED.value
    assert registrant.status == ZoomRegistrantStatus.CANCELLED.value
    assert calls == []


@pytest.mark.asyncio
async def test_block_twice_makes_no_second_zoom_call(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """REPEAT axis: the second block finds no CONFIRMED booking, calls Zoom zero
    times, and the registrant the first block cancelled stays cancelled."""
    master = await _user(client, db_session, 69706, master=True)
    student = await _user(client, db_session, 69707)
    practice = await _practice(
        db_session, master, meeting_status=ZoomMeetingStatus.ACTIVE.value,
    )
    booking = await create_booking(student, practice.id, session=db_session)
    await db_session.flush()
    registrant = await _registrant_of(db_session, booking)

    calls = _count_cancel_calls(monkeypatch)
    await block_student(master.id, student.id, db_session)
    await db_session.flush()
    assert calls == [registrant.zoom_registrant_id]

    second = await block_student(master.id, student.id, db_session)
    await db_session.flush()
    await db_session.refresh(registrant)

    assert second["cancelled_bookings_count"] == 0
    assert calls == [registrant.zoom_registrant_id]
    assert registrant.status == ZoomRegistrantStatus.CANCELLED.value


@pytest.mark.asyncio
async def test_no_future_bookings_block_passes_with_no_zoom_call(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """EMPTINESS axis: nothing to cancel -> zero Zoom calls, and the block itself
    still happened (blocked_at set). Pair: another student of the same
    master, not blocked, keeps a live registrant."""
    master = await _user(client, db_session, 69708, master=True)
    blocked = await _user(client, db_session, 69709)
    bystander = await _user(client, db_session, 69710)
    practice = await _practice(
        db_session, master, meeting_status=ZoomMeetingStatus.ACTIVE.value,
    )
    bystander_booking = await create_booking(bystander, practice.id, session=db_session)
    await db_session.flush()
    bystander_registrant = await _registrant_of(db_session, bystander_booking)

    calls = _count_cancel_calls(monkeypatch)
    result = await block_student(master.id, blocked.id, db_session)
    await db_session.flush()
    await db_session.refresh(bystander_registrant)
    await db_session.refresh(bystander_booking)

    assert result["blocked_at"] is not None
    assert result["cancelled_bookings_count"] == 0
    assert calls == []
    assert bystander_booking.status == BookingStatus.CONFIRMED.value
    assert bystander_registrant.status == ZoomRegistrantStatus.REGISTERED.value


@pytest.mark.asyncio
async def test_other_masters_registrant_is_not_touched(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The cancel is scoped like the booking cancel: by THIS master. The
    same student's registrant on another master's practice stays live, and
    only this master's registrant reaches Zoom."""
    master = await _user(client, db_session, 69711, master=True)
    other_master = await _user(client, db_session, 69712, master=True)
    student = await _user(client, db_session, 69713)
    mine = await _practice(
        db_session, master, meeting_status=ZoomMeetingStatus.ACTIVE.value,
        hours_ahead=3,
    )
    theirs = await _practice(
        db_session, other_master, meeting_status=ZoomMeetingStatus.ACTIVE.value,
        hours_ahead=7,
    )
    b_mine = await create_booking(student, mine.id, session=db_session)
    b_theirs = await create_booking(student, theirs.id, session=db_session)
    await db_session.flush()
    r_mine = await _registrant_of(db_session, b_mine)
    r_theirs = await _registrant_of(db_session, b_theirs)

    calls = _count_cancel_calls(monkeypatch)
    await block_student(master.id, student.id, db_session)
    await db_session.flush()
    await db_session.refresh(r_mine)
    await db_session.refresh(r_theirs)
    await db_session.refresh(b_theirs)

    assert r_mine.status == ZoomRegistrantStatus.CANCELLED.value
    assert r_theirs.status == ZoomRegistrantStatus.REGISTERED.value
    assert b_theirs.status == BookingStatus.CONFIRMED.value
    assert calls == [r_mine.zoom_registrant_id]
