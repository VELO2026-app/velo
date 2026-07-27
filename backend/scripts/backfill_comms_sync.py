#!/usr/bin/env python3
# =============================================================================
# VELO Backend -- Comms sync backfill (Phase 6 / T0, item 6)
# =============================================================================
#
# One-shot projection of the EXISTING user base into the comms sync
# events: for every user an identity snapshot (user_upserted), plus a
# group_changed(member=true) for every held communication capability
# (group:masters -- a verified MasterProfile; group:admins -- role ==
# admin OR the switched-away-admin marker). Events land in the outbox
# (the same emit_event as live traffic); the background relay ships
# them to comms.
#
# WHEN TO RUN (operator ritual, run BY HAND after deploy):
#
#     docker compose exec app python scripts/backfill_comms_sync.py
#
#   - once after the T0 deploy (comms up + velo updated) -- projects
#     everyone who existed before the sync went live;
#   - again after ANY seed run (scripts/seed*.py create User rows
#     directly, bypassing the instrumented auth path -- the backfill
#     is how seeded users reach comms).
#
# IDEMPOTENCY: both sync events are naturally idempotent per the
# frozen comms contract (user_upserted is a snapshot upsert;
# group_changed(member=true) is "ensure member"). A repeat run emits
# a fresh batch of identical snapshots -- more outbox rows, ZERO new
# recipients/memberships in comms. Ordering per user (snapshot first,
# then memberships) satisfies the contract's "user_upserted must
# precede group_changed".
#
# SCOPE: only the communication groups of integration design §4.
# Domain master-groups (groups_models) are NOT synced (deferred, §7);
# `all` is derived by comms and needs no membership.
#
# SESSION: own session factory + explicit commit, dispose_engine() in
# finally -- same shape as seed*.py / set_role.py. Commits in batches
# so a huge user base does not build one giant transaction.
# =============================================================================

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

# -- sys.path bootstrap (same as set_role.py) --------------------------------
_SCRIPTS_DIR = Path(__file__).resolve().parent
_BACKEND_DIR = _SCRIPTS_DIR.parent
for _p in (_SCRIPTS_DIR, _BACKEND_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

from sqlalchemy import select  # noqa: E402

from app.core.database import dispose_engine, get_session_factory  # noqa: E402
from app.core.events import (  # noqa: E402
    GROUP_ADMINS,
    GROUP_MASTERS,
    emit_group_changed,
    emit_user_upserted,
)
from app.modules.masters.models import MasterProfile  # noqa: E402
from app.modules.users.models import User, UserRole  # noqa: E402
from app.modules.users.schemas import has_admin_home  # noqa: E402

_BATCH_SIZE = 200


def _is_verified(profile: MasterProfile | None) -> bool:
    return (
        profile is not None
        and (profile.data or {}).get("account", {}).get("status") == "verified"
    )


async def backfill() -> tuple[int, int, int]:
    """Emit sync events for every existing user.

    Returns (users, masters, admins) counts of emitted snapshots and
    memberships.
    """
    session_factory = get_session_factory()
    users = masters = admins = 0

    async with session_factory() as session:
        # Verified-master ids in one pass (avoid a per-user profile get).
        result = await session.execute(select(MasterProfile))
        verified_ids = {
            p.user_id for p in result.scalars().all() if _is_verified(p)
        }

        result = await session.execute(select(User).order_by(User.created_at))
        all_users = list(result.scalars().all())

        for i, user in enumerate(all_users, start=1):
            # Snapshot FIRST, memberships after (contract ordering).
            await emit_user_upserted(session, user)
            users += 1

            if user.id in verified_ids:
                await emit_group_changed(
                    session,
                    group_key=GROUP_MASTERS,
                    recipient_id=user.id,
                    member=True,
                )
                masters += 1

            if user.role == UserRole.ADMIN or has_admin_home(user.credentials):
                await emit_group_changed(
                    session,
                    group_key=GROUP_ADMINS,
                    recipient_id=user.id,
                    member=True,
                )
                admins += 1

            if i % _BATCH_SIZE == 0:
                await session.commit()
                print(f"  ... {i}/{len(all_users)} users projected")

        await session.commit()

    return users, masters, admins


async def main() -> None:
    print("Backfilling the comms sync projection (outbox events)...")
    try:
        users, masters, admins = await backfill()
    finally:
        await dispose_engine()
    print(
        f"Done: {users} user snapshot(s), {masters} masters membership(s), "
        f"{admins} admins membership(s) emitted into the outbox."
    )
    print("The background relay ships them to comms on its next passes.")


if __name__ == "__main__":
    asyncio.run(main())
