# =============================================================================
# VELO Backend -- Booking Service (Phase 5.1+5.2+5.3+5.4+6.5+6.7, Backlog)
# =============================================================================
#
# Business logic for booking create, cancel, attendance, finalize,
# and user-facing list/detail endpoints (Frontend Backlog).
#
# STATE MACHINE:
#   pending   -> confirmed, cancelled
#   confirmed -> attended, no_show, cancelled
#   attended  -> (terminal)
#   no_show   -> (terminal)
#   cancelled -> (terminal)
#
# ATTENDANCE + LIFECYCLE (Phase 5.4; Batch 1 -- time-driven, no manual path):
#   join_booking:           sets joined_at (status stays confirmed)
#   leave_booking:          sets left_at (requires joined_at)
#   auto_start_practice:    scheduled -> live once the start time has passed
#                           (system actor; called by the autofinalizer worker)
#   auto_finalize_practice: scheduled/live -> completed once the end has passed
#                           confirmed + (joined_at OR PRE check-in) -> attended
#                           confirmed + neither                     -> no_show
#                           (system actor; shared core _finalize_practice_core)
#
# PURCHASE INTEGRATION (Phase 6.4):
#   create_booking:         creates Purchase + double-entry ledger (always, even free)
#   auto_finalize_practice: finalizes Purchases (unfreeze + commission)
#
# PROMO INTEGRATION (Phase 6.7 Batch 4):
#   create_booking: optional promo param, passed to create_purchase_for_booking.
#   Promo validation happens in the caller (router or purchase_router).
#
# CANCELLATION POLICY (Phase 6.5):
#   cancel_booking now handles refunds based on deadline:
#     > cancellation_deadline_hours before practice -> 100% refund
#     <= cancellation_deadline_hours before practice -> 0% refund (early finalize)
#   Both paths produce double-entry ledger entries (even for free practices).
#
# PARTICIPANT COUNT (Frontend Backlog A-03):
#   recalculate_participants() updates Practice.current_participants
#   after every booking status change.
#
# CAPACITY:
#   Checked via COUNT of active bookings, not current_participants (TD-034).
#
# WAITLIST INTEGRATION (Phase 5.3):
#   After cancelling a booking, process_waitlist is called.
#
# SESSION RULES:
#   No session.commit() here (P-01). Router handles flush + refresh.
#
# B-05: list_user_bookings uses subquery pattern for count (same as
#   list_user_checkins in diary/checkins_service.py). Eliminates parallel
#   count_base query that required manual filter duplication.
# =============================================================================

from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING
from uuid import UUID

import structlog
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import (
    BadRequestError,
    ConflictError,
    NotFoundError,
)
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.payments.purchase import (
    create_purchase_for_booking,
    finalize_purchases,
)
from app.modules.payments.refund import (
    early_finalize_booking,
    refund_booking,
)
from app.modules.practices.audience_service import assert_viewer_can_access_practice
from app.modules.practices.models import Practice, PracticeStatus
from app.modules.promos.models import Promo
from app.modules.users.models import User

if TYPE_CHECKING:
    # Type-only import: the runtime import lives inside get_attendance to keep
    # the bookings -> diary dependency one-way (diary imports from bookings).
    from app.modules.diary.models import Checkin

logger = structlog.get_logger()

# Statuses that count toward capacity (for overbooking prevention).
_ACTIVE_BOOKING_STATUSES = {
    BookingStatus.PENDING.value,
    BookingStatus.CONFIRMED.value,
}

# Statuses from which cancellation is allowed.
_CANCELLABLE_STATUSES = {
    BookingStatus.PENDING.value,
    BookingStatus.CONFIRMED.value,
}

# Practice statuses that allow user check-in.
_JOINABLE_PRACTICE_STATUSES = {
    PracticeStatus.SCHEDULED.value,
    PracticeStatus.LIVE.value,
}

# Practice statuses that allow finalization.
_FINALIZABLE_PRACTICE_STATUSES = {
    PracticeStatus.SCHEDULED.value,
    PracticeStatus.LIVE.value,
}

# Statuses that count toward current_participants (display count).
# Different from _ACTIVE_BOOKING_STATUSES which includes pending
# for capacity checks. This counts who is actually "in" the practice.
# Consistent with Semaphore 3.4.
_PARTICIPANT_STATUSES = {
    BookingStatus.CONFIRMED.value,
    BookingStatus.ATTENDED.value,
}


async def _get_active_booking_count(
    session: AsyncSession,
    practice_id: UUID,
) -> int:
    """Count active bookings for a practice (TD-034)."""
    stmt = (
        select(func.count(Booking.id))
        .where(
            Booking.practice_id == practice_id,
            Booking.status.in_(_ACTIVE_BOOKING_STATUSES),
        )
    )
    result = await session.execute(stmt)
    return result.scalar_one()


async def recalculate_participants(
    practice_id: UUID,
    session: AsyncSession,
) -> int:
    """Recalculate and update Practice.current_participants.

    Counts bookings with status IN (confirmed, attended).
    Uses FOR UPDATE on Practice to prevent concurrent cached writes.

    This is the ONLY correct way to update current_participants.
    Analogous to balance recalculation in payments/service.py.

    Called after every booking status change:
      - create_booking (bookings/service.py)
      - cancel_booking (bookings/service.py)
      - auto_finalize_practice (bookings/service.py, via _finalize_practice_core)
      - confirm_waitlist (waitlist/service.py)
      - refund_all_bookings_for_practice (payments/refund.py)

    Returns the new participant count.
    """
    count_stmt = (
        select(func.count(Booking.id))
        .where(
            Booking.practice_id == practice_id,
            Booking.status.in_(_PARTICIPANT_STATUSES),
        )
    )
    result = await session.execute(count_stmt)
    count = result.scalar_one()

    # Lock practice row and update cached field.
    # Same pattern as balance recalculation (payments/service.py).
    practice = await session.get(
        Practice, practice_id, with_for_update=True,
    )
    if practice is not None:
        practice.current_participants = count
        await session.flush()

    logger.info(
        "participants_recalculated",
        practice_id=str(practice_id),
        current_participants=count,
    )

    return count


