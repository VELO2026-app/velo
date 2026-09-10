# =============================================================================
# VELO Backend -- Diary Service (Phase 8.1-8.4)
# =============================================================================
#
# CREATE CHECKIN (8.1):
#   Find confirmed booking -> validate window -> insert (once, immutable).
#   A check-in is a recorded data point: submitted once, never changed. A
#   repeat submission is rejected with ConflictError, never overwritten.
#
# CREATE FEEDBACK (8.2):
#   Find attended booking -> validate completed + window -> insert (once,
#   immutable). Same one-and-only-once rule as check-in.
#
# DIARY ENTRY CRUD (8.3):
#   Create / get / update / delete / list.
#   If practice_id provided: validate practice exists + user has booking.
#
# PRACTICE INSIGHTS (8.4, master-facing):
#   Aggregated mood/rating distributions + participants + comments count.
#   Anonymous: no user IDs, names, or comment texts.
#
# 11.1 fix: list_user_checkins / list_user_feedbacks / list_user_diary_entries
#   previously built two parallel queries (base + count_base) and applied
#   every filter clause twice. Now count is derived from the base query as a
#   subquery: select(func.count()).select_from(base.subquery()). Filters are
#   applied once; count_base duplication is eliminated.
#
# SESSION RULES:
#   No session.commit() here (P-01). Router manages transaction.
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
from app.modules.diary.models import DiaryEntry, DiaryEntryType, Feedback
from app.modules.diary.notify_master import notify_master_of_feedback
from app.modules.diary.projections import (
    hide_entry_event,
    upsert_entry_event,
    upsert_feedback_event,
)
from app.modules.masters.service import get_master_full_name
from app.modules.practices.models import Practice, PracticeStatus
from app.modules.users.models import User

logger = structlog.get_logger()


# ===================================================================
# Upsert feedback (Phase 8.2)
# ===================================================================


async def upsert_feedback(
    user: User,
    practice_id: UUID,
    rating: int,
    session: AsyncSession,
    *,
    comment: str | None = None,
) -> tuple[Feedback, bool]:
    """Create a post-practice feedback (immutable, once only).

    Feedback is a recorded data point and can never be changed. If feedback
    already exists for this (practice, user), the request is rejected with
    ConflictError -- the original row is never overwritten.

    Args:
        user: Authenticated user.
        practice_id: Target practice UUID.
        rating: A 1..10 score (validated in schema).
        session: Write session (caller manages commit).
        comment: Optional text (max length validated in schema).

    Returns:
        Tuple of (feedback, is_new). is_new is always True (create-only);
        the tuple shape is kept for backward compatibility with callers.

    Raises:
        NotFoundError: No attended booking for this practice.
        BadRequestError: Practice not completed or outside feedback window.
        ConflictError: Feedback already exists (resubmission is forbidden).
    """
    # 1. Find attended booking.
    booking_stmt = (
        select(Booking)
        .where(
            Booking.practice_id == practice_id,
            Booking.user_id == user.id,
            Booking.status == BookingStatus.ATTENDED.value,
        )
    )
    result = await session.execute(booking_stmt)
    booking = result.scalar_one_or_none()

    if booking is None:
        raise NotFoundError(
            "No attended booking found for this practice"
        )

    # 2. Load practice to check window.
    practice = await session.get(Practice, practice_id)
    if practice is None:
        raise NotFoundError("Practice not found")

    if practice.status != PracticeStatus.COMPLETED.value:
        raise BadRequestError("Feedback is only available after practice completion")

    now = datetime.now(UTC)
    window_close = practice.scheduled_at + timedelta(
        minutes=practice.duration_minutes,
        hours=settings.feedback_window_hours,
    )

    if now > window_close:
        raise BadRequestError("Feedback window has closed")

    # 3. Reject resubmission -- feedback is immutable once recorded.
    existing_stmt = (
        select(Feedback)
        .where(
            Feedback.practice_id == practice_id,
            Feedback.user_id == user.id,
        )
    )
    result = await session.execute(existing_stmt)
    existing = result.scalar_one_or_none()

    if existing is not None:
        # Feedback is a recorded data point: submitted once, never changed.
        raise ConflictError(
            "Feedback already submitted and cannot be changed"
        )

    # Create new feedback.
    feedback = Feedback(
        practice_id=practice_id,
        user_id=user.id,
        booking_id=booking.id,
        rating=rating,
        comment=comment,
    )

    # P-05: guard the concurrent first-submit race. Two parallel requests can
    # both pass the SELECT above with existing=None; the unique constraint
    # uq_feedback_practice_user then rejects the loser. try/except OUTSIDE
    # begin_nested (ERR-05) so the savepoint rolls back cleanly and the outer
    # transaction survives; convert to the same ConflictError as resubmission.
    try:
        async with session.begin_nested():
            session.add(feedback)
            await session.flush()
    except IntegrityError:
        raise ConflictError(
            "Feedback already submitted and cannot be changed"
        ) from None

    await record_audit(
        event="feedback_created",
        actor_id=user.id,
        actor_type="user",
        target_type="feedback",
        target_id=feedback.id,
        data={"rating": rating, "practice_id": str(practice_id)},
        session=session,
    )

    logger.info(
        "feedback_created",
        feedback_id=str(feedback.id),
        user_id=str(user.id),
        practice_id=str(practice_id),
        rating=rating,
    )

    # Diary feed: project the new feedback onto the user's timeline.
    master_name = await get_master_full_name(practice.master_id, session)
    await upsert_feedback_event(
        session,
        feedback=feedback,
        practice=practice,
        master_name=master_name,
    )

    # BE-33 item 6: tell the practice's master, one message per review, in
    # the same transaction as the row.
    await notify_master_of_feedback(
        session, feedback=feedback, practice=practice, author=user,
    )
    return feedback, True


