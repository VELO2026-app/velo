# =============================================================================
# VELO Backend -- the comms push listener (BE-134)
# =============================================================================
#
# comms says "this job changed -- go read it" by writing the job's key into
# its own redis stream, <COMMS_EVENTS_STREAM>:changes (comms
# deploy/INTEGRATION.md section 10). A push is a HINT: the read by key is
# the truth, and a push may be lost, repeated or reordered. So the listener
# is two readers of one fact, and either alone is enough:
#
#   reconcile -- comms' changes feed (section 9) from the cursor kept in
#     comms_feed_cursors, page by page, each key read by its handler; the
#     cursor is stored only AFTER its page was acted on. Run when the
#     listener becomes active, every _RECONCILE_EVERY_SECONDS while it is,
#     and after a push of an unknown format. 410 cursor_expired: every
#     handler re-reads everything of its own that is still unfinished, and
#     the feed starts again without a cursor.
#   the stream -- XREADGROUP in a consumer group with a stable name, own
#     unacknowledged entries first ("0"), then new ones (">"). READ, THEN
#     ACKNOWLEDGE: an entry acknowledged before its read is lost if the
#     process dies in between.
#
# A SWEEP on every pass of the loop: each handler's own small retries that
# cannot wait for a push (KeyHandler.sweep) -- pushes come only at a job's
# outcome.
#
# THE FEED CARRIES EVERY JOB OF THE PRODUCT -- people's notifications too,
# and comms' own message pings. A handler claims keys by PREFIX
# (register); a key no handler claims is acknowledged without a read: no
# request to comms is made for a job that is not ours to act on.
#
# ONE ACTIVE LISTENER. Every uvicorn worker starts run_listener; each tries
# a SESSION-level advisory lock on a dedicated connection and only the one
# that gets it listens -- the others try again every _LOCK_RETRY_SECONDS.
# Session-level, not the relay's per-tick transaction lock: the listener
# lives in a blocking XREADGROUP, and a transaction held open across it
# would be an idle-in-transaction connection for as long as the worker
# runs. The lock goes with the connection: a worker that dies, or whose
# connection drops, releases it and another takes over. Every read of the
# stream is preceded by a round trip on that connection, so a listener
# whose lock went with a dropped connection stops at its next read rather
# than going on beside the new holder. Between those two moments both may
# act on the same key; that is harmless by construction -- every handler
# decides under a row lock and from the row's own state (one outcome is
# applied once), and what it sends to comms carries a key derived from the
# row (one message per row however often it is sent).
# =============================================================================

import asyncio
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass
from typing import Any

import structlog
from fastapi import HTTPException
from redis import asyncio as aioredis
from redis.exceptions import ResponseError
from sqlalchemy import func, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core.comms import comms_request
from app.core.config import settings
from app.core.database import get_engine, get_session_factory
from app.core.events.models import CommsFeedCursor

logger = structlog.get_logger()

# BE-134: the advisory-lock key of the push listener. A NAMED constant, like
# the relay's (core/events/relay.py _RELAY_ADVISORY_LOCK_KEY, which names
# this one back): any other lock on this number would keep the listener
# idle while held. Two advisory locks exist in this database -- the relay's
# and this one; a new one picks another number and says so in both places.
_LISTENER_ADVISORY_LOCK_KEY = 4_701_134_000_134

CHANGES_PATH = "/api/v1/notifications/changes"
# The consumer group and its one consumer: stable names, so a restarted
# listener finds its own unacknowledged entries again.
GROUP = "velo"
CONSUMER = "velo-listener"
# The row of comms_feed_cursors this listener owns.
CURSOR_CONSUMER = "velo-listener"

_PAGE_LIMIT = 100
_STREAM_COUNT = 100
_BLOCK_MS = 5_000
_RECONCILE_EVERY_SECONDS = 60.0
_LOCK_RETRY_SECONDS = 15.0
_ERROR_BACKOFF_SECONDS = 5.0
_FORMAT_BACKOFF_SECONDS = 60.0


class PushFormatError(Exception):
    """A push of a format version this listener does not know (v != 1):
    stop following the stream and reconcile by the feed (section 10)."""


