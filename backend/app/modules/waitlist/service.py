# =============================================================================
# VELO Backend -- Waitlist Service (Phase 5.3, bugfix round, updated Phase 6.4)
# =============================================================================
#
# Business logic for waitlist join, leave/decline, confirm, and
# automatic processing when a booking is cancelled.
#
# JOIN FLOW:
#   1. FOR UPDATE on practice (same lock as booking -- prevents races)
#   2. Validate: exists, scheduled, IS full, no active booking, not owner
#   3. Check existing waitlist entry:
#      - active (waiting/notified) -> 409
#      - rejoinable (left/declined/expired) -> UPDATE (re-join, new position)
#      - none -> INSERT with position = MAX+1 subquery
#   4. IntegrityError -> savepoint rollback + 409 (P-05, FIX 2.1)
#
# LEAVE/DECLINE FLOW:
#   1. FOR UPDATE on waitlist entry (P-12)
#   2. Owner check (P-08: 404 not 403)
#   3. waiting -> left; notified -> declined
#   4. If declined (was notified): process_waitlist -> notify next
#
# CONFIRM FLOW:
#   1. FOR UPDATE on waitlist entry (P-12)
#   2. Owner check, status must be notified, not expired
#   3. Lazy expiration: if expired -> EXPIRED + process_waitlist + return None
#      (no exception -- changes must commit)
#   4. FOR UPDATE on practice + capacity recheck (overbooking prevention)
#      If spot taken -> WAITING (back to queue) + return None
#   5. Create booking + purchase (double-entry), status -> converted
#   6. Recalculate current_participants (Frontend Backlog A-03)
#
# PROCESS_WAITLIST (internal):
#   Called from cancel_booking and leave/decline.
#   Finds first waiting entry, transitions to notified,
#   sets expires_at = now + 30 min.
#   FIX 3.1: creates real Notification (WAITLIST_SPOT_AVAILABLE) instead
#   of stub logger. Template includes 30-min deadline + deep link.
#
# SESSION RULES:
#   No session.commit() here (P-01). Router calls flush + refresh.
#
# BUGFIX NOTES:
#   - confirm_waitlist returns (entry, None) instead of raising when
#     expired or spot taken. This ensures get_db_session commits the
#     status changes (EXPIRED/WAITING) instead of rolling them back.
#   - confirm_waitlist locks Practice with FOR UPDATE and rechecks
#     capacity to prevent overbooking race with create_booking.
#   - FIX 2.1: confirm_waitlist uses begin_nested() (SAVEPOINT) instead
#     of session.rollback() on IntegrityError. Rollback kills the entire
#     transaction; savepoint rolls back only the failed flush.
# =============================================================================

from datetime import UTC, datetime, timedelta
from uuid import UUID

import structlog
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import (
    BadRequestError,
    ConflictError,
    NotFoundError,
)
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.bookings.service import (
    _ACTIVE_BOOKING_STATUSES,
    _get_active_booking_count,
    recalculate_participants,
)
from app.modules.masters.service import get_master_display_name
from app.modules.payments.purchase import create_purchase_for_booking
from app.modules.practices.audience_service import assert_viewer_can_access_practice
from app.modules.practices.models import Practice, PracticeStatus
from app.modules.users.models import User
from app.modules.waitlist.models import (
    ACTIVE_STATUSES,
    REJOINABLE_STATUSES,
    Waitlist,
    WaitlistStatus,
)

logger = structlog.get_logger()

# How long a notified user has to confirm.
_CONFIRM_WINDOW = timedelta(minutes=30)


# L-03 fix: removed async -- this function contains only synchronous
# SQLAlchemy expression building (no I/O, no awaits).
def _next_position_subquery(practice_id: UUID):
    """Build a scalar subquery for next position in waitlist.

    Returns a correlated subquery: COALESCE(MAX(position), 0) + 1
    filtered by practice_id.
    """
    return (
        select(func.coalesce(func.max(Waitlist.position), 0) + 1)
        .where(Waitlist.practice_id == practice_id)
        .scalar_subquery()
    )


