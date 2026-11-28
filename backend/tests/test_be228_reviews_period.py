# =============================================================================
# VELO Backend -- Tests: period on GET /masters/me/reviews (BE-228)
# =============================================================================
#
# telegram_id band: 71400-71449.
#
# BAND PROVENANCE. 71400-72769 is one free window of free_windows() over the
# allowed space (tests/telegram_id_bands.py), covered by no file's cleanup
# sweep; test_be185_can_add_to_group.py takes 71450-71499 next to this band.
#   71400-71401  -- masters under test
#   71410-71449  -- reviewers, handed out from 71410 afresh for every test
#                   (the busiest one needs 21)
#
# WHAT IS UNDER TEST. The "Требуют внимания" block of the master's analytics
# screen reads this feed. It used to cut the newest 20 reviews on the phone by
# a sliding 7/30/90-day window, while the numbers above it came from
# GET /masters/me/analytics, which counts a master's CALENDAR week / month /
# quarter. `period` makes the feed read the same window:
#
#   - the bounds are the master's own calendar (calendar_period_bounds_in_tz
#     on User.timezone), local midnights returned in UTC;
#   - the practices are the ones analytics counts (stats_service.
#     completed_in_window), so a review belongs to the period of its
#     PRACTICE, not of the day it was written;
#   - without `period` nothing changes, except that the feed now has a total
#     order (created_at, then id) and the default page depends on `period`.
#
# Every "left out" assertion sits beside a "kept" one on the same data, so a
# query that returns nothing for the wrong reason cannot pass.
#
# THE CLOCK IS FROZEN (the `now` fixture). The endpoint and /me/analytics read
# the time inside the request; a test that read it too, a moment earlier or
# later, would disagree with them for the whole minute around a local midnight
# and for the hour around a DST change. One instant, handed to the test and to
# both services, removes that.
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
from collections.abc import AsyncGenerator, Awaitable, Callable
from datetime import UTC, datetime, timedelta, tzinfo
from typing import NamedTuple
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.periods import calendar_period_bounds_in_tz
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.diary.models import Feedback
from app.modules.masters import reviews_service, stats_service
from app.modules.practices.models import Practice, PracticeStatus, PracticeType
from tests.helpers import auth_headers, full_cleanup_range, login_user
from tests.test_master_analytics import _make_verified_master

REVIEWS_URL = "/api/v1/masters/me/reviews"
ANALYTICS_URL = "/api/v1/masters/me/analytics"

_TID_MIN = 71400
_TID_MAX = 71449

_MASTER_TID = 71400
_OTHER_MASTER_TID = 71401
_REVIEWER_TID_MIN = 71410

_MOSCOW = "Europe/Moscow"


class Reviewed(NamedTuple):
    """What a made review leaves a test to compare against."""

    reviewer_id: str
    feedback_id: UUID


Review = Callable[..., Awaitable[Reviewed]]


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """Clean all test data for this band before/after each test (ORM only)."""
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


@pytest.fixture(autouse=True)
def now(monkeypatch: pytest.MonkeyPatch) -> datetime:
    """One instant for the test and for both services that read the clock."""
    frozen = datetime.now(UTC)

    class _Frozen(datetime):
        @classmethod
        def now(cls, tz: tzinfo | None = None) -> datetime:
            return frozen if tz is None else frozen.astimezone(tz)

    monkeypatch.setattr(reviews_service, "datetime", _Frozen)
    monkeypatch.setattr(stats_service, "datetime", _Frozen)
    return frozen


@pytest.fixture
def review(client: AsyncClient, db_session: AsyncSession) -> Review:
    """Make one practice with one named review; every test gets its own ids.

    The reviewer is new every time (a review is unique per booking) and takes
    the next telegram_id of the band; the counter lives and dies with the
    test. `created_at` pins the review's own timestamp for the test that needs
    reviews written at one instant.
    """
    reviewer_ids = itertools.count(_REVIEWER_TID_MIN)

    async def make(
        master: dict,
        *,
        title: str,
        scheduled_at: datetime,
        rating: int = 3,
        created_at: datetime | None = None,
    ) -> Reviewed:
        practice = Practice(
            master_id=UUID(master["user"]["id"]),
            title=title,
            description="x",
            practice_type=PracticeType.LIVE.value,
            status=PracticeStatus.COMPLETED.value,
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
            client, telegram_id=next(reviewer_ids), first_name="Reviewer",
        )
        booking = Booking(
            practice_id=practice.id,
            user_id=UUID(reviewer["user"]["id"]),
            status=BookingStatus.ATTENDED.value,
        )
        db_session.add(booking)
        await db_session.flush()
        feedback = Feedback(
            practice_id=practice.id,
            user_id=booking.user_id,
            booking_id=booking.id,
            rating=rating,
        )
        if created_at is not None:
            feedback.created_at = created_at
        db_session.add(feedback)
        await db_session.flush()
        made = Reviewed(reviewer["user"]["id"], feedback.id)
        await db_session.commit()
        return made

    return make


