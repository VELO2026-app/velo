# =============================================================================
# VELO Backend -- the Mini App `signature` measurement (BE-201)
# =============================================================================
#
# record() -- called by POST /api/v1/auth/telegram on a successful sign-in,
#   in the request's transaction: it commits with the sign-in or not at all.
# count() -- the three numbers the owner reads through
#   scripts/signature_stats.py (the `signature-stats` verb).
#
# The table and this module go away with BE-183, together with the
# bot-token check they measure the way off.
# =============================================================================

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import and_, func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.auth.models import MiniAppSignatureSeen

_T = MiniAppSignatureSeen


async def record(session: AsyncSession, user_id: UUID, has_signature: bool) -> None:
    """Mark that `user_id` signed in now, with or without `signature`.

    One statement, so two sign-ins of the same person never race into two
    rows or a lost mark. The time is the database's now() -- the start of
    this transaction -- not the process clock.

    GREATEST, not EXCLUDED, on conflict, for two reasons at once:
      - the column this sign-in does not set arrives as NULL in EXCLUDED,
        and GREATEST ignores NULLs, so the other mark is kept;
      - now() is when the transaction STARTED: two sign-ins of one person
        can commit in the opposite order to their starts, and a plain
        overwrite would then move a time backwards.
    """
    now = func.now()
    stmt = pg_insert(_T).values(
        user_id=user_id,
        last_with_signature_at=now if has_signature else None,
        last_without_signature_at=None if has_signature else now,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=[_T.user_id],
        set_={
            "last_with_signature_at": func.greatest(
                _T.last_with_signature_at,
                stmt.excluded.last_with_signature_at,
            ),
            "last_without_signature_at": func.greatest(
                _T.last_without_signature_at,
                stmt.excluded.last_without_signature_at,
            ),
        },
    )
    await session.execute(stmt)


@dataclass(frozen=True)
class SignatureStats:
    """People, not sign-ins.

    only_with: came only with `signature` (since the date, if given).
    ever_without: came without it at least once (since the date).
    total: came at all (since the date); always only_with + ever_without.
    """

    only_with: int
    ever_without: int
    total: int


async def count(session: AsyncSession, since: datetime | None = None) -> SignatureStats:
    """The three numbers, over all time or from `since` (inclusive).

    The last-seen times answer "since D" exactly: a person came without
    `signature` on or after D if and only if the LAST time they did is on
    or after D, and likewise with it.
    """
    with_at = _T.last_with_signature_at
    without_at = _T.last_without_signature_at

    if since is None:
        came_with = with_at.is_not(None)
        came_without = without_at.is_not(None)
        no_without = without_at.is_(None)
    else:
        # NULL >= since is NULL, not true: a person with no mark of a kind
        # never counts as having come that way.
        came_with = with_at >= since
        came_without = without_at >= since
        no_without = or_(without_at.is_(None), without_at < since)

    row = (
        await session.execute(
            select(
                func.count().filter(and_(came_with, no_without)),
                func.count().filter(came_without),
                func.count().filter(or_(came_with, came_without)),
            )
        )
    ).one()
    return SignatureStats(only_with=row[0], ever_without=row[1], total=row[2])
