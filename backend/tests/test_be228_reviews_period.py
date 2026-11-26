# =============================================================================
# VELO Backend -- Tests: period on GET /masters/me/reviews (BE-228)
# =============================================================================
#
# telegram_id band: 71400-71449.
#
# BAND PROVENANCE. 71400-72769 is one free window of free_windows() over the
# allowed space (tests/telegram_id_bands.py), covered by no file's cleanup
# sweep; test_be185_can_add_to_group.py takes 71450-71499 next to this band.
#   71400-71402  -- masters under test
#   71410-71449  -- reviewers, handed out by a counter that starts over for
#                   every test (the busiest one needs 21)
#
# WHAT IS UNDER TEST. The "Требуют внимания" block of the master's analytics
# screen reads this feed. It used to cut the newest 20 reviews on the phone by
# a sliding 7/30/90-day window, while the numbers above it came from
# GET /masters/me/analytics, which counts a master's CALENDAR week / month /
# quarter. `period` makes the feed read the same window:
#
#   - the bounds are the master's own calendar (calendar_period_bounds_in_tz
#     on User.timezone), local midnights returned in UTC;
#   - the practices are the ones analytics counts (COMPLETED, scheduled_at in
#     [start, end)), so a review belongs to the period of its PRACTICE, not of
#     the day it was written;
#   - without `period` nothing changes.
#
# Every "left out" assertion sits beside a "kept" one on the same data, so a
# query that returns nothing for the wrong reason cannot pass.
#
# THE BOUNDS ARE BUILT FROM THE SAME FUNCTION THE ENDPOINT CALLS. That is the
# bet of test_master_analytics.py too: the function has its own tests there,
# and what this file proves is that the feed ASKS it with the master's zone
# and reads the window half-open. Europe/Moscow is the zone because it is the
# zone where UTC and local calendars disagree for three hours every period
# edge: an hour after the master's midnight is still the previous period
# under UTC bounds.
# =============================================================================

import itertools
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.periods import calendar_period_bounds_in_tz
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.diary.models import Feedback
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice, PracticeStatus, PracticeType
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user

REVIEWS_URL = "/api/v1/masters/me/reviews"
ANALYTICS_URL = "/api/v1/masters/me/analytics"

_TID_MIN = 71400
_TID_MAX = 71449

_MASTER_TID = 71400
_OTHER_MASTER_TID = 71401
_REVIEWER_TID_MIN = 71410

_MOSCOW = "Europe/Moscow"

_reviewer_counter = itertools.count(_REVIEWER_TID_MIN)
_practice_counter = itertools.count()


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """Clean all test data for this band before/after each test (ORM only).

    Also hands the reviewers' ids out from the start again: a counter that ran
    for the whole module would leave the band after a few tests.
    """
    global _reviewer_counter
    _reviewer_counter = itertools.count(_REVIEWER_TID_MIN)
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


# ===================================================================
# Helpers
# ===================================================================


async def _master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int = _MASTER_TID,
    timezone: str = "UTC",
) -> dict:
    """A verified master whose calendar is `timezone`."""
    auth = await login_user(client, telegram_id=telegram_id, first_name="Master")
    user = await db_session.get(User, UUID(auth["user"]["id"]))
    user.role = UserRole.MASTER.value
    user.timezone = timezone
    db_session.add(
        MasterProfile(
            user_id=user.id,
            data={"account": {"status": "verified"}, "profile": {"bio": "m"}},
        )
    )
    await db_session.commit()
    return auth


async def _reviewed_practice(
    client: AsyncClient,
    db_session: AsyncSession,
    master: dict,
    *,
    title: str,
    scheduled_at: datetime,
    rating: int = 3,
    status: str = PracticeStatus.COMPLETED.value,
) -> None:
    """One practice at `scheduled_at` with one named review of `rating`.

    The practice is titled, and the review's practice_title is how a test
    reads which practices the feed returned. The reviewer is new every time:
    a review is unique per booking.
    """
    practice = Practice(
        master_id=UUID(master["user"]["id"]),
        title=f"{title} #{next(_practice_counter)}",
        description="x",
        practice_type=PracticeType.LIVE.value,
        status=status,
        scheduled_at=scheduled_at,
        duration_minutes=60,
        timezone="UTC",
        max_participants=20,
        current_participants=0,
        is_free=True,
        price_cents=0,
        currency="eur",
    )
    db_session.add(practice)
    await db_session.flush()
    reviewer = await login_user(
        client, telegram_id=next(_reviewer_counter), first_name="Reviewer",
    )
    booking = Booking(
        practice_id=practice.id,
        user_id=UUID(reviewer["user"]["id"]),
        status=BookingStatus.ATTENDED.value,
    )
    db_session.add(booking)
    await db_session.flush()
    db_session.add(
        Feedback(
            practice_id=practice.id,
            user_id=booking.user_id,
            booking_id=booking.id,
            rating=rating,
        )
    )
    await db_session.commit()


