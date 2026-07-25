# =============================================================================
# VELO Backend -- Admin Practices Service (E9 / 4c)
# =============================================================================
#
# Read-only global practices oversight.
#
# LIST (GET /admin/practices?scope=all|upcoming|past):
#   All platform practices except draft/deleted (matches the public
#   practices_count definition), joined to their master for name + verified
#   badge. scope filters on scheduled_at vs now; booked = non-cancelled
#   bookings per practice (one grouped query for the page). Newest first.
#
# DETAIL (GET /admin/practices/{id}):
#   Practice + master + booked/attended counts + full non-cancelled roster
#   (each entry carries its booking status; the frontend buckets attended /
#   no_show for past practices). 404 when missing or soft-deleted.
#
# SESSION RULES: read-only, no commit (P-01), ORM-only.
# =============================================================================

from datetime import UTC, datetime
from uuid import UUID

import structlog
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError
from app.modules.admin.practices.schemas import (
    AdminPracticeDetailResponse,
    AdminPracticeListItem,
    AdminRosterEntry,
    AdminZoomAttendanceResponse,
    AdminZoomBookingAttendance,
    AdminZoomUnmatchedRow,
    PaginatedAdminPracticesResponse,
)
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice, PracticeStatus
from app.modules.users.helpers import display_name
from app.modules.users.models import User
from app.modules.zoom.models import ZoomAttendanceSegment, ZoomMeeting

logger = structlog.get_logger()

# Statuses never shown in the admin list (not "real" practices).
_HIDDEN_STATUSES = (
    PracticeStatus.DRAFT.value,
    PracticeStatus.DELETED.value,
)


def _temporal_status(scheduled_at: datetime, now: datetime) -> str:
    """upcoming if the practice has not happened yet, else past."""
    return "upcoming" if scheduled_at >= now else "past"


def _master_name(profile: MasterProfile, user: User) -> str:
    """Master display name: profile display_name -> first_name -> fallback."""
    display = profile.data.get("profile", {}).get("display_name")
    return display or user.first_name or "Мастер"


def _master_verified(profile: MasterProfile) -> bool:
    return profile.data.get("account", {}).get("status") == "verified"


async def list_admin_practices(
    session: AsyncSession,
    *,
    scope: str = "all",
    limit: int = 20,
    offset: int = 0,
) -> PaginatedAdminPracticesResponse:
    """List all platform practices (except draft/deleted), newest first."""
    now = datetime.now(UTC)

    conditions = [Practice.status.notin_(_HIDDEN_STATUSES)]
    if scope == "upcoming":
        conditions.append(Practice.scheduled_at >= now)
    elif scope == "past":
        conditions.append(Practice.scheduled_at < now)

    total = (
        await session.execute(
            select(func.count(Practice.id)).where(*conditions)
        )
    ).scalar_one()

    rows = (
        await session.execute(
            select(Practice, MasterProfile, User)
            .join(MasterProfile, Practice.master_id == MasterProfile.user_id)
            .join(User, MasterProfile.user_id == User.id)
            .where(*conditions)
            .order_by(Practice.scheduled_at.desc())
            .limit(limit)
            .offset(offset)
        )
    ).all()

    page_ids = [practice.id for practice, _profile, _user in rows]
    booked_map: dict[UUID, int] = {}
    if page_ids:
        booked_rows = (
            await session.execute(
                select(Booking.practice_id, func.count(Booking.id))
                .where(
                    Booking.practice_id.in_(page_ids),
                    Booking.status != BookingStatus.CANCELLED.value,
                )
                .group_by(Booking.practice_id)
            )
        ).all()
        booked_map = {pid: count for pid, count in booked_rows}

    items = [
        AdminPracticeListItem(
            id=practice.id,
            title=practice.title,
            direction=practice.direction,
            master_name=_master_name(profile, user),
            master_verified=_master_verified(profile),
            scheduled_at=practice.scheduled_at,
            duration_minutes=practice.duration_minutes,
            booked=booked_map.get(practice.id, 0),
            capacity=practice.max_participants,
            status=_temporal_status(practice.scheduled_at, now),
            timezone=practice.timezone,
        )
        for practice, profile, user in rows
    ]

    return PaginatedAdminPracticesResponse(
        items=items, total=total, limit=limit, offset=offset,
    )