@dataclass(frozen=True)
class KeyHandler:
    """What one kind of our jobs does with its keys.

    on_key: read the job by its key and update our own state from it.
    resume: act on every job of this kind we still hold as unfinished --
        after 410 cursor_expired, and on every reconcile (it also picks up
        work a crashed process left half done).
    sweep: the small work that cannot wait for a push, on EVERY pass of
        the stream loop (at least every _BLOCK_MS): comms pushes a job
        only at its outcome, so what must follow the job's mere ARRIVAL
        in comms -- a variant request, BE-166 -- is retried from here
        until comms takes it.
    """

    prefix: str
    on_key: Callable[[str], Awaitable[None]]
    resume: Callable[[], Awaitable[None]]
    sweep: Callable[[], Awaitable[None]]


_HANDLERS: list[KeyHandler] = []


def register(handler: KeyHandler) -> None:
    """Claim the keys starting with handler.prefix. Two handlers whose
    prefixes overlap would both claim a key -- refused."""
    for other in _HANDLERS:
        if other.prefix == handler.prefix:
            return
        if other.prefix.startswith(handler.prefix) or handler.prefix.startswith(
            other.prefix,
        ):
            raise ValueError(f"key prefix {handler.prefix!r} overlaps {other.prefix!r}")
    _HANDLERS.append(handler)


def handler_for(key: str) -> KeyHandler | None:
    for handler in _HANDLERS:
        if key.startswith(handler.prefix):
            return handler
    return None


def stream_name() -> str:
    return f"{settings.comms_events_stream}:changes"


async def handle_key(key: str) -> bool:
    """Hand one key to its handler. False -- not ours, nothing was read."""
    handler = handler_for(key)
    if handler is None:
        return False
    await handler.on_key(key)
    return True


# ---------------------------------------------------------------------------
# The changes feed (section 9)
# ---------------------------------------------------------------------------


async def load_cursor() -> str | None:
    async with get_session_factory()() as session:
        row = await session.get(CommsFeedCursor, CURSOR_CONSUMER)
        return None if row is None else row.cursor


async def save_cursor(cursor: str | None) -> None:
    async with get_session_factory()() as session, session.begin():
        stmt = pg_insert(CommsFeedCursor).values(
            consumer=CURSOR_CONSUMER,
            cursor=cursor,
        )
        await session.execute(
            stmt.on_conflict_do_update(
                index_elements=[CommsFeedCursor.consumer],
                set_={"cursor": stmt.excluded.cursor},
            )
        )


async def _resume_all() -> None:
    for handler in _HANDLERS:
        await handler.resume()


async def reconcile() -> None:
    """Act on everything that changed since the kept cursor (section 9's
    recovery, steps 2-6)."""
    await _resume_all()
    cursor = await load_cursor()
    while True:
        params: dict[str, Any] = {"limit": _PAGE_LIMIT}
        if cursor is not None:
            params["cursor"] = cursor
        try:
            page = await comms_request("GET", CHANGES_PATH, params=params)
        except HTTPException as exc:
            if exc.status_code != 410:
                raise
            logger.warning("comms_changes_cursor_expired")
            await _resume_all()
            cursor = None
            await save_cursor(None)
            continue
        items = page.get("items") if isinstance(page, dict) else None
        next_cursor = page.get("next_cursor") if isinstance(page, dict) else None
        if not isinstance(items, list) or not isinstance(next_cursor, str):
            raise ValueError("comms changes page of an unexpected shape")
        for item in items:
            key = item.get("idempotency_key") if isinstance(item, dict) else None
            if isinstance(key, str) and key:
                await handle_key(key)
        # Only now: the page it ends was acted on.
        await save_cursor(next_cursor)
        cursor = next_cursor
        if not items:
            return


# ---------------------------------------------------------------------------
# The push stream (section 10)
# ---------------------------------------------------------------------------