async def join_waitlist(
    user: User,
    practice_id: UUID,
    session: AsyncSession,
) -> Waitlist:
    """Add user to the waitlist for a full practice.

    Validates:
    - Practice exists and is scheduled.
    - Practice IS full (otherwise user should book directly).
    - User is not the practice owner.
    - No active booking for this practice.
    - No active waitlist entry (waiting/notified).
    - Rejoinable entry (left/declined/expired) -> re-join with new position.
    """
    # Lock practice (same strategy as create_booking).
    stmt = (
        select(Practice)
        .where(Practice.id == practice_id)
        .with_for_update()
    )
    result = await session.execute(stmt)
    practice = result.scalar_one_or_none()

    if not practice:
        raise NotFoundError("Practice not found")

    if practice.status != PracticeStatus.SCHEDULED.value:
        raise BadRequestError("Can only join waitlist for scheduled practices")

    if practice.master_id == user.id:
        raise BadRequestError("Cannot join waitlist for your own practice")

    # Practice must be full -- otherwise user should book directly.
    if practice.max_participants is None:
        raise BadRequestError(
            "Practice has no capacity limit -- book directly"
        )

    active_count = await _get_active_booking_count(session, practice_id)
    if active_count < practice.max_participants:
        raise BadRequestError("Practice is not full -- book directly")

    # Check no active booking exists.
    booking_stmt = (
        select(func.count(Booking.id))
        .where(
            Booking.practice_id == practice_id,
            Booking.user_id == user.id,
            Booking.status.in_(_ACTIVE_BOOKING_STATUSES),
        )
    )
    booking_result = await session.execute(booking_stmt)
    if booking_result.scalar_one() > 0:
        raise ConflictError("Already booked for this practice")

    # Check existing waitlist entry.
    existing_stmt = (
        select(Waitlist)
        .where(
            Waitlist.practice_id == practice_id,
            Waitlist.user_id == user.id,
        )
        .with_for_update()
    )
    existing_result = await session.execute(existing_stmt)
    existing = existing_result.scalar_one_or_none()

    now = datetime.now(UTC)
    # L-03 fix: no longer awaited (sync function).
    next_pos = _next_position_subquery(practice_id)

    if existing:
        if existing.status in ACTIVE_STATUSES:
            raise ConflictError("Already on waitlist for this practice")

        if existing.status in REJOINABLE_STATUSES:
            # Re-join: update existing row with new position.
            existing.status = WaitlistStatus.WAITING.value
            existing.position = next_pos
            existing.joined_at = now
            existing.notified_at = None
            existing.expires_at = None

            await session.flush()
            await session.refresh(existing)

            logger.info(
                "waitlist_rejoined",
                waitlist_id=str(existing.id),
                practice_id=str(practice_id),
                user_id=str(user.id),
                position=existing.position,
            )
            return existing

    # New entry.
    entry = Waitlist(
        practice_id=practice_id,
        user_id=user.id,
        position=next_pos,
        status=WaitlistStatus.WAITING.value,
        joined_at=now,
    )
    session.add(entry)

    try:
        async with session.begin_nested():
            await session.flush()
    except IntegrityError:
        raise ConflictError(
            "Already on waitlist for this practice"
        ) from None

    await session.refresh(entry)

    logger.info(
        "waitlist_joined",
        waitlist_id=str(entry.id),
        practice_id=str(practice_id),
        user_id=str(user.id),
        position=entry.position,
    )

    return entry


async def leave_waitlist(
    waitlist_id: UUID,
    user: User,
    session: AsyncSession,
) -> Waitlist:
    """Leave the waitlist or decline a notification.

    Transitions:
    - waiting -> left
    - notified -> declined (triggers process_waitlist for next user)

    Uses FOR UPDATE (P-12).
    """
    stmt = (
        select(Waitlist)
        .where(Waitlist.id == waitlist_id)
        .with_for_update()
    )
    result = await session.execute(stmt)
    entry = result.scalar_one_or_none()

    if not entry:
        raise NotFoundError("Waitlist entry not found")

    # P-08: 404 not 403 for non-owner.
    if entry.user_id != user.id:
        raise NotFoundError("Waitlist entry not found")

    was_notified = entry.status == WaitlistStatus.NOTIFIED.value

    if entry.status == WaitlistStatus.WAITING.value:
        entry.status = WaitlistStatus.LEFT.value
    elif entry.status == WaitlistStatus.NOTIFIED.value:
        entry.status = WaitlistStatus.DECLINED.value
    else:
        raise BadRequestError("Cannot leave waitlist in current status")

    logger.info(
        "waitlist_left",
        waitlist_id=str(waitlist_id),
        user_id=str(user.id),
        new_status=entry.status,
    )

    # If user was notified (had a spot offer), notify next in line.
    if was_notified:
        await process_waitlist(entry.practice_id, session)

    return entry


