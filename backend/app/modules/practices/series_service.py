# =============================================================================
# VELO Backend -- Practice Series Service (E3, W26 split from service.py)
# =============================================================================
#
# Series occurrence generation: compute the child occurrence start times for a
# published series root and materialize them as Practice rows. Leaf area: no
# dependency on practices/service.py. Consumed by practices/service.py
# (update_practice, on draft -> scheduled publication of a series root).
# =============================================================================

import copy
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import structlog
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import BadRequestError
from app.modules.practices.models import Practice, PracticeStatus, PracticeType

logger = structlog.get_logger()


def _series_occurrence_starts(
    root: Practice,
    spec: dict,
    cap: int,
) -> list[datetime]:
    """Compute UTC start datetimes for a series root's CHILD occurrences.

    The root itself is occurrence #1 (its scheduled_at); this returns the
    subsequent occurrences (#2..N) as tz-aware UTC datetimes.

    DST-safe: each occurrence is built at the root's LOCAL wall-clock time (same
    hour/minute as the root) in the root's IANA timezone, then converted to UTC
    per-occurrence -- so 19:00 local stays 19:00 local across a DST transition
    rather than drifting by an hour.

    period:
      daily    -- every calendar day after the root (days are ignored).
      weekly   -- on the spec's ISO weekdays (1=Mon..7=Sun), every week.
      biweekly -- on the spec's ISO weekdays, every OTHER week (parity measured
                  from the root's week, Monday-anchored).

    end / cap (root included in the total):
      after_count -- total occurrences is min(count, cap).
      until_date  -- occurrences through until_date (inclusive, local date),
                     truncated to the cap.
      never       -- exactly cap occurrences.
    The TOTAL (root + children) never exceeds `cap`, so at most cap-1 children
    are returned.
    """
    period = spec["period"]
    end = spec["end"]
    days = set(spec.get("days") or ())
    count = spec.get("count")
    until_raw = spec.get("until_date")
    until_date = date.fromisoformat(until_raw) if until_raw else None

    # Total occurrences (root included) we are allowed to emit.
    if end == "after_count" and count is not None:
        total_target = min(int(count), cap)
    else:  # never / until_date
        total_target = cap
    max_children = max(0, total_target - 1)
    if max_children == 0:
        return []

    tz = ZoneInfo(root.timezone)
    anchor_local = root.scheduled_at.astimezone(tz)
    anchor_date = anchor_local.date()
    anchor_monday = anchor_date - timedelta(days=anchor_date.weekday())

    # Absolute safety ceiling on the forward day-walk so a pathological spec can
    # never loop unbounded. cap=40 with biweekly single-day needs ~78 weeks;
    # five years of days is comfortably beyond any reachable case.
    safety_days = 366 * 5

    starts: list[datetime] = []
    cursor = anchor_date
    for _ in range(safety_days):
        cursor += timedelta(days=1)
        if until_date is not None and cursor > until_date:
            break

        if period == "daily":
            qualifies = True
        else:
            iso_weekday = cursor.isoweekday()  # 1=Mon .. 7=Sun
            if iso_weekday not in days:
                qualifies = False
            elif period == "weekly":
                qualifies = True
            else:  # biweekly: even week offset from the root's week
                cursor_monday = cursor - timedelta(days=cursor.weekday())
                week_offset = (cursor_monday - anchor_monday).days // 7
                qualifies = week_offset % 2 == 0

        if not qualifies:
            continue

        # Build the local wall-clock instant -- preserving the root's FULL
        # time-of-day (sub-minute included) so occurrences sit exactly one
        # recurrence interval apart -- then convert to UTC (DST-safe).
        local_dt = datetime(
            cursor.year, cursor.month, cursor.day,
            anchor_local.hour, anchor_local.minute,
            anchor_local.second, anchor_local.microsecond,
            tzinfo=tz,
        )
        starts.append(local_dt.astimezone(UTC))
        if len(starts) >= max_children:
            break

    return starts


def _build_child_occurrence(
    root: Practice,
    start_utc: datetime,
) -> Practice:
    """Build one child Practice for a series, copying the root's fields.

    The child links back via parent_practice_id=root.id, starts already
    SCHEDULED (it is created at publication time), and carries only the root's
    taxonomy in its data sandbox -- NOT the recurrence spec (that lives on the
    root alone) and NOT any seed marker. current_participants resets to 0 (the
    ORM default).
    """
    child = Practice(
        master_id=root.master_id,
        practice_type=PracticeType.SERIES.value,
        status=PracticeStatus.SCHEDULED.value,
        title=root.title,
        description=root.description,
        what_to_prepare=root.what_to_prepare,
        contraindications=root.contraindications,
        scheduled_at=start_utc,
        duration_minutes=root.duration_minutes,
        timezone=root.timezone,
        max_participants=root.max_participants,
        zoom_link=root.zoom_link,
        parent_practice_id=root.id,
        is_free=root.is_free,
        price_cents=root.price_cents,
        currency=root.currency,
    )
    taxonomy = (root.data or {}).get("taxonomy")
    if taxonomy is not None:
        child.set_jsonb("data", {"taxonomy": copy.deepcopy(taxonomy)})
    return child