async def create_booking(
    user: User,
    practice_id: UUID,
    session: AsyncSession,
    promo: Promo | None = None,
) -> Booking:
    """Book a user into a practice.

    Validates:
    - Practice exists and is in scheduled/live status.
    - User is not the practice owner.
    - Practice is not full.
    - No active booking already exists (IntegrityError -> 409).

    Phase 6.7: optional promo for discount calculation.

    Uses begin_nested() (SAVEPOINT) to catch IntegrityError
    on the partial unique index without killing the outer transaction.
    """
    stmt = (
        select(Practice)
        .where(Practice.id == practice_id)
        .with_for_update()
    )
    result = await session.execute(stmt)
    practice = result.scalar_one_or_none()

    if not practice:
        raise NotFoundError("Practice not found")

    if practice.status not in _JOINABLE_PRACTICE_STATUSES:
        raise BadRequestError("Practice is not available for booking")

    # Time guard: a practice that has already started can no longer be booked.
    # The public feed (practices/listing_service.py list_public_practices) hides
    # started/past practices, but the booking endpoints are reachable directly
    # by practice_id (e.g. opening a practice from "my bookings" history or a
    # deep link), so the feed filter is not enough. This is the single choke
    # point both POST /bookings and POST /practices/{id}/purchase go through,
    # so the guard here covers both paths. Threshold is the start
    # (scheduled_at), matching the feed. The status check above does not catch
    # this: a practice can still be `scheduled` past its start time when the
    # master never finalized it and the auto-finalizer has not run yet.
    if practice.scheduled_at <= datetime.now(timezone.utc):
        raise BadRequestError(
            "Cannot book a practice that has already started"
        )

    if practice.master_id == user.id:
        raise BadRequestError("Cannot book your own practice")

    # P5 (ПРОМТ №594, the carried seam from P1): reject a viewer blocked by
    # this practice's master, or outside its configured audience. Shared
    # with confirm_waitlist (waitlist/service.py, the OTHER booking-creation
    # path) and upsert_checkin (diary/checkins_service.py) -- one predicate,
    # not reimplemented per call site.
    await assert_viewer_can_access_practice(user.id, practice, session)

    active_count = await _get_active_booking_count(session, practice_id)
    # max_participants=None means unlimited capacity -- skip the check.
    if (
        practice.max_participants is not None
        and active_count >= practice.max_participants
    ):
        # F-03: unique code so frontend can switch on e.code instead of
        # string-matching the human-readable message.
        raise BadRequestError("Practice is full", code="practice_full")

    booking = Booking(
        practice_id=practice_id,
        user_id=user.id,
        status=BookingStatus.CONFIRMED.value,
    )
    session.add(booking)

    try:
        async with session.begin_nested():
            await session.flush()
    except IntegrityError:
        raise ConflictError(
            "Already booked for this practice"
        ) from None

    # Double-entry purchase (always, even for free practices).
    # Phase 6.7: pass promo for discount calculation.
    purchase = await create_purchase_for_booking(
        booking=booking,
        practice=practice,
        user=user,
        session=session,
        promo=promo,
    )

    # Update cached participant count (Frontend Backlog A-03).
    await recalculate_participants(practice_id, session)

    logger.info(
        "booking_created",
        booking_id=str(booking.id),
        purchase_id=str(purchase.id),
        practice_id=str(practice_id),
        user_id=str(user.id),
        status=booking.status,
        paid_cents=purchase.paid_cents,
        promo_code=promo.code if promo else None,
    )

    # Diary feed: project "user booked a practice" onto the user's timeline.
    # Lazy import keeps the dependency one-way (bookings -> diary) and avoids
    # an import cycle, same pattern as process_waitlist below.
    from app.modules.diary.projections import project_booking_confirmed
    from app.modules.masters.service import get_master_display_name
    master_name = await get_master_display_name(practice.master_id, session)
    await project_booking_confirmed(
        session,
        booking=booking,
        practice=practice,
        master_name=master_name,
        occurred_at=booking.created_at,
    )

    # E21 step E: create the Zoom registrant for this booking. Best-effort,
    # never raises, never blocks -- if the meeting isn't active yet or the
    # Zoom call fails, the booking above has ALREADY succeeded; the
    # registrant is queued for the retry poller (ПРОМТ №520 amendment,
    # restated explicitly: not softened into "usually"). Lazy import, same
    # one-way-dependency pattern as diary above.
    from app.modules.zoom.service import create_registrant_for_booking
    await create_registrant_for_booking(booking, user, session)

    return booking


