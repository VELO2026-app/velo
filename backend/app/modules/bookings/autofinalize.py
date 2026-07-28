# =============================================================================
# VELO Backend -- Practice Lifecycle Worker (Batch 1, extended)
# =============================================================================
#
# Background asyncio.Task that runs inside FastAPI lifespan, mirroring the
# comms outbox relay (app/core/events/relay.py).
#
# WHY:
#   Practices are driven by the clock -- the master no longer starts or finishes
#   a practice by hand. Without this worker a practice would stay scheduled
#   forever: it would never go live, its confirmed bookings would never resolve
#   to attended/no_show, the master's money would stay frozen, and the feedback
#   prompt would never fire. This worker performs BOTH time-based transitions,
#   acting as the system actor.
#
# HOW (two phases per poll, FINISH before START):
#   FINISH: practices WHERE status IN (scheduled, live) AND
#           scheduled_at + duration_minutes + buffer <= now. Each runs the full
#           settlement core via bookings.service.auto_finalize_practice
#           (attendance + ledger unfreeze/commission + diary projection +
#           feedback push).
#   START:  practices WHERE status == scheduled AND scheduled_at <= now AND the
#           scheduled END has NOT passed. Each moves scheduled -> live via
#           bookings.service.auto_start_practice (status only -- no bookings,
#           money or diary are touched).
#
#   FINISH runs first on purpose: a practice whose start AND end have both
#   already passed (e.g. the worker was down for a while) is caught by FINISH
#   and goes straight to completed -- it never flickers through live. START only
#   ever sees practices whose end is still in the future.
#
# SESSION / ISOLATION:
#   Runs outside request context -- uses get_session_factory() like the
#   notification processor and the Stripe webhook. Each practice is transitioned
#   in its OWN session/transaction: FINISH settlement touches money + diary and
#   is comparatively heavy, so we isolate failures (one bad practice must not
#   roll back the others) and hold the FOR UPDATE lock only for that practice.
#   START is light but uses the same per-practice isolation for symmetry.
#
#   Both phases claim rows with FOR UPDATE SKIP LOCKED, so a row already locked
#   by the other phase (or a concurrent op) is simply skipped this tick and
#   picked up next cycle -- no double transition, no deadlock.
#
# BACKOFF:
#   Empty poll (nothing started or finished) -> interval doubles (up to
#   max_backoff). Any work found -> reset.
#
# ERROR HANDLING:
#   Each practice is transitioned independently. One failure is logged and the
#   loop continues. Unhandled exceptions in the main loop are caught, logged,
#   and the loop continues after backoff.
# =============================================================================

import asyncio
from datetime import UTC, datetime

import structlog
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.core.config import settings
from app.core.database import get_session_factory
from app.core.exceptions import BadRequestError, NotFoundError
from app.modules.bookings.service import (
    auto_finalize_practice,
    auto_start_practice,
)
from app.modules.practices.models import Practice, PracticeStatus

logger = structlog.get_logger()

# Practice statuses that can still be (auto-)finalized. Mirrors
# _FINALIZABLE_PRACTICE_STATUSES in bookings/service.py.
_FINALIZABLE_PRACTICE_STATUSES = {
    PracticeStatus.SCHEDULED.value,
    PracticeStatus.LIVE.value,
}


# ===================================================================
# Main loop
# ===================================================================


async def run_autofinalizer() -> None:
    """Main auto-finalizer loop. Runs until cancelled.

    Called from FastAPI lifespan as a background task. Catches all
    exceptions to prevent the loop from dying.
    """
    base_interval = settings.practice_autofinalize_poll_interval_seconds
    max_backoff = settings.practice_autofinalize_max_backoff_seconds
    interval = base_interval

    logger.info(
        "practice_autofinalizer_started",
        poll_interval=base_interval,
        max_backoff=max_backoff,
        buffer_minutes=settings.practice_autofinalize_buffer_minutes,
    )

    while True:
        try:
            work_done = await _poll_cycle()

            if work_done:
                interval = base_interval
            else:
                interval = min(interval * 2, max_backoff)

        except asyncio.CancelledError:
            logger.info("practice_autofinalizer_stopped")
            return
        except Exception:
            logger.exception("practice_autofinalizer_error")
            interval = max_backoff

        try:
            await asyncio.sleep(interval)
        except asyncio.CancelledError:
            logger.info("practice_autofinalizer_stopped")
            return


# ===================================================================
# Poll cycle
# ===================================================================


async def _poll_cycle() -> bool:
    """Run one lifecycle tick: FINISH overdue practices, then START due ones.

    Returns True if at least one practice was started or finalized (resets
    backoff).

    FINISH runs before START so a practice whose start and end have both passed
    goes straight to completed instead of flickering through live (see module
    docstring). Each phase claims its rows in a short SKIP LOCKED transaction and
    then transitions each practice in a fresh session, so a single failure cannot
    roll back the rest of the batch.
    """
    # -- FINISH phase: scheduled/live past their end -> completed --
    overdue_ids = await _claim_overdue_ids()
    finalized = 0
    for practice_id in overdue_ids:
        if await _finalize_one(practice_id):
            finalized += 1
    if finalized > 0:
        logger.info("practice_autofinalize_batch", finalized=finalized)

    # -- START phase: scheduled whose start has passed (end still ahead) -> live --
    startable_ids = await _claim_startable_ids()
    started = 0
    for practice_id in startable_ids:
        if await _start_one(practice_id):
            started += 1
    if started > 0:
        logger.info("practice_autostart_batch", started=started)

    return bool(finalized or started)


