# =============================================================================
# VELO Backend -- Master Finance Schemas (E2)
# =============================================================================
#
# Master-facing income + transactions, projected from master_ledger.
#
# IncomeResponse:                GET /masters/me/income -- period income + delta.
# MasterTransactionItem:         one title-tagged ledger movement.
# PaginatedTransactionsResponse: GET /masters/me/transactions -- paginated feed.
#
# Only title-tagged ledger rows (sale / commission / refund) surface here;
# internal plumbing (frozen<->available reversals, withdrawal holds) is NULL
# and excluded. See record_master_ledger(title=...) and the E2 tagging map.
# =============================================================================

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class IncomeResponse(BaseModel):
    """GET /api/v1/masters/me/income?period=week|month|quarter.

    income_cents       -- gross booked turnover for the current calendar period:
                          signed sum of title-tagged sale (+) / commission (-) /
                          refund (-) movements, frozen sales included. Matches
                          the transaction feed, not realized/available earnings.
    prev_income_cents  -- same sum for the previous calendar period.
    delta_pct          -- signed percent change vs the previous period, or null
                          when the previous period had no net-positive turnover.
    """

    income_cents: int
    prev_income_cents: int
    delta_pct: int | None


class MasterTransactionItem(BaseModel):
    """One master-facing transaction (a title-tagged master_ledger row).

    amount_cents is signed: positive = credit (sale), negative = debit
    (commission, refund). counterparty_name is the paying student for a
    sale/refund and null for platform-side rows (commission). practice_title
    (M5) is the name of the practice the movement belongs to, joined from the
    ledger row's practice_id — null when the row has no practice or it was
    deleted; the client falls back to `title` then.
    """

    title: str
    practice_title: str | None
    created_at: datetime
    counterparty_name: str | None
    amount_cents: int

    model_config = ConfigDict(from_attributes=True)


class PaginatedTransactionsResponse(BaseModel):
    """GET /api/v1/masters/me/transactions -- paginated transaction feed."""

    items: list[MasterTransactionItem]
    total: int
    limit: int
    offset: int