async def _feed(
    client: AsyncClient, master: dict, **params: str | int,
) -> dict:
    """GET the feed and assert the call itself succeeded."""
    response = await client.get(
        REVIEWS_URL, params=params, headers=auth_headers(master["session_token"]),
    )
    assert response.status_code == 200, response.text
    return response.json()


def _titles(feed: dict) -> set[str]:
    """The practices the feed's reviews are about, without the counter."""
    return {item["practice_title"].rsplit(" #", 1)[0] for item in feed["items"]}


def _bounds(period: str, tz: str) -> tuple[datetime, datetime]:
    cur_start, cur_end, _prev_start = calendar_period_bounds_in_tz(
        period, datetime.now(UTC), tz,
    )
    return cur_start, cur_end


# ===================================================================
# Without `period` the feed is what it was
# ===================================================================


async def test_without_period_the_feed_spans_every_period(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    master = await _master(client, db_session)
    now = datetime.now(UTC)
    for title, age in (("today", 0), ("last month", 40), ("last year", 400)):
        await _reviewed_practice(
            client, db_session, master,
            title=title, scheduled_at=now - timedelta(days=age),
        )

    everything = await _feed(client, master)
    this_week = await _feed(client, master, period="week")

    assert everything["total"] == 3
    assert _titles(everything) == {"today", "last month", "last year"}
    assert _titles(this_week) == {"today"}


# ===================================================================
# The window: the master's calendar, half-open
# ===================================================================


@pytest.mark.parametrize("period", ["week", "month", "quarter"])
async def test_period_keeps_the_masters_calendar_period_and_nothing_else(
    client: AsyncClient, db_session: AsyncSession, period: str,
) -> None:
    """Each edge of the period, an hour to either side, in Moscow's calendar.

    Moscow midnight is 21:00 UTC the evening before, so the practice an hour
    after the master's start is in the period for him and in the PREVIOUS one
    under UTC bounds -- the case a UTC-bounded feed gets wrong. The same
    practices are then counted by /me/analytics, which is the point of the
    parameter: the block and the numbers above it speak of the same window.
    The start is inclusive, the end exclusive.
    """
    master = await _master(client, db_session, timezone=_MOSCOW)
    start, end = _bounds(period, _MOSCOW)
    hour = timedelta(hours=1)
    for title, at in (
        ("before start", start - hour),
        ("at start", start),
        ("after start", start + hour),
        ("before end", end - hour),
        ("at end", end),
        ("after end", end + hour),
    ):
        await _reviewed_practice(
            client, db_session, master, title=title, scheduled_at=at,
        )

    feed = await _feed(client, master, period=period)
    analytics = await client.get(
        ANALYTICS_URL,
        params={"period": period},
        headers=auth_headers(master["session_token"]),
    )

    assert _titles(feed) == {"at start", "after start", "before end"}
    assert feed["total"] == 3
    assert analytics.json()["feedbacks_count"] == feed["total"]


async def test_period_reads_the_master_zone_not_utc(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """One instant, two masters: his own midnight decides which week it is.

    The instant is picked INSIDE the Moscow week and OUTSIDE the UTC one --
    the three-hour slab where the two calendars disagree, an hour after
    Moscow's Monday midnight (Sunday 22:00 UTC) or, in the three hours each
    week when Moscow has rolled over and UTC has not, an hour before the end of
    the Moscow week. The master in Moscow gets the review, the master in UTC
    does not, for the very same instant.
    """
    moscow = await _master(client, db_session, timezone=_MOSCOW)
    utc = await _master(client, db_session, _OTHER_MASTER_TID, timezone="UTC")
    m_start, m_end = _bounds("week", _MOSCOW)
    u_start, u_end = _bounds("week", "UTC")
    hour = timedelta(hours=1)
    instant = next(
        at
        for at in (m_start + hour, m_end - hour)
        if m_start <= at < m_end and not u_start <= at < u_end
    )
    for master in (moscow, utc):
        await _reviewed_practice(
            client, db_session, master, title="Sunday night", scheduled_at=instant,
        )

    assert _titles(await _feed(client, moscow, period="week")) == {"Sunday night"}
    assert _titles(await _feed(client, utc, period="week")) == set()


# ===================================================================
# Which reviews: the period's practices, this master's, attention narrowing
# ===================================================================


async def test_a_review_belongs_to_the_period_of_its_practice(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The review is written NOW; its practice ran before the period began.

    Every review in this file is created today, so every "outside" practice
    above is already this case. This one names it, with its pair: a practice
    inside the period, reviewed at the same moment, stays.
    """
    master = await _master(client, db_session)
    start, _end = _bounds("week", "UTC")
    await _reviewed_practice(
        client, db_session, master,
        title="ran last week", scheduled_at=start - timedelta(days=1),
    )
    await _reviewed_practice(
        client, db_session, master, title="ran this week", scheduled_at=start,
    )

    feed = await _feed(client, master, period="week")

    assert _titles(feed) == {"ran this week"}


async def test_period_never_shows_another_masters_reviews(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    master = await _master(client, db_session)
    other = await _master(client, db_session, _OTHER_MASTER_TID)
    start, _end = _bounds("week", "UTC")
    await _reviewed_practice(
        client, db_session, master, title="mine", scheduled_at=start,
    )
    await _reviewed_practice(
        client, db_session, other, title="theirs", scheduled_at=start,
    )

    feed = await _feed(client, master, period="week")

    assert _titles(feed) == {"mine"}
    assert feed["total"] == 1


async def test_period_and_attention_narrow_together(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The "Требуют внимания" request: ratings 1-4 of the period's practices.

    Four reviews, one per cell of the 2x2 -- low or high rating, inside or
    outside the period -- so each filter is proven by a review only IT drops.
    """
    master = await _master(client, db_session)
    start, _end = _bounds("week", "UTC")
    before = start - timedelta(days=1)
    for title, at, rating in (
        ("low, inside", start, 2),
        ("high, inside", start, 9),
        ("low, outside", before, 2),
        ("high, outside", before, 9),
    ):
        await _reviewed_practice(
            client, db_session, master, title=title, scheduled_at=at, rating=rating,
        )

    feed = await _feed(client, master, period="week", attention="true")

    assert _titles(feed) == {"low, inside"}
    assert feed["total"] == 1


# ===================================================================
# Paging is the feed's own, not the screen's old 20
# ===================================================================


async def test_the_period_is_not_cut_at_twenty_and_still_pages(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """21 reviews: one more than the page the screen used to take.

    With the page the screen will ask for (the endpoint's 100) all 21 come
    back and `total` agrees; with a small page, offset and limit still walk
    the same period and `total` stays the whole count.
    """
    master = await _master(client, db_session)
    start, _end = _bounds("week", "UTC")
    for number in range(21):
        await _reviewed_practice(
            client, db_session, master,
            title=f"practice {number:02d}",
            scheduled_at=start + timedelta(minutes=number),
        )

    whole = await _feed(client, master, period="week", limit=100)
    page = await _feed(client, master, period="week", limit=5, offset=20)

    assert len(whole["items"]) == whole["total"] == 21
    assert len(page["items"]) == 1
    assert page["total"] == 21


# ===================================================================
# The parameter itself
# ===================================================================


async def test_an_unknown_period_is_refused_and_a_known_one_is_not(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    master = await _master(client, db_session)
    headers = auth_headers(master["session_token"])

    refused = await client.get(REVIEWS_URL, params={"period": "year"}, headers=headers)
    accepted = await client.get(
        REVIEWS_URL, params={"period": "quarter"}, headers=headers,
    )

    assert refused.status_code == 422
    assert accepted.status_code == 200