async def confirm_waitlist(
    waitlist_id: UUID,
    user: User,
    session: AsyncSession,
) -> tuple[Waitlist, Booking | None]:
    """Confirm a waitlist spot -- creates a booking + purchase.

    Only works when status=notified and expires_at > now().
    Creates a booking (confirmed), a purchase (double-entry),
    and transitions to converted.

    Returns (entry, booking) on success.
    Returns (entry, None) when:
    - Offer expired: entry -> EXPIRED, next user notified.
    - Spot taken by concurrent booking: entry -> WAITING (back to queue).

    IMPORTANT: Returns (entry, None) instead of raising exceptions for
    expired/spot-taken cases. This ensures get_db_session commits the
    status changes. If we raised, the exception would trigger rollback
    and the changes would be lost.

    W1 fix: locks Practice before Waitlist, same order as join_waitlist /
    create_booking. An unlocked peek finds which practice the entry
    belongs to, so Practice can be locked first; the entry itself is then
    loaded FOR UPDATE (authoritative) for the ownership/status/expiry
    checks below. The previous Waitlist-then-Practice order here was the
    reverse of join_waitlist's Practice-then-Waitlist order, a lock-order
    deadlock risk under concurrent requests.
    """
    peek_stmt = select(Waitlist.practice_id).where(Waitlist.id == waitlist_id)
    practice_id = (await session.execute(peek_stmt)).scalar_one_or_none()
    if practice_id is None:
        raise NotFoundError("Waitlist entry not found")

    practice_stmt = (
        select(Practice)
        .where(Practice.id == practice_id)
        .with_for_update()
    )
    practice = (await session.execute(practice_stmt)).scalar_one_or_none()
    if not practice:
        raise NotFoundError("Waitlist entry not found")

    stmt = (
        select(Waitlist)
        .where(Waitlist.id == waitlist_id)
        .with_for_update()
    )
    result = await session.execute(stmt)
    entry = result.scalar_one_or_none()

    if not entry:
        raise NotFoundError("Waitlist entry not found")

    # P-08: 404 not 403 for non-owner.
    if entry.user_id != user.id:
        raise NotFoundError("Waitlist entry not found")

    if entry.status != WaitlistStatus.NOTIFIED.value:
        raise BadRequestError("Can only confirm a notified waitlist entry")

    # Lazy expiration check.
    # Returns (entry, None) instead of raising -- changes must commit.
    now = datetime.now(UTC)
    if entry.expires_at and entry.expires_at < now:
        entry.status = WaitlistStatus.EXPIRED.value
        await process_waitlist(entry.practice_id, session)

        logger.info(
            "waitlist_confirm_expired",
            waitlist_id=str(waitlist_id),
            user_id=str(user.id),
            expires_at=entry.expires_at.isoformat(),
        )
        return entry, None

    # P5 (ПРОМТ №594, the carried seam from P1): reject a viewer blocked by
    # this practice's master, or outside its configured audience. This is
    # the OTHER booking-creation path besides create_booking -- a waitlist
    # notification is a HELD spot; without this check here, a user blocked
    # (or audience-narrowed out) after joining the waitlist but before being
    # notified could still convert that hold into a real booking. Raises
    # (not the soft (entry, None) return the expiry/capacity cases below
    # use) -- this is a rejection, not a business state to route back to
    # the queue.
    await assert_viewer_can_access_practice(user.id, practice, session)

    # Recheck capacity (overbooking prevention) -- practice already locked
    # above. Between cancel_booking (which freed a spot) and now, a
    # concurrent create_booking could have taken the spot.
    if practice.max_participants is not None:
        active = await _get_active_booking_count(
            session, entry.practice_id,
        )
        if active >= practice.max_participants:
            # Spot was taken -- return user to queue (not their fault).
            entry.status = WaitlistStatus.WAITING.value
            entry.notified_at = None
            entry.expires_at = None

            logger.info(
                "waitlist_confirm_spot_taken",
                waitlist_id=str(waitlist_id),
                user_id=str(user.id),
                active_bookings=active,
                max_participants=practice.max_participants,
            )
            return entry, None

    # Create booking (auto-confirmed).
    booking = Booking(
        practice_id=entry.practice_id,
        user_id=user.id,
        status=BookingStatus.CONFIRMED.value,
    )
    session.add(booking)

    # FIX 2.1: begin_nested() (SAVEPOINT) instead of session.rollback().
    # Rollback kills the entire transaction including FOR UPDATE locks
    # and the entry status changes above. Savepoint rolls back only
    # the failed flush, keeping the outer transaction alive.
    try:
        async with session.begin_nested():
            await session.flush()
    except IntegrityError:
        raise ConflictError(
            "Already booked for this practice"
        ) from None

    # Double-entry purchase (always, Semaphore 1.1).
    # Load user for balance check inside create_purchase_for_booking.
    user_obj = await session.get(User, user.id)
    await create_purchase_for_booking(
        booking=booking,
        practice=practice,
        user=user_obj,
        session=session,
    )

    entry.status = WaitlistStatus.CONVERTED.value

    # Update cached participant count (Frontend Backlog A-03).
    await recalculate_participants(entry.practice_id, session)

    logger.info(
        "waitlist_confirmed",
        waitlist_id=str(waitlist_id),
        booking_id=str(booking.id),
        practice_id=str(entry.practice_id),
        user_id=str(user.id),
    )

    return entry, booking


