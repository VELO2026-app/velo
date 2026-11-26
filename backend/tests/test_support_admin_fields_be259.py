# =============================================================================
# VELO -- support: the admin console's list filter and statistics (BE-259, BE-260)
# =============================================================================
# Band 71400-71439.
#
# What is under test, and why each one exists:
#
#   1. "MINE" (BE-259): GET /support/tickets?claimed_by_me=true keeps the
#      tickets the CALLER has taken -- the caller is the session's, so there
#      is no id to ask another admin's tickets with -- and composes with the
#      filters beside it.
#   2. BY DAY (BE-260): GET /support/stats answers `by_day`, the period's
#      tickets per calendar day of the ADMIN'S zone (oldest first, empty
#      days at zero, spam out), which add up to `total`; a period past the
#      cap lists only the days that have tickets; a stored zone name that is
#      not a zone reads as UTC.
#
# Not here: the tab counts, the user's data in a ticket, the first-reply time
# and "resolved in a day" of BE-259 / BE-260 -- they are not built yet.
# comms is not asked by either route, so it is not faked.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.support.models import TOPICS, SupportThread, SupportTicket
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user

BAND_MIN, BAND_MAX = 71400, 71439

TICKETS_URL = "/api/v1/support/tickets"
STATS_URL = "/api/v1/support/stats"


