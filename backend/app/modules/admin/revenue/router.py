# =============================================================================
# VELO Backend -- Admin Revenue Router (E9 / 4b)
# =============================================================================
#
# ENDPOINT:
#   GET /api/v1/admin/revenue?period=week|month&offset=N
#       -- platform revenue (GMV) + commission + payout + per-master breakdown.
#       offset (W9, PROMPT №387): same stepper convention as admin/metrics.
#
# AUTH: get_current_admin. SESSION: get_db_reader -- read-only.
# =============================================================================

from typing import Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db_reader
from app.modules.admin.revenue.schemas import AdminRevenueResponse
from app.modules.admin.revenue.service import get_admin_revenue
from app.modules.auth.dependencies import get_current_admin
from app.modules.users.models import User

router = APIRouter()


@router.get("/revenue", response_model=AdminRevenueResponse)
async def revenue_endpoint(
    period: Literal["week", "month"] = Query(default="week"),
    offset: int = Query(default=0),
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_reader),
) -> AdminRevenueResponse:
    """Platform revenue, commission, payout, and per-master breakdown."""
    return await get_admin_revenue(period, session, offset=offset)