async def skip_checkin(
    booking_id: UUID,
    user: User,
    session: AsyncSession,
) -> Booking:
    """Persist the user's choice to skip their PRE check-in for this booking.

    Sets booking.checkin_skipped = True so the dashboard banner / check-in
    prompt stays hidden across sessions and devices (was client-only before).
    Owner-only (P-08: 404 not 403 to avoid revealing booking existence).
    Idempotent: re-skipping an already-skipped booking is a no-op.
    """
    stmt = select(Booking).where(Booking.id == booking_id)
    booking = (await session.execute(stmt)).scalar_one_or_none()

    if not booking:
        raise NotFoundError("Booking not found")

    # P-08: 404 not 403 to avoid revealing booking existence.
    if booking.user_id != user.id:
        raise NotFoundError("Booking not found")

    booking.checkin_skipped = True
    return booking


async def cancel_booking(
    booking_id: UUID,
    user: User,
    session: AsyncSession,
    reason: str | None = None,
) -> Booking:
    """Cancel a booking with refund policy enforcement.

    Only the booking owner can cancel. Only pending/confirmed
    bookings can be cancelled.

    Refund policy (Phase 6.5):
    - Cancel > cancellation_deadline_hours before practice:
      100% refund (Purchase -> REFUNDED).
    - Cancel <= cancellation_deadline_hours before practice:
      0% refund, early finalize (Purchase -> COMPLETED,
      master keeps money minus commission).

    Both paths create double-entry ledger entries, even for
    free practices (zero-amount entries as proof of path).

    After cancellation, triggers waitlist processing to notify
    the next waiting user (Phase 5.3).

    Uses FOR UPDATE to prevent concurrent cancellation (P-12).
    """
    stmt = (
        select(Booking)
        .where(Booking.id == booking_id)
        .with_for_update()
    )
    result = await session.execute(stmt)
    booking = result.scalar_one_or_none()

    if not booking:
        raise NotFoundError("Booking not found")

    # P-08: 404 not 403 to avoid revealing booking existence.
    if booking.user_id != user.id:
        raise NotFoundError("Booking not found")

    if booking.status not in _CANCELLABLE_STATUSES:
        raise BadRequestError(
            f"Cannot cancel booking in status "
            f"{booking.status}"
        )

    booking.status = BookingStatus.CANCELLED.value
    booking.cancelled_at = datetime.now(timezone.utc)
    booking.cancellation_reason = reason

    # Phase 6.5: Refund or early-finalize based on deadline.
    # Load practice for scheduled_at (read-only, no FOR UPDATE needed).
    practice_stmt = (
        select(Practice)
        .where(Practice.id == booking.practice_id)
    )
    practice = (
        await session.execute(practice_stmt)
    ).scalar_one()

    # Fix 2.3: scheduled_at is NOT NULL in the model, but guard against
    # incomplete ORM objects (e.g. partial loads in tests). Treat missing
    # scheduled_at as early cancel (full refund) -- the safe default.
    if practice.scheduled_at is None:
        logger.warning(
            "cancel_booking_missing_scheduled_at",
            booking_id=str(booking_id),
            practice_id=str(booking.practice_id),
        )
        await refund_booking(
            booking=booking,
            practice=practice,
            session=session,
        )
    else:
        deadline = practice.scheduled_at - timedelta(
            hours=settings.cancellation_deadline_hours,
        )
        now = datetime.now(timezone.utc)

        if now < deadline:
            # Early cancel: full refund.
            await refund_booking(
                booking=booking,
                practice=practice,
                session=session,
            )
            logger.info(
                "booking_cancelled_with_refund",
                booking_id=str(booking_id),
                user_id=str(user.id),
                reason=reason,
            )
        else:
            # Late cancel: master keeps the money (early finalize).
            await early_finalize_booking(
                booking=booking,
                practice=practice,
                session=session,
            )
            logger.info(
                "booking_cancelled_no_refund",
                booking_id=str(booking_id),
                user_id=str(user.id),
                reason=reason,
            )

    # Update cached participant count (Frontend Backlog A-03).
    await recalculate_participants(booking.practice_id, session)

    # Phase 5.3: Notify next waiting user in the queue.
    from app.modules.waitlist.service import process_waitlist
    await process_waitlist(booking.practice_id, session)

    # Diary feed: project "user cancelled their booking" onto the timeline.
    # occurred_at is the cancellation instant (set above). Lazy import keeps
    # the dependency one-way (bookings -> diary).
    from app.modules.diary.projections import project_booking_cancelled
    from app.modules.masters.service import get_master_display_name
    master_name = await get_master_display_name(practice.master_id, session)
    await project_booking_cancelled(
        session,
        booking=booking,
        practice=practice,
        master_name=master_name,
        occurred_at=booking.cancelled_at,
    )

    # E21 step E: best-effort Zoom-side registrant cancel. Our own row's
    # status is the authority regardless of Zoom's outcome -- see
    # cancel_registrant_for_booking's docstring.
    from app.modules.zoom.service import cancel_registrant_for_booking
    await cancel_registrant_for_booking(booking, session)

    return booking


# ===================================================================
# Phase 5.4: Attendance
# ===================================================================


