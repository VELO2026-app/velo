# =============================================================================
# VELO Backend -- Master Finance Router (E2)
# =============================================================================
#
# Master-facing income + transactions, projected from master_ledger.
#
# ENDPOINTS:
#   GET /api/v1/masters/me/income        -- period income + delta vs previous
#   GET /api/v1/masters/me/transactions  -- title-tagged transaction feed
#
# AUTH: get_current_master on all endpoints (verified master only).
# SESSION: get_db_reader -- read-only.
# =============================================================================

from typing import Literal

import structlog
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db_reader
from app.modules.auth.dependencies import get_current_master
from app.modules.masters.finance_schemas import (
    IncomeResponse,
    MasterTransactionItem,
    PaginatedTransactionsResponse,
)
from app.modules.masters.finance_service import (
    get_master_income,
    list_master_transactions,
)
from app.modules.masters.models import MasterProfile
from app.modules.users.models import User

logger = structlog.get_logger()

router = APIRouter(prefix="/api/v1/masters", tags=["master-finance"])


@router.get("/me/income", response_model=IncomeResponse)
async def get_my_income_endpoint(
    period: Literal["week", "month", "quarter"] = Query(default="week"),
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_reader),
) -> IncomeResponse:
    """Income for the current calendar period + delta against the previous one.

    Net of title-tagged movements (sale - commission - refund). The period is
    a calendar week (Mon..Sun), month or quarter -- bounds come from
    core.periods, same as the dashboard grid; delta_pct is null on the first
    period.
    """
    user, _profile = master_tuple
    data = await get_master_income(user.id, period, session)
    return IncomeResponse(**data)


@router.get("/me/transactions", response_model=PaginatedTransactionsResponse)
async def list_my_transactions_endpoint(
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_reader),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> PaginatedTransactionsResponse:
    """List my transactions (title-tagged ledger movements, newest first)."""
    user, _profile = master_tuple
    items, total = await list_master_transactions(
        user.id, session, limit=limit, offset=offset,
    )
    return PaginatedTransactionsResponse(
        items=[MasterTransactionItem(**row) for row in items],
        total=total,
        limit=limit,
        offset=offset,
    )
