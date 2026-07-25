# =============================================================================
# VELO Backend -- Booking Router (Phase 5.2 + 5.4 + Backlog, updated 6.7)
# =============================================================================
#
# ENDPOINTS:
#   POST   /api/v1/bookings              -- create booking (+ optional promo)
#   GET    /api/v1/bookings/me           -- my bookings (Frontend Backlog)
#   GET    /api/v1/bookings/{id}         -- booking detail (Frontend Backlog)
#   DELETE /api/v1/bookings/{id}         -- cancel booking
#   POST   /api/v1/bookings/{id}/join    -- check-in (Phase 5.4)
#   POST   /api/v1/bookings/{id}/leave   -- check-out (Phase 5.4)
#   GET    /api/v1/practices/{id}/attendance  -- attendance list (Phase 5.4)
#
# Phase 6.7 Batch 4: POST /bookings now accepts optional promo_code
# in CreateBookingRequest. Promo is validated before booking creation.
#
# ROUTE ORDER:
#   /me MUST come before /{booking_id} to avoid FastAPI parsing "me"
#   as a UUID path parameter.
#
# AUTH: get_current_user on booking endpoints.
#       get_current_master on practice-level endpoints.
# SESSION: Mutating = get_db_session. Read = get_db_reader.
# =============================================================================

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db_reader, get_db_session
from app.modules.auth.dependencies import (
    get_current_master,
    get_current_user,
)
from app.core.exceptions import NotFoundError
from app.modules.bookings.models import BookingStatus
from app.modules.bookings.schemas import (
    AttendanceCheckinResponse,
    AttendanceItemResponse,
    AttendanceResponse,
    BookingDetailResponse,
    BookingResponse,
    BookingWithPracticeResponse,
    CancelBookingRequest,
    CreateBookingRequest,
    PaginatedBookingsResponse,
    UserStatsResponse,
)
from app.modules.bookings.service import (
    cancel_booking,
    create_booking,
    get_attendance,
    get_booking_by_id,
    get_user_practice_stats,
    join_booking,
    leave_booking,
    list_upcoming_bookings,
    list_user_bookings,
    skip_checkin,
)
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice
from app.modules.practices.schemas import PracticeSummary, PracticeResponse
from app.modules.promos.models import Promo
from app.modules.promos.validation import validate_promo
from app.modules.users.models import User

router = APIRouter(
    prefix="/api/v1/bookings", tags=["bookings"],
)

# Separate router for practice-level attendance endpoints.
practices_attendance_router = APIRouter(
    prefix="/api/v1/practices", tags=["attendance"],
)


def _participant_display_name(user: User | None) -> str | None:
    """Human-readable participant name for the master's attendance view.

    Joins first_name + last_name when present. Returns None when the user is
    missing or has no name on file -- the frontend then falls back to the
    user_id / a generic label. Unlike get_master_display_name, there is no
    "Master" fallback: this is a participant, and an empty name is left as
    None for the client to handle.
    """
    if user is None:
        return None
    parts = [p for p in (user.first_name, user.last_name) if p]
    return " ".join(parts) if parts else None


