#!/usr/bin/env python3
# =============================================================================
# VELO -- signature-stats CLI (BE-201)
# =============================================================================
#
# The measurement BE-183 is decided on: how many people sign in from the
# Mini App with Telegram's `signature` field and how many without it.
# Thin argparse wrapper: ALL logic lives in
# app/modules/auth/signature_stats.py (importable, tested there).
#
#   python scripts/signature_stats.py                    # all time
#   python scripts/signature_stats.py --since 2026-11-20 # from that date
#
# Prints ONE line of JSON, numbers only, nothing about any person:
#   {"only_with": N, "ever_without": N, "total": N, "since": "YYYY-MM-DD"|null}
# `--since D` counts from midnight UTC of D, inclusive.
#
# Exit codes: 0 -- printed; 2 -- a malformed argument (argparse's own);
# 1 -- anything else (the traceback is the message).
#
# SESSION: own session factory, read only, dispose_engine() in a finally --
# same skeleton as comms_outbox.py.
# =============================================================================

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import UTC, date, datetime, time
from pathlib import Path

# -- sys.path bootstrap (same as comms_outbox.py) ----------------------------
_SCRIPTS_DIR = Path(__file__).resolve().parent
_BACKEND_DIR = _SCRIPTS_DIR.parent
for _p in (_SCRIPTS_DIR, _BACKEND_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

from app.core.database import dispose_engine, get_session_factory  # noqa: E402
from app.modules.auth.signature_stats import count  # noqa: E402


def _day(raw: str) -> date:
    """argparse type for --since. Raising ValueError here is what gives
    argparse its own clean "invalid _day value" + usage and exit 2, not a
    traceback."""
    return date.fromisoformat(raw)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Mini App sign-ins with / without Telegram's `signature`."
    )
    p.add_argument(
        "--since",
        type=_day,
        default=None,
        metavar="YYYY-MM-DD",
        help="count from midnight UTC of this date (default: all time)",
    )
    return p.parse_args(argv)


def render(stats, since: date | None) -> str:
    """The one output line."""
    return json.dumps(
        {
            "only_with": stats.only_with,
            "ever_without": stats.ever_without,
            "total": stats.total,
            "since": since.isoformat() if since else None,
        }
    )


async def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    since_at = (
        datetime.combine(args.since, time.min, tzinfo=UTC) if args.since else None
    )
    try:
        session_factory = get_session_factory()
        async with session_factory() as session:
            stats = await count(session, since_at)
        print(render(stats, args.since))
        return 0
    finally:
        await dispose_engine()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