async def generate_series_occurrences(
    root: Practice,
    session: AsyncSession,
) -> int:
    """Generate child occurrences for a published series root.

    No-op (returns 0) unless the root carries a recurrence spec in
    data.recurrence. Idempotent: if children already exist for this root they
    are left untouched (defends against any re-entry, though draft -> scheduled
    is a one-way transition). Children are added to the session; the router's
    flush + refresh of the root persists them.

    Returns the number of children created.
    """
    spec = (root.data or {}).get("recurrence")
    if not spec:
        return 0

    # Idempotency guard: never double-generate for the same root.
    existing = (
        await session.execute(
            select(func.count(Practice.id)).where(
                Practice.parent_practice_id == root.id,
            )
        )
    ).scalar_one()
    if existing > 0:
        logger.info(
            "series_generation_skipped_existing",
            root_practice_id=str(root.id),
            existing_children=existing,
        )
        return 0

    cap = settings.practice_series_max_occurrences
    starts = _series_occurrence_starts(root, spec, cap)

    # W-1: an until_date earlier than the first recurring occurrence produces no
    # children, which would silently publish a "series" of just the root. Reject
    # it so the master gets clear feedback rather than a degenerate series. Only
    # until_date can be degenerate this way: never always fills to the cap, and
    # after_count with count=1 is an explicit single-occurrence choice.
    if not starts and spec.get("end") == "until_date":
        raise BadRequestError(
            "recurrence until_date is too early -- it yields no sessions "
            "after the first occurrence; choose a later date"
        )

    # E21 (ПРОМТ №520, closing the series hole): children are created
    # already SCHEDULED (_build_child_occurrence sets status=SCHEDULED at
    # construction) and never pass through update_practice()'s
    # draft->scheduled branch, which is where meeting creation is wired for
    # a non-series practice -- so without this, no recurring practice ever
    # gets a Zoom meeting. ПРОМТ №527: child.id (app-side uuid4) is only
    # populated at flush time, not at `Practice(...)` construction, so each
    # child is flushed before its ZoomMeeting row is built (that row's FK
    # needs a real id).
    #
    # ПРОМТ №559 (OWNER-3): each child's Zoom meeting used to be created
    # HERE, synchronously, one real Zoom API call per child, all inside this
    # one request/transaction. MEASURED on prod: the parent and every child
    # PRACTICE row land within 194ms of each other (occurrence layout is
    # instant) -- the only candidate for the actual delay is exactly this
    # per-child Zoom call, sequential, up to 39 of them. The frontend's own
    # 15s AbortController gives up long before that finishes; the backend
    # keeps running and commits successfully regardless, so the master saw
    # a timeout, believed publish had failed, and pressed the button again
    # -- three complete duplicate "Сказки" series in four minutes on prod
    # today, not a cosmetic double-click.
    #
    # DECIDED DESIGN (owner): the ROOT still gets its meeting synchronously
    # (update_practice's existing publish branch, immediately after this
    # function returns, UNCHANGED -- the root is always the nearest
    # occurrence in time, since children are only ever LATER dates, so "the
    # link is there right now" is preserved exactly where a human actually
    # needs it first). Every CHILD's meeting is deferred: only a ZoomMeeting
    # row is created here, status=PENDING_CREATION (never ATTEMPTED, not a
    # failure -- retry_poller.py claims this status the same as
    # create_failed and makes the real Zoom call in the background, same
    # per-row isolation and 429 handling as any other retried meeting). A
    # student CAN still book a pending child before its meeting exists --
    # zoom/service.py's create_registrant_for_booking already anticipated
    # exactly this ("series-child edge case" in its own docstring) and
    # queues the registrant as pending until the meeting goes active.
    from app.modules.zoom.models import ZoomMeeting, ZoomMeetingStatus

    children: list[Practice] = []
    for start_utc in starts:
        child = _build_child_occurrence(root, start_utc)
        session.add(child)
        await session.flush()
        children.append(child)
        session.add(
            ZoomMeeting(
                practice_id=child.id,
                status=ZoomMeetingStatus.PENDING_CREATION.value,
            )
        )

    logger.info(
        "series_occurrences_generated",
        root_practice_id=str(root.id),
        master_id=str(root.master_id),
        period=spec.get("period"),
        end=spec.get("end"),
        children_created=len(starts),
    )

    return len(starts)
