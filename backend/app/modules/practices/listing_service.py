# =============================================================================
# VELO Backend -- Practice Listing Service (W26 split from service.py)
# =============================================================================
#
# Master-facing list (list_master_practices) and public feed
# (list_public_practices), plus the time_of_day facet helpers. The only area
# consumed by TWO routers: masters/router.py (list_master_practices) and
# practices/router.py (list_public_practices).
# =============================================================================

from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from sqlalchemy import and_, extract, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.modules.practices.audience_service import viewer_audience_clause
from app.modules.practices.enrichment_service import (
    attendance_counts_for_practices,
    attendance_counts_kwargs,
    series_meta_for_practices,
    series_meta_kwargs,
)
from app.modules.practices.models import Practice, PracticeStatus
from app.modules.practices.schemas import PaginatedPracticesResponse
from app.modules.practices.service import (
    master_full_name,
    practice_to_response,
    user_flags_for_practices,
)
from app.modules.users.models import User

# Statuses shown in public feed (4.3).
_FEED_STATUSES = {
    PracticeStatus.SCHEDULED.value,
    PracticeStatus.LIVE.value,
}


# T22-3/T22-5 (ПРОМТ №561): the two master-list tabs ask fundamentally
# different questions ("what's next" vs "what happened"), each wanting the
# OPPOSITE ordering -- one shared futures-first cursor can never answer both
# without one tab drowning in the other's rows. "upcoming" = draft/scheduled/
# live, nearest first; "past" = completed only, most-recent first. Cancelled
# practices are excluded from BOTH (they didn't happen -- matches the prior
# client-side behavior, now enforced server-side).
_UPCOMING_STATUSES = (
    PracticeStatus.DRAFT.value,
    PracticeStatus.SCHEDULED.value,
    PracticeStatus.LIVE.value,
)


async def list_master_practices(
    user: User,
    session: AsyncSession,
    limit: int = 20,
    offset: int = 0,
    status: str | None = None,
    bucket: Literal["upcoming", "past"] | None = None,
) -> PaginatedPracticesResponse:
    """List practices owned by the current master.

    R-04 fix: returns PaginatedPracticesResponse (with total count),
    consistent with list_public_practices().

    Excludes deleted practices. Master sees their own drafts.

    E3a: optional exact-status filter (draft/scheduled/live/completed/
    cancelled), mirroring list_public_practices' explicit `status` param.
    None (default) keeps the prior behavior -- every non-deleted status,
    futures-first.

    bucket (T22-3/T22-5, ПРОМТ №561): the tab-shaped alternative to `status`.
    "upcoming" filters to draft/scheduled/live and orders NEAREST FIRST
    (ascending); "past" filters to completed and orders MOST RECENT FIRST
    (descending). When given, `bucket` OWNS both the filter and the
    ordering and `status` is ignored -- the two params serve different
    callers (bucket: the two-tab master list; status: exact-match tooling)
    and are not meant to compose.
    """
    base_filter = (
        Practice.master_id == user.id,
        Practice.status != PracticeStatus.DELETED.value,
    )
    if bucket == "upcoming":
        base_filter = (*base_filter, Practice.status.in_(_UPCOMING_STATUSES))
        order_clause = Practice.scheduled_at.asc()
    elif bucket == "past":
        base_filter = (*base_filter, Practice.status == PracticeStatus.COMPLETED.value)
        order_clause = Practice.scheduled_at.desc()
    else:
        if status is not None:
            base_filter = (*base_filter, Practice.status == status)
        order_clause = Practice.scheduled_at.desc()

    # -- Total count --
    count_query = select(func.count(Practice.id)).where(*base_filter)
    total_result = await session.execute(count_query)
    total = total_result.scalar_one()

    # -- Paginated items with master name --
    stmt = (
        select(Practice, User.first_name, User.last_name)
        .join(User, Practice.master_id == User.id)
        .where(*base_filter)
        .order_by(order_clause)
        .limit(limit)
        .offset(offset)
    )
    result = await session.execute(stmt)
    rows = result.all()

    # E3 batch 2: series card meta for the practices on this page (2 queries).
    page_practices = [p for p, _first, _last in rows]
    series_meta = await series_meta_for_practices(page_practices, session)
    # E12 + aggregate: attendance counts for the same page (2 queries). This is
    # the master's own list (get_current_master), so the counts are shown
    # unconditionally here -- the owner-only gate lives on the shared public
    # detail endpoint (get_practice_detail) instead.
    attendance = await attendance_counts_for_practices(page_practices, session)
    # T21-1: host join_url for this page (one batched query, same owner-only
    # posture as zoom_link_visible=True below -- every row here is the
    # requester's own).
    from app.modules.zoom.service import get_host_join_urls, get_zoom_meeting_statuses
    host_join_urls = await get_host_join_urls([p.id for p in page_practices], session)
    # A4 V2 (ПРОМТ №572): batched Zoom meeting status for this page --
    # MasterDashboardView's "nearest practices" and MasterPracticesView both
    # read practicesUpcoming (this endpoint), and their Zoom button needs to
    # tell "готовится" apart from "не удалось создать встречу".
    zoom_meeting_statuses = await get_zoom_meeting_statuses(
        [p.id for p in page_practices], session,
    )

    return PaginatedPracticesResponse(
        items=[
            practice_to_response(
                p,
                master_full_name(first, last),
                # Z-6: the master's OWN list (get_current_master) -- every row
                # is owned by the requester, so expose zoom_link (the same owner
                # rule get_practice_detail applies). The master dashboard's
                # "Войти" button reads zoom_link from this list.
                zoom_link_visible=True,
                zoom_host_join_url=host_join_urls.get(p.id),
                zoom_meeting_status=zoom_meeting_statuses.get(p.id),
                **series_meta_kwargs(series_meta.get(p.id)),
                **attendance_counts_kwargs(attendance.get(p.id)),
            )
            for p, first, last in rows
        ],
        total=total,
        limit=limit,
        offset=offset,
    )


