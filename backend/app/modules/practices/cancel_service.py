# =============================================================================
# VELO Backend -- Practice Cancel Service (Phase 6.5, W26 split from service.py)
# =============================================================================
#
# Master cancels a scheduled/live practice (or a series scope), refunding all
# active bookings. This is the ONLY path to Practice.status=cancelled (PATCH
# status=cancelled is intentionally blocked in practices/service.py's
# _VALID_TRANSITIONS). Imports only master_full_name from the core.
# =============================================================================

from datetime import UTC, datetime
from uuid import UUID

import structlog
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import record_audit
from app.core.exceptions import BadRequestError, NotFoundError
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.payments.refund import refund_all_bookings_for_practice
from app.modules.practices.models import Practice, PracticeStatus
from app.modules.practices.service import master_full_name
from app.modules.users.models import User

logger = structlog.get_logger()

# Statuses from which cancel_practice() is allowed.
_CANCELLABLE_PRACTICE_STATUSES = {
    PracticeStatus.SCHEDULED.value,
    PracticeStatus.LIVE.value,
}


async def _cancel_one(
    practice: Practice,
    user: User,
    session: AsyncSession,
    *,
    occurred_at: datetime | None = None,
) -> int:
    """Cancel a single, already-locked + already-validated practice occurrence.

    Runs the full refund flow for ONE occurrence: collect booked users, refund
    all active bookings (+ clear waitlist), flip status to cancelled, audit, and
    project the diary "cancelled" event. The CALLER must have locked the row
    (FOR UPDATE), verified ownership, and confirmed the status is cancellable --
    this core does not re-check. Returns the number of refunded bookings.

    occurred_at is the diary timestamp for the projected "cancelled" event. A
    scope cancellation spanning several occurrences passes ONE shared instant so
    every diary card shares it (W-3); a lone call defaults to now.
    """
    # Diary feed: collect the booked users BEFORE the refund flow runs --
    # refund_all_bookings_for_practice transitions bookings to cancelled, so
    # reading them afterwards would yield an empty set. Inline ORM query
    # (Booking/BookingStatus are already imported) -- we do not import the
    # private _booked_user_ids from diary.projections (P: no cross-module
    # private import, consistent with calendar C-1).
    affected_ids_stmt = (
        select(Booking.user_id)
        .where(
            Booking.practice_id == practice.id,
            Booking.status != BookingStatus.CANCELLED.value,
        )
        .distinct()
    )
    affected_user_ids = list(
        (await session.execute(affected_ids_stmt)).scalars().all()
    )

    # Refund all active bookings + clear waitlist.
    refunded_count = await refund_all_bookings_for_practice(
        practice=practice,
        session=session,
    )

    practice.status = PracticeStatus.CANCELLED.value

    # Audit.
    await record_audit(
        event="practice_cancelled_by_master",
        actor_id=user.id,
        actor_type="user",
        target_type="practice",
        target_id=practice.id,
        data={
            "refunded_bookings": refunded_count,
        },
        session=session,
    )

    logger.info(
        "practice_cancelled",
        practice_id=str(practice.id),
        master_id=str(user.id),
        refunded_bookings=refunded_count,
    )

    # Diary feed: fan out "master cancelled the practice" to the users who were
    # booked (collected above, before the refund). occurred_at is now. Master
    # name for the diary card: full "First Last" (MVP rule). Load the User
    # directly rather than get_master_display_name (notification helper).
    from app.modules.diary.projections import project_practice_cancelled
    master_user = await session.get(User, practice.master_id)
    master_name = master_full_name(
        master_user.first_name if master_user else None,
        master_user.last_name if master_user else None,
    )
    await project_practice_cancelled(
        session,
        practice=practice,
        master_name=master_name,
        user_ids=affected_user_ids,
        occurred_at=(
            occurred_at if occurred_at is not None else datetime.now(UTC)
        ),
    )

    # E21: best-effort delete the practice's Zoom meeting so a cancelled
    # session can't still be joined via a still-live personal link. Skips
    # meetings that already have attendance segments, and never raises --
    # refunds/cancellation must proceed regardless of Zoom's outcome.
    from app.modules.zoom.service import delete_meeting_for_practice
    await delete_meeting_for_practice(practice, session)

    return refunded_count


async def cancel_practice(
    practice_id: UUID,
    user: User,
    session: AsyncSession,
    *,
    scope: str = "this",
) -> Practice:
    """Cancel a scheduled/live practice with full refund to all participants.

    Master-only. This is the ONLY path to Practice.status=cancelled (PATCH
    status=cancelled is intentionally blocked in _VALID_TRANSITIONS).

    scope:
      "this"            -- cancel only this occurrence (the historical default).
      "this_and_future" -- for a SERIES, also cancel every LATER occurrence of
                           the same series (scheduled_at >= this one's) that is
                           still cancellable. A non-series practice has no
                           siblings, so it behaves like "this". Past, completed,
                           or already-cancelled occurrences are never touched.

    Each affected occurrence is locked FOR UPDATE (P-12), refunded via the same
    double-entry flow, audited, and projected to the diary. Returns the primary
    practice (the one addressed by practice_id).

    Raises NotFoundError if not found or not owner (P-08: 404 not 403).
    Raises BadRequestError if the primary practice is not in a cancellable state.
    """
    # Lock + validate the primary occurrence.
    primary = (
        await session.execute(
            select(Practice)
            .where(Practice.id == practice_id)
            .with_for_update()
        )
    ).scalar_one_or_none()

    if not primary:
        raise NotFoundError("Practice not found")

    # P-08: 404 not 403 for non-owner.
    if primary.master_id != user.id:
        raise NotFoundError("Practice not found")

    if primary.status not in _CANCELLABLE_PRACTICE_STATUSES:
        raise BadRequestError(
            f"Cannot cancel practice in status "
            f"{primary.status}"
        )

    # W-3: one shared instant for every occurrence this action cancels, so the
    # diary cards line up rather than drifting by microseconds.
    cancel_ts = datetime.now(UTC)
    await _cancel_one(primary, user, session, occurred_at=cancel_ts)

    if scope == "this_and_future":
        # Series identity = the root id (parent if this is a child, else its own
        # id). Cancel later siblings of the SAME series that are still
        # cancellable; non-series practices have no siblings, so this is empty
        # and the call reduces to "this".
        root_id = primary.parent_practice_id or primary.id
        root_expr = func.coalesce(Practice.parent_practice_id, Practice.id)
        siblings = (
            (
                await session.execute(
                    select(Practice)
                    .where(
                        root_expr == root_id,
                        Practice.id != primary.id,
                        Practice.scheduled_at >= primary.scheduled_at,
                        Practice.status.in_(_CANCELLABLE_PRACTICE_STATUSES),
                    )
                    .order_by(Practice.scheduled_at)
                    .with_for_update()
                )
            ).scalars().all()
        )
        for sibling in siblings:
            await _cancel_one(sibling, user, session, occurred_at=cancel_ts)

    return primary