async def join_booking(
    booking_id: UUID,
    user: User,
    session: AsyncSession,
) -> Booking:
    """Mark user as joined (check-in).

    Sets joined_at timestamp. Status stays confirmed -- the
    transition to attended happens at finalize.

    Validates:
    - Booking exists and belongs to user (P-08).
    - Status is confirmed.
    - Practice is in joinable state (scheduled/live).
    - Not already joined (409).

    Uses FOR UPDATE (P-12).
    """
    stmt = (
        select(Booking)
        .where(Booking.id == booking_id)
        .with_for_update()
    )
    result = await session.execute(stmt)
    booking = result.scalar_one_or_none()

    if not booking:
        raise NotFoundError("Booking not found")

    if booking.user_id != user.id:
        raise NotFoundError("Booking not found")

    if booking.status != BookingStatus.CONFIRMED.value:
        raise BadRequestError(
            "Can only join a confirmed booking"
        )

    if booking.joined_at is not None:
        raise ConflictError("Already joined")

    # Check practice is in joinable state.
    practice_stmt = (
        select(Practice)
        .where(Practice.id == booking.practice_id)
    )
    practice = (
        await session.execute(practice_stmt)
    ).scalar_one()

    if practice.status not in _JOINABLE_PRACTICE_STATUSES:
        raise BadRequestError("Cannot join this practice")

    booking.joined_at = datetime.now(timezone.utc)

    logger.info(
        "booking_joined",
        booking_id=str(booking_id),
        user_id=str(user.id),
        practice_id=str(booking.practice_id),
    )

    return booking


async def leave_booking(
    booking_id: UUID,
    user: User,
    session: AsyncSession,
) -> Booking:
    """Mark user as left.

    Sets left_at timestamp. Requires joined_at to be set.

    Validates:
    - Booking exists and belongs to user (P-08).
    - joined_at is set (400 if not).
    - left_at is not already set (409).

    Uses FOR UPDATE (P-12).
    """
    stmt = (
        select(Booking)
        .where(Booking.id == booking_id)
        .with_for_update()
    )
    result = await session.execute(stmt)
    booking = result.scalar_one_or_none()

    if not booking:
        raise NotFoundError("Booking not found")

    if booking.user_id != user.id:
        raise NotFoundError("Booking not found")

    if booking.joined_at is None:
        raise BadRequestError(
            "Cannot leave without joining first"
        )

    if booking.left_at is not None:
        raise ConflictError("Already left")

    booking.left_at = datetime.now(timezone.utc)

    logger.info(
        "booking_left",
        booking_id=str(booking_id),
        user_id=str(user.id),
        practice_id=str(booking.practice_id),
    )

    return booking


async def resolve_bookings_via_legacy_proxy(
    bookings: list[Booking],
    practice_id: UUID,
    session: AsyncSession,
) -> list[tuple[UUID, UUID, str]]:
    """Decide a batch of CONFIRMED bookings via the join_at/PRE-checkin
    proxy, tagged attendance_decided_via='legacy_proxy'. THE ONE PLACE that
    knows how the proxy decides -- used both by _finalize_practice_core
    (practices with no active Zoom meeting, decided immediately) and by
    zoom/attendance_service.py's deadline fallback (Zoom-tracked practices
    whose report never arrived in time). Returns (user_id, booking_id,
    status) outcomes for the caller's own diary projection -- this function
    does not project anything itself, since the two callers project at
    different moments (immediately vs. later).

    W-1: presence is proven by a Zoom join OR a PRE check-in. Callers pass
    already FOR-UPDATE-locked, already-CONFIRMED bookings; this does not
    re-check either.
    """
    # Runtime-local import keeps the bookings -> diary dependency one-way.
    from app.modules.diary.models import Checkin, CheckType

    checkin_rows = await session.execute(
        select(Checkin.booking_id).where(
            Checkin.practice_id == practice_id,
            Checkin.check_type == CheckType.PRE.value,
        )
    )
    checked_in_booking_ids = set(checkin_rows.scalars().all())

    outcomes: list[tuple[UUID, UUID, str]] = []
    for booking in bookings:
        attended = (
            booking.joined_at is not None
            or booking.id in checked_in_booking_ids
        )
        booking.status = (
            BookingStatus.ATTENDED.value if attended else BookingStatus.NO_SHOW.value
        )
        booking.attendance_decided_via = "legacy_proxy"
        outcomes.append((booking.user_id, booking.id, booking.status))

    return outcomes