# ===================================================================
# Helpers
# ===================================================================


async def _master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int = _MASTER_TID,
    timezone: str = "UTC",
) -> dict:
    """A verified master whose calendar is `timezone` (this file's band)."""
    return await _make_verified_master(client, db_session, telegram_id, timezone)


async def _feed(
    client: AsyncClient, master: dict, **params: str | int,
) -> dict:
    """GET the feed and assert the call itself succeeded."""
    response = await client.get(
        REVIEWS_URL, params=params, headers=auth_headers(master["session_token"]),
    )
    assert response.status_code == 200, response.text
    return response.json()


async def _analytics_feedbacks(
    client: AsyncClient, master: dict, period: str,
) -> int:
    """`feedbacks_count` of /me/analytics -- the number the feed must match."""
    response = await client.get(
        ANALYTICS_URL,
        params={"period": period},
        headers=auth_headers(master["session_token"]),
    )
    assert response.status_code == 200, response.text
    return response.json()["feedbacks_count"]


def _titles(feed: dict) -> set[str]:
    """The practices the feed's reviews are about."""
    return {item["practice_title"] for item in feed["items"]}


def _bounds(period: str, tz: str, now: datetime) -> tuple[datetime, datetime]:
    cur_start, cur_end, _prev_start = calendar_period_bounds_in_tz(period, now, tz)
    return cur_start, cur_end


# ===================================================================
# Without `period` the feed is what it was
# ===================================================================


async def test_without_period_the_feed_spans_every_period(
    client: AsyncClient, db_session: AsyncSession, review: Review, now: datetime,
) -> None:
    master = await _master(client, db_session)
    for title, age in (("today", 0), ("last month", 40), ("last year", 400)):
        await review(master, title=title, scheduled_at=now - timedelta(days=age))

    everything = await _feed(client, master)
    this_week = await _feed(client, master, period="week")

    assert everything["total"] == 3
    assert _titles(everything) == {"today", "last month", "last year"}
    assert _titles(this_week) == {"today"}


async def test_reviews_written_at_one_instant_page_in_one_order(
    client: AsyncClient, db_session: AsyncSession, review: Review, now: datetime,
) -> None:
    """Seven reviews with the same created_at, read three at a time.

    A shared timestamp is what one transaction writes. Without a second sort
    key the order of the tie is the database's to choose, and a page boundary
    may repeat one review and skip another. With it the pages are one list:
    newest id first, no review twice, none missing.
    """
    master = await _master(client, db_session)
    made = [
        await review(
            master,
            title=f"practice {number}",
            scheduled_at=now - timedelta(days=1),
            created_at=now - timedelta(hours=1),
        )
        for number in range(7)
    ]

    pages = [await _feed(client, master, limit=3, offset=at) for at in (0, 3, 6)]

    read = [item["user_id"] for page in pages for item in page["items"]]
    newest_id_first = sorted(made, key=lambda each: each.feedback_id, reverse=True)
    assert read == [each.reviewer_id for each in newest_id_first]


# ===================================================================
# The window: the master's calendar, half-open
# ===================================================================


