# =============================================================================
# VELO Backend -- Diary Check-ins Service (Phase 8.1, W25 split from service.py)
# =============================================================================
#
# Pre-practice check-ins: create (once, immutable), list own, get one, and
# batch-load PRE check-ins for a set of bookings (consumed by
# bookings/service.py's attendance view, function-locally, to keep the
# bookings -> diary dependency one-way -- see diary/projections.py's
# DEPENDENCY DIRECTION note).
# =============================================================================

from datetime import UTC, datetime, timedelta
from uuid import UUID

import structlog
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import record_audit
from app.core.config import settings
from app.core.exceptions import BadRequestError, ConflictError, NotFoundError
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.diary.models import Checkin, CheckType
from app.modules.diary.notify_master import notify_master_of_checkin
from app.modules.diary.projections import upsert_checkin_event
from app.modules.masters.service import get_master_full_name
from app.modules.practices.audience_service import assert_viewer_not_blocked
from app.modules.practices.models import Practice
from app.modules.users.models import User

logger = structlog.get_logger()


# ===================================================================
# Upsert checkin (Phase 8.1)
# ===================================================================


async def upsert_checkin(
    user: User,
    practice_id: UUID,
    mood: int,
    session: AsyncSession,
    *,
    comment: str | None = None,
) -> tuple[Checkin, bool]:
    """Create a pre-practice check-in (immutable, once only).

    A check-in is a recorded data point and can never be changed. If a PRE
    check-in already exists for this booking, the request is rejected with
    ConflictError -- the original row is never overwritten.

    Args:
        user: Authenticated user.
        practice_id: Target practice UUID.
        mood: A 1..10 score (validated in schema).
        session: Write session (caller manages commit).
        comment: Optional text (max length validated in schema).

    Returns:
        Tuple of (checkin, is_new). is_new is always True (create-only);
        the tuple shape is kept for backward compatibility with callers.

    Raises:
        NotFoundError("no_active_booking"): no live booking for this
            practice, or a live booking that is not CONFIRMED while the
            window has not closed.
        ForbiddenError("blocked_by_master"): the master blocked this viewer.
        BadRequestError("checkin_window_closed"): the practice has started.
        BadRequestError("checkin_window_not_open"): too early.
        ConflictError: A check-in already exists (resubmission is forbidden).
    """
    # 1. Find this user's LIVE booking for the practice, with the practice.
    #
    # Any status but cancelled (BE-92): a booking that left CONFIRMED when
    # the practice started (attendance decided -> attended / no_show) must
    # still reach the window check below and get the honest "window
    # closed", not a 404. Cancelled is "no booking": the person gave it up,
    # and there can be any number of cancelled rows per pair -- the partial
    # unique index uq_booking_practice_user_active (practice_id, user_id)
    # WHERE status <> 'cancelled' is what makes this at most one row.
    #
    # The practice comes in the same row: bookings.practice_id is
    # ON DELETE CASCADE, so a found booking always has its practice.
    #
    # No existence oracle: a stranger -- no booking, or only a cancelled
    # one -- gets the same no_active_booking for a practice that exists and
    # for one that does not; only someone holding a live booking (who knows
    # the practice exists) gets the 403 / 400 answers below.
    row = (
        await session.execute(
            select(Booking, Practice)
            .join(Practice, Practice.id == Booking.practice_id)
            .where(
                Booking.practice_id == practice_id,
                Booking.user_id == user.id,
                Booking.status != BookingStatus.CANCELLED.value,
            )
        )
    ).one_or_none()

    if row is None:
        raise NotFoundError(
            "No active booking found for this practice",
            code="no_active_booking",
        )
    booking, practice = row

    # RETROACTIVE POLICY (B) (H-R2-8, was P5 ПРОМТ №594): of the two
    # retroactive cases create_booking's own gate cannot cover -- a
    # booking made BEFORE the master narrowed the audience, or BEFORE the
    # master blocked this viewer -- only the BLOCK still refuses check-in.
    # Audience narrowing is an impersonal reconfiguration and is
    # grandfathered by the booking found above (CONFIRMED is required
    # below, after the window-closed check; paid access is
    # not retroactively stripped -- the R2 symmetry); a block is targeted
    # moderation and revokes the ACTION (this check-in), though not the
    # record (get_practice_detail keeps the practice readable for a
    # booked viewer -- see its view manifest). Hence the blocked-ONLY
    # probe below instead of the full audience predicate -- see
    # assert_viewer_not_blocked's docstring (audience_service.py) for why
    # a separate function and not a flag. Order preserved: booking-first
    # above keeps "404 before 403" so this endpoint is no existence
    # oracle for strangers.
    # Frontend note: of CheckinView.vue's three mapped codes, only
    # "blocked_by_master" -> "Мастер ограничил вам доступ к этой
    # практике" remains reachable from check-in; the "not_a_student" /
    # "not_in_audience" branches are now dead FOR THIS ENDPOINT (kept in
    # the view -- other consumers of those codes exist; recorded in the
    # H-R2-8 report, not cleaned here).
    await assert_viewer_not_blocked(user.id, practice, session)

    now = datetime.now(UTC)
    window_open = practice.scheduled_at - timedelta(
        hours=settings.checkin_window_hours,
    )

    # Closed BEFORE the status check: past the start, any live booking --
    # still confirmed, or already attended / no_show -- hears that the
    # window closed.
    if now >= practice.scheduled_at:
        raise BadRequestError(
            "Check-in window has closed", code="checkin_window_closed"
        )
    if booking.status != BookingStatus.CONFIRMED.value:
        raise NotFoundError(
            "No active booking found for this practice",
            code="no_active_booking",
        )
    if now < window_open:
        raise BadRequestError(
            f"Check-in window opens "
            f"{settings.checkin_window_hours}h before the practice",
            code="checkin_window_not_open",
        )

    # 3. Reject resubmission -- a check-in is immutable once recorded.
    existing_stmt = (
        select(Checkin)
        .where(
            Checkin.booking_id == booking.id,
            Checkin.check_type == CheckType.PRE.value,
        )
    )
    result = await session.execute(existing_stmt)
    existing = result.scalar_one_or_none()

    if existing is not None:
        # A check-in is a recorded data point: submitted once, never changed.
        raise ConflictError(
            "Check-in already submitted and cannot be changed"
        )

    # Create new checkin.
    checkin = Checkin(
        practice_id=practice_id,
        user_id=user.id,
        booking_id=booking.id,
        mood=mood,
        comment=comment,
        check_type=CheckType.PRE.value,
    )

    # P-05: guard the concurrent first-submit race. Two parallel requests can
    # both pass the SELECT above with existing=None; the unique constraint
    # uq_checkin_booking_type then rejects the loser. try/except OUTSIDE
    # begin_nested (ERR-05) so the savepoint rolls back cleanly and the outer
    # transaction survives; convert to the same ConflictError as resubmission.
    try:
        async with session.begin_nested():
            session.add(checkin)
            await session.flush()
    except IntegrityError:
        raise ConflictError(
            "Check-in already submitted and cannot be changed"
        ) from None

    await record_audit(
        event="checkin_created",
        actor_id=user.id,
        actor_type="user",
        target_type="checkin",
        target_id=checkin.id,
        data={"mood": mood, "practice_id": str(practice_id)},
        session=session,
    )

    logger.info(
        "checkin_created",
        checkin_id=str(checkin.id),
        user_id=str(user.id),
        practice_id=str(practice_id),
        mood=mood,
    )

    # Diary feed: project the new check-in onto the user's timeline.
    master_name = await get_master_full_name(practice.master_id, session)
    await upsert_checkin_event(
        session,
        checkin=checkin,
        practice=practice,
        master_name=master_name,
    )

    # BE-33 item 5: tell the practice's master, one message per check-in.
    # Same transaction as the row (transactional outbox), so a rolled-back
    # check-in leaves no notification behind.
    await notify_master_of_checkin(
        session, checkin=checkin, practice=practice, author=user,
    )
    return checkin, True