async def _finalize_practice_core(
    practice: Practice,
    session: AsyncSession,
    *,
    actor: str,
) -> Practice:
    """Shared finalization logic -- NO authorization, NO practice loading.

    Caller MUST pass a practice that is already loaded FOR UPDATE and already
    validated to be in a finalizable state (_FINALIZABLE_PRACTICE_STATUSES).
    This is the single source of truth for what "finalizing a practice" means.
    It is reached only through the system auto-close path
    (auto_finalize_practice), invoked by the lifecycle worker once the practice's
    scheduled end has passed (the manual master finalize was removed in Batch 1).
    Keeping one core means attendance, money, and the diary are always settled
    the same way.

    Transitions:
    - NO active Zoom meeting, OR an active meeting created in Zoom STUB mode
      (ПРОМТ №530, settings.is_zoom_stub -- no real credentials configured):
      confirmed + (joined_at IS NOT NULL OR PRE check-in) -> attended, else
      -> no_show. Decided HERE, immediately, tagged legacy_proxy (unchanged
      from before E21 step F -- covers practices published before Zoom
      shipped, AND every practice on a server with no real Zoom credentials
      today, since a stub meeting can never produce a real report).
    - HAS an active meeting AND real credentials are configured (E21 step
      F): confirmed bookings are DEFERRED -- left exactly as CONFIRMED, NOT
      flipped here, NOT included in this call's diary projection or
      feedback push. They are decided later by zoom/report_poller.py
      (Zoom's report ripens ~15 min after a meeting ends, so deciding at
      THIS moment would almost always just be "not ready yet"), or by that
      module's deadline fallback if Zoom's report never arrives within
      settings.zoom_attendance_decision_deadline_minutes. See
      zoom/attendance_service.py's module docstring for the full mechanism
      this defers to.
    - Practice status -> completed (UNCONDITIONALLY, regardless of the above)
    - All pending purchases -> completed (unfreeze + commission) --
      UNCONDITIONALLY. Money settlement was never gated on attended/no_show
      in this codebase and E21 does not change that; deferring the
      attendance decision does not defer the money.

    `actor` is logged only (currently always "system") -- it does not change
    behavior. Session rules unchanged (P-01): no commit here.
    """
    practice_id = practice.id

    # Bulk update: confirmed + joined -> attended, else -> no_show.
    bookings_stmt = (
        select(Booking)
        .where(
            Booking.practice_id == practice_id,
            Booking.status == BookingStatus.CONFIRMED.value,
        )
        .with_for_update()
    )
    bookings_result = await session.execute(bookings_stmt)
    bookings = bookings_result.scalars().all()

    # E21 step F: an active Zoom meeting means these bookings' attendance is
    # decided by zoom/report_poller.py, not here. Local import (zoom is a
    # separate bounded context -- one-way dependency, same pattern as the
    # diary/notifications imports elsewhere in this function).
    from app.modules.zoom.models import ZoomMeeting, ZoomMeetingStatus

    zoom_meeting = (
        await session.execute(
            select(ZoomMeeting).where(
                ZoomMeeting.practice_id == practice_id,
                ZoomMeeting.status == ZoomMeetingStatus.ACTIVE.value,
            )
        )
    ).scalar_one_or_none()
    # ПРОМТ №530: an active meeting created in Zoom STUB mode (no real
    # credentials configured -- true on every server today) can never
    # produce a real attendance report; zoom/report_poller.py would poll
    # forever and the deadline fallback (settings.
    # zoom_attendance_decision_deadline_minutes, 120) would be the ONLY
    # thing that ever decided it -- a two-hour delay on the diary card,
    # accrued hours, practice counts, and feedback eligibility for every
    # single practice, a live regression the deploy battery's green run
    # would not have caught (see test_diary_feed.py's finalize test). A
    # stub meeting still gets created and exercised normally everywhere
    # else (reschedule, retry, registrant creation, report ingestion all
    # stay fully covered by stub mode, per zoom_client.py's own docstring --
    # only THIS decision treats it as untracked). The moment real
    # credentials are configured, settings.is_zoom_stub flips to False and
    # the deferral switches itself back on with no other code change.
    zoom_tracked = zoom_meeting is not None and not settings.is_zoom_stub

    attended_count = 0
    no_show_count = 0
    deferred_count = 0
    # Collect (user_id, booking_id, status) for the diary feed projection.
    # We capture the resolved outcome per booking so each booker gets a card
    # showing Done (attended) or "Не состоялась" (no_show). Deferred bookings
    # are NOT added here -- their card is projected later, when decided.
    outcomes: list[tuple[UUID, UUID, str]] = []

    if zoom_tracked:
        deferred_count = len(bookings)
        logger.info(
            "practice_finalize_attendance_deferred_to_zoom",
            practice_id=str(practice_id),
            deferred_bookings=deferred_count,
        )
    else:
        outcomes = await resolve_bookings_via_legacy_proxy(
            list(bookings), practice_id, session,
        )
        attended_count = sum(
            1 for _, _, status in outcomes if status == BookingStatus.ATTENDED.value
        )
        no_show_count = len(outcomes) - attended_count

    practice.status = PracticeStatus.COMPLETED.value

    # Finalize all purchases: unfreeze + commission (double-entry).
    finalized = await finalize_purchases(
        practice_id=practice_id,
        practice=practice,
        session=session,
    )

    # Update cached participant count (Frontend Backlog A-03).
    # After finalize: attended stays in count, no_show drops out.
    await recalculate_participants(practice_id, session)

    logger.info(
        "practice_finalized",
        practice_id=str(practice_id),
        actor=actor,
        attended=attended_count,
        no_show=no_show_count,
        deferred_to_zoom=deferred_count,
        purchases_finalized=len(finalized),
    )

    # Diary feed: project the finalization outcome onto each booker's
    # timeline (attended -> Done, no_show -> "Не состоялась"). occurred_at is
    # the finalization instant. Lazy import keeps the dependency one-way.
    from app.modules.diary.projections import project_practice_outcome
    from app.modules.masters.service import get_master_display_name
    master_name = await get_master_display_name(practice.master_id, session)
    await project_practice_outcome(
        session,
        practice=practice,
        master_name=master_name,
        outcomes=outcomes,
        occurred_at=datetime.now(timezone.utc),
    )

    # Post-practice feedback nudge: enqueue a "leave feedback" push for the
    # attendees. Hooked here so the audience is exactly the just-resolved
    # attendees — target=practice resolves to confirmed/attended bookings, and
    # after this finalize the no_show/cancelled ones are excluded, leaving the
    # attended ones. Skipped when nobody attended (no audience). The notification
    # processor (lifespan worker) delivers it via Telegram; session commit is
    # the caller's (P-01: no commit here).
    if attended_count > 0:
        from app.modules.notifications.models import (
            NotificationType,
            TargetType,
        )
        from app.modules.notifications.service import create_notification

        await create_notification(
            type=NotificationType.LEAVE_FEEDBACK.value,
            title="Как прошла практика?",
            body=f"Поделитесь впечатлением о практике «{practice.title}».",
            target_type=TargetType.PRACTICE.value,
            target_value=str(practice_id),
            session=session,
            action_data={
                "action": "open_feedback",
                "params": {"practice_id": str(practice_id)},
                "practice_title": practice.title,
            },
            priority=5,
        )

    return practice


