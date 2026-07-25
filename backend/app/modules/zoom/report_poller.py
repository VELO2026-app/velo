# =============================================================================
# VELO Backend -- Zoom Report Poller (E21 step F, ПРОМТ №521)
# =============================================================================
#
# Background asyncio.Task, same shape as run_autofinalizer
# (bookings/autofinalize.py): runs inside FastAPI lifespan, per-practice
# isolated try/except so one meeting's failure never stops the others,
# exponential backoff on empty polls.
#
# WHAT IT DOES, per candidate practice (COMPLETED, has an ACTIVE Zoom
# meeting, report_ingested_at still NULL, has at least one CONFIRMED
# booking left to decide, and scheduled end + ripen margin has passed):
#   - Past the deadline (settings.zoom_attendance_decision_deadline_minutes)
#     with no successful ingest yet: apply the legacy-proxy fallback THE
#     BOUND that stops a booking sitting undecided forever.
#   - Otherwise: try to ingest the report. Success sets report_ingested_at
#     (this practice is never polled again); failure leaves it NULL for the
#     next cycle (or, eventually, the deadline above).
#
# SESSION / ISOLATION: each practice is processed in its OWN
# session/transaction, claimed with FOR UPDATE SKIP LOCKED, mirroring every
# other worker in this codebase.
# =============================================================================

import asyncio
from datetime import UTC, datetime, timedelta

import structlog
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_session_factory
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.practices.models import Practice, PracticeStatus
from app.modules.zoom.attendance_service import (
    apply_legacy_proxy_fallback,
    ingest_report_for_meeting,
)
from app.modules.zoom.models import ZoomMeeting, ZoomMeetingStatus

logger = structlog.get_logger()


# ===================================================================
# Main loop
# ===================================================================


async def run_zoom_report_poller() -> None:
    """Main report-poller loop. Runs until cancelled.

    Called from FastAPI lifespan as a background task. Catches all
    exceptions to prevent the loop from dying.
    """
    base_interval = settings.zoom_report_poll_interval_seconds
    max_backoff = settings.zoom_report_max_backoff_seconds
    interval = base_interval

    logger.info(
        "zoom_report_poller_started",
        poll_interval=base_interval,
        max_backoff=max_backoff,
        ripen_margin_minutes=settings.zoom_report_ripen_margin_minutes,
        deadline_minutes=settings.zoom_attendance_decision_deadline_minutes,
    )

    while True:
        try:
            work_done = await _poll_cycle()

            if work_done:
                interval = base_interval
            else:
                interval = min(interval * 2, max_backoff)

        except asyncio.CancelledError:
            logger.info("zoom_report_poller_stopped")
            return
        except Exception:
            logger.exception("zoom_report_poller_error")
            interval = max_backoff

        try:
            await asyncio.sleep(interval)
        except asyncio.CancelledError:
            logger.info("zoom_report_poller_stopped")
            return


# ===================================================================
# Poll cycle
# ===================================================================


async def _poll_cycle() -> bool:
    """Process every eligible practice this tick. Returns True if at least
    one practice was processed (regardless of outcome)."""
    ids = await _claim_eligible_practice_ids()
    processed = 0
    for practice_id in ids:
        if await _process_one(practice_id):
            processed += 1
    if processed > 0:
        logger.info("zoom_report_batch", processed=processed)
    return processed > 0


async def _claim_eligible_practice_ids() -> list:
    """Practices whose Zoom attendance decision is still open:
    - completed, with an ACTIVE Zoom meeting whose report was never
      successfully ingested, AND
    - has at least one CONFIRMED booking still awaiting a decision (once
      either a successful ingest or the deadline fallback resolves every
      booking, the practice stops matching and is never touched again), AND
    - the ripen margin has passed (no point calling Zoom before its report
      could possibly exist yet).
    """
    factory = get_session_factory()
    now = datetime.now(UTC)
    margin_min = settings.zoom_report_ripen_margin_minutes

    has_confirmed_booking = (
        select(Booking.id)
        .where(
            Booking.practice_id == Practice.id,
            Booking.status == BookingStatus.CONFIRMED.value,
        )
        .exists()
    )

    try:
        async with factory() as session:
            stmt = (
                select(Practice.id)
                .join(ZoomMeeting, ZoomMeeting.practice_id == Practice.id)
                .where(
                    Practice.status == PracticeStatus.COMPLETED.value,
                    ZoomMeeting.status == ZoomMeetingStatus.ACTIVE.value,
                    ZoomMeeting.report_ingested_at.is_(None),
                    Practice.scheduled_at
                    + func.make_interval(0, 0, 0, 0, 0, Practice.duration_minutes + margin_min)
                    <= now,
                    has_confirmed_booking,
                )
                .order_by(Practice.scheduled_at.asc())
                .with_for_update(of=Practice, skip_locked=True)
            )
            result = await session.execute(stmt)
            ids = list(result.scalars().all())
            await session.rollback()
            return ids
    except Exception:
        logger.exception("zoom_report_claim_error")
        return []


async def _process_one(practice_id) -> bool:
    """Process one practice: fallback if past deadline, else try to ingest.
    Own transaction, own session. Returns True on any attempt (success or
    failure both count as work done); False only if the row/practice was
    lost to a race or an unexpected error prevented even trying.
    """
    factory = get_session_factory()

    try:
        async with factory() as session:
            practice = (
                await session.execute(
                    select(Practice).where(Practice.id == practice_id).with_for_update()
                )
            ).scalar_one_or_none()
            if practice is None:
                await session.rollback()
                return False

            zoom_meeting = (
                await session.execute(
                    select(ZoomMeeting).where(
                        ZoomMeeting.practice_id == practice_id,
                        ZoomMeeting.status == ZoomMeetingStatus.ACTIVE.value,
                    )
                )
            ).scalar_one_or_none()
            if zoom_meeting is None or zoom_meeting.report_ingested_at is not None:
                # Lost the race -- resolved elsewhere since we claimed it.
                await session.rollback()
                return False

            deadline = practice.scheduled_at + timedelta(
                minutes=practice.duration_minutes
                + settings.zoom_attendance_decision_deadline_minutes,
            )
            if datetime.now(UTC) >= deadline:
                await apply_legacy_proxy_fallback(practice, session)
            else:
                await ingest_report_for_meeting(zoom_meeting, practice, session)

            await session.commit()
            return True
    except Exception:
        logger.exception("zoom_report_process_failed", practice_id=str(practice_id))
        return False
