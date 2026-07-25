# =============================================================================
# VELO Backend -- Admin Practices Router (E9 / 4c)
# =============================================================================
#
# ENDPOINTS:
#   GET /api/v1/admin/practices?scope=all|upcoming|past  -- global list
#   GET /api/v1/admin/practices/{practice_id}            -- detail + roster
#
# ROUTE ORDER: static /practices before dynamic /practices/{id}.
# AUTH: get_current_admin. SESSION: get_db_reader -- read-only.
# =============================================================================

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db_reader
from app.modules.admin.practices.schemas import (
    AdminPracticeDetailResponse,
    AdminZoomAttendanceResponse,
    PaginatedAdminPracticesResponse,
)
from app.modules.admin.practices.service import (
    get_admin_practice_detail,
    get_admin_zoom_attendance,
    list_admin_practices,
)
from app.modules.auth.dependencies import get_current_admin
from app.modules.users.models import User

router = APIRouter()


@router.get("/practices", response_model=PaginatedAdminPracticesResponse)
async def list_practices_endpoint(
    scope: Literal["all", "upcoming", "past"] = Query(default="all"),
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_reader),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> PaginatedAdminPracticesResponse:
    """List all platform practices (except draft/deleted), newest first."""
    return await list_admin_practices(
        session, scope=scope, limit=limit, offset=offset,
    )


@router.get(
    "/practices/{practice_id}", response_model=AdminPracticeDetailResponse,
)
async def practice_detail_endpoint(
    practice_id: UUID,
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_reader),
) -> AdminPracticeDetailResponse:
    """Practice detail, attendance counts, and the non-cancelled roster.

    404 if the practice does not exist or is soft-deleted.
    """
    return await get_admin_practice_detail(practice_id, session)


@router.get(
    "/practices/{practice_id}/zoom-attendance",
    response_model=AdminZoomAttendanceResponse,
)
async def practice_zoom_attendance_endpoint(
    practice_id: UUID,
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_reader),
) -> AdminZoomAttendanceResponse:
    """Per-booking Zoom-derived attendance totals + the raw unmatched
    bucket, for reconciliation (E21 step G, ПРОМТ №521).

    404 if the practice does not exist or is soft-deleted. An empty
    zoom_meeting_status (null) means no Zoom meeting was ever created for
    this practice at all (pre-E21, or creation never succeeded).
    """
    return await get_admin_zoom_attendance(practice_id, session)
