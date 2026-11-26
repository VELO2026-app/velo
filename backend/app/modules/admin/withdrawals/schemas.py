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


class AdminWithdrawalResponse(BaseModel):
    """Single withdrawal record for admin view."""

    id: UUID
    user_id: UUID
    # BE-226: the master's name, as the finance console reads it -- first
    # and last name, "Мастер" when the account has neither (the rule of
    # admin/revenue's per-master rows, so both lists name a master alike).
    master_name: str
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

    model_config = {"from_attributes": True}


class PaginatedAdminWithdrawalsResponse(BaseModel):
    """Paginated list of withdrawals for admin."""

    items: list[AdminWithdrawalResponse]
    total: int
    limit: int
    offset: int