async def _claim_overdue_ids() -> list:
    """Return ids of practices past their scheduled end (+ buffer).

    A practice is overdue when it is still scheduled/live and its scheduled END
    plus practice_autofinalize_buffer_minutes (scheduled_at + duration_minutes +
    buffer) is in the past — so completion / settlement / feedback happen ~at the
    end, not +24h, without the master pressing «Завершить». FOR UPDATE SKIP LOCKED
    means rows currently locked by a manual finalize are skipped this tick (picked
    up next cycle), preventing double finalize and deadlocks.
    """
    factory = get_session_factory()
    now = datetime.now(UTC)
    buffer_min = settings.practice_autofinalize_buffer_minutes
    batch_size = settings.practice_autofinalize_batch_size

    try:
        async with factory() as session:
            stmt = (
                select(Practice.id)
                .where(
                    Practice.status.in_(_FINALIZABLE_PRACTICE_STATUSES),
                    # Overdue = scheduled END (+ buffer) has passed:
                    # scheduled_at + duration_minutes + buffer <= now. Per-practice
                    # (duration is a column), so make_interval, not a fixed cutoff.
                    Practice.scheduled_at
                    + func.make_interval(
                        0, 0, 0, 0, 0,
                        Practice.duration_minutes + buffer_min,
                    )
                    <= now,
                )
                .order_by(Practice.scheduled_at.asc())
                .limit(batch_size)
                .with_for_update(skip_locked=True)
            )
            result = await session.execute(stmt)
            ids = list(result.scalars().all())
            # Read-only claim: nothing was mutated. Release the FOR UPDATE
            # SKIP LOCKED locks now with an explicit rollback, rather than
            # relying on the implicit rollback at session close.
            await session.rollback()
            return ids
    except Exception:
        logger.exception("practice_autofinalize_claim_error")
        return []


async def _finalize_one(practice_id) -> bool:
    """Finalize a single practice in its own transaction.

    Returns True on success. Errors are logged and swallowed so the batch
    continues. BadRequestError/NotFoundError are expected races (the practice
    was finalized or removed between claim and settlement) and are logged at
    info, not error.
    """
    factory = get_session_factory()

    try:
        async with factory() as session:
            try:
                await auto_finalize_practice(practice_id, session)
                await session.commit()
                return True
            except (BadRequestError, NotFoundError) as exc:
                # Lost the race (already finalized/removed) -- not an error.
                await session.rollback()
                logger.info(
                    "practice_autofinalize_skipped",
                    practice_id=str(practice_id),
                    reason=str(exc),
                )
                return False
            except IntegrityError:
                await session.rollback()
                logger.exception(
                    "practice_autofinalize_integrity_error",
                    practice_id=str(practice_id),
                )
                return False
    except Exception:
        # Anything else (DB hiccup, settlement bug): log and move on so one
        # bad practice never stalls the worker.
        logger.exception(
            "practice_autofinalize_failed",
            practice_id=str(practice_id),
        )
        return False


# ===================================================================
# Start phase (scheduled -> live)
# ===================================================================


async def _claim_startable_ids() -> list:
    """Return ids of scheduled practices whose start has passed (end still ahead).

    A practice is startable when it is still `scheduled`, its scheduled_at is in
    the past, and its scheduled END (scheduled_at + duration_minutes) is still in
    the future -- so only practices genuinely running now go live. Practices
    whose end has already passed are intentionally left for the FINISH phase
    (which ran first) so they go straight to completed without flickering through
    live. FOR UPDATE SKIP LOCKED means rows already locked by the FINISH phase or
    a concurrent op are skipped this tick and picked up next cycle.
    """
    factory = get_session_factory()
    now = datetime.now(UTC)
    batch_size = settings.practice_autofinalize_batch_size

    try:
        async with factory() as session:
            stmt = (
                select(Practice.id)
                .where(
                    Practice.status == PracticeStatus.SCHEDULED.value,
                    # Start time has passed...
                    Practice.scheduled_at <= now,
                    # ...but the end has NOT (leave fully-past ones to FINISH).
                    # Per-practice end (duration is a column), so make_interval.
                    Practice.scheduled_at
                    + func.make_interval(
                        0, 0, 0, 0, 0, Practice.duration_minutes,
                    )
                    > now,
                )
                .order_by(Practice.scheduled_at.asc())
                .limit(batch_size)
                .with_for_update(skip_locked=True)
            )
            result = await session.execute(stmt)
            ids = list(result.scalars().all())
            # Read-only claim: nothing was mutated. Release the SKIP LOCKED locks
            # now with an explicit rollback rather than at session close.
            await session.rollback()
            return ids
    except Exception:
        logger.exception("practice_autostart_claim_error")
        return []


async def _start_one(practice_id) -> bool:
    """Move a single scheduled practice to live in its own transaction.

    Returns True on success. BadRequestError/NotFoundError are expected races
    (the practice was started, finalized, cancelled or removed between claim and
    transition) and are logged at info, not error. Any other error is logged and
    swallowed so the batch continues.
    """
    factory = get_session_factory()

    try:
        async with factory() as session:
            try:
                await auto_start_practice(practice_id, session)
                await session.commit()
                return True
            except (BadRequestError, NotFoundError) as exc:
                # Lost the race (already transitioned/removed) -- not an error.
                await session.rollback()
                logger.info(
                    "practice_autostart_skipped",
                    practice_id=str(practice_id),
                    reason=str(exc),
                )
                return False
            except IntegrityError:
                await session.rollback()
                logger.exception(
                    "practice_autostart_integrity_error",
                    practice_id=str(practice_id),
                )
                return False
    except Exception:
        logger.exception(
            "practice_autostart_failed",
            practice_id=str(practice_id),
        )
        return False
