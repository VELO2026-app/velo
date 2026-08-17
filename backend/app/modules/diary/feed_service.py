# =============================================================================
# VELO Backend -- Diary Feed Service (Diary redesign iteration,
#                                      W25 split from service.py)
# =============================================================================
#
# The unified timeline query layer: reads the append-only DiaryEvent journal
# built by diary/projections.py. A distinct bounded concern from the entry/
# checkin/feedback write paths above -- it operates on DiaryEvent, not
# DiaryEntry/Checkin/Feedback, and has zero coupling to their service
# functions (only the already-extracted projections module writes the
# journal it reads). No external consumers outside diary/router.py.
# =============================================================================

from datetime import datetime
from uuid import UUID

from sqlalchemy import or_, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.modules.diary.models import DiaryEvent, DiaryEventKind
from app.modules.users.models import User


def _encode_cursor(occurred_at: datetime, event_id: UUID) -> str:
    """Pack (occurred_at, id) into the single opaque string the wire carries."""
    return f"{occurred_at.isoformat()}|{event_id}"


def _decode_cursor(cursor: str) -> tuple[datetime, UUID]:
    """Inverse of _encode_cursor. Raises ValueError on a malformed cursor."""
    ts_part, _, id_part = cursor.partition("|")
    return datetime.fromisoformat(ts_part), UUID(id_part)


def _kinds_for_categories(categories: list[str] | None) -> list[str] | None:
    """Resolve filter-chip categories to the set of event kinds they include.

    None / empty -> None (no kind filter -> "Все"). Unknown categories are
    ignored. Categories map to kinds via settings.diary_feed_categories
    (NO-LITERALS). Multiple categories union their kinds.
    """
    if not categories:
        return None
    mapping = settings.diary_feed_categories
    kinds: list[str] = []
    for category in categories:
        kinds.extend(mapping.get(category, []))
    # De-dup while preserving order; empty result means no valid category was
    # passed -> treat as no filter rather than "match nothing".
    deduped = list(dict.fromkeys(kinds))
    return deduped or None


async def list_diary_feed(
    user: User,
    session: AsyncSession,
    *,
    limit: int = 20,
    cursor: str | None = None,
    categories: list[str] | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    search: str | None = None,
) -> tuple[list[DiaryEvent], str | None]:
    """List the unified diary timeline for a user (cursor-paginated).

    The feed reads the append-only DiaryEvent journal in one query, newest
    first. Hidden events (soft-deleted entries) are excluded.

    Filters:
        categories: filter chips (entries/dreams/feedbacks/checkins/
            practices) -> resolved to event kinds. None -> all.
        date_from / date_to: bound occurred_at.
        search: case-insensitive ilike over the denormalized text_search.
        cursor: opaque `(occurred_at, id)` pair packed by _encode_cursor; the
            next page returns events strictly OLDER than that pair, in total
            order.

    Returns:
        Tuple of (events, next_cursor). next_cursor packs the last returned
        event's (occurred_at, id) when a full page was returned, else None
        (end of feed). The caller echoes it back verbatim as `cursor` for the
        next page -- it is opaque to it and always was (useCursorPagination.ts,
        api/diary.ts never parse/construct/compare the value).

    SW12 fix, 2026-08-17: occurred_at is NOT unique across events -- a series
    cancellation deliberately stamps ONE shared instant on every sibling it
    fans out (cancel_service.py, comment "W-3"), and project_practice_cancelled
    then writes one DiaryEvent per booked user per sibling with that same
    occurred_at. A plain occurred_at cursor silently and permanently drops
    whichever tied rows didn't make the page before the cursor advanced past
    their timestamp, because Postgres does not order ties and `< cursor`
    excludes them on every subsequent page. Total-ordering on (occurred_at, id)
    closes it -- id is a UUID (no chronological meaning) but it is a stable,
    deterministic secondary key, which is all a tiebreaker needs.

    THIS DOES CHANGE THE DECLARED API TYPE, contrary to what this docstring
    used to claim: `cursor`/`next_cursor` move from a `datetime`-typed field to
    an opaque `str`-typed one (router.py, schemas.py), because a packed
    "timestamp|uuid" value is not a valid datetime and FastAPI would reject it
    at the query-param layer otherwise. The frontend was already treating the
    field as opaque (confirmed: `useCursorPagination.ts`, `api/diary.ts`,
    `api/utils.ts` never parse/compare it), and this codegen already collapses
    every `datetime`-typed field to a plain TS `string` (checked: every
    created_at/updated_at in generated.ts), so the regenerated
    `next_cursor`/`cursor` TS type is `string | null` both before and after --
    unchanged. The claim that survives is narrower than the one this docstring
    used to make: no FRONTEND code changes, but the backend's own OpenAPI
    schema for this field does change shape (format: date-time is dropped).
    """
    base = select(DiaryEvent).where(
        DiaryEvent.user_id == user.id,
        DiaryEvent.is_hidden.is_(False),
        # B41 (owner-ruled 2026-08-15, D=C): "you started a dialogue" is no
        # longer written (chats/router.py, both open_* endpoints), and
        # EXISTING rows are hidden here rather than deleted -- reversible,
        # no schema change, no touch to DiaryEvent.kind's enum or the
        # uq_diary_events_thread_started partial index. Unconditional: this
        # kind never surfaces regardless of which category chip is active.
        DiaryEvent.kind != DiaryEventKind.THREAD_STARTED.value,
    )

    kinds = _kinds_for_categories(categories)
    if kinds is not None:
        base = base.where(DiaryEvent.kind.in_(kinds))

    if date_from is not None:
        base = base.where(DiaryEvent.occurred_at >= date_from)

    if date_to is not None:
        base = base.where(DiaryEvent.occurred_at <= date_to)

    if search:
        # text_search is stored lowercased; lower the needle to match.
        needle = f"%{search.lower()}%"
        base = base.where(
            or_(
                DiaryEvent.text_search.ilike(needle),
                # Practice title lives in the snapshot for practice cards
                # that may have an empty text_search; match it too.
                DiaryEvent.snapshot["practice_title"].as_string().ilike(needle),
            )
        )

    if cursor is not None:
        cursor_ts, cursor_id = _decode_cursor(cursor)
        base = base.where(
            tuple_(DiaryEvent.occurred_at, DiaryEvent.id) < tuple_(cursor_ts, cursor_id)
        )

    stmt = (
        base
        .order_by(DiaryEvent.occurred_at.desc(), DiaryEvent.id.desc())
        .limit(limit)
    )
    result = await session.execute(stmt)
    items = list(result.scalars().all())

    # next_cursor only when the page was full (more may remain).
    next_cursor = (
        _encode_cursor(items[-1].occurred_at, items[-1].id) if len(items) == limit else None
    )
    return items, next_cursor
