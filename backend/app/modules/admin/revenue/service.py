# =============================================================================
# VELO Backend -- Admin Revenue Service (E9 / 4b)
# =============================================================================
#
# Read-only platform revenue aggregate over a calendar period (week|month, UTC).
#
#   revenue_cents    = SUM(Purchase.paid_cents) WHERE status=completed AND
#                      completed_at in period            (GMV / gross sales)
#   commission_cents = SUM(CompanyLedger.amount_cents) WHERE type=commission
#                      AND status=done AND created_at in period
#   payout_cents     = SUM(amount_cents - fee_cents) WHERE status=approved AND
#                      approved_at in period             (net paid to masters)
#   per_master[]     = per master: earned (title-tagged MasterLedger movements,
#                      E2) + payout (net approved withdrawals), in the period;
#                      sorted by earned_cents desc.
#
# CALENDAR BOUNDS come from core.periods (single source of truth, E7); revenue
# is a single-period aggregate, so the previous-period start is ignored.
#
# offset (W9, PROMPT №387): steps the window by whole periods, mirroring the
# admin dashboard's other engagement metrics (admin/metrics/service.py,
# admin/stats/overview_service.py) -- the revenue card previously had no
# offset support at all, so it silently ignored the dashboard's week/month
# stepper while its sibling cards respected it.
#
# All metrics are platform-wide. SESSION: read-only, no commit (P-01), ORM-only.
# =============================================================================

from datetime import UTC, datetime
from uuid import UUID

import structlog
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.periods import calendar_period_bounds, shift_anchor
from app.modules.admin.revenue.schemas import (
    AdminRevenuePerMaster,
    AdminRevenueResponse,
)
from app.modules.payments.models import (
    CompanyLedger,
    CompanyLedgerType,
    LedgerStatus,
    MasterLedger,
    Purchase,
    PurchaseStatus,
)
from app.modules.users.models import User
from app.modules.withdrawals.models import Withdrawal, WithdrawalStatus

logger = structlog.get_logger()


def _master_name(first_name: str | None, last_name: str | None) -> str:
    """Display name: first + last, else a neutral label (this is a master)."""
    name = " ".join(part for part in (first_name, last_name) if part).strip()
    return name or "Мастер"


async def get_admin_revenue(
    period: str,
    session: AsyncSession,
    *,
    offset: int = 0,
) -> AdminRevenueResponse:
    """Platform revenue, commission, payout, and per-master breakdown.

    `offset` steps the window by whole periods (0 = current, -1 = previous
    week/month, +1 = next), same convention as the dashboard's other
    engagement metrics. Default 0 preserves prior behavior.
    """
    # Single-period aggregate: the previous-period start is unused here.
    anchor = shift_anchor(period, datetime.now(UTC), offset)
    start, end, _prev_start = calendar_period_bounds(period, anchor)

    # -- revenue (GMV): gross sales of completed purchases in the period --
    revenue_cents = (
        await session.execute(
            select(func.coalesce(func.sum(Purchase.paid_cents), 0)).where(
                Purchase.status == PurchaseStatus.COMPLETED.value,
                Purchase.completed_at >= start,
                Purchase.completed_at < end,
            )
        )
    ).scalar_one()

    # -- commission: platform's cut booked into the company ledger --
    commission_cents = (
        await session.execute(
            select(func.coalesce(func.sum(CompanyLedger.amount_cents), 0)).where(
                CompanyLedger.type == CompanyLedgerType.COMMISSION.value,
                CompanyLedger.status == LedgerStatus.DONE.value,
                CompanyLedger.created_at >= start,
                CompanyLedger.created_at < end,
            )
        )
    ).scalar_one()

    # -- payout: net paid out to masters via approved withdrawals --
    payout_cents = (
        await session.execute(
            select(
                func.coalesce(
                    func.sum(Withdrawal.amount_cents - Withdrawal.fee_cents), 0,
                )
            ).where(
                Withdrawal.status == WithdrawalStatus.APPROVED.value,
                Withdrawal.approved_at >= start,
                Withdrawal.approved_at < end,
            )
        )
    ).scalar_one()

    # -- per-master earnings (title-tagged ledger movements, E2 income) --
    earned_rows = (
        await session.execute(
            select(
                MasterLedger.user_id,
                func.sum(MasterLedger.amount_cents),
            )
            .where(
                MasterLedger.title.isnot(None),
                MasterLedger.status == LedgerStatus.DONE.value,
                MasterLedger.created_at >= start,
                MasterLedger.created_at < end,
            )
            .group_by(MasterLedger.user_id)
        )
    ).all()
    earned_map: dict[UUID, int] = {uid: total for uid, total in earned_rows}

    # -- per-master payouts (net approved withdrawals) --
    payout_rows = (
        await session.execute(
            select(
                Withdrawal.user_id,
                func.sum(Withdrawal.amount_cents - Withdrawal.fee_cents),
            )
            .where(
                Withdrawal.status == WithdrawalStatus.APPROVED.value,
                Withdrawal.approved_at >= start,
                Withdrawal.approved_at < end,
            )
            .group_by(Withdrawal.user_id)
        )
    ).all()
    payout_map: dict[UUID, int] = {uid: total for uid, total in payout_rows}

    master_ids = set(earned_map) | set(payout_map)

    names: dict[UUID, str] = {}
    if master_ids:
        name_rows = (
            await session.execute(
                select(User.id, User.first_name, User.last_name).where(
                    User.id.in_(master_ids)
                )
            )
        ).all()
        names = {
            uid: _master_name(first, last) for uid, first, last in name_rows
        }

    per_master = sorted(
        (
            AdminRevenuePerMaster(
                master_id=mid,
                name=names.get(mid, "Мастер"),
                earned_cents=earned_map.get(mid, 0),
                payout_cents=payout_map.get(mid, 0),
            )
            for mid in master_ids
        ),
        key=lambda item: (-item.earned_cents, str(item.master_id)),
    )

    return AdminRevenueResponse(
        revenue_cents=revenue_cents,
        commission_cents=commission_cents,
        payout_cents=payout_cents,
        per_master=per_master,
    )
