# =============================================================================
# VELO Backend -- Admin Withdrawals Schemas (Phase 6.6, Batch 3, NO-LITERALS)
# =============================================================================
#
# NO-LITERALS: note field limits sourced from
#   settings.admin_action_note_max_length -- change once, applies everywhere.
#
# CR-01: AdminWithdrawalResponse.status uses WithdrawalStatus StrEnum.
# =============================================================================

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field

from app.core.config import settings
from app.modules.masters.schemas import PayoutDetails
from app.modules.withdrawals.models import WithdrawalStatus


class ApproveWithdrawalRequest(BaseModel):
    """POST /admin/withdrawals/{id}/approve -- optional admin note."""

    note: str | None = Field(
        default=None, max_length=settings.admin_action_note_max_length,
    )


class RejectWithdrawalRequest(BaseModel):
    """POST /admin/withdrawals/{id}/reject -- reason required."""

    note: str = Field(
        min_length=1, max_length=settings.admin_action_note_max_length,
    )


class AdminWithdrawalRow(BaseModel):
    """A withdrawal as it is stored: the fields of the admin view without the
    master's name. Built from the ORM row; AdminWithdrawalResponse adds the
    name (BE-226)."""

    id: UUID
    user_id: UUID
    amount_cents: int
    fee_cents: int
    currency: str
    status: WithdrawalStatus
    payout_details: PayoutDetails
    admin_id: UUID | None = None
    admin_note: str | None = None
    approved_at: datetime | None = None
    rejected_at: datetime | None = None
    created_at: datetime
    updated_at: datetime | None = None


class AdminWithdrawalResponse(AdminWithdrawalRow):
    """Single withdrawal record for admin view."""

    # BE-226: the master's name, as practices.service.master_full_name builds
    # it -- the one rule for a master's name: first and last name, "Мастер"
    # when the account has neither.
    master_name: str


class PaginatedAdminWithdrawalsResponse(BaseModel):
    """Paginated list of withdrawals for admin."""

    items: list[AdminWithdrawalResponse]
    total: int
    limit: int
    offset: int
