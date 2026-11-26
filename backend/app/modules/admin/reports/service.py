# =============================================================================
# VELO Backend -- Admin Reports Service (Phase 3.3, updated F8-fix)
# =============================================================================
#
# Admin actions on reports: list, resolve, dismiss, get by id.
#
# RESOLVE FLOW:
#   1. Load Report by id with FOR UPDATE (P-12)
#   2. Validate status == "pending"
#   3. Update: status -> "resolved", resolved_by, resolution_note, resolved_at
#
# DISMISS FLOW:
#   1. Load Report by id with FOR UPDATE (P-12)
#   2. Validate status == "pending"
#   3. Update: status -> "dismissed", resolved_by, resolution_note, resolved_at
#
# F8-fix (W-2):
#   get_report_by_id() -- single report lookup without FOR UPDATE.
#   Read-only. Used by GET /admin/reports/{id} so the frontend detail
#   screen can recover after a page refresh.
#
# BE-258: every report an admin reads (list, one, resolve, dismiss) goes
#   through to_admin_report_responses(), which adds the reporter's and the
#   target's names -- one query per kind of fact, whatever the number of
#   reports.
#
# SESSION RULES:
#   No session.commit() here (P-01). Router calls flush + refresh.
# =============================================================================

from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

import structlog
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, NotFoundError
from app.modules.admin.reports.schemas import (
    AdminReportResponse,
    PaginatedReportsResponse,
)
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice
from app.modules.reports.models import Report, ReportStatus, ReportTargetType
from app.modules.reports.schemas import ReportResponse
from app.modules.users.helpers import display_name
from app.modules.users.models import User

logger = structlog.get_logger()


async def to_admin_report_responses(
    session: AsyncSession,
    reports: Sequence[Report],
) -> list[AdminReportResponse]:
    """Reports as an admin reads them: each with the reporter's name and the
    name of what was reported (BE-258).

    The target is polymorphic and has no foreign key, so a target that is
    gone reads as a null name rather than failing the report.
    """
    by_type: dict[str, set[UUID]] = {t.value: set() for t in ReportTargetType}
    for report in reports:
        if report.target_type in by_type:
            by_type[report.target_type].add(report.target_id)

    person_ids = {r.reporter_id for r in reports}
    person_ids |= by_type[ReportTargetType.USER.value]
    person_ids |= by_type[ReportTargetType.MASTER.value]
    people: dict[UUID, tuple[str | None, str | None]] = {}
    if person_ids:
        people = {
            uid: (first, last)
            for uid, first, last in (
                await session.execute(
                    select(User.id, User.first_name, User.last_name).where(
                        User.id.in_(person_ids)
                    )
                )
            ).all()
        }

    # A master is named by the profile's display name ("визитка") first, as
    # a master is across the admin lists; the account name is the fallback.
    master_ids = by_type[ReportTargetType.MASTER.value]
    cards: dict[UUID, str | None] = {}
    if master_ids:
        cards = {
            uid: card
            for uid, card in (
                await session.execute(
                    select(
                        MasterProfile.user_id,
                        MasterProfile.data["profile"]["display_name"].astext,
                    ).where(MasterProfile.user_id.in_(master_ids))
                )
            ).all()
        }

    practice_ids = by_type[ReportTargetType.PRACTICE.value]
    titles: dict[UUID, str] = {}
    if practice_ids:
        titles = {
            pid: title
            for pid, title in (
                await session.execute(
                    select(Practice.id, Practice.title).where(
                        Practice.id.in_(practice_ids)
                    )
                )
            ).all()
        }

    def target_name(report: Report) -> str | None:
        if report.target_type == ReportTargetType.USER.value:
            name = people.get(report.target_id)
            return display_name(*name) if name else None
        if report.target_type == ReportTargetType.MASTER.value:
            name = people.get(report.target_id)
            if name is None:
                return None
            return (
                cards.get(report.target_id)
                or " ".join(part for part in name if part).strip()
                or "Мастер"
            )
        if report.target_type == ReportTargetType.PRACTICE.value:
            return titles.get(report.target_id)
        return None

    return [
        AdminReportResponse(
            **ReportResponse.model_validate(r, from_attributes=True).model_dump(),
            reporter_name=display_name(*people.get(r.reporter_id, (None, None))),
            target_name=target_name(r),
        )
        for r in reports
    ]


async def _load_pending_report(
    report_id: UUID,
    session: AsyncSession,
) -> Report:
    """Load Report with FOR UPDATE and validate 'pending' status.

    Uses SELECT FOR UPDATE (P-12) to prevent race condition when two
    admins act on the same report simultaneously.

    Raises NotFoundError if report doesn't exist.
    Raises ConflictError if report is not pending.
    """
    stmt = (
        select(Report)
        .where(Report.id == report_id)
        .with_for_update()
    )
    result = await session.execute(stmt)
    report = result.scalar_one_or_none()

    if not report:
        raise NotFoundError("Report not found")

    if report.status != ReportStatus.PENDING.value:
        # P-08: do not leak current status in error message.
        raise ConflictError("Report is not pending")

    return report


async def get_report_by_id(
    report_id: UUID,
    session: AsyncSession,
) -> Report:
    """Fetch a single report by id (read-only, no FOR UPDATE).

    Used by GET /api/v1/admin/reports/{id} (F8-fix W-2).
    Raises NotFoundError if the report does not exist.
    """
    stmt = select(Report).where(Report.id == report_id)
    result = await session.execute(stmt)
    report = result.scalar_one_or_none()

    if report is None:
        raise NotFoundError("Report not found")

    return report


async def list_reports(
    session: AsyncSession,
    *,
    limit: int = 20,
    offset: int = 0,
    status: Literal["pending", "resolved", "dismissed"] | None = None,
    target_type: Literal["user", "master", "practice"] | None = None,
) -> PaginatedReportsResponse:
    """List all reports with optional filters and pagination."""
    query = select(Report).order_by(Report.created_at.desc())
    count_query = select(func.count(Report.id))

    if status is not None:
        query = query.where(Report.status == status)
        count_query = count_query.where(Report.status == status)

    if target_type is not None:
        query = query.where(Report.target_type == target_type)
        count_query = count_query.where(Report.target_type == target_type)

    total_result = await session.execute(count_query)
    total = total_result.scalar_one()

    query = query.limit(limit).offset(offset)
    result = await session.execute(query)
    reports = result.scalars().all()

    return PaginatedReportsResponse(
        items=await to_admin_report_responses(session, reports),
        total=total,
        limit=limit,
        offset=offset,
    )


async def resolve_report(
    report_id: UUID,
    admin: User,
    resolution_note: str,
    session: AsyncSession,
) -> Report:
    """Resolve a pending report."""
    report = await _load_pending_report(report_id, session)

    report.status = ReportStatus.RESOLVED.value
    report.resolved_by = admin.id
    report.resolution_note = resolution_note
    report.resolved_at = datetime.now(UTC)

    logger.info(
        "report_resolved",
        report_id=str(report_id),
        admin_id=str(admin.id),
    )

    return report


async def dismiss_report(
    report_id: UUID,
    admin: User,
    resolution_note: str | None,
    session: AsyncSession,
) -> Report:
    """Dismiss a pending report."""
    report = await _load_pending_report(report_id, session)

    report.status = ReportStatus.DISMISSED.value
    report.resolved_by = admin.id
    report.resolution_note = resolution_note
    report.resolved_at = datetime.now(UTC)

    logger.info(
        "report_dismissed",
        report_id=str(report_id),
        admin_id=str(admin.id),
    )

    return report