@pytest.fixture(autouse=True)
async def _band(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(db_session, BAND_MIN, BAND_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, BAND_MIN, BAND_MAX, delete_users=True)
    await db_session.commit()


async def _person(
    client: AsyncClient,
    db_session: AsyncSession,
    offset: int,
    *,
    admin: bool = False,
    timezone: str | None = None,
) -> dict:
    """A user of the band; an admin when asked (logged in again, so the
    session carries the role), in `timezone` when given."""
    tid = BAND_MIN + offset
    name = f"BE259-{offset}"
    auth = await login_user(client, telegram_id=tid, first_name=name)
    user = await db_session.get(User, UUID(auth["user"]["id"]))
    if admin:
        user.role = UserRole.ADMIN.value
    if timezone is not None:
        user.timezone = timezone
    await db_session.commit()
    if admin:
        auth = await login_user(client, telegram_id=tid, first_name=name)
    return auth


async def _ticket(
    db_session: AsyncSession,
    user_id: str,
    *,
    status: str = "open",
    created_at: datetime | None = None,
    age_minutes: int = 0,
    claimed_by: str | None = None,
) -> UUID:
    thread_id = uuid4()
    pointer = SupportThread(comms_thread_id=thread_id, client_user_id=UUID(user_id))
    db_session.add(pointer)
    await db_session.flush()
    when = created_at or datetime.now(UTC) - timedelta(minutes=age_minutes)
    db_session.add(
        SupportTicket(
            support_thread_id=pointer.id,
            topic="technical",
            category=TOPICS["technical"].category,
            status=status,
            status_changed_at=when,
            created_at=when,
            claimed_by_user_id=UUID(claimed_by) if claimed_by else None,
            version=1,
        )
    )
    await db_session.commit()
    return thread_id


# ---------------------------------------------------------------------------
# 1. "Mine"
# ---------------------------------------------------------------------------


class TestClaimedByMe:
    async def test_the_flag_keeps_only_the_callers_tickets(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        me = await _person(client, db_session, 1, admin=True)
        other = await _person(client, db_session, 2, admin=True)
        user = await _person(client, db_session, 3)
        uid = user["user"]["id"]
        mine_id, other_id = me["user"]["id"], other["user"]["id"]
        mine_open = await _ticket(db_session, uid, claimed_by=mine_id, age_minutes=40)
        mine_done = await _ticket(
            db_session, uid, claimed_by=mine_id, status="resolved", age_minutes=30
        )
        theirs = await _ticket(db_session, uid, claimed_by=other_id, age_minutes=20)
        nobodys = await _ticket(db_session, uid, age_minutes=10)

        async def ids(who: dict, **params) -> list[str]:
            resp = await client.get(
                TICKETS_URL,
                params=params,
                headers=auth_headers(who["session_token"]),
            )
            assert resp.status_code == 200, resp.text
            return [t["id"] for t in resp.json()["tickets"]]

        everything = [nobodys, theirs, mine_done, mine_open]
        assert await ids(me) == [str(t) for t in everything]
        assert await ids(me, claimed_by_me="false") == [str(t) for t in everything]
        assert await ids(me, claimed_by_me="true") == [str(mine_done), str(mine_open)]
        # The caller is the session's: the other admin gets their own, not mine.
        assert await ids(other, claimed_by_me="true") == [str(theirs)]
        # Beside the other filters: "mine, and still open".
        assert await ids(me, claimed_by_me="true", status="open") == [str(mine_open)]

    async def test_the_flag_is_for_admins_only(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        user = await _person(client, db_session, 4)
        resp = await client.get(
            TICKETS_URL,
            params={"claimed_by_me": "true"},
            headers=auth_headers(user["session_token"]),
        )
        assert resp.status_code == 403


# ---------------------------------------------------------------------------
# 2. By day
# ---------------------------------------------------------------------------


def _utc(day: int, hour: int, minute: int = 0, *, month: int = 11) -> datetime:
    return datetime(2026, month, day, hour, minute, tzinfo=UTC)


class TestStatsByDay:
    async def test_the_days_are_the_admins_zone_and_add_up_to_the_total(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """Tokyo is UTC+9: its 11 November starts at 10 November 15:00 UTC.
        The period is four of those days; the 12th has no ticket and still
        has its line; the period's own edges (inclusive start, exclusive
        end) and a spam ticket stay out of the counts."""
        admin = await _person(
            client, db_session, 5, admin=True, timezone="Asia/Tokyo"
        )
        user = await _person(client, db_session, 6)
        uid = user["user"]["id"]
        for created_at, status in (
            (_utc(10, 14, 59), "open"),  # a minute before the period
            (_utc(10, 15, 0), "open"),  # 11th 00:00 -- the first instant of day one
            (_utc(11, 14, 59), "resolved"),  # 11th 23:59
            (_utc(12, 16, 0), "open"),  # 13th 01:00
            (_utc(13, 14, 59), "open"),  # 13th 23:59
            (_utc(13, 15, 0), "rejected"),  # 14th 00:00
            (_utc(13, 20, 0), "spam"),  # 14th, but spam: not counted
            (_utc(14, 15, 0), "open"),  # 15th 00:00 -- created_to is exclusive
        ):
            await _ticket(db_session, uid, status=status, created_at=created_at)

        resp = await client.get(
            STATS_URL,
            params={
                "created_from": _utc(10, 15, 0).isoformat(),
                "created_to": _utc(14, 15, 0).isoformat(),
            },
            headers=auth_headers(admin["session_token"]),
        )

        assert resp.status_code == 200, resp.text
        stats = resp.json()
        assert stats["period"]["timezone"] == "Asia/Tokyo"
        assert stats["by_day"] == [
            {"date": "2026-11-11", "tickets": 2},
            {"date": "2026-11-12", "tickets": 0},
            {"date": "2026-11-13", "tickets": 2},
            {"date": "2026-11-14", "tickets": 1},
        ]
        assert stats["total"] == sum(d["tickets"] for d in stats["by_day"]) == 5
        assert stats["spam"] == 1

    async def test_a_period_past_the_cap_lists_only_days_with_tickets(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """Four hundred days are over the cap of filled days: the answer is
        the days that have tickets, not four hundred lines."""
        admin = await _person(client, db_session, 7, admin=True)
        user = await _person(client, db_session, 8)
        uid = user["user"]["id"]
        for day in (3, 1, 1):
            await _ticket(
                db_session, uid, created_at=datetime(2025, 6, day, 12, tzinfo=UTC)
            )

        resp = await client.get(
            STATS_URL,
            params={
                "created_from": "2025-01-01T00:00:00+00:00",
                "created_to": "2026-03-01T00:00:00+00:00",
            },
            headers=auth_headers(admin["session_token"]),
        )

        assert resp.status_code == 200, resp.text
        assert resp.json()["by_day"] == [
            {"date": "2025-06-01", "tickets": 2},
            {"date": "2025-06-03", "tickets": 1},
        ]

    @pytest.mark.parametrize(
        "stored,counted_in",
        [
            ("Asia/Katmandu", "Asia/Kathmandu"),  # an old browser spelling
            ("Not/AZone", "UTC"),  # not a zone: UTC, not a 500
        ],
    )
    async def test_a_stored_zone_name_is_made_one_postgres_knows(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        stored: str,
        counted_in: str,
    ) -> None:
        admin = await _person(client, db_session, 9, admin=True, timezone=stored)

        resp = await client.get(
            STATS_URL,
            params={
                "created_from": "2026-11-01T00:00:00+00:00",
                "created_to": "2026-11-03T00:00:00+00:00",
            },
            headers=auth_headers(admin["session_token"]),
        )

        assert resp.status_code == 200, resp.text
        assert resp.json()["period"]["timezone"] == counted_in
        assert len(resp.json()["by_day"]) >= 2
