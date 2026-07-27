# =============================================================================
# VELO Backend -- Outbox Relay (Phase 6 / T0, item 3)
# =============================================================================
#
# Background loop: ships pending OutboxEvent rows to the comms Redis
# Stream, in id order, batched, marking published_at. Sits in the app
# lifespan as a SIBLING of run_processor (which stays untouched until
# T1) behind the comms_relay_enabled settings gate.
#
# WIRE (frozen comms contract, app/transport/events.py 3c):
#   XADD <COMMS_EVENTS_STREAM> * event <name> data <UTF-8 JSON>
# The stream name mirrors the comms consumer's default
# (comms app/core/config.py:66 `comms_events_stream: str =
# "comms:events"`); the consumer itself creates the consumer group
# with XGROUP CREATE MKSTREAM, so the relay may publish before the
# consumer has ever started -- nothing is lost.
#
# ERROR MODEL (mandatory fix #1 of the T0 review):
#   - PER-EVENT failures (a poison row: XADD/serialization rejects
#     THIS event) -> attempts += 1 on that row, the REST of the batch
#     still publishes -- one poison event must not head-of-line block
#     the whole outgoing pipe. The row is NEVER dropped; every
#     RELAY_WARN_EVERY_ATTEMPTS failures it logs a loud WARNING so the
#     operator sees the poison in the logs, not a silent loop.
#   - CONNECTION-level failures (comms Redis unreachable) abort the
#     current pass WITHOUT touching attempts -- an infra outage is not
#     the rows' fault; the outbox waits it out and the next tick
#     retries. The outbox survives velo restarts by construction
#     (state is in the table, not in memory).
#
# ORDERING: publishes in id order within a pass. A poison row being
# skipped means later rows of the same pass do publish -- a momentary
# per-user inversion is the consumer's documented territory (bounded
# backoff, then DLQ); accepted in the T0 review.
#
# CONCURRENCY: FOR UPDATE SKIP LOCKED -- a second app replica running
# its own relay claims disjoint rows instead of double-publishing.
# (Sync events are idempotent anyway; notification_request dedups by
# idempotency_key -- but not racing at all is cheaper than relying on
# that.)
# =============================================================================

import asyncio
import json
from datetime import UTC, datetime

import structlog
from redis import asyncio as aioredis
from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import TimeoutError as RedisTimeoutError
from sqlalchemy import select

from app.core.config import settings
from app.core.database import get_session_factory
from app.core.events.models import OutboxEvent

logger = structlog.get_logger()

# Envelope field names (frozen contract mirror).
_ENVELOPE_EVENT_FIELD = "event"
_ENVELOPE_DATA_FIELD = "data"

# Redis errors that mean "the pipe is down", not "this event is bad".
_CONNECTION_ERRORS = (RedisConnectionError, RedisTimeoutError, OSError)


def build_envelope(event: OutboxEvent) -> dict[str, str]:
    """Assemble the wire envelope {event, data} for one outbox row."""
    return {
        _ENVELOPE_EVENT_FIELD: event.event_type,
        _ENVELOPE_DATA_FIELD: json.dumps(event.payload, ensure_ascii=False),
    }


async def relay_pending_batch(redis: aioredis.Redis) -> tuple[int, int]:
    """Publish one batch of pending outbox rows.

    Returns (published, failed) counts for the pass. Opens its own
    session/transaction: published_at / attempts updates commit even
    though the emitting transactions are long gone.

    Raises nothing for per-event failures (counted + logged); lets
    connection-level errors abort the pass after committing whatever
    already published (see module header).
    """
    session_factory = get_session_factory()
    published = 0
    failed = 0
    async with session_factory() as session, session.begin():
        stmt = (
            select(OutboxEvent)
            .where(OutboxEvent.published_at.is_(None))
            .order_by(OutboxEvent.id)
            .limit(settings.comms_relay_batch_size)
            .with_for_update(skip_locked=True)
        )
        result = await session.execute(stmt)
        events = list(result.scalars().all())
        if not events:
            return (0, 0)

        connection_down = False
        for event in events:
            try:
                await redis.xadd(
                    settings.comms_events_stream,
                    build_envelope(event),  # type: ignore[arg-type]
                )
            except _CONNECTION_ERRORS as exc:
                # Infra, not poison: stop the pass, do NOT charge
                # attempts to rows that never got a fair try.
                logger.warning(
                    "outbox_relay_redis_unreachable",
                    error=str(exc),
                    pending_from_event_id=event.id,
                )
                connection_down = True
                break
            except Exception as exc:
                # Poison row: charge it, keep the pipe moving.
                event.attempts += 1
                failed += 1
                log = logger.warning if (
                    event.attempts
                    % settings.comms_relay_warn_every_attempts
                    == 0
                ) else logger.info
                log(
                    "outbox_event_publish_failed",
                    event_id=event.id,
                    event_type=event.event_type,
                    attempts=event.attempts,
                    error=str(exc),
                )
                continue
            event.published_at = datetime.now(UTC)
            published += 1

        if connection_down and published == 0 and failed == 0:
            # Nothing to persist; rollback keeps the rows clean.
            await session.rollback()
            return (0, 0)
        # session.begin() context committed here: published_at marks
        # and attempts increments persist together.
    return (published, failed)


async def run_relay() -> None:
    """The lifespan loop: connect, relay, sleep, repeat.

    Cancellation-safe: CancelledError propagates out of the sleep /
    the pass; the outbox state is in the table, so a restart resumes
    exactly where the last committed pass ended.
    """
    redis = aioredis.from_url(
        settings.comms_redis_url,
        encoding="utf-8",
        decode_responses=False,
    )
    logger.info(
        "outbox_relay_started",
        stream=settings.comms_events_stream,
        interval_seconds=settings.comms_relay_interval_seconds,
        batch_size=settings.comms_relay_batch_size,
    )
    try:
        while True:
            try:
                published, failed = await relay_pending_batch(redis)
                if published or failed:
                    logger.info(
                        "outbox_relay_pass",
                        published=published,
                        failed=failed,
                    )
            except _CONNECTION_ERRORS as exc:
                logger.warning(
                    "outbox_relay_redis_unreachable", error=str(exc)
                )
            except Exception:
                # DB down, unexpected bug -- log loudly, keep looping:
                # the relay must outlive transient trouble.
                logger.exception("outbox_relay_pass_crashed")
            await asyncio.sleep(settings.comms_relay_interval_seconds)
    finally:
        await redis.aclose()
        logger.info("outbox_relay_stopped")
