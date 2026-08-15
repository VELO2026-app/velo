# =============================================================================
# VELO Backend -- Booking Schemas (Phase 5.2 + 5.4 + Backlog, updated 6.7)
# =============================================================================
#
# BookingResponse:                Base booking representation.
# BookingWithPracticeResponse:    Booking + PracticeSummary (for list views).
# BookingDetailResponse:          Booking + full PracticeResponse (for detail).
# PaginatedBookingsResponse:      Paginated list of BookingWithPractice items.
# AttendanceItemResponse:         Single booking in attendance list (Phase 5.4).
# AttendanceResponse:             Full attendance summary (Phase 5.4).
#
# Phase 6.7 Batch 4: CreateBookingRequest gains optional promo_code.
#
# CR-01: Response schemas use BookingStatus StrEnum instead of str
#   so OpenAPI emits enum values and generated TypeScript types
#   produce union literals instead of plain string.
#
# ATTENDANCE ENRICHMENT (master prep view):
#   AttendanceItemResponse now also carries, per participant:
#     - user_display_name / user_avatar_url: who this booking belongs to, so
#       the master sees a name+avatar instead of a bare user_id.
#     - checkin: the participant's PRE check-in (mood + comment) for this
#       practice, if they left one (AttendanceCheckinResponse | None).
#   This intentionally exposes a participant's otherwise-private PRE check-in
#   to the practice owner, and ONLY inside this master-only attendance view
#   (ownership is enforced in get_attendance, P-08). The global check-in
#   privacy (GET /users/me/checkins -- own check-ins only) is unchanged.
#   The original "master_request" field from the spec is intentionally NOT
#   added here: user<->master messaging is a separate dialog feature, out of
#   scope for this iteration.
# =============================================================================

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from app.modules.bookings.models import BookingStatus
from app.modules.practices.schemas import PracticeSummary, PracticeResponse


class CreateBookingRequest(BaseModel):
    """POST /api/v1/bookings -- request body.

    Phase 6.7: optional promo_code for discount.
    Existing clients that omit promo_code continue to work unchanged.
    """

    practice_id: UUID
    promo_code: str | None = Field(
        default=None,
        min_length=1, max_length=50,
        description="Optional promo code to apply.",
    )


class CancelBookingRequest(BaseModel):
    """DELETE /api/v1/bookings/{id} -- optional body."""

    reason: str | None = Field(
        default=None, max_length=1000,
    )


class BookingResponse(BaseModel):
    """Booking representation returned by endpoints."""

    id: UUID
    practice_id: UUID
    user_id: UUID
    status: BookingStatus
    purchase_id: UUID | None
    cancelled_at: datetime | None
    cancellation_reason: str | None
    joined_at: datetime | None
    left_at: datetime | None
    checkin_skipped: bool
    created_at: datetime
    updated_at: datetime | None

    model_config = {"from_attributes": True}


# -- Frontend Backlog: Enriched booking schemas ----------------------------


class BookingWithPracticeResponse(BaseModel):
    """Booking with lightweight practice summary for list views.

    Used by GET /api/v1/bookings/me. Gives the frontend enough data
    for card rendering (title, time, type, master) without N+1 calls.
    """

    id: UUID
    practice_id: UUID
    user_id: UUID
    status: BookingStatus
    purchase_id: UUID | None
    cancelled_at: datetime | None
    cancellation_reason: str | None
    joined_at: datetime | None
    left_at: datetime | None
    checkin_skipped: bool
    created_at: datetime
    updated_at: datetime | None
    # Diary state for the dashboard banners: whether the current user has
    # already left a feedback for this practice / done a PRE check-in for this
    # booking. Lets the dashboard hide the "оставьте feedback" / "пора на
    # check-in" prompt once done (and stops re-submitting via a stale banner).
    has_feedback: bool
    has_checkin: bool
    practice: PracticeSummary
    # T21-1: this booking's OWN Zoom registrant link (the personal ?tk= URL),
    # never anyone else's -- these two endpoints (GET /me, GET /me/upcoming)
    # are already hard-scoped to Booking.user_id == the requesting user, so
    # "this booking" and "this user's own booking" are the same thing here.
    # None when the M-3 gate does not open (booking not confirmed/attended
    # yet), or when create_registrant_for_booking hasn't succeeded yet
    # (best-effort, create_failed -- bookings/service.py:311-312). T-35: this
    # is now the ONLY Zoom URL on this response -- the manual zoom_link the
    # same gate used to cover no longer exists.
    zoom_registrant_join_url: str | None = None

    model_config = {"from_attributes": True}