def _local_hour(column_tz, column_ts):
    """Local hour (0-23) of a timestamp in a given timezone.

    `column_tz` may be a column (e.g. Practice.timezone) or a bound string
    (e.g. the viewer's timezone) -- func.timezone accepts both, and a string
    is emitted as a bound parameter, not an identifier.

    Postgres: EXTRACT(HOUR FROM (ts AT TIME ZONE tz_name)). Expressed via
    func.timezone(tz, ts) + extract() so it stays within the ORM (no raw
    SQL). func.timezone(text, timestamptz) returns the local wall-clock
    timestamp for that zone, from which we pull the hour.
    """
    return extract("hour", func.timezone(column_tz, column_ts))


def _time_of_day_filter(time_of_day: str, viewer_tz: str):
    """Build a half-open local-hour range condition for a time_of_day bucket.

    F5: the local hour is computed in the VIEWER'S timezone (passed in), not
    the practice's own timezone. The profile decides in which timezone the
    viewer sees practice times, so the "morning/day/evening" facet must bucket
    by the same wall-clock the card shows -- otherwise the filter and the
    displayed time disagree.

    Buckets (config-driven boundaries):
      night   [night_start,   morning_start)
      morning [morning_start, day_start)
      day     [day_start,     evening_start)
      evening [evening_start, 24)
    """
    night = settings.practice_time_night_start_hour
    morning = settings.practice_time_morning_start_hour
    day = settings.practice_time_day_start_hour
    evening = settings.practice_time_evening_start_hour

    ranges = {
        "night": (night, morning),
        "morning": (morning, day),
        "day": (day, evening),
        "evening": (evening, 24),
    }
    low, high = ranges[time_of_day]
    local_hour = _local_hour(viewer_tz, Practice.scheduled_at)
    return and_(local_hour >= low, local_hour < high)