# ===================================================================
# List user feedbacks (Phase 8.2)
# ===================================================================


async def list_user_feedbacks(
    user: User,
    session: AsyncSession,
    *,
    limit: int = 20,
    offset: int = 0,
    practice_id: UUID | None = None,
    rating: int | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
) -> tuple[list[Feedback], int]:
    """List feedbacks for a user with optional filters.

    11.1 fix: count derived from base subquery.

    Returns:
        Tuple of (items, total_count).
    """
    base = select(Feedback).where(Feedback.user_id == user.id)

    if practice_id is not None:
        base = base.where(Feedback.practice_id == practice_id)

    if rating is not None:
        base = base.where(Feedback.rating == rating)

    if date_from is not None:
        base = base.where(Feedback.created_at >= date_from)

    if date_to is not None:
        base = base.where(Feedback.created_at <= date_to)

    total = (
        await session.execute(
            select(func.count()).select_from(base.subquery())
        )
    ).scalar_one()

    items_stmt = (
        base
        .order_by(Feedback.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    result = await session.execute(items_stmt)
    items = list(result.scalars().all())

    return items, total


async def get_feedback(
    user: User,
    feedback_id: UUID,
    session: AsyncSession,
) -> Feedback:
    """Get a single feedback owned by the user (read-only detail).

    Raises:
        NotFoundError: Feedback not found or not owned by user.
    """
    feedback = await session.get(Feedback, feedback_id)

    if feedback is None or feedback.user_id != user.id:
        raise NotFoundError("Feedback not found")

    return feedback


# ===================================================================
# Create diary entry (Phase 8.3)
# ===================================================================


async def create_diary_entry(
    user: User,
    content: str,
    session: AsyncSession,
    *,
    title: str | None = None,
    mood: int | None = None,
    practice_id: UUID | None = None,
    entry_type: str = DiaryEntryType.NOTE.value,
    practice_phase: str | None = None,
) -> DiaryEntry:
    """Create a personal diary entry.

    Args:
        user: Authenticated user.
        content: Entry text (1-10000 chars, validated in schema).
        session: Write session (caller manages commit).
        title: Optional short title (max 200 chars).
        mood: Optional 1..10 score (validated in schema).
        practice_id: Optional practice link. Validated if provided.
        entry_type: note (free-form) or dream (Сонник). Defaults to note --
            the ledger composer only creates note this iteration.
        practice_phase: before/after relative to the linked practice; only
            meaningful when practice_id is set.

    Returns:
        Created DiaryEntry.

    Raises:
        NotFoundError: practice_id invalid or user has no booking.
    """
    if practice_id is not None:
        await _validate_practice_link(user.id, practice_id, session)

    entry = DiaryEntry(
        user_id=user.id,
        content=content,
        title=title,
        mood=mood,
        practice_id=practice_id,
        entry_type=entry_type,
        practice_phase=practice_phase,
    )
    session.add(entry)
    await session.flush()

    await record_audit(
        event="diary_entry_created",
        actor_id=user.id,
        actor_type="user",
        target_type="diary_entry",
        target_id=entry.id,
        data={
            "practice_id": str(practice_id) if practice_id else None,
            "entry_type": entry_type,
        },
        session=session,
    )

    logger.info(
        "diary_entry_created",
        entry_id=str(entry.id),
        user_id=str(user.id),
        entry_type=entry_type,
        mood=mood,
    )

    # Diary feed: project the new entry onto the user's timeline.
    await upsert_entry_event(session, entry=entry)
    return entry


async def _validate_practice_link(
    user_id: UUID,
    practice_id: UUID,
    session: AsyncSession,
) -> None:
    """Validate that practice exists and user has any booking for it.

    Raises:
        NotFoundError: Practice not found or user has no booking.
    """
    practice = await session.get(Practice, practice_id)
    if practice is None:
        raise NotFoundError("Practice not found")

    booking_stmt = (
        select(func.count(Booking.id))
        .where(
            Booking.practice_id == practice_id,
            Booking.user_id == user_id,
            Booking.status != BookingStatus.CANCELLED.value,
        )
    )
    count = (await session.execute(booking_stmt)).scalar_one()

    if count == 0:
        raise BadRequestError("Cannot link diary entry to a practice without a booking")


# ===================================================================
# Get diary entry (Phase 8.3)
# ===================================================================


async def get_diary_entry(
    user: User,
    entry_id: UUID,
    session: AsyncSession,
) -> DiaryEntry:
    """Get a single diary entry owned by the user.

    Raises:
        NotFoundError: Entry not found or not owned by user.
    """
    entry = await session.get(DiaryEntry, entry_id)

    if entry is None or entry.user_id != user.id or entry.is_deleted:
        raise NotFoundError("Diary entry not found")

    return entry


# ===================================================================
# Update diary entry (Phase 8.3)
# ===================================================================


async def update_diary_entry(
    user: User,
    entry_id: UUID,
    session: AsyncSession,
    *,
    content: str | None = None,
    title: str | None = None,
    mood: int | None = None,
    practice_id: UUID | None = None,
    entry_type: str | None = None,
    practice_phase: str | None = None,
    clear_title: bool = False,
    clear_mood: bool = False,
    clear_practice: bool = False,
    clear_practice_phase: bool = False,
) -> DiaryEntry:
    """Partially update a diary entry.

    Only provided fields are updated. Use clear_* flags to set
    nullable fields to None.

    Raises:
        NotFoundError: Entry not found, not owned by user, or soft-deleted.
        BadRequestError: New practice_id invalid.
    """
    entry = await session.get(DiaryEntry, entry_id)

    if entry is None or entry.user_id != user.id or entry.is_deleted:
        raise NotFoundError("Diary entry not found")

    # Validate new practice link if provided.
    if practice_id is not None:
        await _validate_practice_link(user.id, practice_id, session)
        entry.practice_id = practice_id
    elif clear_practice:
        entry.practice_id = None

    if content is not None:
        entry.content = content

    if title is not None:
        entry.title = title
    elif clear_title:
        entry.title = None

    if mood is not None:
        entry.mood = mood
    elif clear_mood:
        entry.mood = None

    if entry_type is not None:
        entry.entry_type = entry_type

    if practice_phase is not None:
        entry.practice_phase = practice_phase
    elif clear_practice_phase:
        entry.practice_phase = None

    await session.flush()

    await record_audit(
        event="diary_entry_updated",
        actor_id=user.id,
        actor_type="user",
        target_type="diary_entry",
        target_id=entry.id,
        data={
            "practice_id": str(entry.practice_id) if entry.practice_id else None,
            "entry_type": entry.entry_type,
        },
        session=session,
    )

    logger.info(
        "diary_entry_updated",
        entry_id=str(entry.id),
        user_id=str(user.id),
    )

    # Diary feed: refresh the timeline event (snapshot + kind + text).
    await upsert_entry_event(session, entry=entry)
    return entry


# ===================================================================
# Delete diary entry (Phase 8.3)
# ===================================================================


async def delete_diary_entry(
    user: User,
    entry_id: UUID,
    session: AsyncSession,
) -> None:
    """Soft-delete a diary entry owned by the user.

    Redesign: this is a SOFT delete -- the row is hidden (is_deleted=True),
    not physically removed. The matching DiaryEvent is hidden in parallel
    (is_hidden=True) so it drops out of the feed while staying a stable
    target for future relations. Personal data remains recoverable.

    Raises:
        NotFoundError: Entry not found, not owned by user, or already deleted.
    """
    entry = await session.get(DiaryEntry, entry_id)

    if entry is None or entry.user_id != user.id or entry.is_deleted:
        raise NotFoundError("Diary entry not found")

    entry.is_deleted = True
    await session.flush()

    await record_audit(
        event="diary_entry_deleted",
        actor_id=user.id,
        actor_type="user",
        target_type="diary_entry",
        target_id=entry.id,
        data={"title": entry.title},
        session=session,
    )

    # Diary feed: hide the timeline event (soft) -- never drop the row.
    await hide_entry_event(session, entry_id=entry.id)

    logger.info(
        "diary_entry_deleted",
        entry_id=str(entry_id),
        user_id=str(user.id),
    )


# ===================================================================
# Restore diary entry (Diary redesign -- undo soft-delete)
# ===================================================================


async def restore_diary_entry(
    user: User,
    entry_id: UUID,
    session: AsyncSession,
) -> DiaryEntry:
    """Restore a soft-deleted diary entry owned by the user (undo delete).

    Mirror of delete_diary_entry: clears is_deleted and re-projects the
    timeline event (upsert_entry_event sets is_hidden = entry.is_deleted, so
    re-projecting un-hides it and the entry returns to the feed).

    We load the row directly (NOT via get_diary_entry, which 404s deleted
    rows) and require it to be currently deleted -- restoring an active entry
    is a no-op the client never needs, so we 404 to keep the contract tight.

    Raises:
        NotFoundError: Entry not found, not owned by user, or not deleted.
    """
    entry = await session.get(DiaryEntry, entry_id)

    if entry is None or entry.user_id != user.id or not entry.is_deleted:
        raise NotFoundError("Diary entry not found")

    entry.is_deleted = False
    await session.flush()

    await record_audit(
        event="diary_entry_restored",
        actor_id=user.id,
        actor_type="user",
        target_type="diary_entry",
        target_id=entry.id,
        data={"title": entry.title},
        session=session,
    )

    # Diary feed: re-project the timeline event -- upsert sets is_hidden to
    # entry.is_deleted (now False), so the event reappears in the feed.
    await upsert_entry_event(session, entry=entry)

    logger.info(
        "diary_entry_restored",
        entry_id=str(entry_id),
        user_id=str(user.id),
    )
    return entry


# ===================================================================
# List user diary entries (Phase 8.3)
# ===================================================================


async def list_user_diary_entries(
    user: User,
    session: AsyncSession,
    *,
    limit: int = 20,
    offset: int = 0,
    practice_id: UUID | None = None,
    mood: int | None = None,
    entry_type: str | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
) -> tuple[list[DiaryEntry], int]:
    """List diary entries for a user with optional filters.

    11.1 fix: count derived from base subquery.
    Redesign: soft-deleted entries (is_deleted=True) are excluded.

    Returns:
        Tuple of (items, total_count).
    """
    base = select(DiaryEntry).where(
        DiaryEntry.user_id == user.id,
        DiaryEntry.is_deleted.is_(False),
    )

    if practice_id is not None:
        base = base.where(DiaryEntry.practice_id == practice_id)

    if mood is not None:
        base = base.where(DiaryEntry.mood == mood)

    if entry_type is not None:
        base = base.where(DiaryEntry.entry_type == entry_type)

    if date_from is not None:
        base = base.where(DiaryEntry.created_at >= date_from)

    if date_to is not None:
        base = base.where(DiaryEntry.created_at <= date_to)

    total = (
        await session.execute(
            select(func.count()).select_from(base.subquery())
        )
    ).scalar_one()

    items_stmt = (
        base
        .order_by(DiaryEntry.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    result = await session.execute(items_stmt)
    items = list(result.scalars().all())

    return items, total