def create_listener_redis() -> aioredis.Redis:
    """The listener's redis: a socket timeout above the read's own block,
    or every idle read would end as a timeout error."""
    return aioredis.from_url(
        settings.comms_redis_url,
        decode_responses=False,
        socket_connect_timeout=settings.comms_relay_socket_connect_timeout_seconds,
        socket_timeout=_BLOCK_MS / 1000 + settings.comms_relay_socket_timeout_seconds,
    )


async def ensure_group(redis: aioredis.Redis) -> None:
    try:
        await redis.xgroup_create(stream_name(), GROUP, id="$", mkstream=True)
    except ResponseError as exc:
        if "BUSYGROUP" not in str(exc):
            raise


async def process_entries(
    redis: aioredis.Redis,
    entries: list[tuple[Any, dict[Any, Any]]],
) -> None:
    """Read, then acknowledge, entry by entry."""
    for entry_id, fields in entries:
        if fields.get(b"v") != b"1":
            raise PushFormatError(str(fields.get(b"v")))
        raw = fields.get(b"idempotency_key")
        if isinstance(raw, bytes) and raw:
            await handle_key(raw.decode("utf-8", errors="replace"))
        await redis.xack(stream_name(), GROUP, entry_id)


# ---------------------------------------------------------------------------
# One active listener
# ---------------------------------------------------------------------------


async def try_lock(conn: AsyncConnection) -> bool:
    """Take the listener's session-level lock on this connection, or not.
    The statement's own transaction is committed at once: the lock is the
    session's, and the connection must not sit idle in a transaction."""
    got = (
        await conn.execute(
            select(func.pg_try_advisory_lock(_LISTENER_ADVISORY_LOCK_KEY)),
        )
    ).scalar()
    await conn.commit()
    return bool(got)


async def _release(conn: AsyncConnection) -> None:
    try:
        await conn.execute(
            select(func.pg_advisory_unlock(_LISTENER_ADVISORY_LOCK_KEY)),
        )
        await conn.commit()
    except Exception:  # a dead connection took the lock with it
        # Never hand a connection that may still hold the lock back to the
        # pool: it would keep every other worker idle.
        with suppress(Exception):
            await conn.invalidate()


async def _still_holding(conn: AsyncConnection) -> None:
    """A round trip on the lock's connection; raises when it is gone."""
    await conn.execute(text("SELECT 1"))
    await conn.commit()


async def listen(conn: AsyncConnection, redis: aioredis.Redis) -> None:
    """Follow the stream while holding the lock on `conn`; never returns
    on its own."""
    await ensure_group(redis)
    await reconcile()
    loop = asyncio.get_running_loop()
    last_reconcile = loop.time()
    start = "0"
    while True:
        await _still_holding(conn)
        reply = await redis.xreadgroup(
            GROUP,
            CONSUMER,
            {stream_name(): start},
            count=_STREAM_COUNT,
            block=_BLOCK_MS,
        )
        entries = reply[0][1] if reply else []
        if start == "0" and not entries:
            start = ">"
        await process_entries(redis, entries)
        for handler in _HANDLERS:
            await handler.sweep()
        if loop.time() - last_reconcile >= _RECONCILE_EVERY_SECONDS:
            await reconcile()
            last_reconcile = loop.time()


async def run_listener() -> None:
    """The lifespan task (main.py): become the active listener when the
    lock is free, and listen until cancelled."""
    logger.info("comms_listener_started", stream=stream_name())
    while True:
        try:
            async with get_engine().connect() as conn:
                if not await try_lock(conn):
                    await asyncio.sleep(_LOCK_RETRY_SECONDS)
                    continue
                logger.info("comms_listener_active")
                redis = create_listener_redis()
                try:
                    await listen(conn, redis)
                finally:
                    with suppress(Exception):
                        await redis.aclose()
                    await _release(conn)
        except asyncio.CancelledError:
            raise
        except PushFormatError as exc:
            logger.error("comms_listener_push_format_unknown", v=str(exc))
            await asyncio.sleep(_FORMAT_BACKOFF_SECONDS)
        except Exception as exc:  # the loop must survive
            # The class only: an exception's text may carry a request.
            logger.warning(
                "comms_listener_error",
                error=type(exc).__name__,
            )
            await asyncio.sleep(_ERROR_BACKOFF_SECONDS)
