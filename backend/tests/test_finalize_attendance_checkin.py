# =============================================================================
# VELO Backend -- Tests: Finalize attendance by PRE check-in (W-1, variant 1)
# =============================================================================
#
# W-1: joined_at is set only via the Zoom "join" flow. While Zoom is disabled
# joined_at stays null, which would send every confirmed booking to no_show on
# finalize and block feedback / named reviews (E1). Variant 1 makes a PRE
# check-in an alternative proof of presence:
#
#   confirmed + (joined_at IS NOT NULL OR has PRE check-in) -> attended
#   confirmed + neither                                     -> no_show
#
# The rule lives in _finalize_practice_core, reached via the system auto-close
# path (auto_finalize_practice) run by the lifecycle worker -- covered here.
#
# These tests drive the service layer directly inside one uncommitted
# transaction: domain rows are flushed (not committed) and asserted in-session,
# so cleanup only has to drop the users created via the auth API.
#
# telegram_id range: 95000-95999.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import BadRequestError
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.bookings.service import (
    auto_finalize_practice,
    auto_start_practice,
)
from app.core.events.models import OutboxEvent
from app.modules.diary.models import Checkin, CheckType
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import (
    Practice,
    PracticeStatus,
    PracticeType,
)
from app.modules.users.models import User, UserRole
from tests.helpers import login_user

_TID_MIN = 95000
_TID_MAX = 95999


# ===================================================================
# Cleanup -- only users are committed (by the auth API); the rest is
# flushed-not-committed and disappears on rollback.
# ===================================================================


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await _do_cleanup(db_session)
    yield
    await _do_cleanup(db_session)


async def _do_cleanup(session: AsyncSession) -> None:
    await session.rollback()
    subq = select(User.id).where(User.telegram_id.between(_TID_MIN, _TID_MAX))
    await session.execute(
        MasterProfile.__table__.delete().where(MasterProfile.user_id.in_(subq))
    )
    from app.core.audit import AuditLog
    await session.execute(
        AuditLog.__table__.delete().where(AuditLog.actor_id.in_(subq))
    )
    await session.execute(
        User.__table__.delete().where(
            User.telegram_id.between(_TID_MIN, _TID_MAX)
        )
    )
    await session.commit()


# ===================================================================
# Helpers
# ===================================================================


async def _make_master(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int,
) -> str:
    auth = await login_user(client, telegram_id=telegram_id, first_name="Master")
    user_id = auth["user"]["id"]
    user = await db_session.get(User, user_id)
    user.role = UserRole.MASTER
    await db_session.flush()
    db_session.add(
        MasterProfile(
            user_id=user_id,
            data={
                "account": {"status": "verified"},
                "profile": {"display_name": "Master"},
            },
        )
    )
    await db_session.flush()
    # Return the UUID (not the JSON string): practice.master_id is a UUID
    # column, so passing the JSON-serialised id would create a str-vs-UUID
    # mismatch when the practice row is created / compared.
    return user.id


