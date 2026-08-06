# =============================================================================
# VELO Backend -- Diary Projections (Diary redesign iteration)
# =============================================================================
#
# The diary feed is powered by an append-only journal table (DiaryEvent).
# These projection functions are the ONLY writers of that table. Source
# modules call them in the SAME transaction as the originating mutation:
#
#   bookings/service.py            -> project_booking_confirmed,
#                                      project_booking_cancelled,
#                                      project_practice_outcome (fan-out in finalize)
#   practices/service.py           -> project_practice_rescheduled
#   practices/cancel_service.py    -> project_practice_cancelled (fan-out)
#   diary/checkins_service.py      -> upsert_checkin_event
#   diary/service.py               -> upsert_feedback_event, upsert_entry_event,
#                                      hide_entry_event
#
# DEPENDENCY DIRECTION (decoupling):
#   bookings/practices depend on diary, never the reverse. To avoid an import
#   cycle (diary.service already imports nothing from bookings at module load
#   beyond models), source modules import THIS module lazily inside the call
#   site (same pattern as bookings.service importing waitlist.process_waitlist
#   inside cancel_booking).
#
# SESSION RULES (P-01):
#   No commit/flush of our own beyond what is needed to obtain ids. We add the
#   DiaryEvent to the caller's session; the caller's router flushes/commits.
#   We DO call session.flush() after add so the event id is materialized for
#   the same-transaction callers that may need it -- consistent with how
#   checkin/feedback/entry already flush before record_audit.
#
# JSONB SAFETY:
#   snapshot is written via DiaryEvent.set_jsonb("snapshot", deepcopy(...)).
#   Never mutate event.snapshot in place.
#
# APPEND-ONLY vs UPSERT:
#   Per-fact kinds (booking_confirmed, booking_cancelled_by_user,
#   practice_rescheduled, practice_cancelled_by_master, practice_outcome)
#   always INSERT a new row -- each occurrence is an immutable fact.
#   Per-object kinds (checkin, feedback, note, dream) UPSERT a single row
#   keyed by (source_type, source_id) -- the feed card reflects current state.
#
# NO-LITERALS:
#   Snapshot text preview length comes from settings.diary_feed_preview_length.
# =============================================================================

import copy
from datetime import datetime
from uuid import UUID

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.modules.diary.models import (
    DiaryEvent,
    DiaryEventKind,
    DiaryEventSourceType,
)

logger = structlog.get_logger()


# ===================================================================
# Helpers
# ===================================================================


def _preview(text: str | None) -> str | None:
    """Truncate free text to the feed preview length (NO-LITERALS).

    Returns None for None/empty input so the snapshot stays clean.
    """
    if not text:
        return None
    limit = settings.diary_feed_preview_length
    text = text.strip()
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "..."


def _practice_direction(practice) -> str | None:  # noqa: ANN001 -- ORM Practice
    """Extract data.taxonomy.direction from a Practice without a join.

    The hero icon on the feed card is chosen by direction (same contract as
    the Calendar). Missing taxonomy (legacy practices) resolves to None.
    """
    taxonomy = (practice.data or {}).get("taxonomy", {})
    return taxonomy.get("direction")


