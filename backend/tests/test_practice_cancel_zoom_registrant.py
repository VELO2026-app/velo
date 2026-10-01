# =============================================================================
# VELO -- Tests: the master's practice cancel cancels the bookings' Zoom
# registrants (BE-100)
# =============================================================================
#
# telegram_id band: 69950-69999.
#
# BAND PROVENANCE. On 2026-10-01, on 7020191,
# free_windows(space=(69700, 79299)) returned [(69950, 79299)].
#
# WHAT IS UNDER TEST
#
#   cancel_practice -> _cancel_one -> refund_all_bookings_for_practice sets
#   every PENDING / CONFIRMED booking CANCELLED. Until BE-100 it did so past
#   the registrant: the row stayed live, and our own pages kept handing its
#   link out. Now each booking goes through cancel_registrant_for_booking,
#   like cancel_booking and block_student: our row cancelled + queued in
#   the cancel's transaction, the Zoom-side cancel made by the retry poller
#   after commit.
#
#   COST: zero registrant-cancel calls inside the practice-cancel
#   transaction, asserted AT the call -- the fake Zoom cancel tries
#   `FOR UPDATE NOWAIT` on the practice from an independent connection.
#   The meeting DELETE that _cancel_one still makes inside the transaction
#   (delete_meeting_for_practice) is NOT under test here and NOT counted:
#   only update_registrant_status is watched.
#
# Rows of other files may sit queued in the same database: the phase is
# driven for this file's own rows only (_cancel_registrant_one by id).
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session_factory
from app.core.exceptions import BadRequestError
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.bookings.service import create_booking
from app.modules.masters.models import MasterProfile
from app.modules.practices.cancel_service import cancel_practice
from app.modules.practices.models import Practice, PracticeStatus, PracticeType
from app.modules.users.models import User, UserRole
from app.modules.zoom import retry_poller, zoom_client
from app.modules.zoom import service as zoom_service
from app.modules.zoom.models import (
    ZoomMeeting,
    ZoomMeetingStatus,
    ZoomRegistrant,
    ZoomRegistrantStatus,
)
from app.modules.zoom.zoom_client import ZoomAPIError
from tests.helpers import full_cleanup_range, login_user

_TID_MIN = 69950
_TID_MAX = 69999

_LOCK_NOT_AVAILABLE = "55P03"


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
    db_session: AsyncSession, master: User, *, meeting_status: str | None,
    hours_ahead: int = 3,
) -> Practice:
    """A bookable future practice; meeting_status None -> no ZoomMeeting."""
    practice = Practice(
        master_id=master.id,
        title="Practice cancel registrants",
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
                zoom_meeting_id=f"be100-{practice.id.hex[:16]}",
                zoom_meeting_uuid=f"uuid-be100-{practice.id}",
                status=meeting_status,
            )
        )
        await db_session.flush()
    return practice


async def _meeting_of(db_session: AsyncSession, practice: Practice) -> ZoomMeeting:
    return (
        await db_session.execute(
            select(ZoomMeeting).where(ZoomMeeting.practice_id == practice.id)
        )
    ).scalar_one()


async def _registrant_of(
    db_session: AsyncSession, booking_id: UUID,
) -> ZoomRegistrant | None:
    return (
        await db_session.execute(
            select(ZoomRegistrant).where(ZoomRegistrant.booking_id == booking_id)
        )
    ).scalar_one_or_none()


async def _practice_is_lockable(practice_id: UUID) -> bool:
    """From an independent connection: can the practice row be taken FOR
    UPDATE right now? False when another transaction holds it."""
    async with get_session_factory()() as probe:
        try:
            await probe.execute(
                text("SELECT id FROM practices WHERE id = :id FOR UPDATE NOWAIT"),
                {"id": practice_id},
            )
            return True
        except DBAPIError as exc:
            orig = getattr(exc, "orig", None)
            state = getattr(orig, "sqlstate", None) or getattr(
                getattr(orig, "__cause__", None), "sqlstate", None,
            )
            assert state == _LOCK_NOT_AVAILABLE, exc
            return False
        finally:
            await probe.rollback()