@router.post(
    "",
    response_model=BookingResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_booking_endpoint(
    body: CreateBookingRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> BookingResponse:
    """Book the current user into a practice.

    Phase 6.7: optional promo_code in body for discount.
    """
    # Validate promo if provided.
    promo: Promo | None = None
    if body.promo_code:
        practice = await session.get(Practice, body.practice_id)
        if not practice:
            raise NotFoundError("Practice not found")
        promo = await validate_promo(
            code=body.promo_code,
            practice=practice,
            user_id=user.id,
            session=session,
        )

    booking = await create_booking(
        user, body.practice_id, session, promo=promo,
    )
    await session.flush()
    await session.refresh(booking)
    return BookingResponse.model_validate(booking)


# ===================================================================
# Frontend Backlog: GET /me -- my bookings (BEFORE /{booking_id})
# ===================================================================


@router.get(
    "/me",
    response_model=PaginatedBookingsResponse,
)
async def list_my_bookings_endpoint(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_reader),
    status_filter: Literal[
        "pending", "confirmed", "cancelled",
        "attended", "no_show",
    ] | None = Query(
        default=None, alias="status",
    ),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> PaginatedBookingsResponse:
    """List bookings for the current user.

    Returns paginated list with embedded PracticeSummary so the
    frontend can render cards without additional API calls.

    Optional ``status`` filter (e.g. ``?status=confirmed``).
    """
    items, total = await list_user_bookings(
        user, session,
        status_filter=status_filter,
        limit=limit,
        offset=offset,
    )

    # Resolve master display names for this page. The embedded PracticeSummary
    # has no ORM source for master_name (it lives on a different row), so
    # model_validate leaves it None -> list cards showed a "Мастер" fallback.
    # Fill it here with the same helper the single-booking/detail responses use.
    # Dedup by master_id so a master repeated across the page is looked up once.
    from app.modules.masters.service import get_master_display_name
    # M-3 gate: expose zoom_link only for confirmed/attended bookings. Imported
    # locally to match this file's cross-service import style (get_master_-
    # display_name above) and sidestep any module-load import cycle.
    from app.modules.practices.service import ZOOM_VISIBLE_BOOKING_STATUSES
    # A4 V2 (ПРОМТ №572): batched Zoom meeting status for this page's
    # practices -- NOT gated by ZOOM_VISIBLE_BOOKING_STATUSES (that gate is
    # for the manual zoom_link fallback, M-3); the meeting STATUS carries no
    # secret material, same posture as PracticeResponse.zoom_meeting_status.
    from app.modules.zoom.service import get_zoom_meeting_statuses

    master_names: dict[UUID, str] = {}
    for row in items:
        mid = row[1].master_id
        if mid not in master_names:
            master_names[mid] = await get_master_display_name(mid, session)
    zoom_meeting_statuses = await get_zoom_meeting_statuses(
        [row[1].id for row in items], session,
    )

    return PaginatedBookingsResponse(
        items=[
            BookingWithPracticeResponse(
                id=booking.id,
                practice_id=booking.practice_id,
                user_id=booking.user_id,
                status=booking.status,
                purchase_id=booking.purchase_id,
                cancelled_at=booking.cancelled_at,
                cancellation_reason=booking.cancellation_reason,
                joined_at=booking.joined_at,
                left_at=booking.left_at,
                checkin_skipped=booking.checkin_skipped,
                created_at=booking.created_at,
                updated_at=booking.updated_at,
                has_feedback=has_feedback,
                has_checkin=has_checkin,
                # zoom_link (M-3): exposed only for this user's confirmed /
                # attended booking; the fail-closed factory nulls it otherwise.
                practice=PracticeSummary.from_practice(
                    practice,
                    master_name=master_names[practice.master_id],
                    zoom_link_visible=(
                        booking.status in ZOOM_VISIBLE_BOOKING_STATUSES
                    ),
                    zoom_meeting_status=zoom_meeting_statuses.get(practice.id),
                ),
                # T21-1: same M-3 gate as zoom_link above -- this booking is
                # already this user's own (query is scoped to Booking.user_id).
                zoom_registrant_join_url=(
                    zoom_join_url
                    if booking.status in ZOOM_VISIBLE_BOOKING_STATUSES
                    else None
                ),
            )
            for booking, practice, has_feedback, has_checkin, zoom_join_url in items
        ],
        total=total,
        limit=limit,
        offset=offset,
    )


# ===================================================================
# Frontend Backlog: GET /{booking_id} -- booking detail
# ===================================================================


@router.get(
    "/me/upcoming",
    response_model=list[BookingWithPracticeResponse],
)
async def list_my_upcoming_bookings_endpoint(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_reader),
) -> list[BookingWithPracticeResponse]:
    """Confirmed live-or-upcoming bookings, soonest first (dashboard widget).

    Dedicated from GET /me (which paginates by created_at DESC) so the
    «Ближайшая практика» card always sees the truly-soonest practice, not the
    nearest within the first created_at page (>20-bookings mis-select fix, B1).
    Declared before GET /{booking_id} so "me/upcoming" is not parsed as a UUID.
    """
    items = await list_upcoming_bookings(user, session)

    from app.modules.masters.service import get_master_display_name
    from app.modules.practices.service import ZOOM_VISIBLE_BOOKING_STATUSES
    from app.modules.zoom.service import get_zoom_meeting_statuses

    master_names: dict[UUID, str] = {}
    for row in items:
        mid = row[1].master_id
        if mid not in master_names:
            master_names[mid] = await get_master_display_name(mid, session)
    # A4 V2 (ПРОМТ №572): this is the exact endpoint UserDashboardView's
    # "nearest practice" card reads -- the participant surface this fix is
    # for.
    zoom_meeting_statuses = await get_zoom_meeting_statuses(
        [row[1].id for row in items], session,
    )

    return [
        BookingWithPracticeResponse(
            id=booking.id,
            practice_id=booking.practice_id,
            user_id=booking.user_id,
            status=booking.status,
            purchase_id=booking.purchase_id,
            cancelled_at=booking.cancelled_at,
            cancellation_reason=booking.cancellation_reason,
            joined_at=booking.joined_at,
            left_at=booking.left_at,
            checkin_skipped=booking.checkin_skipped,
            created_at=booking.created_at,
            updated_at=booking.updated_at,
            has_feedback=has_feedback,
            has_checkin=has_checkin,
            practice=PracticeSummary.from_practice(
                practice,
                master_name=master_names[practice.master_id],
                zoom_link_visible=(
                    booking.status in ZOOM_VISIBLE_BOOKING_STATUSES
                ),
                zoom_meeting_status=zoom_meeting_statuses.get(practice.id),
            ),
            zoom_registrant_join_url=(
                zoom_join_url
                if booking.status in ZOOM_VISIBLE_BOOKING_STATUSES
                else None
            ),
        )
        for booking, practice, has_feedback, has_checkin, zoom_join_url in items
    ]


@router.get(
    "/me/stats",
    response_model=UserStatsResponse,
)
async def get_my_stats_endpoint(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_reader),
) -> UserStatsResponse:
    """Current user's attended-practice stats for the profile screen.

    Declared before GET /{booking_id} so "me/stats" is not parsed as a
    booking UUID (same route-order rule as GET /me above).
    """
    practices_attended, hours_attended = await get_user_practice_stats(
        user, session,
    )
    return UserStatsResponse(
        practices_attended=practices_attended,
        hours_attended=hours_attended,
    )