async def _practice_snapshot(
    session: AsyncSession,
    practice,  # noqa: ANN001 -- ORM Practice (avoid import cycle)
    *,
    master_name: str | None,
    scheduled_at_override: datetime | None = None,
) -> dict:
    """Build the practice-card snapshot embedded in a DiaryEvent.

    Captures the fields needed to render the feed card without joining back
    to practices/users. scheduled_at is captured as-of the event (an override
    lets reschedule record the OLD time on the "before" side if needed).

    master_verified is snapshotted as-of the event too (W-1): the feed is an
    append-only historical record, so we freeze the master's verified state at
    projection time rather than resolving it live on read. master_avatar_url is
    captured the same way (User.avatar_url at projection time). Lazy import
    keeps the diary->masters dependency from loading at module import (house
    style; same reason bookings is imported lazily below).

    S-1: master_name is resolved by the caller (passed in), so we cannot
    assume the MasterProfile / User are already in this session's identity
    map. We prime both once up front, making the session.get calls inside
    is_master_verified (MasterProfile) and get_master_avatar_url (User)
    guaranteed cache hits rather than fresh queries.
    """
    from app.modules.masters.models import MasterProfile
    from app.modules.masters.service import (
        get_master_avatar_url,
        is_master_verified,
    )
    from app.modules.users.models import User

    # Prime the identity map once (see S-1 note above): is_master_verified
    # reads MasterProfile, get_master_avatar_url reads User.
    await session.get(MasterProfile, practice.master_id)
    await session.get(User, practice.master_id)

    scheduled_at = scheduled_at_override or practice.scheduled_at
    master_verified = await is_master_verified(practice.master_id, session)
    master_avatar_url = await get_master_avatar_url(
        practice.master_id, session,
    )
    return {
        "practice_id": str(practice.id),
        "practice_title": practice.title,
        "master_id": str(practice.master_id),
        "master_name": master_name,
        "master_verified": master_verified,
        "master_avatar_url": master_avatar_url,
        "scheduled_at": scheduled_at.isoformat() if scheduled_at else None,
        "duration_minutes": practice.duration_minutes,
        "direction": _practice_direction(practice),
    }


async def _booked_user_ids(
    practice_id: UUID,
    session: AsyncSession,
) -> list[UUID]:
    """User ids with a non-cancelled booking for a practice (fan-out target).

    Master actions (reschedule / cancel / finalize) project one event per
    booked user. We read the booking rows via the ORM (no raw SQL). Cancelled
    bookings are excluded -- a user who already left should not get a new
    "practice cancelled" card.
    """
    # Lazy import to keep the dependency direction one-way and avoid a cycle
    # at module load (bookings.service imports this module).
    from app.modules.bookings.models import Booking, BookingStatus

    stmt = (
        select(Booking.user_id)
        .where(
            Booking.practice_id == practice_id,
            Booking.status != BookingStatus.CANCELLED.value,
        )
        .distinct()
    )
    result = await session.execute(stmt)
    return list(result.scalars().all())


async def _add_event(
    session: AsyncSession,
    *,
    user_id: UUID,
    kind: str,
    occurred_at: datetime,
    source_type: str,
    source_id: UUID,
    snapshot: dict,
    text_search: str | None,
) -> DiaryEvent:
    """Insert a single append-only DiaryEvent and flush to materialize its id.

    text_search is lowercased here so the feed's ilike stays case-insensitive
    without per-query lower() on the column.
    """
    event = DiaryEvent(
        user_id=user_id,
        kind=kind,
        occurred_at=occurred_at,
        source_type=source_type,
        source_id=source_id,
        text_search=text_search.lower() if text_search else None,
    )
    # JSONB contract: assign via set_jsonb (deepcopy) -- never in place.
    event.set_jsonb("snapshot", copy.deepcopy(snapshot))
    session.add(event)
    await session.flush()
    return event


async def _find_object_event(
    session: AsyncSession,
    *,
    source_type: str,
    source_id: UUID,
    kind: str | None = None,
) -> DiaryEvent | None:
    """Find the single per-object event for (source_type, source_id).

    Used by upsert projections (checkin/feedback/note/dream) to refresh the
    existing event on edit instead of appending a duplicate.

    `kind` narrows the lookup and exists because (source_type, source_id) is
    only unique while a source type produces ONE kind of event. That holds
    for the upsert kinds above, and it is exactly what a second kind on the
    same source would break: scalar_one_or_none() would start raising
    MultipleResultsFound at runtime, in a projection, inside somebody else's
    transaction. Pass it whenever the source could grow a second event kind.
    """
    stmt = (
        select(DiaryEvent)
        .where(
            DiaryEvent.source_type == source_type,
            DiaryEvent.source_id == source_id,
        )
    )
    if kind is not None:
        stmt = stmt.where(DiaryEvent.kind == kind)
    result = await session.execute(stmt)
    return result.scalar_one_or_none()


# ===================================================================
# Booking projections (per-fact, append-only)
# ===================================================================