class BookingRecordingResponse(BaseModel):
    """GET /api/v1/bookings/{id}/recording -- REC-1 (PROMPT №618).

    Three states, deliberately not collapsed (owner-mandate: never conflate
    "we checked, nothing there" with "we couldn't check"):
      - available:   url is set, ready to open. Passcode already embedded
                     (see zoom/service.py::get_meeting_recording_link) --
                     the caller never sees a raw Zoom URL or a passcode.
      - unavailable: Zoom has no recording for this meeting right now.
                     Covers three cases we deliberately do NOT distinguish
                     (we store nothing, so we cannot and the user-facing
                     message is identical either way): never created, still
                     processing, or already deleted by Zoom's own 7-day
                     retention.
      - error:       the Zoom call itself failed (network/auth/5xx). NOT
                     the same as unavailable -- this means we could not
                     check, not that we checked and found nothing.

    A booking that does not qualify at all (wrong owner, never confirmed,
    or the practice hasn't ended) is a 404 (P-08), not one of these three --
    that is an entitlement question, not a recording-state one.
    """

    status: Literal["available", "unavailable", "error"]
    url: str | None = None


class BookingDetailResponse(BaseModel):
    """Booking with full practice details for single-booking view.

    Used by GET /api/v1/bookings/{id}. Returns the complete
    PracticeResponse so the frontend can render a full detail page
    (deep link from notification, master dashboard, etc.).
    """

    id: UUID
    practice_id: UUID
    user_id: UUID
    status: BookingStatus
    purchase_id: UUID | None
    cancelled_at: datetime | None
    cancellation_reason: str | None
    joined_at: datetime | None
    left_at: datetime | None
    created_at: datetime
    updated_at: datetime | None
    practice: PracticeResponse

    model_config = {"from_attributes": True}


class PaginatedBookingsResponse(BaseModel):
    """GET /api/v1/bookings/me -- paginated list."""

    items: list[BookingWithPracticeResponse]
    total: int
    limit: int
    offset: int


# -- Phase 5.4: Attendance --


class AttendanceCheckinResponse(BaseModel):
    """A participant's PRE check-in as shown to the practice master.

    Minimal projection of Checkin (diary module): only what the master needs
    while preparing for the practice -- the mood score and the optional note.
    Exposed ONLY inside the master-only attendance view (see module docstring).
    """

    mood: int
    comment: str | None


class AttendanceItemResponse(BaseModel):
    """Single booking in attendance list.

    Enriched for the master's prep view (see module docstring):
      - user_display_name / user_avatar_url identify the participant.
      - checkin is their PRE check-in for this practice, or None if they
        did not leave one.
    """

    booking_id: UUID
    user_id: UUID
    status: BookingStatus
    joined_at: datetime | None
    left_at: datetime | None
    user_display_name: str | None
    user_avatar_url: str | None
    checkin: AttendanceCheckinResponse | None

    model_config = {"from_attributes": True}


class AttendanceResponse(BaseModel):
    """GET /api/v1/practices/{id}/attendance -- response."""

    practice_id: UUID
    total: int
    attended: int
    no_show: int
    pending: int
    items: list[AttendanceItemResponse]
    # E21 step G: size of the Zoom unmatched bucket, count only (no PII --
    # the master is not an admin; see admin/practices' zoom-attendance
    # endpoint for the raw rows). 0 when there's no Zoom meeting at all.
    unmatched_count: int = 0


# -- Screen A: profile stats --


class UserStatsResponse(BaseModel):
    """GET /api/v1/bookings/me/stats -- current user's practice stats.

    Powers the two stat cards on the main profile screen:
      - practices_attended: how many practices the user actually attended.
      - hours_attended: total attended duration in hours (one decimal).

    B52 (owner-ruled 2026-08-15, D=C, ADDITIVE): has_unread_messages powers
    the profile's "Сообщения" row colour dot. A COLOUR flag only -- never a
    count, the owner was explicit. See service.has_unread_messages for the
    comms round-trip this rides on.
    """

    practices_attended: int
    hours_attended: float
    has_unread_messages: bool