async def auto_finalize_practice(
    practice_id: UUID,
    session: AsyncSession,
) -> Practice:
    """System path: finalize a practice without a master actor.

    Used by the lifecycle worker for practices whose scheduled end has passed
    (the master no longer closes practices by hand). There is no User and
    no ownership check (the actor is the system, mirroring how the Stripe
    webhook acts: actor_type="system", actor_id=None). Authorization is
    intentionally absent -- this function must never be exposed via an
    HTTP route.

    Loads + locks the practice and verifies it is still finalizable (another
    worker tick or a concurrent manual finalize may have closed it first, in
    which case we raise BadRequestError and the caller skips it). Delegates
    settlement to the shared _finalize_practice_core. Session rules unchanged
    (P-01): no commit here -- the worker's session owns the transaction.
    """
    stmt = (
        select(Practice)
        .where(Practice.id == practice_id)
        .with_for_update()
    )
    result = await session.execute(stmt)
    practice = result.scalar_one_or_none()

    if not practice:
        raise NotFoundError("Practice not found")

    if practice.status not in _FINALIZABLE_PRACTICE_STATUSES:
        raise BadRequestError("Practice already finalized")

    return await _finalize_practice_core(practice, session, actor="system")


async def auto_start_practice(
    practice_id: UUID,
    session: AsyncSession,
) -> Practice:
    """System path: move a scheduled practice to live once its start has passed.

    Called by the lifecycle worker (autofinalize.py START phase). There is no
    User and no ownership check -- the actor is the system, mirroring
    auto_finalize_practice and the Stripe webhook (actor_type="system",
    actor_id=None). Authorization is intentionally absent -- this function must
    never be exposed via an HTTP route.

    Loads + locks the practice and verifies it is still `scheduled` and its
    start time has passed (a concurrent tick, cancel or finalize may have moved
    it first, in which case we raise BadRequestError and the caller skips it).
    Only the status changes -- no bookings, money or diary are touched. Session
    rules unchanged (P-01): no commit here -- the worker's session owns the
    transaction.
    """
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
        raise BadRequestError("Practice is not in a startable state")

    # Defensive: only go live once the start time has actually passed. The
    # worker's claim query already enforces this, but a direct / test caller
    # might not -- never start a future practice.
    if practice.scheduled_at > datetime.now(timezone.utc):
        raise BadRequestError("Practice start time has not passed yet")

    practice.status = PracticeStatus.LIVE.value
    return practice


async def get_attendance(
    practice_id: UUID,
    user: User,
    session: AsyncSession,
) -> tuple[
    Practice, list[Booking], dict[UUID, User], dict[UUID, "Checkin"], int,
]:
    """Get attendance list for a practice (master-only), enriched for prep.

    Returns all non-cancelled bookings with attendance data, plus two lookup
    maps the master's prep view needs per participant:
      - users:    user_id -> User, so the router can show a name + avatar
                  instead of a bare user_id.
      - checkins: booking_id -> PRE Checkin, the participant's pre-practice
                  check-in (mood + comment), when they left one.
    ...and unmatched_count: the size of the Zoom unmatched bucket for this
    practice (E21 plan sec 6) -- COUNT only, no PII, since the master is
    not an admin. 0 if there's no Zoom meeting for this practice at all.

    Both maps are built with one batch query each (id IN (...)), so the
    endpoint stays N+1-free no matter how many participants there are.

    PRIVACY: exposing each participant's PRE check-in to the master is
    intentional and scoped to this practice only. Ownership is enforced
    immediately below (P-08), and the check-in batch is keyed on this
    practice's booking_ids, so no cross-practice data can leak. Global
    check-in privacy (GET /users/me/checkins -- own-only) is untouched.

    Validates:
    - Practice exists and belongs to master (P-08: 404).
    """
    # Local import keeps the bookings -> diary dependency one-way (diary
    # already imports from bookings), same pattern as list_user_bookings.
    from app.modules.diary.checkins_service import get_pre_checkins_for_bookings
    from app.modules.diary.models import Checkin

    practice = await session.get(Practice, practice_id)

    if not practice:
        raise NotFoundError("Practice not found")

    if practice.master_id != user.id:
        raise NotFoundError("Practice not found")

    stmt = (
        select(Booking)
        .where(
            Booking.practice_id == practice_id,
            Booking.status != BookingStatus.CANCELLED.value,
        )
        .order_by(Booking.created_at)
    )
    result = await session.execute(stmt)
    bookings = list(result.scalars().all())

    # Batch-load participants (one query) so the router can render names.
    user_ids = [b.user_id for b in bookings]
    users: dict[UUID, User] = {}
    if user_ids:
        users_result = await session.execute(
            select(User).where(User.id.in_(user_ids))
        )
        users = {u.id: u for u in users_result.scalars().all()}

    # Batch-load PRE check-ins (one query) keyed by booking_id.
    booking_ids = [b.id for b in bookings]
    checkins: dict[UUID, Checkin] = await get_pre_checkins_for_bookings(
        booking_ids, session,
    )

    # E21 step G: unmatched-bucket count for the master's roster (count
    # only, no raw rows -- the master is not an admin). Local import keeps
    # the bookings -> zoom dependency one-way, same pattern as diary above.
    from app.modules.zoom.models import ZoomAttendanceSegment, ZoomMeeting

    zoom_meeting = (
        await session.execute(
            select(ZoomMeeting.id).where(ZoomMeeting.practice_id == practice_id)
        )
    ).scalar_one_or_none()
    unmatched_count = 0
    if zoom_meeting is not None:
        unmatched_count = (
            await session.execute(
                select(func.count(ZoomAttendanceSegment.id)).where(
                    ZoomAttendanceSegment.zoom_meeting_id == zoom_meeting,
                    ZoomAttendanceSegment.matched_registrant_row_id.is_(None),
                )
            )
        ).scalar_one()

    return practice, bookings, users, checkins, unmatched_count