async def project_booking_confirmed(
    session: AsyncSession,
    *,
    booking,  # noqa: ANN001 -- ORM Booking
    practice,  # noqa: ANN001 -- ORM Practice
    master_name: str | None,
    occurred_at: datetime,
) -> DiaryEvent:
    """Project "user booked a practice" onto the booker's timeline.

    occurred_at is the booking time (booking.created_at once flushed; the
    caller passes it explicitly so the projection does not depend on flush
    ordering).
    """
    snapshot = await _practice_snapshot(
        session, practice, master_name=master_name,
    )
    return await _add_event(
        session,
        user_id=booking.user_id,
        kind=DiaryEventKind.BOOKING_CONFIRMED.value,
        occurred_at=occurred_at,
        source_type=DiaryEventSourceType.BOOKING.value,
        source_id=booking.id,
        snapshot=snapshot,
        text_search=practice.title,
    )


async def project_booking_cancelled(
    session: AsyncSession,
    *,
    booking,  # noqa: ANN001 -- ORM Booking
    practice,  # noqa: ANN001 -- ORM Practice
    master_name: str | None,
    occurred_at: datetime,
) -> DiaryEvent:
    """Project "user cancelled their own booking" onto their timeline."""
    snapshot = await _practice_snapshot(
        session, practice, master_name=master_name,
    )
    return await _add_event(
        session,
        user_id=booking.user_id,
        kind=DiaryEventKind.BOOKING_CANCELLED_BY_USER.value,
        occurred_at=occurred_at,
        source_type=DiaryEventSourceType.BOOKING.value,
        source_id=booking.id,
        snapshot=snapshot,
        text_search=practice.title,
    )


async def project_practice_outcome(
    session: AsyncSession,
    *,
    practice,  # noqa: ANN001 -- ORM Practice
    master_name: str | None,
    outcomes: list[tuple[UUID, UUID, str]],
    occurred_at: datetime,
) -> int:
    """Project the finalization outcome onto each finalized booker's timeline.

    outcomes is a list of (user_id, booking_id, status) tuples assembled by
    finalize_practice while it transitions each booking to attended/no_show.
    We embed the per-user status in the snapshot so the card can render
    "Done" vs "Не состоялась". Returns the number of events written.
    """
    base_snapshot = await _practice_snapshot(
        session, practice, master_name=master_name,
    )
    count = 0
    for user_id, booking_id, status in outcomes:
        snapshot = dict(base_snapshot)
        snapshot["outcome_status"] = status  # attended | no_show
        await _add_event(
            session,
            user_id=user_id,
            kind=DiaryEventKind.PRACTICE_OUTCOME.value,
            occurred_at=occurred_at,
            # Source is the practice (deep-link target / future replay), not
            # the booking -- the card represents the session, not the booking.
            source_type=DiaryEventSourceType.PRACTICE.value,
            source_id=practice.id,
            snapshot=snapshot,
            text_search=practice.title,
        )
        count += 1
    logger.info(
        "diary_projected_practice_outcome",
        practice_id=str(practice.id),
        events=count,
    )
    return count


# ===================================================================
# Practice projections (per-fact, append-only, fan-out)
# ===================================================================


async def project_practice_rescheduled(
    session: AsyncSession,
    *,
    practice,  # noqa: ANN001 -- ORM Practice (already holds the NEW time)
    master_name: str | None,
    old_scheduled_at: datetime,
    new_scheduled_at: datetime,
    occurred_at: datetime,
) -> int:
    """Fan out "master moved the practice time" to every booked user.

    The snapshot records both old and new times so the card can render
    "перенёс на ...". Returns the number of events written.
    """
    user_ids = await _booked_user_ids(practice.id, session)
    snapshot = await _practice_snapshot(
        session,
        practice,
        master_name=master_name,
        scheduled_at_override=new_scheduled_at,
    )
    snapshot["old_scheduled_at"] = old_scheduled_at.isoformat()
    snapshot["new_scheduled_at"] = new_scheduled_at.isoformat()

    for user_id in user_ids:
        await _add_event(
            session,
            user_id=user_id,
            kind=DiaryEventKind.PRACTICE_RESCHEDULED.value,
            occurred_at=occurred_at,
            source_type=DiaryEventSourceType.PRACTICE.value,
            source_id=practice.id,
            snapshot=snapshot,
            text_search=practice.title,
        )
    logger.info(
        "diary_projected_practice_rescheduled",
        practice_id=str(practice.id),
        events=len(user_ids),
    )
    return len(user_ids)