@router.get(
    "/{booking_id}",
    response_model=BookingDetailResponse,
)
async def get_booking_detail_endpoint(
    booking_id: UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_reader),
) -> BookingDetailResponse:
    """Get a single booking with full practice details.

    Access control:
      - Booking owner (deep link from notification).
      - Master of the practice (attendance dashboard).

    Returns 404 for non-existent or unauthorized bookings (P-08).
    """
    booking, practice = await get_booking_by_id(
        booking_id, user, session,
    )

    return BookingDetailResponse(
        id=booking.id,
        practice_id=booking.practice_id,
        user_id=booking.user_id,
        status=booking.status,
        purchase_id=booking.purchase_id,
        cancelled_at=booking.cancelled_at,
        cancellation_reason=booking.cancellation_reason,
        joined_at=booking.joined_at,
        left_at=booking.left_at,
        created_at=booking.created_at,
        updated_at=booking.updated_at,
        # zoom_link (M-3): not exposed on the booking-detail response -- no UI
        # reads it here, and an authorized viewer gets the link via the
        # practice detail / dashboard. Nulled explicitly (no schema validator).
        practice=PracticeResponse.model_validate(practice).model_copy(
            update={"zoom_link": None},
        ),
    )


# ===================================================================
# DELETE /{booking_id} -- cancel booking
# ===================================================================


