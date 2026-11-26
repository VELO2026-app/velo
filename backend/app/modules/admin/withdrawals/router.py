# =============================================================================
# VELO Backend -- Admin Withdrawals Router (Phase 6.6, Batch 3)
# =============================================================================
#
# ENDPOINTS:
#   POST /api/v1/admin/withdrawals/{id}/approve
#   POST /api/v1/admin/withdrawals/{id}/reject
#   GET  /api/v1/admin/withdrawals
#
# AUTH: get_current_admin on every endpoint.
# SESSION: flush() + refresh(), no commit (P-01).
# =============================================================================

from typing import Literal
from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db_reader, get_db_session
from app.modules.admin.withdrawals.schemas import (
    AdminWithdrawalResponse,
    ApproveWithdrawalRequest,
    PaginatedAdminWithdrawalsResponse,
    RejectWithdrawalRequest,
)
from app.modules.admin.withdrawals.service import (
    approve_withdrawal,
    list_withdrawals_admin,
    reject_withdrawal,
    to_admin_withdrawal_responses,
)
from app.modules.auth.dependencies import get_current_admin
from app.modules.users.models import User

logger = structlog.get_logger()

router = APIRouter(prefix="/withdrawals")


@router.post(
    "/{withdrawal_id}/approve",
    response_model=AdminWithdrawalResponse,
)
async def approve_withdrawal_endpoint(
    withdrawal_id: UUID,
    body: ApproveWithdrawalRequest,
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_session),
) -> AdminWithdrawalResponse:
    """Approve a pending withdrawal -- debit frozen, credit company fee."""
    withdrawal = await approve_withdrawal(
        withdrawal_id, admin, body.note, session,
    )
    await session.flush()
    await session.refresh(withdrawal)
    (response,) = await to_admin_withdrawal_responses(session, [withdrawal])
    return response


@router.post(
    "/{withdrawal_id}/reject",
    response_model=AdminWithdrawalResponse,
)
async def reject_withdrawal_endpoint(
    withdrawal_id: UUID,
    body: RejectWithdrawalRequest,
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_session),
) -> AdminWithdrawalResponse:
    """Reject a pending withdrawal -- unfreeze funds back to available."""
    withdrawal = await reject_withdrawal(
        withdrawal_id, admin, body.note, session,
    )
    await session.flush()
    await session.refresh(withdrawal)
    (response,) = await to_admin_withdrawal_responses(session, [withdrawal])
    return response


@router.get(
    "",
    response_model=PaginatedAdminWithdrawalsResponse,
)
async def list_withdrawals_endpoint(
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_reader),
    # P-11: Literal validates status at FastAPI layer (422 on invalid value).
    status: Literal["pending", "approved", "rejected"] | None = Query(
        default=None,
    ),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> PaginatedAdminWithdrawalsResponse:
    """List all withdrawals (admin view, optional status filter)."""
    return await list_withdrawals_admin(
        session,
        status_filter=status,
        limit=limit,
        offset=offset,
    )