async def project_practice_cancelled(
    session: AsyncSession,
    *,
    practice,  # noqa: ANN001 -- ORM Practice
    master_name: str | None,
    user_ids: list[UUID],
    occurred_at: datetime,
) -> int:
    """Fan out "master cancelled the practice" to the given booked users.

    The caller (cancel_practice) collects the affected user ids BEFORE the
    refund flow mutates booking statuses, then passes them here. Returns the
    number of events written.
    """
    snapshot = await _practice_snapshot(
        session, practice, master_name=master_name,
    )
    for user_id in user_ids:
        await _add_event(
            session,
            user_id=user_id,
            kind=DiaryEventKind.PRACTICE_CANCELLED_BY_MASTER.value,
            occurred_at=occurred_at,
            source_type=DiaryEventSourceType.PRACTICE.value,
            source_id=practice.id,
            snapshot=snapshot,
            text_search=practice.title,
        )
    logger.info(
        "diary_projected_practice_cancelled",
        practice_id=str(practice.id),
        events=len(user_ids),
    )
    return len(user_ids)


# ===================================================================
# Diary object projections (per-object, upsert)
# ===================================================================


async def upsert_checkin_event(
    session: AsyncSession,
    *,
    checkin,  # noqa: ANN001 -- ORM Checkin
    practice,  # noqa: ANN001 -- ORM Practice
    master_name: str | None,
) -> DiaryEvent:
    """Create or refresh the timeline event for a check-in.

    occurred_at is the check-in creation time (checkin.created_at). On edit
    we keep the original occurred_at but refresh the snapshot + text.
    """
    snapshot = await _practice_snapshot(
        session, practice, master_name=master_name,
    )
    snapshot["mood"] = checkin.mood
    snapshot["comment_preview"] = _preview(checkin.comment)

    existing = await _find_object_event(
        session,
        source_type=DiaryEventSourceType.CHECKIN.value,
        source_id=checkin.id,
    )
    if existing is not None:
        existing.set_jsonb("snapshot", copy.deepcopy(snapshot))
        existing.text_search = (
            checkin.comment.lower() if checkin.comment else None
        )
        await session.flush()
        return existing

    return await _add_event(
        session,
        user_id=checkin.user_id,
        kind=DiaryEventKind.CHECKIN.value,
        occurred_at=checkin.created_at,
        source_type=DiaryEventSourceType.CHECKIN.value,
        source_id=checkin.id,
        snapshot=snapshot,
        text_search=checkin.comment,
    )


async def upsert_feedback_event(
    session: AsyncSession,
    *,
    feedback,  # noqa: ANN001 -- ORM Feedback
    practice,  # noqa: ANN001 -- ORM Practice
    master_name: str | None,
) -> DiaryEvent:
    """Create or refresh the timeline event for a feedback."""
    snapshot = await _practice_snapshot(
        session, practice, master_name=master_name,
    )
    snapshot["rating"] = feedback.rating
    snapshot["comment_preview"] = _preview(feedback.comment)

    existing = await _find_object_event(
        session,
        source_type=DiaryEventSourceType.FEEDBACK.value,
        source_id=feedback.id,
    )
    if existing is not None:
        existing.set_jsonb("snapshot", copy.deepcopy(snapshot))
        existing.text_search = (
            feedback.comment.lower() if feedback.comment else None
        )
        await session.flush()
        return existing

    return await _add_event(
        session,
        user_id=feedback.user_id,
        kind=DiaryEventKind.FEEDBACK.value,
        occurred_at=feedback.created_at,
        source_type=DiaryEventSourceType.FEEDBACK.value,
        source_id=feedback.id,
        snapshot=snapshot,
        text_search=feedback.comment,
    )


