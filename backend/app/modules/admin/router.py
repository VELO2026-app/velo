# =============================================================================
# VELO Backend -- Admin Router (Phase 3.1, updated 7.3 + E9/4a + 4b + 4c)
# =============================================================================
#
# Main router for all admin endpoints. Includes sub-routers:
#   - masters/      -- verify/reject master applications (Phase 2.3)
#   - stats/        -- platform statistics (Phase 3.1) + overview (E7)
#   - users/        -- user and master listings (Phase 3.2)
#   - reports/      -- report management (Phase 3.3)
#   - withdrawals/  -- approve/reject withdrawals (Phase 6.6)
#   - promos/       -- company promo management (Phase 6.7)
#   - metrics/      -- engagement metrics drill-ins (E9/4a)
#   - revenue/      -- platform revenue drill-in (E9/4b)
#   - practices/    -- global practices oversight (E9/4c)
#   - participants/ -- global participants list (E1)
#   - taxonomy/     -- direction/style catalog CRUD (R5, batch R)
#   - curator_groups/ -- read-only oversight of the schools (P4, GT-9)
#
# Direct endpoints on this router:
#   - POST /announcements -- system.announcement via comms (Phase 6/T1)
#
# All sub-routers inherit the /api/v1/admin prefix and "admin" tag.
# Auth: get_current_admin dependency is applied per-endpoint in
# each sub-router, not globally here.
# =============================================================================

import structlog
from fastapi import APIRouter, Depends

from app.modules.admin.curator_groups.router import (            # P4/GT-9
    router as curator_groups_router,
)
from app.modules.admin.masters.router import router as masters_router
from app.modules.admin.metrics.router import router as metrics_router
from app.modules.admin.participants.router import router as participants_router
from app.modules.admin.practices.router import router as practices_router
from app.modules.admin.revenue.router import router as revenue_router
from app.modules.admin.promos.router import router as promos_router
from app.modules.admin.reports.router import router as reports_router
from app.modules.admin.stats.router import router as stats_router
from app.modules.admin.stats.overview_router import (              # E7
    router as stats_overview_router,
)
from app.modules.admin.taxonomy.router import router as taxonomy_router  # R5
from app.modules.admin.users.router import router as users_router
from app.modules.admin.withdrawals.router import router as withdrawals_router
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db_session
from app.modules.auth.dependencies import get_current_admin
from app.modules.users.models import User

logger = structlog.get_logger()

router = APIRouter(prefix="/api/v1/admin", tags=["admin"])

router.include_router(masters_router)
router.include_router(stats_router)
router.include_router(stats_overview_router)  # E7
router.include_router(users_router)
router.include_router(reports_router)
router.include_router(withdrawals_router)
router.include_router(promos_router)
router.include_router(metrics_router)        # E9/4a
router.include_router(revenue_router)        # E9/4b
router.include_router(practices_router)      # E9/4c
router.include_router(participants_router)   # E1
router.include_router(taxonomy_router)       # R5
router.include_router(curator_groups_router)  # P4/GT-9


# ---------------------------------------------------------------------------
# System announcements (Phase 6 / T1, approved fork В6)
# ---------------------------------------------------------------------------
# The dictionary §2 has system.announcement (group:all / group:masters)
# but velo had no domain feature that produces one -- this endpoint IS
# the emit point: a thin admin-only handle over emit_notification. The
# audience is COMMUNICATIONAL (C-boundary ID-4): one emit, comms
# expands "all" / group:masters over its synced contact book. The type
# is category-less (decision A) -> always delivered.
# (The old POST /templates/reload died with modules/notifications --
# comms owns templates now; editing them = commit to comms-profile/ +
# comms restart, see the T1 cutover checklist.)


class AnnouncementRequest(BaseModel):
    """Admin announcement: pre-rendered title/body + audience pick."""

    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=200)
    body: str = Field(min_length=1, max_length=2000)
    audience: Literal["all", "masters"] = "all"


@router.post("/announcements")
async def create_announcement(
    request: AnnouncementRequest,
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """Emit a system.announcement through the comms outbox."""
    from app.core.events.notify import (
        TARGET_ALL,
        TARGET_GROUP_MASTERS,
        emit_notification,
    )

    target_type, target_value = (
        TARGET_ALL if request.audience == "all" else TARGET_GROUP_MASTERS
    )
    event = await emit_notification(
        session,
        type="system.announcement",
        target_type=target_type,
        target_value=target_value,
        title=request.title,
        body=request.body,
        action_data={"action": "open_notifications", "params": {}},
    )

    logger.info(
        "announcement_emitted",
        admin_id=str(admin.id),
        audience=request.audience,
        outbox_event_id=event.id,
    )
    return {"queued": True, "audience": request.audience}
