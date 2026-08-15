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

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.modules.diary.models import DiaryEvent, DiaryEventKind
from app.modules.users.models import User


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
    cursor: datetime | None = None,
    categories: list[str] | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    search: str | None = None,
) -> tuple[list[DiaryEvent], datetime | None]:
    """List the unified diary timeline for a user (cursor-paginated).

    The feed reads the append-only DiaryEvent journal in one query, newest
    first. Hidden events (soft-deleted entries) are excluded.

    Filters:
        categories: filter chips (entries/dreams/feedbacks/checkins/
            practices) -> resolved to event kinds. None -> all.
        date_from / date_to: bound occurred_at.
        search: case-insensitive ilike over the denormalized text_search.
        cursor: occurred_at of the last item from the previous page; the
            next page returns events strictly OLDER than the cursor.

    Returns:
        Tuple of (events, next_cursor). next_cursor is the occurred_at of the
        last returned event when a full page was returned, else None (end of
        feed). The caller echoes it back as `cursor` for the next page.

    Note on cursor stability: occurred_at is not guaranteed unique across
    events (a master fan-out stamps many rows with the same instant). For
    alpha volumes a plain occurred_at cursor is acceptable; a future tie-break
    (occurred_at, id) can be added without an API change.
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
        base = base.where(DiaryEvent.occurred_at < cursor)

    stmt = (
        base
        .order_by(DiaryEvent.occurred_at.desc())
        .limit(limit)
    )
    result = await session.execute(stmt)
    items = list(result.scalars().all())

    # next_cursor only when the page was full (more may remain).
    next_cursor = (
        items[-1].occurred_at if len(items) == limit else None
    )
    return items, next_cursor
