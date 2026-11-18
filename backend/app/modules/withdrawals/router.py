# =============================================================================
# VELO Backend -- Withdrawal Router (Phase 6.6)
# =============================================================================
#
# Master-facing endpoints for withdrawal requests.
#
# ENDPOINTS:
#   POST /api/v1/masters/me/withdraw      -- create withdrawal request
#   GET  /api/v1/masters/me/withdrawals   -- list my withdrawals (paginated)
#
# AUTH: get_current_master on all endpoints (verified master only).
# =============================================================================

import structlog
from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db_reader, get_db_session
from app.core.options import option_dependency
from app.modules.auth.dependencies import get_current_master
from app.modules.masters.models import MasterProfile
from app.modules.users.models import User
from app.modules.withdrawals.schemas import (
    CreateWithdrawalRequest,
    PaginatedWithdrawalsResponse,
    WithdrawalResponse,
)
from app.modules.withdrawals.service import (
    create_withdrawal,
    list_my_withdrawals,
)

logger = structlog.get_logger()

router = APIRouter(
    prefix="/api/v1/masters",
    tags=["withdrawals"],
    # BE-182: the option `payments` closes this router (app/core/options.py).
    dependencies=[option_dependency("payments")],
)


@router.post(
    "/me/withdraw",
    response_model=WithdrawalResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_withdrawal_endpoint(
    body: CreateWithdrawalRequest,
    master_tuple: tuple[User, MasterProfile] = Depends(
        get_current_master,
    ),
    session: AsyncSession = Depends(get_db_session),
) -> WithdrawalResponse:
    """Create a withdrawal request.

    Freezes the requested amount from available balance.
    Requires payout details to be configured first.
    """
    user, profile = master_tuple
    withdrawal = await create_withdrawal(
        user=user,
        profile=profile,
        amount_cents=body.amount_cents,
        session=session,
    )
    await session.flush()
    await session.refresh(withdrawal)
    return WithdrawalResponse.model_validate(
        withdrawal, from_attributes=True,
    )


@router.get(
    "/me/withdrawals",
    response_model=PaginatedWithdrawalsResponse,
)
async def list_my_withdrawals_endpoint(
    master_tuple: tuple[User, MasterProfile] = Depends(
        get_current_master,
    ),
    session: AsyncSession = Depends(get_db_reader),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> PaginatedWithdrawalsResponse:
    """List my withdrawal requests (newest first, paginated)."""
    user, _profile = master_tuple
    return await list_my_withdrawals(
        user_id=user.id,
        session=session,
        limit=limit,
        offset=offset,
    )
