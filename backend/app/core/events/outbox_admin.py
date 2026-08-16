# =============================================================================
# VELO Backend -- Outbox Admin (H-R3, relay hardening §8a-3)
# =============================================================================
#
# Service-level operations behind the `comms-outbox` CLI
# (scripts/comms_outbox.py -> `velo comms-outbox ...` via velo-manage.sh):
# see and revive dead-lettered outbox rows without hand-written psql.
#
# Importable ON PURPOSE: the integration tests exercise these functions
# directly (service level, no subprocess), the script stays a thin
# argparse wrapper. Session ownership follows the relay's convention:
# functions never commit; the caller (script / test) owns the
# transaction.
# =============================================================================

import structlog
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.events.models import OutboxEvent

logger = structlog.get_logger()


async def list_dead_events(session: AsyncSession) -> list[OutboxEvent]:
    """Dead-lettered outbox rows, oldest death first."""
    rows = (
        await session.execute(
            select(OutboxEvent)
            .where(OutboxEvent.dead_lettered_at.is_not(None))
            .order_by(OutboxEvent.dead_lettered_at, OutboxEvent.id)
        )
    ).scalars().all()
    return list(rows)


async def requeue_events(
    session: AsyncSession,
    *,
    event_ids: list[int] | None = None,
    requeue_all: bool = False,
) -> int:
    """Revive dead rows: clear dead_lettered_at AND next_attempt_at, so
    the next relay pass picks them up immediately.

    event_ids are OutboxEvent.id values -- a BigInteger publication
    sequence (models.py), NOT a UUID (T-46 item 2: the CLI used to
    parse them as UUID, which meant the one recovery path for a
    relay-buried event could never accept the number the operator
    actually had).

    attempts is DELIBERATELY kept (history): an unfixed poison re-dies
    after a single further failure, loudly, instead of buying another
    ~30 minutes of backoff ladder -- revival without a fix should fail
    fast. Exactly one of event_ids / requeue_all must be given. Returns
    the number of revived rows; ids that are not dead (or unknown) are
    simply not matched -- a clean 0, never a traceback. Caller commits.
    """
    if requeue_all == bool(event_ids):
        raise ValueError("pass exactly one of event_ids / requeue_all")

    stmt = (
        update(OutboxEvent)
        .where(OutboxEvent.dead_lettered_at.is_not(None))
        .values(dead_lettered_at=None, next_attempt_at=None)
    )
    if event_ids:
        stmt = stmt.where(OutboxEvent.id.in_(event_ids))
    result = await session.execute(stmt)
    revived = result.rowcount or 0
    logger.info(
        "outbox_events_requeued",
        revived=revived,
        scope="all" if requeue_all else [str(i) for i in event_ids or []],
    )
    return revived
