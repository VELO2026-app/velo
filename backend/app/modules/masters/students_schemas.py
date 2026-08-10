# =============================================================================
# VELO Backend -- Master Students Schemas (E5)
# =============================================================================
#
# Master-facing "my students" CRM aggregate, projected from bookings +
# practices + diary (checkins / feedbacks). No new entity -- a "student" is
# any user with at least one ATTENDED booking on this master's practices.
#
# StudentListItem:            one student row (GET /masters/me/students).
# PaginatedStudentsResponse:  paginated + searchable list.
# StudentCheckinItem:         one recent check-in on the detail screen.
# StudentFeedbackItem:        one feedback on the detail screen.
# StudentDetailResponse:      GET /masters/me/students/{id}.
# =============================================================================

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class StudentListItem(BaseModel):
    """One student in the master's students list.

    needs_attention is True when the student's MOST RECENT feedback on this
    master's practices is in the negative bucket (rating 1-3) -- the same
    signal that feeds the dashboard "needs attention" block (consistent with
    the reviews projection).
    """

    id: UUID
    name: str
    avatar_url: str | None
    practices_count: int
    needs_attention: bool


class PaginatedStudentsResponse(BaseModel):
    """GET /api/v1/masters/me/students -- paginated, searchable list."""

    items: list[StudentListItem]
    total: int
    limit: int
    offset: int


class StudentCheckinItem(BaseModel):
    """One recent check-in by the student (on this master's practices)."""

    mood: int
    comment: str | None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class StudentFeedbackItem(BaseModel):
    """One feedback left by the student (on this master's practices)."""

    rating: int
    comment: str | None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class StudentDetailResponse(BaseModel):
    """GET /api/v1/masters/me/students/{id} -- per-student aggregate.

    name / avatar_url -- the student's identity, same source as StudentListItem
                       (so a direct/refreshed deep-link renders the real name,
                       not a fallback).
    practices_count -- number of this master's practices the student attended.
    hours           -- attended duration_minutes summed, in hours (1 decimal).
    satisfaction_pct-- round(avg(rating) * 10) over the student's feedbacks on
                       this master's practices; null when they left no feedback.
    recent_checkins -- newest-first, capped.
    feedbacks       -- newest-first, capped.
    blocked         -- T24-20 (PROMPT №638): True iff MasterStudent.blocked_at
                       is set for THIS master. Lets the frontend swap the
                       bottom action ("Заблокировать" / "Разблокировать")
                       instead of guessing from the fact the request merely
                       succeeded. get_master_student_detail's own narrow
                       allow-path (NOT is_master_audience_member, which still
                       never admits a blocked student -- see that function's
                       docstring) is the only place blocked=True can occur.
    """

    name: str
    avatar_url: str | None
    practices_count: int
    hours: float
    satisfaction_pct: int | None
    recent_checkins: list[StudentCheckinItem]
    feedbacks: list[StudentFeedbackItem]
    blocked: bool
