# =============================================================================
# VELO Backend -- Admin Practices Schemas (E9 / 4c)
# =============================================================================
#
# Global practices oversight for the admin dashboard.
#
# AdminPracticeListItem:           one row in GET /admin/practices.
# PaginatedAdminPracticesResponse: paginated list.
# AdminRosterEntry:                one participant in the detail roster.
# AdminPracticeDetailResponse:     GET /admin/practices/{id} (detail + roster).
#
# status is a temporal split ("upcoming" if scheduled_at >= now, else "past").
# Times are raw (scheduled_at + duration_minutes); the frontend formats them.
# roster carries each participant's booking status; the frontend buckets it
# (upcoming -> registered = all; past -> present=attended / absent=no_show).
# Class names are Admin-prefixed to avoid OpenAPI component-name collisions.
# =============================================================================

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class AdminPracticeListItem(BaseModel):
    """One practice in the global admin list."""

    id: UUID
    title: str
    direction: str | None
    master_name: str
    master_verified: bool
    scheduled_at: datetime
    duration_minutes: int
    booked: int
    capacity: int | None
    status: str  # "upcoming" | "past"
    timezone: str  # IANA tz of the practice; FE renders local wall-clock time


class PaginatedAdminPracticesResponse(BaseModel):
    """GET /api/v1/admin/practices -- paginated, scope-filtered list."""

    items: list[AdminPracticeListItem]
    total: int
    limit: int
    offset: int


class AdminRosterEntry(BaseModel):
    """One participant in a practice's roster (non-cancelled booking)."""

    user_id: UUID
    name: str
    avatar_url: str | None
    status: str  # booking status: confirmed / attended / no_show / pending


class AdminPracticeDetailResponse(BaseModel):
    """GET /api/v1/admin/practices/{id} -- detail + attendance + roster."""

    id: UUID
    title: str
    direction: str | None
    master_name: str
    master_verified: bool
    scheduled_at: datetime
    duration_minutes: int
    booked: int
    capacity: int | None
    status: str  # "upcoming" | "past"
    timezone: str  # IANA tz of the practice; FE renders local wall-clock time
    attended: int
    roster: list[AdminRosterEntry]


# -- Zoom attendance (E21 step G, ПРОМТ №521) --


class AdminZoomBookingAttendance(BaseModel):
    """One booking's Zoom-derived attendance totals, for reconciliation."""

    booking_id: UUID
    user_id: UUID
    user_name: str
    status: str  # confirmed / attended / no_show / cancelled
    zoom_minutes_present: int | None
    attendance_decided_via: str | None  # zoom_report / legacy_proxy / null


class AdminZoomUnmatchedRow(BaseModel):
    """One raw report row Zoom sent us that we could not attribute to any
    known registrant -- the unmatched bucket, made visible (E21 plan sec 6).
    Not masked: this is an authenticated admin surface, not the throwaway
    probe's chat-paste output."""

    segment_id: UUID
    user_email: str | None
    join_time: datetime | None
    leave_time: datetime | None
    duration_seconds: int | None


class AdminZoomAttendanceResponse(BaseModel):
    """GET /api/v1/admin/practices/{id}/zoom-attendance."""

    practice_id: UUID
    zoom_meeting_status: str | None  # null if no ZoomMeeting row exists at all
    report_ingested: bool
    bookings: list[AdminZoomBookingAttendance]
    unmatched: list[AdminZoomUnmatchedRow]
    unmatched_count: int