async def list_public_practices(
    session: AsyncSession,
    *,
    user: User,
    limit: int = 20,
    offset: int = 0,
    master_id: UUID | None = None,
    practice_type: list[str] | None = None,
    direction: list[str] | None = None,
    difficulty: list[str] | None = None,
    style: list[str] | None = None,
    duration_bucket: Literal["short", "long"] | None = None,
    time_of_day: Literal[
        "night", "morning", "day", "evening",
    ] | None = None,
    status: str | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    sort_by: Literal[
        "scheduled_at", "price_cents",
    ] = "scheduled_at",
    sort_order: Literal["asc", "desc"] = "asc",
) -> PaginatedPracticesResponse:
    """List practices visible in the public feed (Calendar feed).

    Default feed shows only UPCOMING bookable practices: status in
    scheduled/live AND scheduled_at strictly in the future. Practices that
    already started (including live) or are past are excluded -- they can no
    longer be booked. Passing an explicit `status` bypasses the time gate and
    matches that status exactly (no future-only restriction). Supports
    filtering by master, type, date range, and the Calendar facets
    (direction / difficulty / style / duration_bucket / time_of_day).

    Multi-value semantics (Calendar "Выбрать практики"):
      - Within one facet, values are OR-ed (.in_()).
      - Across facets, conditions are AND-ed (separate filter entries).

    Per-user flags (is_booked / is_paid) are computed for `user` over the
    practices on the returned page via a single bookings query.
    """
    # FIX 5.3: Build filter list once, apply to both queries (DRY).
    filters: list = []

    # Audience + block (Master GROUPS P5, ПРОМТ №594): applies regardless of
    # the branch below (explicit status or the default time-gated feed) --
    # a blocked/out-of-audience viewer must not see the practice either way.
    # The owner always sees their OWN practice here too (same posture as
    # get_practice's draft/deleted owner-bypass) -- audience targeting is
    # a viewer-facing gate, not something that hides a practice from its
    # own creator.
    filters.append(
        or_(Practice.master_id == user.id, viewer_audience_clause(user.id))
    )

    if status is not None:
        # Explicit status request (e.g. internal/master tooling): exact match,
        # no time gate -- the caller asked for a specific status on purpose.
        filters.append(Practice.status == status)
    else:
        # Default public feed: only practices a user can still BOOK.
        # "Bookable" = not yet started (scheduled_at strictly in the future).
        # This drops both past practices and ones that already started (incl.
        # live) -- you cannot sign up once a practice has begun. Bookings the
        # user already holds are surfaced elsewhere (dashboard / my bookings)
        # with a different, end-of-practice cutoff, so this gate does not hide
        # a practice the user is already attending.
        filters.append(Practice.status.in_(_FEED_STATUSES))
        filters.append(Practice.scheduled_at > datetime.now(UTC))

    if master_id is not None:
        filters.append(Practice.master_id == master_id)

    # practice_type: multi-select (OR within facet).
    if practice_type:
        filters.append(Practice.practice_type.in_(practice_type))

    # -- Calendar taxonomy facets (JSONB data.taxonomy, schema-on-read) --
    # direction / difficulty / style: multi-select (OR within facet).
    # B-4 (2026-05-29): style switched to list[str] + .in_() — was a single
    # exact match. Frontend sends one or more selected style chips.
    if direction:
        filters.append(
            Practice.data["taxonomy"]["direction"].as_string().in_(direction)
        )
    if difficulty:
        filters.append(
            Practice.data["taxonomy"]["difficulty"].as_string().in_(difficulty)
        )
    if style:
        filters.append(
            Practice.data["taxonomy"]["style"].as_string().in_(style)
        )

    # duration_bucket: short = < N minutes, long = >= N minutes.
    if duration_bucket is not None:
        threshold = settings.practice_duration_long_min_minutes
        if duration_bucket == "short":
            filters.append(Practice.duration_minutes < threshold)
        else:  # "long"
            filters.append(Practice.duration_minutes >= threshold)

    # time_of_day: local-hour bucket in the VIEWER'S timezone (F5). The
    # profile decides the display timezone, so the facet buckets by the same
    # wall-clock the card shows. `or "UTC"` guards an empty profile value with
    # the same neutral default the frontend format helpers use (never the
    # practice's own timezone, which would reintroduce the mismatch).
    if time_of_day is not None:
        filters.append(_time_of_day_filter(time_of_day, user.timezone or "UTC"))

    if date_from is not None:
        filters.append(Practice.scheduled_at >= date_from)

    if date_to is not None:
        filters.append(Practice.scheduled_at <= date_to)

    # -- Sort --
    sort_column = (
        Practice.price_cents
        if sort_by == "price_cents"
        else Practice.scheduled_at
    )
    if sort_order == "desc":
        sort_column = sort_column.desc()
    else:
        sort_column = sort_column.asc()

    # -- Total count --
    count_query = select(func.count(Practice.id)).where(*filters)
    total_result = await session.execute(count_query)
    total = total_result.scalar_one()

    # -- Paginated items with master name --
    query = (
        select(Practice, User.first_name, User.last_name)
        .join(User, Practice.master_id == User.id)
        .where(*filters)
        .order_by(sort_column)
        .limit(limit)
        .offset(offset)
    )
    result = await session.execute(query)
    rows = result.all()

    # -- Per-user flags for the practices on this page (single query) --
    practice_ids = [p.id for p, _first, _last in rows]
    flags = await user_flags_for_practices(user.id, practice_ids, session)

    return PaginatedPracticesResponse(
        items=[
            practice_to_response(
                p,
                master_full_name(first, last),
                is_booked=flags.get(p.id, (False, False))[0],
                is_paid=flags.get(p.id, (False, False))[1],
            )
            for p, first, last in rows
        ],
        total=total,
        limit=limit,
        offset=offset,
    )
