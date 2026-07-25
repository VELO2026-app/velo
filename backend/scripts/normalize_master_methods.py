#!/usr/bin/env python3
# =============================================================================
# VELO Backend -- One-time repair: normalize master_profiles methods format
# =============================================================================
#
# PROBLEM (T21-7, MEASURED on prod, ПРОМТ №547):
#   MasterProfile.data.profile.methods is stored in TWO formats depending on
#   how it was written: a frozen catalog LABEL ("Йога — Кундалини-йога") from
#   the wizard (flattenMethods / admin/masters/service.py's
#   approve_method_change), or a raw catalog VALUE ("yoga") from seed data or
#   a direct API write. The mix breaks label-only display: methodTaxonomy.ts's
#   parseMethods only resolves labels, so a value-stored master's chip renders
#   as the raw slug ("yoga") instead of the Russian label ("Йога").
#
# WHAT THIS SCRIPT DOES:
#   Normalizes every MasterProfile.data.profile.methods entry to the CURRENT
#   catalog LABEL form -- bare "Направление" or composite "Направление — Вид"
#   (methodTaxonomy.ts's SEP) -- matching what the wizard already produces and
#   what parseMethods already expects. No frontend change needed. An entry
#   that doesn't resolve to any catalog direction/style (a genuine custom/
#   free-text method, or a stale value from a removed row) is left verbatim,
#   exactly as parseMethods already treats an unmatched entry (surfaced as
#   customText, never dropped).
#
#   Direction/style rows are matched by EITHER their value or their label,
#   regardless of is_active -- a retired row must keep resolving for an
#   existing master's stored confirmation (taxonomy_models.py's is_active
#   docstring: "existing masters' stored methods strings must keep resolving
#   even after a direction/style is retired from new selection").
#
# ORDERING (owner decision, ПРОМТ №547): run this AFTER
# practices/service.py's _assert_master_confirmed_taxonomy already tolerates
# BOTH formats (T21-7 fix) -- this script is cleanup on top of an
# already-safe read path, never a prerequisite for it. The confirmation
# check must stand on its own regardless of whether this script has ever run.
#
# REVERSIBILITY:
#   Before writing each changed row, records an AuditLog entry (event=
#   "master_methods_normalized", target_type="master_profile", target_id=
#   <user_id>, data={"before": [...], "after": [...]}) in the SAME
#   transaction as the write. --rollback finds, per master, the MOST RECENT
#   such entry and restores data.profile.methods to its recorded "before"
#   value -- exact, per-master, no guessing from terminal scrollback. A
#   master normalized more than once only ever rolls back ONE step (the last
#   apply) -- matches how every other repair script in this directory scopes
#   its own idempotency/rollback story.
#
#   ПРОМТ №549/550: --rollback checks the row's CURRENT value against BOTH
#   "before" and "after", not just "before" -- current==before means already
#   rolled back (skip), current==after means untouched since normalization
#   (safe to revert), and current matching NEITHER means the row changed for
#   some other, legitimate reason since (e.g. an admin approved a real
#   method-change request) -- reverting that to "before" would silently
#   discard the real change. That case is REFUSED loudly (printed, naming the
#   master and all three values), never silently skipped and never
#   overwritten -- a rollback that discards a real approval is worse than no
#   rollback at all, and this runs against production.
#
# IDEMPOTENCY:
#   A row already in target form has computed "after" == current methods --
#   skipped, no write, no audit entry, safe to re-run any number of times.
#
# USAGE (relayed -- one command at a time, wait for output):
#   python scripts/normalize_master_methods.py --dry-run   # preview only
#   python scripts/normalize_master_methods.py              # apply
#   python scripts/normalize_master_methods.py --rollback   # revert last apply
# =============================================================================

import argparse
import asyncio
import copy
import sys
from pathlib import Path
from uuid import UUID

_backend_dir = Path(__file__).resolve().parent.parent
if str(_backend_dir) not in sys.path:
    sys.path.insert(0, str(_backend_dir))

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import AuditLog, record_audit
from app.core.database import dispose_engine, get_session_factory
from app.modules.masters.models import MasterProfile
from app.modules.practices.taxonomy_models import TaxonomyDirection, TaxonomyStyle
# T21-6 chain (ПРОМТ №552, MEASURED in the app container): required even
# though nothing below calls User directly by name for its own sake --
# MasterProfile.user (masters/models.py) is a STRING forward-ref
# relationship ("User", carrying its own lint-suppression comment for F821
# right there, admitting the name isn't statically resolvable). SQLAlchemy
# resolves that name against whatever
# classes have been mapped ANYWHERE in the running process by the time
# mapper configuration runs (a single global pass across every mapped class,
# not just the ones a given query touches) -- inside the app that's always
# true because app.main imports the whole model graph, but a standalone
# script only registers what IT imports. Without this line, the very first
# ORM operation below (not necessarily one that touches MasterProfile)
# triggers that global configure_mappers() pass, which then fails resolving
# "User" for MasterProfile's relationship -- crashing before anything is
# read or written. Confirmed empirically: importing this module alone reaches
# Settings() (a separate, known, unrelated local-only blocker) instead of
# raising ModuleNotFoundError, so this is not a packaging/namespace issue.
# Also used directly below for readable log lines (telegram_id), matching
# the same pattern already followed by repair_orphaned_debits.py.
from app.modules.users.models import User