# ===================================================================
# Frontend Backlog: list / detail
# ===================================================================


async def list_user_bookings(
    user: User,
    session: AsyncSession,
    *,
    status_filter: str | None = None,
    limit: int = 20,
    offset: int = 0,
) -> tuple[list[tuple[Booking, Practice, bool, bool, str | None]], int]:
    """List bookings for a user with practice details (paginated).

    B-05: count derived from base query subquery instead of maintaining
    a parallel count_base with duplicated filter clauses. Same pattern
    as list_user_checkins in diary/checkins_service.py.

    Each row also carries two diary-state flags for the dashboard banners:
      - has_feedback: the user already left a feedback for this practice.
      - has_checkin:  the user already did a PRE check-in for this booking.
    They let the dashboard hide the "оставьте feedback" / "пора на check-in"
    prompt once done (and stop re-submitting through a stale banner). Computed
    with two set-membership queries over the current page -- no N+1.

    Returns:
        Tuple of (list of (Booking, Practice, has_feedback, has_checkin,
        zoom_registrant_join_url) tuples, total count).
    """
    # Local import keeps the bookings -> diary dependency one-way and avoids
    # any import-order surprise (diary.projections imports bookings lazily).
    from app.modules.diary.models import Checkin, CheckType, Feedback
    from app.modules.zoom.models import (
        ZoomMeeting,
        ZoomMeetingStatus,
        ZoomRegistrant,
        ZoomRegistrantStatus,
    )

    base = (
        select(Booking, Practice)
        .join(Practice, Booking.practice_id == Practice.id)
        .where(Booking.user_id == user.id)
    )

    if status_filter:
        base = base.where(Booking.status == status_filter)

    # Count via subquery -- filters applied exactly once, no duplication.
    total = (
        await session.execute(
            select(func.count()).select_from(base.subquery())
        )
    ).scalar_one()

    items_stmt = (
        base
        .order_by(Booking.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    result = await session.execute(items_stmt)
    page = [(row[0], row[1]) for row in result.all()]

    # Diary-state flags for this page (set membership -- no per-row query).
    practice_ids = [b.practice_id for b, _ in page]
    booking_ids = [b.id for b, _ in page]

    feedback_practice_ids: set[UUID] = set()
    if practice_ids:
        feedback_practice_ids = set(
            (
                await session.execute(
                    select(Feedback.practice_id)
                    .where(
                        Feedback.user_id == user.id,
                        Feedback.practice_id.in_(practice_ids),
                    )
                    .distinct()
                )
            ).scalars().all()
        )

    checkin_booking_ids: set[UUID] = set()
    if booking_ids:
        checkin_booking_ids = set(
            (
                await session.execute(
                    select(Checkin.booking_id)
                    .where(
                        Checkin.booking_id.in_(booking_ids),
                        Checkin.check_type == CheckType.PRE.value,
                    )
                    .distinct()
                )
            ).scalars().all()
        )

    # T21-1: this user's own registrant join_url per booking (set membership,
    # same no-N+1 pattern as the two diary flags above). role='student' is
    # implicit -- booking_id is NULL for the master's own host row (see
    # ZoomRegistrant model docstring).
    #
    # ПРОМТ №563: joined to ZoomMeeting.status == ACTIVE, same posture as the
    # host path (zoom/service.py's get_host_join_url[s]). Without this, a
    # registrant row whose join_url was set while the meeting was active
    # keeps being handed out after the meeting is deleted outside the normal
    # cancel flow (get_host_join_url's own docstring: the registrant row is
    # not touched on delete, only the meeting -- status must be checked
    # here). A PENDING_CREATION series child is unaffected either way: its
    # registrant row (if any) has join_url IS NULL until the poller actually
    # succeeds (zoom/service.py's create_registrant_for_booking queues it as
    # PENDING with no join_url), so it was already excluded by the
    # `join_url.is_not(None)` filter and still reads as the honest "ссылка
    # готовится" empty state, not broken by this join.
    join_urls: dict[UUID, str] = {}
    if booking_ids:
        rows = (
            await session.execute(
                select(ZoomRegistrant.booking_id, ZoomRegistrant.join_url)
                .join(ZoomMeeting, ZoomRegistrant.zoom_meeting_id == ZoomMeeting.id)
                .where(
                    ZoomRegistrant.booking_id.in_(booking_ids),
                    ZoomRegistrant.status != ZoomRegistrantStatus.CANCELLED.value,
                    ZoomRegistrant.join_url.is_not(None),
                    ZoomMeeting.status == ZoomMeetingStatus.ACTIVE.value,
                )
            )
        ).all()
        join_urls = {row[0]: row[1] for row in rows}

    items = [
        (
            booking,
            practice,
            booking.practice_id in feedback_practice_ids,
            booking.id in checkin_booking_ids,
            join_urls.get(booking.id),
        )
        for booking, practice in page
    ]

    return items, total


async def list_upcoming_bookings(
    user: User,
    session: AsyncSession,
    *,
    limit: int = 10,
) -> list[tuple[Booking, Practice, bool, bool, str | None]]:
    """Confirmed bookings that are live-or-upcoming, soonest first.

    Feeds the dashboard «Ближайшая практика» widget. Unlike list_user_bookings
    (paginated by created_at DESC for the full list), this filters to CONFIRMED
    bookings and orders by ``Practice.scheduled_at ASC`` so the client's
    nearest-selection sees the truly-soonest practice -- fixing the >20-bookings
    mis-select, where the nearest widget only saw the newest-BOOKED page.

    "Not ended" is bounded portably: a practice cannot exceed
    ``practice_max_duration_minutes``, so any practice scheduled at or after
    ``now - max_duration`` may still be live. The client applies the exact
    per-row ``scheduled_at + duration_minutes`` ceiling (nearestBookings.ts).

    Returns the same (Booking, Practice, has_feedback, has_checkin,
    zoom_registrant_join_url) row shape as list_user_bookings so the router
    reuses one response builder.
    """
    from app.modules.diary.models import Checkin, CheckType, Feedback
    from app.modules.zoom.models import (
        ZoomMeeting,
        ZoomMeetingStatus,
        ZoomRegistrant,
        ZoomRegistrantStatus,
    )

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(minutes=settings.practice_max_duration_minutes)

    stmt = (
        select(Booking, Practice)
        .join(Practice, Booking.practice_id == Practice.id)
        .where(
            Booking.user_id == user.id,
            Booking.status == BookingStatus.CONFIRMED.value,
            Practice.scheduled_at >= cutoff,
        )
        .order_by(Practice.scheduled_at.asc())
        .limit(limit)
    )
    result = await session.execute(stmt)
    page = [(row[0], row[1]) for row in result.all()]

    practice_ids = [b.practice_id for b, _ in page]
    booking_ids = [b.id for b, _ in page]

    feedback_practice_ids: set[UUID] = set()
    if practice_ids:
        feedback_practice_ids = set(
            (
                await session.execute(
                    select(Feedback.practice_id)
                    .where(
                        Feedback.user_id == user.id,
                        Feedback.practice_id.in_(practice_ids),
                    )
                    .distinct()
                )
            ).scalars().all()
        )

    checkin_booking_ids: set[UUID] = set()
    if booking_ids:
        checkin_booking_ids = set(
            (
                await session.execute(
                    select(Checkin.booking_id)
                    .where(
                        Checkin.booking_id.in_(booking_ids),
                        Checkin.check_type == CheckType.PRE.value,
                    )
                    .distinct()
                )
            ).scalars().all()
        )

    # ПРОМТ №563: same meeting-state join as list_user_bookings above -- see
    # that function's comment for the full reasoning.
    join_urls: dict[UUID, str] = {}
    if booking_ids:
        rows = (
            await session.execute(
                select(ZoomRegistrant.booking_id, ZoomRegistrant.join_url)
                .join(ZoomMeeting, ZoomRegistrant.zoom_meeting_id == ZoomMeeting.id)
                .where(
                    ZoomRegistrant.booking_id.in_(booking_ids),
                    ZoomRegistrant.status != ZoomRegistrantStatus.CANCELLED.value,
                    ZoomRegistrant.join_url.is_not(None),
                    ZoomMeeting.status == ZoomMeetingStatus.ACTIVE.value,
                )
            )
        ).all()
        join_urls = {row[0]: row[1] for row in rows}

    return [
        (
            booking,
            practice,
            booking.practice_id in feedback_practice_ids,
            booking.id in checkin_booking_ids,
            join_urls.get(booking.id),
        )
        for booking, practice in page
    ]


async def get_booking_by_id(
    booking_id: UUID,
    user: User,
    session: AsyncSession,
) -> tuple[Booking, Practice]:
    """Get a single booking with full practice details.

    Access control:
    - Booking owner.
    - Master of the associated practice.

    Returns 404 for non-existent or unauthorized bookings (P-08).
    """
    stmt = (
        select(Booking, Practice)
        .join(Practice, Booking.practice_id == Practice.id)
        .where(Booking.id == booking_id)
    )
    result = await session.execute(stmt)
    row = result.one_or_none()

    if not row:
        raise NotFoundError("Booking not found")

    booking, practice = row[0], row[1]

    # P-08: owner or practice master.
    if booking.user_id != user.id and practice.master_id != user.id:
        raise NotFoundError("Booking not found")

    return booking, practice


# ===================================================================
# Profile stats (Screen A: main profile)
# ===================================================================


async def get_user_practice_stats(
    user: User,
    session: AsyncSession,
) -> tuple[int, float]:
    """Aggregate the user's attended-practice stats for the profile screen.

    Returns (practices_attended, hours_attended):
      - practices_attended: count of the user's bookings with status=attended.
      - hours_attended: sum of those practices' duration_minutes / 60,
        rounded to one decimal (mockup shows e.g. "9.5").

    Single ORM query (count + coalesced sum) joined practices<->bookings.
    Only attended bookings count, so the two numbers stay consistent
    (a practice contributes to both the count and the hours, or neither).
    coalesce keeps sum at 0 (not NULL) when the user has no attended
    bookings, so the empty case returns (0, 0.0).
    """
    stmt = (
        select(
            func.count(Booking.id),
            func.coalesce(func.sum(Practice.duration_minutes), 0),
        )
        .join(Practice, Booking.practice_id == Practice.id)
        .where(
            Booking.user_id == user.id,
            Booking.status == BookingStatus.ATTENDED.value,
        )
    )
    result = await session.execute(stmt)
    practices_attended, total_minutes = result.one()

    hours_attended = round(int(total_minutes) / 60, 1)
    return int(practices_attended), hours_attended
