# =============================================================================
# VELO Backend -- Admin Participants Service (E1)
# =============================================================================
#
# Read-only global participants (all platform users) listing for the admin
# «Участников» screen. Fixes the honest-stub empty list (there was no
# endpoint); the header count already came from /admin/stats.
#
# LIST (GET /admin/participants?filter=all|new|active&period=week|month):
#   all    -> every user, newest first.
#   new    -> users created within the selected period (created_at >= start).
#   active -> users who opened the app within the period (last_login_at >=
#             start). Coarse "opened >= 1x since window start" using the
#             existing User.last_login_at (written on every auth); a per-open
#             activity journal is deferred (operator Q2=C). No migration.
#
# period + offset reuse app.core.periods (calendar_period_bounds / shift_anchor)
# for parity with the dashboard stepper. practices_count = non-cancelled
# bookings per user (one grouped subquery for the page).
#
# SESSION RULES: read-only, no commit (P-01), ORM-only.
# =============================================================================

from datetime import UTC, datetime

import structlog
from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.periods import calendar_period_bounds, shift_anchor
from app.modules.admin.participants.schemas import (
    AdminParticipant,
    PaginatedParticipantsResponse,
)
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.users.helpers import display_name
from app.modules.users.models import User

logger = structlog.get_logger()


def _apply_filter(
    stmt: Select,
    *,
    filter: str,
    period: str,
    offset: int,
) -> Select:
    """Apply the new/active window filter to a User query.

    ``all`` is a no-op. ``new`` / ``active`` bound on the selected calendar
    period (shifted by ``offset`` whole periods), reusing the shared period
    math so the window matches the dashboard stepper.
    """
    if filter not in ("new", "active"):
        return stmt

    anchor = shift_anchor(period, datetime.now(UTC), offset)
    period_start, _cur_end, _prev_start = calendar_period_bounds(period, anchor)

    if filter == "new":
        return stmt.where(User.created_at >= period_start)
    # active: opened the app (authenticated) at least once since window start.
    return stmt.where(User.last_login_at.is_not(None)).where(
        User.last_login_at >= period_start
    )


async def list_participants(
    session: AsyncSession,
    *,
    filter: str = "all",
    period: str = "week",
    offset: int = 0,
    limit: int = 20,
    page_offset: int = 0,
) -> PaginatedParticipantsResponse:
    """List platform participants with an optional new/active window filter.

    ``offset`` shifts the new/active window (period stepper); ``page_offset``
    is the pagination offset (mirrors /admin/users limit/offset).
    """
    # -- practices_count: non-cancelled bookings grouped by user (page-wide) --
    practices_sq = (
        select(
            Booking.user_id.label("uid"),
            func.count(Booking.id).label("cnt"),
        )
        .where(Booking.status != BookingStatus.CANCELLED.value)
        .group_by(Booking.user_id)
        .subquery()
    )

    base = _apply_filter(
        select(User), filter=filter, period=period, offset=offset
    )
    count_stmt = _apply_filter(
        select(func.count(User.id)),
        filter=filter,
        period=period,
        offset=offset,
    )

    total = (await session.execute(count_stmt)).scalar_one()

    rows = (
        await session.execute(
            base.add_columns(func.coalesce(practices_sq.c.cnt, 0))
            .outerjoin(practices_sq, User.id == practices_sq.c.uid)
            .order_by(User.created_at.desc())
            .limit(limit)
            .offset(page_offset)
        )
    ).all()

    items = [
        AdminParticipant(
            id=user.id,
            name=display_name(user.first_name, user.last_name),
            telegram_id=user.telegram_id,
            avatar_url=user.avatar_url,
            practices_count=practices_count,
            created_at=user.created_at,
            last_login_at=user.last_login_at,
        )
        for user, practices_count in rows
    ]

    return PaginatedParticipantsResponse(
        items=items, total=total, limit=limit, offset=page_offset,
    )