# Byte-for-byte identical to frontend/src/utils/methodTaxonomy.ts's SEP and
# practices/service.py's _METHOD_LABEL_SEP.
_SEP = " — "
_AUDIT_EVENT = "master_methods_normalized"

G = "\033[0;32m"
Y = "\033[1;33m"
R = "\033[0;31m"
N = "\033[0m"


def log(msg: str) -> None:
    print(f"{G}[NORMALIZE]{N} {msg}")


def warn(msg: str) -> None:
    print(f"{Y}[WARN]{N} {msg}")


def err(msg: str) -> None:
    print(f"{R}[ERROR]{N} {msg}")


class _Catalog:
    """Direction/style lookup by EITHER value or label, is_active-agnostic
    (see module header -- retired rows must keep resolving)."""

    def __init__(
        self,
        directions: list[TaxonomyDirection],
        styles: list[TaxonomyStyle],
    ) -> None:
        self._dir_by_key: dict[str, TaxonomyDirection] = {}
        for d in directions:
            self._dir_by_key.setdefault(d.value, d)
            self._dir_by_key.setdefault(d.label, d)

        self._style_by_key: dict[tuple[UUID, str], TaxonomyStyle] = {}
        for s in styles:
            self._style_by_key.setdefault((s.direction_id, s.value), s)
            self._style_by_key.setdefault((s.direction_id, s.label), s)

    def direction(self, raw: str) -> TaxonomyDirection | None:
        return self._dir_by_key.get(raw)

    def style(self, direction_id: UUID, raw: str) -> TaxonomyStyle | None:
        return self._style_by_key.get((direction_id, raw))


async def _load_catalog(session: AsyncSession) -> _Catalog:
    directions = (
        (await session.execute(select(TaxonomyDirection))).scalars().all()
    )
    styles = (await session.execute(select(TaxonomyStyle))).scalars().all()
    return _Catalog(list(directions), list(styles))


def _normalize_methods(methods: list[str], catalog: _Catalog) -> list[str]:
    """Resolve every entry to its current catalog LABEL form. An entry that
    doesn't resolve (custom/free-text, or references a removed row) is kept
    verbatim -- matches parseMethods' own surfaced-unmatched behavior."""
    result: list[str] = []
    for raw in methods:
        sep_idx = raw.find(_SEP)
        part_dir = raw if sep_idx == -1 else raw[:sep_idx]
        part_style = None if sep_idx == -1 else raw[sep_idx + len(_SEP):]

        dir_row = catalog.direction(part_dir)
        if dir_row is None:
            result.append(raw)
            continue

        if part_style is None:
            result.append(dir_row.label)
            continue

        style_row = catalog.style(dir_row.id, part_style)
        if style_row is None:
            result.append(raw)
            continue

        result.append(f"{dir_row.label}{_SEP}{style_row.label}")
    return result


async def _telegram_id_for(session: AsyncSession, user_id: UUID) -> int | None:
    """Human-readable identifier for log lines -- there are only two real
    masters on production and the operator eyeballs this by hand, so a raw
    UUID alone is not enough to recognize which master a line is about."""
    user = await session.get(User, user_id)
    return user.telegram_id if user else None


async def _run_normalize(session: AsyncSession, dry_run: bool) -> None:
    catalog = await _load_catalog(session)
    profiles = (await session.execute(select(MasterProfile))).scalars().all()

    if not profiles:
        log("No master profiles found -- nothing to do.")
        return

    changed = 0
    unchanged = 0

    for profile in profiles:
        data = profile.data or {}
        prof = data.get("profile", {})
        methods = prof.get("methods", [])
        if not methods:
            unchanged += 1
            continue

        normalized = _normalize_methods(methods, catalog)
        if normalized == methods:
            unchanged += 1
            continue

        tg = await _telegram_id_for(session, profile.user_id)
        log(
            f"  {'[DRY] Would normalize' if dry_run else 'Normalizing'} "
            f"master {profile.user_id} (tg={tg}):\n"
            f"    before: {methods!r}\n"
            f"    after:  {normalized!r}"
        )

        if not dry_run:
            new_data = copy.deepcopy(data)
            new_data.setdefault("profile", {})["methods"] = normalized
            profile.set_jsonb("data", new_data)
            await record_audit(
                event=_AUDIT_EVENT,
                actor_id=None,
                actor_type="system",
                target_type="master_profile",
                target_id=profile.user_id,
                data={"before": methods, "after": normalized},
                session=session,
            )

        changed += 1

    log(
        f"\nSummary: {changed} profile(s) {'would be ' if dry_run else ''}normalized, "
        f"{unchanged} already in target form / empty."
    )


