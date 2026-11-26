# =============================================================================
# VELO Backend -- Master Reviews Router (#3 -- cross-practice attention feed)
# =============================================================================
#
# ENDPOINT:
#   GET /api/v1/masters/me/reviews?attention=true|false&period=&limit=&offset=
#     -> paginated named reviews across the master's completed practices.
#
# attention=true serves the dashboard "Требуют внимания" block (ratings
# 1-4, zones bad and low); attention=false serves the full cross-practice
# feed. Mirrors E1's per-practice ?attention= switch.
#
# period=week|month|quarter (BE-228) narrows the feed to the practices of the
# master's own calendar period -- the same window and the same practices as
# GET /masters/me/analytics. Without it the feed is as it always was.
#
# AUTH: get_current_master (verified master only). SESSION: get_db_reader.
# =============================================================================

from typing import Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db_reader
from app.modules.auth.dependencies import get_current_master
from app.modules.masters.models import MasterProfile
from app.modules.masters.reviews_schemas import (
    PaginatedMasterReviewsResponse,
)
from app.modules.masters.reviews_service import list_master_reviews
from app.modules.users.models import User

router = APIRouter(prefix="/api/v1/masters", tags=["master-reviews"])


@router.get("/me/reviews", response_model=PaginatedMasterReviewsResponse)
async def list_my_reviews_endpoint(
    attention: bool = Query(default=False),
    period: Literal["week", "month", "quarter"] | None = Query(default=None),
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_reader),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> PaginatedMasterReviewsResponse:
    """Named reviews across the master's completed practices.

    attention=true narrows to ratings 1-4 (zones bad and low) for the
    dashboard "needs attention" block; otherwise returns the full feed.

    period (BE-228) keeps only the reviews of practices scheduled in the
    master's own calendar week / month / quarter, bounded exactly as
    /me/analytics bounds it. Paging is unchanged: limit and offset apply to
    the narrowed feed, and `total` counts all of it, so a caller that asks
    for the period can tell whether the page held everything.
    """
    user, _profile = master_tuple
    items, total = await list_master_reviews(
        user, session,
        attention=attention, period=period, limit=limit, offset=offset,
    )
    return PaginatedMasterReviewsResponse(
        items=items, total=total, limit=limit, offset=offset,
    )