async def process_waitlist(
    practice_id: UUID,
    session: AsyncSession,
) -> Waitlist | None:
    """Notify the next waiting user in the queue.

    Called automatically when:
    - A booking is cancelled (from cancel_booking)
    - A notified user declines or expires

    Finds the first 'waiting' entry by position, transitions
    to 'notified', and sets expires_at.

    FIX 3.1: Creates a real Notification (WAITLIST_SPOT_AVAILABLE)
    instead of a stub logger call. Template tells the user they have
    30 minutes to confirm (not "automatically booked"). Deep link
    points to the confirm action.

    Returns the notified entry, or None if queue is empty.
    """
    stmt = (
        select(Waitlist)
        .where(
            Waitlist.practice_id == practice_id,
            Waitlist.status == WaitlistStatus.WAITING.value,
        )
        .order_by(Waitlist.position)
        .limit(1)
        .with_for_update()
    )
    result = await session.execute(stmt)
    entry = result.scalar_one_or_none()

    if not entry:
        logger.info(
            "waitlist_empty",
            practice_id=str(practice_id),
        )
        return None

    now = datetime.now(UTC)
    entry.status = WaitlistStatus.NOTIFIED.value
    entry.notified_at = now
    entry.expires_at = now + _CONFIRM_WINDOW

    # FIX 3.1: Create real notification instead of stub logger.
    # Lazy imports to avoid circular dependencies.
    from app.modules.notifications.models import (
        NotificationType,
        TargetType,
    )
    from app.modules.notifications.service import create_notification

    # Load practice for template variables.
    practice = await session.get(Practice, practice_id)
    master_name = await get_master_display_name(
        practice.master_id, session,
    )

    await create_notification(
        type=NotificationType.WAITLIST_SPOT_AVAILABLE.value,
        title="Spot available",
        body="A spot opened up",
        target_type=TargetType.USER.value,
        target_value=str(entry.user_id),
        session=session,
        action_data={
            "action": "confirm_waitlist",
            "params": {"waitlist_id": str(entry.id)},
            "practice_id": str(practice_id),
            "practice_title": practice.title,
            "scheduled_at": practice.scheduled_at.isoformat(),
            "master_name": master_name,
            "expires_at": entry.expires_at.isoformat(),
        },
        priority=2,
        expiry_at=entry.expires_at,
    )

    logger.info(
        "waitlist_user_notified",
        waitlist_id=str(entry.id),
        practice_id=str(practice_id),
        user_id=str(entry.user_id),
        expires_at=entry.expires_at.isoformat(),
    )

    return entry


# ===================================================================
# Frontend Backlog: User-facing list endpoint
# ===================================================================


async def list_user_waitlist(
    user: User,
    session: AsyncSession,
    *,
    status_filter: str | None = None,
    limit: int = 20,
    offset: int = 0,
) -> tuple[list[tuple[Waitlist, Practice]], int]:
    """List waitlist entries for the current user with practice data.

    Returns (items, total) where items are (Waitlist, Practice) tuples.
    Supports filtering by waitlist status and pagination.

    Used by GET /api/v1/waitlist/me.
    """
    filters: list = [Waitlist.user_id == user.id]
    if status_filter:
        filters.append(Waitlist.status == status_filter)

    # Total count.
    count_stmt = (
        select(func.count(Waitlist.id))
        .where(*filters)
    )
    total = (await session.execute(count_stmt)).scalar_one()

    # Paginated items with practice JOIN.
    stmt = (
        select(Waitlist, Practice)
        .join(Practice, Waitlist.practice_id == Practice.id)
        .where(*filters)
        .order_by(Waitlist.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    result = await session.execute(stmt)
    items = [(row[0], row[1]) for row in result.all()]

    return items, total
