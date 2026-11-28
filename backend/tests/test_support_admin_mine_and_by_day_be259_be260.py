# =============================================================================
# VELO -- support: the admin console's "mine" filter and statistics by day
# (BE-259, BE-260)
# =============================================================================
# Band 71400-71439.
#
# What is under test, and why each one exists:
#
#   1. "MINE" (BE-259): GET /support/tickets?claimed_by_me=true keeps the
#      tickets the CALLER has taken -- the caller is the session's, so there
#      is no id to ask another admin's tickets with -- composes with the
#      filters beside it, and pages by the list's own cursor.
#   2. BY DAY (BE-260): GET /support/stats answers `by_day`, the period's
#      tickets per calendar day of the ADMIN'S zone (oldest first, every day
#      of the period listed, spam out), which add up to `total`; a period
#      longer than 366 days is a 400; a stored zone name that is not one
#      Postgres knows is made canonical, or read as UTC.
#
# Every ticket here is created in a past window of its own (March and
# November 2020, a leap year for the period test), and every read names that
# window through created_from / created_to: tickets other files leave in
# the table are never in the answer, so the assertions are about this band
# alone.
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
    created_at: datetime,
    *,
    status: str = "open",
    claimed_by: str | None = None,
) -> UUID:
    thread_id = uuid4()
    pointer = SupportThread(comms_thread_id=thread_id, client_user_id=UUID(user_id))
    db_session.add(pointer)
    await db_session.flush()
    db_session.add(
        SupportTicket(
            support_thread_id=pointer.id,
            topic="technical",
            category=TOPICS["technical"].category,
            status=status,
            status_changed_at=created_at,
            created_at=created_at,
            claimed_by_user_id=UUID(claimed_by) if claimed_by else None,
            version=1,
        )
    )
    await db_session.commit()
    return thread_id


def _utc(year: int, month: int, day: int, hour: int = 0, minute: int = 0) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=UTC)


# ---------------------------------------------------------------------------
# 1. "Mine"
# ---------------------------------------------------------------------------

# The window every list read of this band names.
MARCH = {
    "created_from": _utc(2020, 3, 1).isoformat(),
    "created_to": _utc(2020, 3, 2).isoformat(),
}


def _march(minute: int) -> datetime:
    return _utc(2020, 3, 1, 10, minute)


