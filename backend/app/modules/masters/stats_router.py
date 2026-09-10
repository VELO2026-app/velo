# =============================================================================
# VELO Backend -- Master Stats Router (E7)
# =============================================================================
#
# Master-facing period-scoped stat grid for the dashboard.
#
# ENDPOINT:
#   GET /api/v1/masters/me/stats?period=week|month|quarter
#       -- practices + participants + income for the period, each with a
#          period-over-period delta.
#
# AUTH: get_current_master (verified master only).
# SESSION: get_db_reader -- read-only.
# =============================================================================

from typing import Literal

import structlog
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db_reader
from app.modules.auth.dependencies import get_current_master
from app.modules.masters.models import MasterProfile
from app.modules.masters.stats_schemas import MasterStatsResponse
from app.modules.masters.stats_service import get_master_stats
from app.modules.users.models import User

logger = structlog.get_logger()

router = APIRouter(prefix="/api/v1/masters", tags=["master-stats"])


@router.get("/me/stats", response_model=MasterStatsResponse)
async def get_my_stats_endpoint(
    period: Literal["week", "month", "quarter"] = Query(default="week"),
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_reader),
) -> MasterStatsResponse:
    """Period-scoped stats for the current master + deltas vs the previous one."""
    user, _profile = master_tuple
    data = await get_master_stats(user.id, period, session)
    return MasterStatsResponse(**data)