def _watch_registrant_cancel(
    monkeypatch: pytest.MonkeyPatch, practice_id: UUID,
    *, answer: BaseException | None = None,
) -> list[tuple[str, bool]]:
    """Fake Zoom REGISTRANT cancel, patched everywhere it could be made
    from (client module, poller, and zoom.service should it ever move back
    there). Records (zoom_registrant_id, practice lockable at the call);
    raises `answer` if given. delete_meeting is not touched."""
    seen: list[tuple[str, bool]] = []

    async def fake(
        *, zoom_meeting_id: str, zoom_registrant_id: str, email: str, action: str,
    ) -> None:
        assert action == "cancel"
        seen.append((zoom_registrant_id, await _practice_is_lockable(practice_id)))
        if answer is not None:
            raise answer

    monkeypatch.setattr(zoom_client, "update_registrant_status", fake)
    monkeypatch.setattr(retry_poller, "update_registrant_status", fake)
    monkeypatch.setattr(zoom_service, "update_registrant_status", fake, raising=False)
    return seen


async def _practice_with_two_registrants(
    client: AsyncClient, db_session: AsyncSession, tid: int, *, hours_ahead: int = 3,
) -> tuple[User, Practice, Booking, Booking]:
    """Master + practice + two booked students: one registrant still
    pending (booked while the meeting was not active), one registered
    (booked after it became active)."""
    master = await _user(client, db_session, tid, master=True)
    early = await _user(client, db_session, tid + 1)
    late = await _user(client, db_session, tid + 2)
    practice = await _practice(
        db_session, master,
        meeting_status=ZoomMeetingStatus.PENDING_CREATION.value,
        hours_ahead=hours_ahead,
    )
    b_pending = await create_booking(early, practice.id, session=db_session)
    meeting = await _meeting_of(db_session, practice)
    meeting.status = ZoomMeetingStatus.ACTIVE.value
    await db_session.flush()
    b_registered = await create_booking(late, practice.id, session=db_session)
    await db_session.flush()
    return master, practice, b_pending, b_registered


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_practice_cancel_cancels_every_registrant_and_queues_zoom(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Both registrants of the cancelled practice go cancelled + queued in
    the cancel's transaction; no registrant-cancel call is made inside it;
    the poller's call comes after commit, with the practice free, exactly
    once (the pending row has no Zoom id -- cleared without a call). Pair:
    a registrant on the same master's OTHER practice stays live and
    unqueued."""
    master, practice, b_pending, b_registered = await _practice_with_two_registrants(
        client, db_session, 69950,
    )
    other = await _practice(
        db_session, master, meeting_status=ZoomMeetingStatus.ACTIVE.value,
        hours_ahead=9,
    )
    bystander = await _user(client, db_session, 69953)
    b_other = await create_booking(bystander, other.id, session=db_session)
    await db_session.commit()

    r_pending = await _registrant_of(db_session, b_pending.id)
    r_registered = await _registrant_of(db_session, b_registered.id)
    r_other = await _registrant_of(db_session, b_other.id)
    assert r_pending.status == ZoomRegistrantStatus.PENDING.value
    assert r_registered.status == ZoomRegistrantStatus.REGISTERED.value
    zoom_id = r_registered.zoom_registrant_id
    assert zoom_id

    seen = _watch_registrant_cancel(monkeypatch, practice.id)
    await cancel_practice(practice.id, master, db_session)
    await db_session.flush()
    assert seen == []  # no registrant cancel inside the practice cancel

    for row in (r_pending, r_registered, r_other):
        await db_session.refresh(row)
    assert r_pending.status == ZoomRegistrantStatus.CANCELLED.value
    assert r_registered.status == ZoomRegistrantStatus.CANCELLED.value
    assert r_pending.zoom_cancel_pending is True
    assert r_registered.zoom_cancel_pending is True
    assert r_other.status == ZoomRegistrantStatus.REGISTERED.value
    assert r_other.zoom_cancel_pending is False

    ids = [r_pending.id, r_registered.id]
    await db_session.commit()
    for registrant_id in ids:
        assert await retry_poller._cancel_registrant_one(registrant_id) is True

    assert seen == [(zoom_id, True)]
    for row in (r_pending, r_registered, r_other):
        await db_session.refresh(row)
    assert r_pending.zoom_cancel_pending is False
    assert r_registered.zoom_cancel_pending is False
    assert r_other.zoom_cancel_pending is False
    for booking in (b_pending, b_registered):
        await db_session.refresh(booking)
        assert booking.status == BookingStatus.CANCELLED.value
        assert booking.cancellation_reason == "Practice cancelled by master"


@pytest.mark.asyncio
async def test_practice_cancelled_twice_queues_nothing_the_second_time(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """REPEAT axis: the second cancel is refused on the practice status
    (BadRequestError) and queues nothing -- after the first cancel's queue
    was worked off, no row is pending again."""
    master, practice, b_pending, b_registered = await _practice_with_two_registrants(
        client, db_session, 69955,
    )
    await db_session.commit()
    seen = _watch_registrant_cancel(monkeypatch, practice.id)

    await cancel_practice(practice.id, master, db_session)
    await db_session.commit()
    rows = [
        await _registrant_of(db_session, b_pending.id),
        await _registrant_of(db_session, b_registered.id),
    ]
    for row in rows:
        assert await retry_poller._cancel_registrant_one(row.id) is True
    calls_after_first = list(seen)
    assert len(calls_after_first) == 1

    with pytest.raises(BadRequestError):
        await cancel_practice(practice.id, master, db_session)
    await db_session.rollback()

    for row in rows:
        await db_session.refresh(row)
        assert row.status == ZoomRegistrantStatus.CANCELLED.value
        assert row.zoom_cancel_pending is False
    assert seen == calls_after_first


@pytest.mark.asyncio
async def test_empty_practices_cancel_with_nothing_queued(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """EMPTINESS axis: a practice without bookings, and a practice without
    a ZoomMeeting (so its bookings have no registrant) -- both cancel, their
    bookings cancel, nothing is queued and no Zoom call is made. Pair: a
    registrant on a third practice of the same master stays live."""
    master = await _user(client, db_session, 69960, master=True)
    student = await _user(client, db_session, 69961)
    no_bookings = await _practice(
        db_session, master, meeting_status=ZoomMeetingStatus.ACTIVE.value,
        hours_ahead=3,
    )
    no_meeting = await _practice(db_session, master, meeting_status=None, hours_ahead=4)
    live = await _practice(
        db_session, master, meeting_status=ZoomMeetingStatus.ACTIVE.value,
        hours_ahead=5,
    )
    b_no_meeting = await create_booking(student, no_meeting.id, session=db_session)
    b_live = await create_booking(student, live.id, session=db_session)
    await db_session.commit()
    assert await _registrant_of(db_session, b_no_meeting.id) is None
    r_live = await _registrant_of(db_session, b_live.id)

    seen = _watch_registrant_cancel(monkeypatch, no_bookings.id)
    await cancel_practice(no_bookings.id, master, db_session)
    await cancel_practice(no_meeting.id, master, db_session)
    await db_session.commit()

    await db_session.refresh(b_no_meeting)
    await db_session.refresh(r_live)
    assert b_no_meeting.status == BookingStatus.CANCELLED.value
    assert await _registrant_of(db_session, b_no_meeting.id) is None
    assert r_live.status == ZoomRegistrantStatus.REGISTERED.value
    assert r_live.zoom_cancel_pending is False
    assert seen == []


@pytest.mark.asyncio
async def test_zoom_refusal_keeps_the_row_queued_and_counted(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """SHORTAGE axis: Zoom refuses the registrant cancel in the phase ->
    our row stays cancelled, still queued, attempts 1. Pair: the master's
    other practice is not touched."""
    master, practice, _b_pending, b_registered = await _practice_with_two_registrants(
        client, db_session, 69965,
    )
    other = await _practice(
        db_session, master, meeting_status=ZoomMeetingStatus.ACTIVE.value,
        hours_ahead=9,
    )
    bystander = await _user(client, db_session, 69968)
    b_other = await create_booking(bystander, other.id, session=db_session)
    await db_session.commit()

    seen = _watch_registrant_cancel(
        monkeypatch, practice.id,
        answer=ZoomAPIError("stub refusal", status_code=500, body="down"),
    )
    await cancel_practice(practice.id, master, db_session)
    await db_session.commit()
    row = await _registrant_of(db_session, b_registered.id)
    assert await retry_poller._cancel_registrant_one(row.id) is True

    await db_session.refresh(row)
    r_other = await _registrant_of(db_session, b_other.id)
    stored_other = await db_session.get(Practice, other.id)
    assert len(seen) == 1
    assert row.status == ZoomRegistrantStatus.CANCELLED.value
    assert row.zoom_cancel_pending is True
    assert row.zoom_cancel_attempts == 1
    assert r_other.status == ZoomRegistrantStatus.REGISTERED.value
    assert r_other.zoom_cancel_pending is False
    assert stored_other.status == PracticeStatus.SCHEDULED.value
