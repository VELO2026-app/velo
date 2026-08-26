# =============================================================================
# VELO Backend -- Admin Curator Groups Router (P4, GT-9)
# =============================================================================
#
# ENDPOINTS:
#   GET /api/v1/admin/curator-groups   -- every school, active or frozen
#
# ONE METHOD, BY DECISION. There is no DELETE and no PATCH here (TZ 1,
# Q-ADMINDEL): a school belongs to its curator, and the admin's job is to
# see it, not to run it. Adding a write path later is a decision somebody
# has to take on purpose rather than a gap somebody fills in passing.
#
# AUTH: get_current_admin, like every other endpoint under this prefix.
# SESSION: get_db_reader -- nothing here writes.
#
# The prefix and the "admin" tag are inherited from admin/router.py.
# =============================================================================

import structlog
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db_reader
from app.modules.admin.curator_groups.schemas import (
    PaginatedAdminCuratorGroupsResponse,
)
from app.modules.admin.curator_groups.service import (
    list_curator_groups_for_admin,
)
from app.modules.auth.dependencies import get_current_admin
from app.modules.users.models import User

logger = structlog.get_logger()

router = APIRouter(prefix="/curator-groups")


@router.get("", response_model=PaginatedAdminCuratorGroupsResponse)
async def list_curator_groups_endpoint(
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_reader),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> PaginatedAdminCuratorGroupsResponse:
    """Every school on the platform, including the frozen ones.

    is_active carries the difference instead of a filter: for its own
    members a frozen school is a 404 (I-6), and this listing is the only
    place it can be seen at all.
    """
    return await list_curator_groups_for_admin(
        session, limit=limit, offset=offset,
    )
