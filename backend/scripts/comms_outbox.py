# =============================================================================
# VELO -- comms-outbox CLI (H-R3, relay hardening §8a-3)
# =============================================================================
#
# Operator's view of the outbox dead-letter queue -- see and revive
# dead rows without hand-written psql. Thin argparse wrapper: ALL logic
# lives in app/core/events/outbox_admin.py (importable, tested at the
# service level). Wired as `velo comms-outbox ...` in velo-manage.sh,
# mirroring resync-comms.
#
#   python scripts/comms_outbox.py list-dead
#   python scripts/comms_outbox.py requeue <event-id> [<event-id> ...]
#   python scripts/comms_outbox.py requeue --all
#
# SESSION: own session factory + explicit commit, dispose_engine() in
# a finally -- same skeleton as backfill_comms_sync.py.
# =============================================================================

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

# -- sys.path bootstrap (same as backfill_comms_sync.py) ---------------------
_SCRIPTS_DIR = Path(__file__).resolve().parent
_BACKEND_DIR = _SCRIPTS_DIR.parent
for _p in (_SCRIPTS_DIR, _BACKEND_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

from app.core.database import dispose_engine, get_session_factory  # noqa: E402
from app.core.events.outbox_admin import (  # noqa: E402
    list_dead_events,
    requeue_events,
)


def _event_id(raw: str) -> int:
    """argparse type for an OutboxEvent.id (BigInteger, not UUID -- T-46
    item 2). Raising ValueError here is what gives argparse its own
    clean "invalid event_id value: '...'" + usage, not a traceback --
    the CLI's own contract for a malformed argument.
    """
    try:
        value = int(raw)
    except ValueError:
        raise ValueError(f"not an integer event id: {raw!r}") from None
    if value <= 0:
        raise ValueError(f"event id must be positive, got: {value}")
    return value


async def _list_dead() -> None:
    session_factory = get_session_factory()
    async with session_factory() as session:
        rows = await list_dead_events(session)
    if not rows:
        print("No dead-lettered outbox events.")
        return
    print(f"{len(rows)} dead-lettered outbox event(s):")
    for e in rows:
        print(
            f"  id={e.id}  type={e.event_type}  attempts={e.attempts}  "
            f"dead_lettered_at={e.dead_lettered_at.isoformat()}  "
            f"created_at={e.created_at.isoformat()}"
        )


async def _requeue(ids: list[int], requeue_all: bool) -> None:
    session_factory = get_session_factory()
    async with session_factory() as session:
        revived = await requeue_events(
            session,
            event_ids=ids or None,
            requeue_all=requeue_all,
        )
        await session.commit()
    print(
        f"Revived {revived} event(s). "
        "The background relay picks them up on its next pass."
    )


async def main() -> None:
    parser = argparse.ArgumentParser(
        prog="comms-outbox",
        description="Inspect / revive dead-lettered comms outbox events.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("list-dead", help="list dead-lettered events")

    requeue = sub.add_parser(
        "requeue", help="revive dead events (attempts kept -- history)",
    )
    requeue.add_argument(
        "event_ids", nargs="*", type=_event_id,
        help="event id(s) to revive (OutboxEvent.id, an integer)",
    )
    requeue.add_argument(
        "--all", action="store_true", dest="requeue_all",
        help="revive every dead event",
    )

    args = parser.parse_args()
    try:
        if args.command == "list-dead":
            await _list_dead()
        else:
            if args.requeue_all == bool(args.event_ids):
                parser.error("pass event id(s) OR --all, exactly one")
            await _requeue(args.event_ids, args.requeue_all)
    finally:
        await dispose_engine()


if __name__ == "__main__":
    asyncio.run(main())