class TestClaimedByMe:
    async def test_the_flag_keeps_only_the_callers_tickets(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        me = await _person(client, db_session, 1, admin=True)
        other = await _person(client, db_session, 2, admin=True)
        user = await _person(client, db_session, 3)
        uid = user["user"]["id"]
        mine_id, other_id = me["user"]["id"], other["user"]["id"]
        mine_open = await _ticket(db_session, uid, _march(10), claimed_by=mine_id)
        mine_done = await _ticket(
            db_session, uid, _march(20), claimed_by=mine_id, status="resolved"
        )
        theirs = await _ticket(db_session, uid, _march(30), claimed_by=other_id)
        nobodys = await _ticket(db_session, uid, _march(40))

        async def ids(who: dict, **params) -> list[str]:
            resp = await client.get(
                TICKETS_URL,
                params={**MARCH, **params},
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

    async def test_the_flag_pages_by_the_lists_own_cursor(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """One row a page: the cursor walks the admin's own tickets and only
        them, none lost between pages, none of another admin's in them."""
        me = await _person(client, db_session, 4, admin=True)
        other = await _person(client, db_session, 5, admin=True)
        user = await _person(client, db_session, 6)
        uid = user["user"]["id"]
        mine = [
            await _ticket(db_session, uid, _march(m), claimed_by=me["user"]["id"])
            for m in (10, 30, 50)
        ]
        await _ticket(db_session, uid, _march(20), claimed_by=other["user"]["id"])
        await _ticket(db_session, uid, _march(40))
        headers = auth_headers(me["session_token"])

        seen: list[str] = []
        cursor = None
        for _ in range(10):  # a bound, not an expectation: three pages end it
            params = {
                **MARCH,
                "claimed_by_me": "true",
                "limit": 1,
                **({"cursor": cursor} if cursor else {}),
            }
            resp = await client.get(TICKETS_URL, params=params, headers=headers)
            body = resp.json()
            assert len(body["tickets"]) == 1
            seen += [t["id"] for t in body["tickets"]]
            cursor = body["next_cursor"]
            if cursor is None:
                break

        assert seen == [str(t) for t in reversed(mine)]


# ---------------------------------------------------------------------------
# 2. By day
# ---------------------------------------------------------------------------


def _nov(day: int, hour: int, minute: int = 0) -> datetime:
    return _utc(2020, 11, day, hour, minute)


class TestStatsByDay:
    async def test_the_days_are_the_admins_zone_and_add_up_to_the_total(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """Tokyo is UTC+9: its 11 November starts at 10 November 15:00 UTC.
        The period is four of those days; the 12th has no ticket and still
        has its line; the period's own edges (inclusive start, exclusive
        end) and a spam ticket stay out of the counts."""
        admin = await _person(
            client, db_session, 7, admin=True, timezone="Asia/Tokyo"
        )
        user = await _person(client, db_session, 8)
        uid = user["user"]["id"]
        for created_at, status in (
            (_nov(10, 14, 59), "open"),  # a minute before the period
            (_nov(10, 15, 0), "open"),  # 11th 00:00 -- the first instant of day one
            (_nov(11, 14, 59), "resolved"),  # 11th 23:59
            (_nov(12, 16, 0), "open"),  # 13th 01:00
            (_nov(13, 14, 59), "open"),  # 13th 23:59
            (_nov(13, 15, 0), "rejected"),  # 14th 00:00
            (_nov(13, 20, 0), "spam"),  # 14th, but spam: not counted
            (_nov(14, 15, 0), "open"),  # 15th 00:00 -- created_to is exclusive
        ):
            await _ticket(db_session, uid, created_at, status=status)

        resp = await client.get(
            STATS_URL,
            params={
                "created_from": _nov(10, 15).isoformat(),
                "created_to": _nov(14, 15).isoformat(),
            },
            headers=auth_headers(admin["session_token"]),
        )

        assert resp.status_code == 200, resp.text
        stats = resp.json()
        assert stats["period"]["timezone"] == "Asia/Tokyo"
        assert stats["by_day"] == [
            {"date": "2020-11-11", "tickets": 2},
            {"date": "2020-11-12", "tickets": 0},
            {"date": "2020-11-13", "tickets": 2},
            {"date": "2020-11-14", "tickets": 1},
        ]
        assert stats["total"] == sum(d["tickets"] for d in stats["by_day"]) == 5
        assert stats["spam"] == 1

    @pytest.mark.parametrize(
        "days,status",
        [(366, 200), (367, 400)],
    )
    async def test_a_period_longer_than_366_days_is_refused(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        days: int,
        status: int,
    ) -> None:
        """The edge of the cap: 366 days are answered -- every one of them
        listed, the ends with their tickets -- 367 are a 400."""
        admin = await _person(client, db_session, 9, admin=True)
        user = await _person(client, db_session, 10)
        uid = user["user"]["id"]
        start = _utc(2020, 1, 1)
        await _ticket(db_session, uid, start)
        await _ticket(db_session, uid, _utc(2020, 12, 31, 23, 59))

        resp = await client.get(
            STATS_URL,
            params={
                "created_from": start.isoformat(),
                "created_to": (start + timedelta(days=days)).isoformat(),
            },
            headers=auth_headers(admin["session_token"]),
        )

        assert resp.status_code == status, resp.text
        if status == 200:
            by_day = resp.json()["by_day"]
            assert len(by_day) == 366
            assert by_day[0] == {"date": "2020-01-01", "tickets": 1}
            assert by_day[-1] == {"date": "2020-12-31", "tickets": 1}
            assert sum(d["tickets"] for d in by_day) == resp.json()["total"] == 2

    @pytest.mark.parametrize(
        "stored,counted_in,dates",
        [
            # +05:45: 1 November 00:00 UTC is 05:45 on the 1st, and the last
            # instant before 3 November 00:00 UTC is 05:44 on the 3rd.
            (
                "Asia/Katmandu",  # an old browser spelling
                "Asia/Kathmandu",
                ["2020-11-01", "2020-11-02", "2020-11-03"],
            ),
            # Not a zone: UTC, not a 500 -- and two days, not three.
            ("Not/AZone", "UTC", ["2020-11-01", "2020-11-02"]),
        ],
    )
    async def test_a_stored_zone_name_is_made_one_postgres_knows(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        stored: str,
        counted_in: str,
        dates: list[str],
    ) -> None:
        admin = await _person(client, db_session, 11, admin=True, timezone=stored)

        resp = await client.get(
            STATS_URL,
            params={
                "created_from": _utc(2020, 11, 1).isoformat(),
                "created_to": _utc(2020, 11, 3).isoformat(),
            },
            headers=auth_headers(admin["session_token"]),
        )

        assert resp.status_code == 200, resp.text
        assert resp.json()["period"]["timezone"] == counted_in
        assert [d["date"] for d in resp.json()["by_day"]] == dates