@pytest.mark.parametrize("period", ["week", "month", "quarter"])
async def test_period_keeps_the_masters_calendar_period_and_nothing_else(
    client: AsyncClient,
    db_session: AsyncSession,
    review: Review,
    now: datetime,
    period: str,
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
    start, end = _bounds(period, _MOSCOW, now)
    hour = timedelta(hours=1)
    for title, at in (
        ("before start", start - hour),
        ("at start", start),
        ("after start", start + hour),
        ("before end", end - hour),
        ("at end", end),
        ("after end", end + hour),
    ):
        await review(master, title=title, scheduled_at=at)

    feed = await _feed(client, master, period=period)

    assert _titles(feed) == {"at start", "after start", "before end"}
    assert feed["total"] == 3
    assert await _analytics_feedbacks(client, master, period) == feed["total"]


async def test_period_reads_the_master_zone_not_utc(
    client: AsyncClient, db_session: AsyncSession, review: Review, now: datetime,
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
    m_start, m_end = _bounds("week", _MOSCOW, now)
    u_start, u_end = _bounds("week", "UTC", now)
    hour = timedelta(hours=1)
    instant = next(
        at
        for at in (m_start + hour, m_end - hour)
        if m_start <= at < m_end and not u_start <= at < u_end
    )
    for master in (moscow, utc):
        await review(master, title="Sunday night", scheduled_at=instant)

    assert _titles(await _feed(client, moscow, period="week")) == {"Sunday night"}
    assert _titles(await _feed(client, utc, period="week")) == set()


# ===================================================================
# Which reviews: the period's practices, this master's, attention narrowing
# ===================================================================


async def test_a_review_belongs_to_the_period_of_its_practice(
    client: AsyncClient, db_session: AsyncSession, review: Review, now: datetime,
) -> None:
    """The review is written NOW; its practice ran before the period began.

    Every review in this file is created today, so every "outside" practice
    above is already this case. This one names it, with its pair: a practice
    inside the period, reviewed at the same moment, stays.
    """
    master = await _master(client, db_session)
    start, _end = _bounds("week", "UTC", now)
    await review(
        master, title="ran last week", scheduled_at=start - timedelta(days=1),
    )
    await review(master, title="ran this week", scheduled_at=start)

    feed = await _feed(client, master, period="week")

    assert _titles(feed) == {"ran this week"}


async def test_period_never_shows_another_masters_reviews(
    client: AsyncClient, db_session: AsyncSession, review: Review, now: datetime,
) -> None:
    master = await _master(client, db_session)
    other = await _master(client, db_session, _OTHER_MASTER_TID)
    start, _end = _bounds("week", "UTC", now)
    await review(master, title="mine", scheduled_at=start)
    await review(other, title="theirs", scheduled_at=start)

    feed = await _feed(client, master, period="week")

    assert _titles(feed) == {"mine"}
    assert feed["total"] == 1


async def test_period_and_attention_narrow_together(
    client: AsyncClient, db_session: AsyncSession, review: Review, now: datetime,
) -> None:
    """The "Требуют внимания" request: ratings 1-4 of the period's practices.

    Four reviews, one per cell of the 2x2 -- low or high rating, inside or
    outside the period -- so each filter is proven by a review only IT drops.
    """
    master = await _master(client, db_session)
    start, _end = _bounds("week", "UTC", now)
    before = start - timedelta(days=1)
    for title, at, rating in (
        ("low, inside", start, 2),
        ("high, inside", start, 9),
        ("low, outside", before, 2),
        ("high, outside", before, 9),
    ):
        await review(master, title=title, scheduled_at=at, rating=rating)

    feed = await _feed(client, master, period="week", attention="true")

    assert _titles(feed) == {"low, inside"}
    assert feed["total"] == 1


# ===================================================================
# Paging: the default depends on `period`, an explicit limit wins
# ===================================================================


async def test_period_widens_the_default_page_and_an_explicit_limit_still_wins(
    client: AsyncClient, db_session: AsyncSession, review: Review, now: datetime,
) -> None:
    """21 reviews: one more than the page the whole feed used to take.

    The whole feed keeps its page of 20. A period, which the screen reads as
    one block, defaults to the largest page (100) and brings all 21. A limit
    named by the caller is honoured either way, and `total` is the whole count
    in all four reads.
    """
    master = await _master(client, db_session)
    start, _end = _bounds("week", "UTC", now)
    for number in range(21):
        await review(
            master,
            title=f"practice {number:02d}",
            scheduled_at=start + timedelta(minutes=number),
        )

    whole = await _feed(client, master)
    period = await _feed(client, master, period="week")
    small = await _feed(client, master, period="week", limit=5, offset=20)
    capped = await _feed(client, master, limit=100)

    assert (whole["limit"], len(whole["items"]), whole["total"]) == (20, 20, 21)
    assert (period["limit"], len(period["items"]), period["total"]) == (100, 21, 21)
    assert (small["limit"], len(small["items"]), small["total"]) == (5, 1, 21)
    assert (capped["limit"], len(capped["items"]), capped["total"]) == (100, 21, 21)


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