async def _create_practice(
    db_session: AsyncSession,
    master_id: str,
    *,
    status: str = PracticeStatus.SCHEDULED.value,
    scheduled_at: datetime | None = None,
    duration_minutes: int = 60,
) -> Practice:
    # Default: started 2h ago (already ended) -- the finalize tests need a
    # practice whose window is in the past. Auto-start tests pass an explicit
    # scheduled_at to place the practice mid-window or in the future.
    practice = Practice(
        master_id=master_id,
        title="W1 Practice",
        description="x",
        practice_type=PracticeType.LIVE.value,
        status=status,
        scheduled_at=(
            scheduled_at
            if scheduled_at is not None
            else datetime.now(UTC) - timedelta(hours=2)
        ),
        duration_minutes=duration_minutes,
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
    return practice


async def _confirmed_booking(
    client: AsyncClient,
    db_session: AsyncSession,
    practice: Practice,
    telegram_id: int,
    *,
    joined: bool = False,
) -> Booking:
    auth = await login_user(
        client, telegram_id=telegram_id, first_name=f"U{telegram_id}",
    )
    booking = Booking(
        practice_id=practice.id,
        user_id=auth["user"]["id"],
        status=BookingStatus.CONFIRMED.value,
        joined_at=(datetime.now(UTC) - timedelta(hours=1)) if joined else None,
    )
    db_session.add(booking)
    await db_session.flush()
    return booking


async def _add_pre_checkin(
    db_session: AsyncSession, practice: Practice, booking: Booking,
) -> None:
    db_session.add(
        Checkin(
            practice_id=practice.id,
            user_id=booking.user_id,
            booking_id=booking.id,
            mood=8,
            check_type=CheckType.PRE.value,
        )
    )
    await db_session.flush()


# ===================================================================
# System path -- auto_finalize_practice
# ===================================================================


@pytest.mark.asyncio
async def test_autofinalize_attendance_by_checkin_or_join(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Auto-close: PRE check-in OR Zoom join -> attended; neither -> no_show."""
    master_id = await _make_master(client, db_session, 95800)
    practice = await _create_practice(db_session, master_id)

    # A: PRE check-in, no joined_at -> attended (the W-1 case).
    b_checkin = await _confirmed_booking(client, db_session, practice, 95001)
    await _add_pre_checkin(db_session, practice, b_checkin)
    # B: joined via Zoom, no check-in -> attended (unchanged behavior).
    b_joined = await _confirmed_booking(
        client, db_session, practice, 95002, joined=True,
    )
    # C: neither -> no_show.
    b_absent = await _confirmed_booking(client, db_session, practice, 95003)

    await auto_finalize_practice(practice.id, db_session)
    await db_session.flush()

    await db_session.refresh(b_checkin)
    await db_session.refresh(b_joined)
    await db_session.refresh(b_absent)
    await db_session.refresh(practice)

    assert b_checkin.status == BookingStatus.ATTENDED.value
    assert b_joined.status == BookingStatus.ATTENDED.value
    assert b_absent.status == BookingStatus.NO_SHOW.value
    assert practice.status == PracticeStatus.COMPLETED.value


# ===================================================================
# System path -- auto_start_practice (scheduled -> live)
# ===================================================================


@pytest.mark.asyncio
async def test_autostart_moves_scheduled_to_live(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A scheduled practice whose start has passed (end still ahead) -> live."""
    master_id = await _make_master(client, db_session, 95820)
    # Started 10 min ago, 60-min duration -> running now (end in the future).
    practice = await _create_practice(
        db_session, master_id,
        scheduled_at=datetime.now(UTC) - timedelta(minutes=10),
        duration_minutes=60,
    )
    assert practice.status == PracticeStatus.SCHEDULED.value

    await auto_start_practice(practice.id, db_session)
    await db_session.flush()
    await db_session.refresh(practice)

    assert practice.status == PracticeStatus.LIVE.value


@pytest.mark.asyncio
async def test_autostart_rejects_future_practice(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """auto_start_practice must not start a practice whose start is still ahead."""
    master_id = await _make_master(client, db_session, 95830)
    practice = await _create_practice(
        db_session, master_id,
        scheduled_at=datetime.now(UTC) + timedelta(minutes=30),
        duration_minutes=60,
    )

    with pytest.raises(BadRequestError):
        await auto_start_practice(practice.id, db_session)

    # Status unchanged -- the guard fires before any mutation.
    await db_session.refresh(practice)
    assert practice.status == PracticeStatus.SCHEDULED.value


@pytest.mark.asyncio
async def test_autostart_rejects_non_scheduled_practice(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """auto_start_practice only acts on scheduled practices (race guard).

    If a concurrent tick or cancel already moved the practice, the function
    raises instead of forcing it back to live.
    """
    master_id = await _make_master(client, db_session, 95835)
    practice = await _create_practice(
        db_session, master_id,
        status=PracticeStatus.LIVE.value,
        scheduled_at=datetime.now(UTC) - timedelta(minutes=10),
        duration_minutes=60,
    )

    with pytest.raises(BadRequestError):
        await auto_start_practice(practice.id, db_session)


# ===================================================================
# Worker claim phases -- FINISH before START (no flicker through live)
# ===================================================================


@pytest.mark.asyncio
async def test_claim_phases_split_running_vs_ended(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Running practice is claimed by START; an already-ended one by FINISH.

    This is what keeps a fully-past practice (start AND end in the past) from
    flickering through live: it is excluded from the START claim and picked up
    by FINISH instead, going straight to completed.

    The claim queries open their own sessions (get_session_factory), so the rows
    must be COMMITTED to be visible. The autouse cleanup deletes them afterwards
    (master delete cascades to practices).
    """
    from app.modules.bookings.autofinalize import (
        _claim_overdue_ids,
        _claim_startable_ids,
    )

    master_id = await _make_master(client, db_session, 95840)
    # Start + end both in the past -> ended.
    ended = await _create_practice(
        db_session, master_id,
        scheduled_at=datetime.now(UTC) - timedelta(hours=2),
        duration_minutes=60,
    )
    # Start in the past, end in the future -> genuinely running.
    running = await _create_practice(
        db_session, master_id,
        scheduled_at=datetime.now(UTC) - timedelta(minutes=10),
        duration_minutes=60,
    )
    await db_session.commit()

    startable = await _claim_startable_ids()
    overdue = await _claim_overdue_ids()

    # Running -> START (will go live); ended -> NOT START (no live flicker).
    assert running.id in startable
    assert ended.id not in startable
    # Ended -> FINISH (straight to completed); running -> not overdue yet.
    assert ended.id in overdue
    assert running.id not in overdue


# ===================================================================
# Feedback nudge on auto-finalize (moved here from the removed
# finalize-endpoint tests in test_attendance.py)
# ===================================================================


async def _feedback_notifs(session: AsyncSession, practice_id) -> list:
    """prompt.leave_feedback requests queued in the outbox for this
    practice (T1: the old engine's practice-targeted LEAVE_FEEDBACK is
    now one delayed prompt PER ATTENDEE via the comms reminder
    mechanic -- see _finalize_practice_core)."""
    result = await session.execute(
        select(OutboxEvent).where(
            OutboxEvent.event_type == "notification_request",
            OutboxEvent.payload["type"].astext
            == "prompt.leave_feedback",
            OutboxEvent.payload["action_data"]["practice_id"].astext
            == str(practice_id),
        )
    )
    return list(result.scalars().all())


@pytest.mark.asyncio
async def test_autofinalize_enqueues_feedback_when_attended(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Auto-finalize with >=1 attendee enqueues exactly one LEAVE_FEEDBACK
    targeting the practice (the processor later resolves the audience)."""
    master_id = await _make_master(client, db_session, 95850)
    practice = await _create_practice(db_session, master_id)  # ended (default)

    b = await _confirmed_booking(
        client, db_session, practice, 95051, joined=True,
    )
    await auto_finalize_practice(practice.id, db_session)
    await db_session.flush()

    await db_session.refresh(b)
    assert b.status == BookingStatus.ATTENDED.value
    notifs = await _feedback_notifs(db_session, practice.id)
    assert len(notifs) == 1
    # T1: velo expands the audience (ID-4) -- the prompt targets the
    # ATTENDEE, and rides the reminder mechanic (future scheduled_at).
    assert notifs[0].payload["target_type"] == "user"
    assert notifs[0].payload["target_value"] == str(b.user_id)
    assert notifs[0].payload["scheduled_at"]


@pytest.mark.asyncio
async def test_autofinalize_no_feedback_when_no_attendees(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Nobody attended (booked but never joined and no PRE check-in -> no_show)
    -> no LEAVE_FEEDBACK notification (the attended_count > 0 guard)."""
    master_id = await _make_master(client, db_session, 95860)
    practice = await _create_practice(db_session, master_id)
    await _confirmed_booking(client, db_session, practice, 95061)

    await auto_finalize_practice(practice.id, db_session)
    await db_session.flush()

    notifs = await _feedback_notifs(db_session, practice.id)
    assert len(notifs) == 0
