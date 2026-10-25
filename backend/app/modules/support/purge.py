# =============================================================================
# VELO Backend -- the support spam bin (BE-162 delivery 2)
# =============================================================================
#
# Owner ruling: a ticket marked spam can come back ("not spam") for 30
# days; then it is deleted with its conversation, and the statistics keep
# only its date and category.
#
# ONE STEP, TWO PHASES, OURS FIRST:
#
#   1. In ONE transaction: take the spam tickets older than the retention
#      under their row lock (FOR UPDATE SKIP LOCKED -- a ticket an admin is
#      bringing back right now is skipped, and "not spam" is refused for a
#      ticket this step holds); for each, a tombstone (the date of the
#      appeal, the category) and a purge row (the comms thread id); then
#      delete the thread pointers -- the tickets and their translation jobs
#      go by cascade. From this commit on, velo does not know the thread:
#      the person's conversation, list and counts never read it again.
#
#   2. Outside any transaction: DELETE each queued thread in comms; on its
#      204 (also for a thread already gone) drop the purge row. comms down
#      leaves the row for the next step -- nothing is lost, nothing is
#      deleted twice that matters (the DELETE is idempotent).
#
# Why not comms first: between the two, velo's rows would name a thread
# comms no longer has -- the person's glued feed would read a 404, a
# translation job would write its variant into a 404 for ever, and "not
# spam" could bring back a ticket whose messages are gone.
#
# Several workers may run the step at once: phase 1 is SKIP LOCKED, phase 2
# repeats an idempotent DELETE at worst. No advisory lock is needed.
# =============================================================================

import asyncio
from datetime import UTC, datetime, timedelta

import structlog
from fastapi import HTTPException
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.comms import comms_request
from app.core.config import settings
from app.core.database import get_session_factory
from app.modules.support.models import (
    STATUS_SPAM,
    SupportSpamTombstone,
    SupportThread,
    SupportThreadPurge,
    SupportTicket,
)

logger = structlog.get_logger()

# Tickets taken, and comms threads deleted, per step at most.
PURGE_BATCH = 100


async def bury_spam(
    session: AsyncSession, *, now: datetime, batch: int = PURGE_BATCH,
) -> int:
    """Phase 1 in the caller's transaction: the spam tickets past the
    retention, under their row lock (SKIP LOCKED), become tombstones and
    purge rows, and their thread pointers go -- the tickets and their
    translation jobs with them, by cascade. Returns how many."""
    cutoff = now - timedelta(days=settings.support_spam_retention_days)
    rows = (
        await session.execute(
            select(SupportTicket, SupportThread)
            .join(
                SupportThread,
                SupportThread.id == SupportTicket.support_thread_id,
            )
            .where(
                SupportTicket.status == STATUS_SPAM,
                SupportTicket.status_changed_at <= cutoff,
            )
            .order_by(SupportTicket.status_changed_at)
            .limit(batch)
            .with_for_update(skip_locked=True, of=SupportTicket)
        )
    ).all()
    for ticket, pointer in rows:
        session.add(
            SupportSpamTombstone(
                appealed_at=ticket.created_at, category=ticket.category,
            )
        )
        session.add(
            SupportThreadPurge(
                comms_thread_id=pointer.comms_thread_id,
                queued_at=now,
                attempts=0,
            )
        )
    if rows:
        await session.flush()
        await session.execute(
            delete(SupportThread).where(
                SupportThread.id.in_([pointer.id for _, pointer in rows])
            )
        )
        logger.info("support_spam_purged", tickets=len(rows))
    return len(rows)


async def purge_spam_step(*, batch: int = PURGE_BATCH) -> tuple[int, int]:
    """One step of the bin: (tickets deleted here, comms threads deleted).
    See the module header."""
    now = datetime.now(UTC)
    factory = get_session_factory()
    async with factory() as session, session.begin():
        buried = await bury_spam(session, now=now, batch=batch)

    async with factory() as session:
        queued = list(
            (
                await session.execute(
                    select(SupportThreadPurge.comms_thread_id)
                    .order_by(SupportThreadPurge.queued_at)
                    .limit(batch)
                )
            ).scalars()
        )
    cleared = 0
    for thread_id in queued:
        try:
            await comms_request("DELETE", f"/api/v1/threads/{thread_id}")
        except HTTPException as exc:
            logger.warning(
                "support_purge_comms_failed",
                thread_id=str(thread_id),
                status=exc.status_code,
            )
            async with factory() as session, session.begin():
                await session.execute(
                    update(SupportThreadPurge)
                    .where(SupportThreadPurge.comms_thread_id == thread_id)
                    .values(
                        attempts=SupportThreadPurge.attempts + 1,
                        last_error_at=datetime.now(UTC),
                    )
                )
            continue
        async with factory() as session, session.begin():
            await session.execute(
                delete(SupportThreadPurge).where(
                    SupportThreadPurge.comms_thread_id == thread_id
                )
            )
        cleared += 1
    return buried, cleared


async def run_support_spam_purge() -> None:
    """The lifespan task (main.py): one purge step every
    support_spam_purge_interval_seconds, until cancelled. A failed step is
    logged and the next one tries again -- what it did not finish is still
    in the database (spam tickets, purge rows)."""
    logger.info(
        "support_spam_purge_started",
        interval=settings.support_spam_purge_interval_seconds,
        retention_days=settings.support_spam_retention_days,
    )
    while True:
        try:
            await purge_spam_step()
        except asyncio.CancelledError:
            logger.info("support_spam_purge_stopped")
            return
        except Exception:
            logger.exception("support_spam_purge_error")
        try:
            await asyncio.sleep(settings.support_spam_purge_interval_seconds)
        except asyncio.CancelledError:
            logger.info("support_spam_purge_stopped")
            return
