# =============================================================================
# VELO Backend -- Admin Reports Router (Phase 3.3, updated F8-fix)
# =============================================================================
#
# ENDPOINTS:
#   GET  /api/v1/admin/reports                -- list reports (filters, pagination)
#   GET  /api/v1/admin/reports/{id}           -- single report by id (F8-fix W-2)
#   POST /api/v1/admin/reports/{id}/resolve   -- resolve a pending report
#   POST /api/v1/admin/reports/{id}/dismiss   -- dismiss a pending report
#
# ROUTE ORDER: GET /{id} must be registered before POST /{id}/resolve|dismiss
#   to avoid any potential ambiguity (FastAPI resolves in declaration order).
#
# AUTH: get_current_admin on all endpoints.
# SESSION: get_db_reader for listing + single fetch, get_db_session for mutations.
# =============================================================================

from typing import Literal
from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db_reader, get_db_session
from app.modules.admin.reports.schemas import (
    AdminReportResponse,
    DismissReportRequest,
    PaginatedReportsResponse,
    ResolveReportRequest,
)
from app.modules.admin.reports.service import (
    dismiss_report,
    get_report_by_id,
    list_reports,
    resolve_report,
    to_admin_report_responses,
)
from app.modules.auth.dependencies import get_current_admin
from app.modules.users.models import User

logger = structlog.get_logger()

router = APIRouter(prefix="/reports")


@router.get("", response_model=PaginatedReportsResponse)
async def get_reports(
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_reader),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    status: Literal["pending", "resolved", "dismissed"] | None = Query(default=None),
    target_type: Literal["user", "master", "practice"] | None = Query(default=None),
) -> PaginatedReportsResponse:
    """List all reports with optional filters and pagination."""
    return await list_reports(
        session,
        limit=limit,
        offset=offset,
        status=status,
        target_type=target_type,
    )


@router.get("/{report_id}", response_model=AdminReportResponse)
async def get_report(
    report_id: UUID,
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_reader),
) -> AdminReportResponse:
    """Fetch a single report by id.

    Used by admin detail screen as fallback when router state is unavailable
    (direct URL navigation, page refresh). Returns 404 if not found.
    """
    report = await get_report_by_id(report_id, session)
    (response,) = await to_admin_report_responses(session, [report])
    return response


@router.post("/{report_id}/resolve", response_model=AdminReportResponse)
async def resolve_report_endpoint(
    report_id: UUID,
    body: ResolveReportRequest,
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_session),
) -> AdminReportResponse:
    """Resolve a pending report."""
    report = await resolve_report(
        report_id=report_id,
        admin=admin,
        resolution_note=body.resolution_note,
        session=session,
    )
    await session.flush()
    await session.refresh(report)

    (response,) = await to_admin_report_responses(session, [report])
    return response


@router.post("/{report_id}/dismiss", response_model=AdminReportResponse)
async def dismiss_report_endpoint(
    report_id: UUID,
    body: DismissReportRequest,
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_session),
) -> AdminReportResponse:
    """Dismiss a pending report."""
    report = await dismiss_report(
        report_id=report_id,
        admin=admin,
        resolution_note=body.resolution_note,
        session=session,
    )
    await session.flush()
    await session.refresh(report)

    (response,) = await to_admin_report_responses(session, [report])
    return response
