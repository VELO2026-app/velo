#!/usr/bin/env python3
# =============================================================================
# VELO Backend -- One-time repair: add missing company_ledger topup entries
# =============================================================================
#
# PROBLEM:
#   Before this fix, topups (stripe + stub) created UserLedger(+N) without
#   the balancing CompanyLedger(-N). This breaks semaphore 2.1 (SUM ≠ 0).
#
# WHAT THIS SCRIPT DOES:
#   For every UserLedger entry with reason LIKE 'payment:%' (real topup)
#   that has no matching CompanyLedger entry, creates the missing entry.
#
# SAFE TO RE-RUN:
#   Idempotent — checks for existing entry before inserting.
#
# USAGE (inside Docker container):
#   python scripts/repair_topup_company_ledger.py
#   python scripts/repair_topup_company_ledger.py --dry-run
#
# AFTER RUNNING:
#   Semaphore 2.1 should return OK (SUM = 0).
#   Seed data still needs a reset of its profile (`pridem seed velo
#   --profile <name> --reset --confirm <server>`) because seed topups
#   use reason 'seed:topup' (handled by CompanyLedger reason LIKE 'seed:%').
# =============================================================================

import argparse
import asyncio
import sys
from pathlib import Path

_backend_dir = Path(__file__).resolve().parent.parent
if str(_backend_dir) not in sys.path:
    sys.path.insert(0, str(_backend_dir))

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import dispose_engine, get_session_factory
from app.modules.payments.models import (
    CompanyLedger,
    CompanyLedgerType,
    LedgerStatus,
    UserLedger,
)

# Terminal colors.
G = "\033[0;32m"
Y = "\033[1;33m"
R = "\033[0;31m"
N = "\033[0m"


def log(msg: str) -> None:
    print(f"{G}[REPAIR]{N} {msg}")


def warn(msg: str) -> None:
    print(f"{Y}[WARN]{N} {msg}")


def err(msg: str) -> None:
    print(f"{R}[ERROR]{N} {msg}")


async def repair(dry_run: bool = False) -> None:
    """Find and fix missing company_ledger entries for real topups."""
    factory = get_session_factory()
    async with factory() as session:
        try:
            await _repair(session, dry_run=dry_run)
            if not dry_run:
                await session.commit()
                log("Committed ✓")
            else:
                await session.rollback()
                log("Dry-run complete — no changes written.")
        except Exception as exc:
            await session.rollback()
            err(f"Repair failed: {exc}")
            raise
        finally:
            await dispose_engine()


async def _repair(session: AsyncSession, dry_run: bool) -> None:
    """Core repair logic."""
    # Find all real topup UserLedger entries (reason starts with 'payment:').
    # Seed topups ('seed:topup') are excluded — they need a reset of the seed.
    stmt = select(UserLedger).where(
        UserLedger.reason.like("payment:%"),
        UserLedger.amount_cents > 0,
        UserLedger.status == LedgerStatus.DONE.value,
    )
    result = await session.execute(stmt)
    topup_entries = result.scalars().all()

    log(f"Found {len(topup_entries)} real topup UserLedger entries.")

    created = 0
    skipped = 0

    for entry in topup_entries:
        # Expected company reason: 'topup:{payment_id}' where payment_id
        # is extracted from UserLedger.reason = 'payment:{payment_id}'.
        payment_id_str = entry.reason.removeprefix("payment:")
        company_reason = f"topup:{payment_id_str}"

        # Check if company entry already exists (idempotency).
        existing_stmt = select(CompanyLedger.id).where(
            CompanyLedger.reason == company_reason,
        ).limit(1)
        existing = (await session.execute(existing_stmt)).scalar_one_or_none()

        if existing is not None:
            skipped += 1
            continue

        # Create the missing balancing entry.
        if not dry_run:
            company_entry = CompanyLedger(
                amount_cents=-entry.amount_cents,
                type=CompanyLedgerType.TOPUP.value,
                status=LedgerStatus.DONE.value,
                reason=company_reason,
                # reference_id: we only have user_ledger here, not Payment.id.
                # The reason field is sufficient for traceability.
                reference_id=None,
            )
            session.add(company_entry)
            await session.flush()

        log(
            f"  {'[DRY] Would create' if dry_run else 'Created'} "
            f"CompanyLedger(amount={-entry.amount_cents}, reason={company_reason!r})"
        )
        created += 1

    print()
    log(f"Summary: {created} entries {'would be ' if dry_run else ''}created, {skipped} already exist.")

    if created > 0 and not dry_run:
        # Verify the global sum is now closer to 0.
        from sqlalchemy import func
        from app.modules.payments.models import MasterLedger

        user_sum = (await session.execute(
            select(func.coalesce(func.sum(UserLedger.amount_cents), 0))
            .where(UserLedger.status == LedgerStatus.DONE.value)
        )).scalar_one()

        master_sum = (await session.execute(
            select(func.coalesce(func.sum(MasterLedger.amount_cents), 0))
            .where(MasterLedger.status == LedgerStatus.DONE.value)
        )).scalar_one()

        company_sum = (await session.execute(
            select(func.coalesce(func.sum(CompanyLedger.amount_cents), 0))
            .where(CompanyLedger.status == LedgerStatus.DONE.value)
        )).scalar_one()

        global_sum = user_sum + master_sum + company_sum
        status = (
            f"{G}OK{N}"
            if global_sum == 0
            else (
                f"{Y}STILL {global_sum}{N} (reset the seed's profile -- "
                "`pridem seed velo --profile <name> --reset` -- to fix seed data)"
            )
        )
        log(f"2.1 global sum after repair: {status}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="VELO -- Repair missing company_ledger topup entries",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be done without writing to DB",
    )
    args = parser.parse_args()
    asyncio.run(repair(dry_run=args.dry_run))


if __name__ == "__main__":
    main()