async def upsert_entry_event(
    session: AsyncSession,
    *,
    entry,  # noqa: ANN001 -- ORM DiaryEntry
) -> DiaryEvent:
    """Create or refresh the timeline event for a diary entry (note/dream).

    The event kind tracks the entry_type (note -> note, dream -> dream). On
    edit we refresh kind too, in case the type changed. text_search combines
    title and content so search hits either.
    """
    # entry_type maps 1:1 onto the event kind (note/dream are valid kinds).
    kind = entry.entry_type
    text_search = " ".join(p for p in (entry.title, entry.content) if p)

    snapshot = {
        "entry_type": entry.entry_type,
        "title": entry.title,
        "content_preview": _preview(entry.content),
        "mood": entry.mood,
        "practice_id": str(entry.practice_id) if entry.practice_id else None,
        "practice_phase": entry.practice_phase,
    }

    existing = await _find_object_event(
        session,
        source_type=DiaryEventSourceType.DIARY_ENTRY.value,
        source_id=entry.id,
    )
    if existing is not None:
        existing.kind = kind
        existing.set_jsonb("snapshot", copy.deepcopy(snapshot))
        existing.text_search = text_search.lower() if text_search else None
        # Un-hide on edit: editing a soft-deleted entry brings it back. The
        # entry's own is_deleted is managed by the service; we mirror it.
        existing.is_hidden = entry.is_deleted
        await session.flush()
        return existing

    return await _add_event(
        session,
        user_id=entry.user_id,
        kind=kind,
        occurred_at=entry.created_at,
        source_type=DiaryEventSourceType.DIARY_ENTRY.value,
        source_id=entry.id,
        snapshot=snapshot,
        text_search=text_search,
    )


async def hide_entry_event(
    session: AsyncSession,
    *,
    entry_id: UUID,
) -> None:
    """Soft-hide the timeline event for a soft-deleted diary entry.

    Mirrors DiaryEntry.is_deleted: the event row survives (future relations
    keep a stable target) but drops out of the feed.
    """
    existing = await _find_object_event(
        session,
        source_type=DiaryEventSourceType.DIARY_ENTRY.value,
        source_id=entry_id,
    )
    if existing is not None:
        existing.is_hidden = True
        await session.flush()


# ===================================================================
# Chat projection (per-object, append-once -- seam T2 / ID-10)
# ===================================================================


async def upsert_thread_started_event(
    session: AsyncSession,
    *,
    user_id: UUID,
    thread_id: UUID,
    occurred_at: datetime,
    master_id: UUID,
    master_name: str | None,
) -> DiaryEvent | None:
    """Record "a conversation with a master began" -- once per thread.

    UPSERT-IF-ABSENT, not append-once-on-a-flag, and the difference matters.
    comms answers create-or-get with `created: true` exactly once in a
    thread's life; if the response carrying that `true` is lost (timeout,
    restart, a failed commit on our side), the retry sees `false` and the
    fact would be gone forever. So the caller runs this on EVERY create-or-get
    and the absence of the row -- not the flag -- decides. The flag only tells
    us whose diary it is the first time round.

    occurred_at is the thread's OWN created_at from comms, never "now": a
    late heal must land on the timeline where the conversation actually
    started, not where we noticed.

    Returns the event (existing or new); None is never returned -- the
    signature keeps the shape of its siblings.
    """
    existing = await _find_object_event(
        session,
        source_type=DiaryEventSourceType.THREAD.value,
        source_id=thread_id,
        # MUST filter: a thread is a long-lived object and a plausible
        # source for further kinds later (first reply, closed, ...).
        kind=DiaryEventKind.THREAD_STARTED.value,
    )
    if existing is not None:
        return existing

    snapshot = {
        "thread_id": str(thread_id),
        "master_id": str(master_id),
        "master_name": master_name,
    }
    return await _add_event(
        session,
        user_id=user_id,
        kind=DiaryEventKind.THREAD_STARTED.value,
        occurred_at=occurred_at,
        source_type=DiaryEventSourceType.THREAD.value,
        source_id=thread_id,
        snapshot=snapshot,
        text_search=master_name,
    )