async def _run_rollback(session: AsyncSession, dry_run: bool) -> None:
    # Most recent normalization entry PER master (target_id), across the
    # whole audit log -- a master normalized twice only rolls back the last
    # apply (see module header).
    stmt = (
        select(AuditLog)
        .where(AuditLog.event == _AUDIT_EVENT)
        .order_by(AuditLog.target_id, AuditLog.created_at.desc())
    )
    entries = (await session.execute(stmt)).scalars().all()

    latest_by_master: dict[UUID, AuditLog] = {}
    for entry in entries:
        latest_by_master.setdefault(entry.target_id, entry)

    if not latest_by_master:
        log("No normalization audit entries found -- nothing to roll back.")
        return

    reverted = 0
    skipped = 0
    refused = 0

    for user_id, entry in latest_by_master.items():
        profile = await session.get(MasterProfile, user_id)
        if profile is None:
            warn(f"  Skipping {user_id} -- master profile no longer exists.")
            skipped += 1
            continue

        before = entry.data.get("before")
        after = entry.data.get("after")
        current = (profile.data or {}).get("profile", {}).get("methods", [])

        if current == before:
            # Already rolled back (a prior --rollback run, or coincidentally
            # already at that value) -- nothing to do, safe to re-run.
            skipped += 1
            continue

        if current != after:
            # ПРОМТ №549/550: current is NEITHER what we recorded as the
            # pre-normalize value NOR what we wrote -- something else
            # legitimately changed this row since normalization (e.g. an
            # admin approved a real method-change request). Deciding on
            # `current == before` alone cannot distinguish "not yet rolled
            # back" from "changed for an unrelated reason", and reverting to
            # `before` here would silently discard that real change.
            # REFUSE loudly instead of guessing either way -- named, with all
            # three values, so this is impossible to miss in the operator's
            # relayed output.
            tg = await _telegram_id_for(session, user_id)
            err(
                f"  REFUSED: master {user_id} (tg={tg}) -- current methods "
                f"match neither the recorded 'before' nor 'after' value. "
                f"This row changed for some other reason since "
                f"normalization; rolling back would discard that change.\n"
                f"    recorded before: {before!r}\n"
                f"    recorded after:  {after!r}\n"
                f"    current (live):  {current!r}"
            )
            refused += 1
            continue

        # current == after: exactly what normalize wrote, untouched since --
        # safe to restore to the pre-normalize value.
        tg = await _telegram_id_for(session, user_id)
        log(
            f"  {'[DRY] Would revert' if dry_run else 'Reverting'} "
            f"master {user_id} (tg={tg}):\n"
            f"    current: {current!r}\n"
            f"    restoring to: {before!r}"
        )

        if not dry_run:
            new_data = copy.deepcopy(profile.data) if profile.data else {}
            new_data.setdefault("profile", {})["methods"] = before
            profile.set_jsonb("data", new_data)

        reverted += 1

    log(
        f"\nSummary: {reverted} profile(s) {'would be ' if dry_run else ''}reverted, "
        f"{skipped} already at their recorded 'before' value or missing, "
        f"{refused} REFUSED (changed for another reason since normalization)."
    )


async def main_async(dry_run: bool, rollback: bool) -> None:
    factory = get_session_factory()
    async with factory() as session:
        try:
            if rollback:
                await _run_rollback(session, dry_run=dry_run)
            else:
                await _run_normalize(session, dry_run=dry_run)

            if not dry_run:
                await session.commit()
                log("Committed ✓")
            else:
                await session.rollback()
                log("Dry-run complete — no changes written.")
        except Exception as exc:
            await session.rollback()
            err(f"Run failed: {exc}")
            raise
        finally:
            await dispose_engine()


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "VELO -- Normalize master_profiles.data.profile.methods to one "
            "catalog-label format (T21-7)"
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be done without writing to DB",
    )
    parser.add_argument(
        "--rollback",
        action="store_true",
        help="Revert the most recent normalization per master",
    )
    args = parser.parse_args()
    asyncio.run(main_async(dry_run=args.dry_run, rollback=args.rollback))


if __name__ == "__main__":
    main()