@router.delete(
    "/{booking_id}",
    response_model=BookingResponse,
)
async def cancel_booking_endpoint(
    booking_id: UUID,
    body: CancelBookingRequest | None = None,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> BookingResponse:
    """Cancel a booking (owner only)."""
    reason = body.reason if body else None
    booking = await cancel_booking(
        booking_id, user, session, reason=reason,
    )
    await session.flush()
    await session.refresh(booking)
    return BookingResponse.model_validate(booking)


# ===================================================================
# Phase 5.4: Attendance (booking-level)
# ===================================================================


@router.post(
    "/{booking_id}/join",
    response_model=BookingResponse,
)
async def join_booking_endpoint(
    booking_id: UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> BookingResponse:
    """Check in to a practice (sets joined_at)."""
    booking = await join_booking(booking_id, user, session)
    await session.flush()
    await session.refresh(booking)
    return BookingResponse.model_validate(booking)


@router.post(
    "/{booking_id}/leave",
    response_model=BookingResponse,
)
async def leave_booking_endpoint(
    booking_id: UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> BookingResponse:
    """Check out from a practice (sets left_at)."""
    booking = await leave_booking(booking_id, user, session)
    await session.flush()
    await session.refresh(booking)
    return BookingResponse.model_validate(booking)


@router.post(
    "/{booking_id}/skip-checkin",
    response_model=BookingResponse,
)
async def skip_checkin_endpoint(
    booking_id: UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> BookingResponse:
    """Persist the current user's choice to skip their PRE check-in.

    Owner-only (404 otherwise). Idempotent. Keeps the dashboard banner /
    check-in prompt hidden across sessions (was client-only before).
    """
    booking = await skip_checkin(booking_id, user, session)
    await session.flush()
    await session.refresh(booking)
    return BookingResponse.model_validate(booking)


# ===================================================================
# Phase 5.4: Attendance (practice-level)
# ===================================================================


@practices_attendance_router.get(
    "/{practice_id}/attendance",
    response_model=AttendanceResponse,
)
async def get_attendance_endpoint(
    practice_id: UUID,
    master_tuple: tuple[User, MasterProfile] = Depends(
        get_current_master,
    ),
    session: AsyncSession = Depends(get_db_reader),
) -> AttendanceResponse:
    """Get attendance list for a practice (master-only).

    Each item is enriched with the participant's name/avatar and their PRE
    check-in (mood + comment), if any. The service layer batch-loads users
    and check-ins; this endpoint only maps them onto the response schema.
    """
    user, _profile = master_tuple
    practice, bookings, users, checkins, unmatched_count = await get_attendance(
        practice_id, user, session,
    )

    items = []
    for b in bookings:
        checkin = checkins.get(b.id)
        participant = users.get(b.user_id)
        items.append(
            AttendanceItemResponse(
                booking_id=b.id,
                user_id=b.user_id,
                status=b.status,
                joined_at=b.joined_at,
                left_at=b.left_at,
                user_display_name=_participant_display_name(participant),
                user_avatar_url=(
                    participant.avatar_url if participant else None
                ),
                checkin=(
                    AttendanceCheckinResponse(
                        mood=checkin.mood,
                        comment=checkin.comment,
                    )
                    if checkin is not None
                    else None
                ),
            )
        )

    attended = sum(1 for b in bookings if b.status == BookingStatus.ATTENDED.value)
    no_show = sum(1 for b in bookings if b.status == BookingStatus.NO_SHOW.value)
    pending = sum(
        1 for b in bookings
        if b.status in {BookingStatus.PENDING.value, BookingStatus.CONFIRMED.value}
    )

    return AttendanceResponse(
        practice_id=practice.id,
        total=len(bookings),
        attended=attended,
        no_show=no_show,
        pending=pending,
        items=items,
        unmatched_count=unmatched_count,
    )
