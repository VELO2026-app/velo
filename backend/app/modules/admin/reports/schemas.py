# =============================================================================
# VELO Backend -- Admin Report Schemas (Phase 3.3, NO-LITERALS)
# =============================================================================
#
# NO-LITERALS: resolution note field limits sourced from
#   settings.admin_report_note_max_length -- change once, applies everywhere.
#
# BE-258: an admin reads a report with the names in it -- who reported and
#   what was reported -- so a list or a card makes no further request.
#   AdminReportResponse is ReportResponse (the user-facing shape, unchanged)
#   plus those names.
# =============================================================================

from pydantic import BaseModel, Field

from app.core.config import settings
from app.modules.reports.schemas import ReportResponse


# ---------------------------------------------------------------------------
# Admin actions
# ---------------------------------------------------------------------------


class ResolveReportRequest(BaseModel):
    """Admin resolves a report."""

    resolution_note: str = Field(
        min_length=1, max_length=settings.admin_report_note_max_length,
    )


class DismissReportRequest(BaseModel):
    """Admin dismisses a report."""

    resolution_note: str | None = Field(
        default=None, max_length=settings.admin_report_note_max_length,
    )


# ---------------------------------------------------------------------------
# Admin reading: a report with its names
# ---------------------------------------------------------------------------


class AdminReportResponse(ReportResponse):
    """A report as an admin reads it (BE-258): the user-facing fields plus
    the names behind the ids. The target's type is `target_type` already
    (user / master / practice)."""

    # The reporter's name, "Участник" when the account has none.
    reporter_name: str
    # What was reported, by its type: a person's name (user), a master's
    # name -- the profile's display name first (master), the practice's title
    # (practice). Null when the target is gone: the polymorphic reference
    # has no foreign key, so nothing keeps it alive.
    target_name: str | None


# ---------------------------------------------------------------------------
# Admin listing
# ---------------------------------------------------------------------------


class PaginatedReportsResponse(BaseModel):
    """GET /api/v1/admin/reports -- paginated report list."""

    items: list[AdminReportResponse]
    total: int
    limit: int
    offset: int
