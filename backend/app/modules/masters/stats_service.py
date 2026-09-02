# =============================================================================
# VELO Backend -- Master Stats Service (E7)
# =============================================================================
#
# Read-only period-scoped projection for the master dashboard stat grid.
# Counts are anchored on Practice.scheduled_at within a calendar period
# (week|month, UTC), each with a period-over-period delta.
#
#   practices_count    -- master's COMPLETED practices scheduled in the period.
#   participants_count -- DISTINCT users with an ATTENDED booking on those
#                         practices in the period.
#   income_cents       -- reused verbatim from the E2 finance projection
#                         (get_master_income): gross booked turnover for the
#                         period. Surfaced here for completeness so master stats
#                         and the finance screen share one income definition.
#
# WHAT THE GRID MEANS (GT-20). Both counts answer "what already happened", not
# "what is on my plate". practices_count used to include everything scheduled
# in the period, so a master with five future practices saw five under a tile
# labelled "Практик" and read it as five conducted.
#
# "Completed" is the practice STATUS, not "the clock has passed": time running
# out does not mean the practice finalized. That status is written in exactly
# one place -- _finalize_practice_core in bookings/service.py -- driven by
# bookings/autofinalize.py once the scheduled end (+ buffer) is behind us. So
# "it happened" here means the platform settled the session, not that a
# timestamp elapsed.
#
# Three consequences, all intended, none a defect:
#   - a period where every practice is still ahead reads 0 / 0 with "--" for
#     both deltas. The zero is honest, not a failed fetch.
#   - a practice running RIGHT NOW (status live) is not counted until it
#     finalizes, so a master mid-session does not see her own practice in the
#     tile. This is the first thing that will look like a bug and is not one.
#   - practices_count can be 1 while participants_count is 0. When Zoom
#     tracking is live the attendance verdict is deferred (no earlier than 15
#     minutes after the end, 2h deadline -- zoom/attendance_service.py): the
#     practice has happened and nobody is an attendee yet.
#
# WHY participants_count CARRIES NO PRACTICE-STATUS FILTER. It does not need
# one. ATTENDED is written only at or after finalization (the legacy proxy in
# bookings/service.py and zoom/attendance_service.py), and finalization is what
# sets COMPLETED, so an ATTENDED booking always sits on a COMPLETED practice.
# Narrowing practices_count therefore cannot hide an attendee: the pair stays
# coherent without a second filter.
#
# DELTAS:
#   practices / participants -- period_delta_pct (signed %, null when the
#     previous period was non-positive -- S-1). The PREVIOUS period is counted
#     by the same rule as the current one, so the percentage compares like with
#     like instead of measuring last week's plans against this week's results.
#   income -- delta_pct comes straight from get_master_income (same S-1 rule).
#
# CALENDAR BOUNDS come from core.periods (single source of truth, E7).
#
# SESSION RULES:
#   Read-only -- callers pass get_db_reader. No commit (P-01). ORM-only.
# =============================================================================

from datetime import UTC, datetime
from uuid import UUID

import structlog
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.periods import calendar_period_bounds, period_delta_pct
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.masters.finance_service import get_master_income
from app.modules.practices.models import Practice, PracticeStatus

logger = structlog.get_logger()


async def _count_practices(
    user_id: UUID,
    start: datetime,
    end: datetime,
    session: AsyncSession,
) -> int:
    """Count the master's COMPLETED practices scheduled in [start, end).

    COMPLETED and nothing else: draft, scheduled, live, cancelled and deleted
    are all "not a session that happened", and the tile this feeds is labelled
    "Практик". A practice scheduled inside the window but still ahead is
    deliberately absent -- see the module header for why that zero is honest.

    The window is anchored on scheduled_at, not on the finalization time: a
    completed practice belongs to the period it ran in.
    """
    stmt = select(func.count(Practice.id)).where(
        Practice.master_id == user_id,
        Practice.status == PracticeStatus.COMPLETED.value,
        Practice.scheduled_at >= start,
        Practice.scheduled_at < end,
    )
    return (await session.execute(stmt)).scalar_one()


async def _count_participants(
    user_id: UUID,
    start: datetime,
    end: datetime,
    session: AsyncSession,
) -> int:
    """Count DISTINCT attendees across the master's practices in [start, end).

    A participant is a user with an ATTENDED booking on one of this master's
    practices whose scheduled_at falls in the period. Counted distinctly, so a
    user attending several of the master's practices in the period counts once.

    Unchanged by GT-20 and deliberately not narrowed to COMPLETED practices:
    ATTENDED is written only at or after finalization, which is what sets
    COMPLETED, so every ATTENDED booking already sits on a completed practice.
    """
    stmt = (
        select(func.count(func.distinct(Booking.user_id)))
        .select_from(Booking)
        .join(Practice, Booking.practice_id == Practice.id)
        .where(
            Practice.master_id == user_id,
            Booking.status == BookingStatus.ATTENDED.value,
            Practice.scheduled_at >= start,
            Practice.scheduled_at < end,
        )
    )
    return (await session.execute(stmt)).scalar_one()


async def get_master_stats(
    user_id: UUID,
    period: str,
    session: AsyncSession,
) -> dict:
    """Period-scoped master stats + deltas. Returns a dict for MasterStatsResponse.

    practices_count (COMPLETED practices) and participants_count (their
    distinct attendees) are anchored on Practice.scheduled_at in the current
    calendar period; their deltas compare against the previous period counted
    by the same rule. income_cents / income_delta_pct are reused from the E2
    finance projection so master stats and the finance screen never disagree
    on what "income" means.
    """
    now = datetime.now(UTC)
    cur_start, cur_end, prev_start = calendar_period_bounds(period, now)

    practices = await _count_practices(user_id, cur_start, cur_end, session)
    prev_practices = await _count_practices(
        user_id, prev_start, cur_start, session,
    )

    participants = await _count_participants(
        user_id, cur_start, cur_end, session,
    )
    prev_participants = await _count_participants(
        user_id, prev_start, cur_start, session,
    )

    # Income comes from the E2 finance projection. It computes its own
    # (identical) bounds internally; the E7 follow-up refactor collapses those
    # onto core.periods too.
    income = await get_master_income(user_id, period, session)

    return {
        "practices_count": practices,
        "practices_delta_pct": period_delta_pct(practices, prev_practices),
        "participants_count": participants,
        "participants_delta_pct": period_delta_pct(
            participants, prev_participants,
        ),
        "income_cents": income["income_cents"],
        "income_delta_pct": income["delta_pct"],
    }