# ===================================================================
# List user checkins (Phase 8.1)
# ===================================================================


async def list_user_checkins(
    user: User,
    session: AsyncSession,
    *,
    limit: int = 20,
    offset: int = 0,
    practice_id: UUID | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
) -> tuple[list[Checkin], int]:
    """List check-ins for a user with optional filters.

    11.1 fix: total count derived from base query subquery instead of
    maintaining a parallel count_base with duplicated filter clauses.

    Returns:
        Tuple of (items, total_count).
    """
    base = select(Checkin).where(Checkin.user_id == user.id)

    if practice_id is not None:
        base = base.where(Checkin.practice_id == practice_id)

    if date_from is not None:
        base = base.where(Checkin.created_at >= date_from)

    if date_to is not None:
        base = base.where(Checkin.created_at <= date_to)

    # Count via subquery -- filters applied once.
    total = (
        await session.execute(
            select(func.count()).select_from(base.subquery())
        )
    ).scalar_one()

    items_stmt = (
        base
        .order_by(Checkin.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    result = await session.execute(items_stmt)
    items = list(result.scalars().all())

    return items, total


async def get_checkin(
    user: User,
    checkin_id: UUID,
    session: AsyncSession,
) -> Checkin:
    """Get a single check-in owned by the user (read-only detail).

    Raises:
        NotFoundError: Check-in not found or not owned by user.
    """
    checkin = await session.get(Checkin, checkin_id)

    if checkin is None or checkin.user_id != user.id:
        raise NotFoundError("Check-in not found")

    return checkin


async def get_pre_checkins_for_bookings(
    booking_ids: list[UUID],
    session: AsyncSession,
) -> dict[UUID, Checkin]:
    """Batch-load PRE check-ins for a set of bookings, keyed by booking_id.

    Used by the master-facing attendance view (bookings/service.py
    get_attendance) to show each participant's PRE check-in alongside their
    attendance row. One query over booking_id IN (...), so the attendance
    endpoint stays free of N+1 lookups regardless of participant count.

    PRIVACY: this reads OTHER users' check-ins, which are otherwise private
    (GET /users/me/checkins is own-only). It is safe here because the only
    caller already enforced practice ownership (get_attendance, P-08) and the
    booking_ids it passes all belong to that one practice. This function does
    NOT re-check authorization -- it must only ever be called with a
    pre-authorized set of booking_ids. Same trust boundary as
    get_practice_insights, which also reads participants' check-ins for the
    owning master.

    Only PRE check-ins are returned (CheckType.PRE): the master cares about
    what the participant reported BEFORE the practice when preparing for it.
    The (booking_id, check_type) uniqueness in the Checkin model guarantees at
    most one PRE row per booking, so the booking_id -> Checkin mapping is
    unambiguous.

    Returns:
        Dict mapping booking_id -> Checkin for bookings that have a PRE
        check-in. Bookings without one are simply absent from the dict.
        Empty dict when booking_ids is empty.
    """
    if not booking_ids:
        return {}

    stmt = (
        select(Checkin)
        .where(
            Checkin.booking_id.in_(booking_ids),
            Checkin.check_type == CheckType.PRE.value,
        )
    )
    result = await session.execute(stmt)
    return {c.booking_id: c for c in result.scalars().all()}