async def get_admin_practice_detail(
    practice_id: UUID,
    session: AsyncSession,
) -> AdminPracticeDetailResponse:
    """Practice detail + attendance counts + non-cancelled roster.

    Raises:
        NotFoundError: when the practice does not exist or is soft-deleted.
    """
    now = datetime.now(UTC)

    row = (
        await session.execute(
            select(Practice, MasterProfile, User)
            .join(MasterProfile, Practice.master_id == MasterProfile.user_id)
            .join(User, MasterProfile.user_id == User.id)
            .where(Practice.id == practice_id)
        )
    ).one_or_none()

    if row is None:
        raise NotFoundError("Practice not found")
    practice, profile, user = row
    if practice.status == PracticeStatus.DELETED.value:
        raise NotFoundError("Practice not found")

    # booked (non-cancelled) + attended in a single query via FILTER.
    booked, attended = (
        await session.execute(
            select(
                func.count(Booking.id).filter(
                    Booking.status != BookingStatus.CANCELLED.value
                ),
                func.count(Booking.id).filter(
                    Booking.status == BookingStatus.ATTENDED.value
                ),
            ).where(Booking.practice_id == practice_id)
        )
    ).one()

    roster_rows = (
        await session.execute(
            select(
                Booking.user_id,
                Booking.status,
                User.first_name,
                User.last_name,
                User.avatar_url,
            )
            .join(User, Booking.user_id == User.id)
            .where(
                Booking.practice_id == practice_id,
                Booking.status != BookingStatus.CANCELLED.value,
            )
            .order_by(Booking.created_at)
        )
    ).all()

    roster = [
        AdminRosterEntry(
            user_id=user_id,
            name=display_name(first_name, last_name),
            avatar_url=avatar_url,
            status=booking_status,
        )
        for user_id, booking_status, first_name, last_name, avatar_url
        in roster_rows
    ]

    return AdminPracticeDetailResponse(
        id=practice.id,
        title=practice.title,
        direction=practice.direction,
        master_name=_master_name(profile, user),
        master_verified=_master_verified(profile),
        scheduled_at=practice.scheduled_at,
        duration_minutes=practice.duration_minutes,
        booked=booked,
        capacity=practice.max_participants,
        status=_temporal_status(practice.scheduled_at, now),
        timezone=practice.timezone,
        attended=attended,
        roster=roster,
    )


# -- Zoom attendance (E21 step G, ПРОМТ №521) --


async def get_admin_zoom_attendance(
    practice_id: UUID,
    session: AsyncSession,
) -> AdminZoomAttendanceResponse:
    """Per-booking Zoom-derived attendance totals + the raw unmatched bucket
    for reconciliation. Not masked (E21 plan sec 6/7) -- an authenticated
    admin surface, unlike the throwaway probe script's chat-paste output.

    Raises:
        NotFoundError: when the practice does not exist or is soft-deleted.
    """
    practice = await session.get(Practice, practice_id)
    if practice is None or practice.status == PracticeStatus.DELETED.value:
        raise NotFoundError("Practice not found")

    zoom_meeting = (
        await session.execute(
            select(ZoomMeeting).where(ZoomMeeting.practice_id == practice_id)
        )
    ).scalar_one_or_none()

    if zoom_meeting is None:
        return AdminZoomAttendanceResponse(
            practice_id=practice_id,
            zoom_meeting_status=None,
            report_ingested=False,
            bookings=[],
            unmatched=[],
            unmatched_count=0,
        )

    booking_rows = (
        await session.execute(
            select(Booking, User.first_name, User.last_name)
            .join(User, Booking.user_id == User.id)
            .where(
                Booking.practice_id == practice_id,
                Booking.status != BookingStatus.CANCELLED.value,
            )
            .order_by(Booking.created_at)
        )
    ).all()

    bookings = [
        AdminZoomBookingAttendance(
            booking_id=booking.id,
            user_id=booking.user_id,
            user_name=display_name(first_name, last_name),
            status=booking.status,
            zoom_minutes_present=booking.zoom_minutes_present,
            attendance_decided_via=booking.attendance_decided_via,
        )
        for booking, first_name, last_name in booking_rows
    ]

    unmatched_rows = (
        await session.execute(
            select(ZoomAttendanceSegment)
            .where(
                ZoomAttendanceSegment.zoom_meeting_id == zoom_meeting.id,
                ZoomAttendanceSegment.matched_registrant_row_id.is_(None),
            )
            .order_by(ZoomAttendanceSegment.created_at)
        )
    ).scalars().all()

    unmatched = [
        AdminZoomUnmatchedRow(
            segment_id=seg.id,
            user_email=(seg.raw_row or {}).get("user_email"),
            join_time=seg.join_time,
            leave_time=seg.leave_time,
            duration_seconds=seg.duration_seconds,
        )
        for seg in unmatched_rows
    ]

    return AdminZoomAttendanceResponse(
        practice_id=practice_id,
        zoom_meeting_status=zoom_meeting.status,
        report_ingested=zoom_meeting.report_ingested_at is not None,
        bookings=bookings,
        unmatched=unmatched,
        unmatched_count=len(unmatched),
    )
