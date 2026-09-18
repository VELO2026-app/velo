# =============================================================================
# VELO Backend -- Tests: Master Analytics Summary (BE-34)
# =============================================================================
#
# telegram_id ranges:
#   69101        -- the master under test
#   69102        -- a second master (isolation check)
#   69103        -- a plain user (auth check)
#   69110-69199  -- participants, handed out by a module-level counter.
#                   The upper edge is the BAND's, not a tighter promise: the
#                   counter runs for the whole session, so a range narrower
#                   than the band would be a number this file stops honouring
#                   the moment a test is added.
#
# The band 69100-69199 was checked against the registry before it was claimed
# (tests/telegram_id_bands.py): no declared band overlaps it and no other
# file's cleanup sweep covers it. Moving into a range without that check is
# the mistake that module exists to prevent.
#
# WHAT THIS FILE PINS, and why it is not covered by test_master_stats_semantics
# .py next door. That file pins the DASHBOARD grid, whose bounds are UTC. This
# one pins the analytics summary, which differs in three ways that each had a
# defect behind them:
#
#   - BOUNDS ARE THE MASTER'S CALENDAR. The screen used to call "week" the
#     last 7x24 hours, so a Monday morning practice left the week on Monday
#     morning.
#   - THE RATE DENOMINATOR IS NON-CANCELLED BOOKINGS, not attended ones.
#     Scoping it to ATTENDED zeroes the rate between a practice ending and the
#     attendance decision landing, because a check-in sits on a CONFIRMED
#     booking. That is the D4 bug, already fixed twice in the admin dashboards
#     and carried by the master's screen until this delivery.
#   - THE WHOLE PERIOD IS COUNTED, not the 20 most recent practices.
#
# Every test asserts a CONCRETE number, and "not counted" is always paired
# with a "counted" assertion on the same data, so a query returning zero for
# the wrong reason cannot pass as correct behaviour.
#
# WHAT IS DELIBERATELY NOT TESTED:
#   - a feedback whose booking is cancelled. Feedback is refused before the
#     practice completes and cancelling is refused after it, so the pair
#     cannot exist. Building it by hand would document an impossible state.
#   - an empty or NULL User.timezone. The column is NOT NULL with a server
#     default and the API validates it against the IANA database, so only a
#     row written outside the ORM could carry one.
# =============================================================================

import itertools
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.periods import (
    calendar_period_bounds,
    calendar_period_bounds_in_tz,
)
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.diary.models import Checkin, CheckType, Feedback
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice, PracticeStatus, PracticeType
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user

ANALYTICS_URL = "/api/v1/masters/me/analytics"

_TID_MIN = 69100
_TID_MAX = 69199


# ===================================================================
# Cleanup
# ===================================================================


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """Clean all test data for this band before/after each test (ORM only)."""
    await _do_cleanup(db_session)
    yield
    await _do_cleanup(db_session)


async def _do_cleanup(session: AsyncSession) -> None:
    """Full ORM cleanup for telegram_id 69100-69199, users included.

    delete_users=True: this file creates its own masters and participants
    inside its own band and shares no fixture users with any other file.
    """
    await full_cleanup_range(
        session, _TID_MIN, _TID_MAX, delete_users=True,
    )
    await session.commit()


# ===================================================================
# Helpers
# ===================================================================


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int = 69101,
    timezone: str = "UTC",
) -> dict:
    """Create a verified master, with a chosen profile timezone.

    `timezone` is a parameter rather than a constant because the period bounds
    are built from it: a test that cannot move the master's zone cannot tell a
    UTC calendar from his own.
    """
    data = await login_user(
        client, telegram_id=telegram_id, first_name="Master",
    )
    user_id = data["user"]["id"]

    user = (
        await db_session.execute(select(User).where(User.id == user_id))
    ).scalar_one()
    user.role = UserRole.MASTER.value
    user.timezone = timezone
    await db_session.flush()

    db_session.add(
        MasterProfile(
            user_id=UUID(user_id),
            data={"account": {"status": "verified"}},
        ),
    )
    await db_session.commit()
    return data


_practice_counter = itertools.count()


async def _create_practice(
    db_session: AsyncSession,
    master_id: str,
    *,
    scheduled_at: datetime,
    status: str = PracticeStatus.COMPLETED.value,
) -> Practice:
    """Create one practice for the master at the given schedule and status.

    Titles carry a counter suffix: uq_practice_master_title_scheduled
    _recurrence is a partial unique index on (master_id, title, scheduled_at,
    recurrence), and several tests below put two practices on the same slot.
    """
    practice = Practice(
        master_id=UUID(master_id),
        practice_type=PracticeType.LIVE.value,
        status=status,
        title=f"Analytics Practice {next(_practice_counter)}",
        scheduled_at=scheduled_at,
        duration_minutes=60,
        timezone="UTC",
    )
    db_session.add(practice)
    await db_session.flush()
    await db_session.commit()
    return practice


_participant_counter = itertools.count(69110)


async def _participant(client: AsyncClient) -> str:
    """Log a fresh participant in and return the user id."""
    data = await login_user(
        client, telegram_id=next(_participant_counter), first_name="P",
    )
    return data["user"]["id"]


async def _book(
    db_session: AsyncSession,
    practice_id: UUID,
    user_id: str,
    status: str = BookingStatus.ATTENDED.value,
) -> Booking:
    """Add one booking and RETURN it -- check-ins and feedbacks hang off it."""
    booking = Booking(
        practice_id=practice_id,
        user_id=UUID(user_id),
        status=status,
    )
    db_session.add(booking)
    await db_session.flush()
    await db_session.commit()
    return booking


async def _check_in(
    db_session: AsyncSession,
    booking: Booking,
    mood: int,
    check_type: str = CheckType.PRE.value,
) -> None:
    """Add one check-in on the booking at an exact mood score."""
    db_session.add(
        Checkin(
            practice_id=booking.practice_id,
            user_id=booking.user_id,
            booking_id=booking.id,
            mood=mood,
            check_type=check_type,
        ),
    )
    await db_session.commit()


async def _leave_feedback(
    db_session: AsyncSession,
    booking: Booking,
    rating: int,
) -> None:
    """Add one feedback on the booking at an exact rating score."""
    db_session.add(
        Feedback(
            practice_id=booking.practice_id,
            user_id=booking.user_id,
            booking_id=booking.id,
            rating=rating,
        ),
    )
    await db_session.commit()


async def _analytics(
    client: AsyncClient, master: dict, period: str = "week",
) -> dict:
    """GET the summary and assert the call itself succeeded."""
    response = await client.get(
        f"{ANALYTICS_URL}?period={period}",
        headers=auth_headers(master["session_token"]),
    )
    assert response.status_code == 200, response.text
    return response.json()


def _inside(period: str, tz: str = "UTC") -> datetime:
    """An instant safely inside the current period, in the master's calendar.

    The period start itself: inclusive by definition, and never in the future.
    Derived from the bounds rather than written as a date, so the test does
    not change meaning on the first of the month.
    """
    cur_start, _cur_end, _prev = calendar_period_bounds_in_tz(
        period, datetime.now(UTC), tz,
    )
    return cur_start


def _inside_previous(period: str, tz: str = "UTC") -> datetime:
    """An instant safely inside the PREVIOUS period."""
    _cur_start, _cur_end, prev_start = calendar_period_bounds_in_tz(
        period, datetime.now(UTC), tz,
    )
    return prev_start


# ===================================================================
# Period bounds in a timezone (BE-34's bet, tested on its own)
# ===================================================================


async def test_utc_bounds_are_unchanged_by_the_timezone_entry_point() -> None:
    """calendar_period_bounds still answers exactly what it used to.

    The delegation added by BE-34 made the UTC function a caller of the
    timezone one. This asserts the two agree for every period on a fixed
    instant; the suite's existing UTC bound tests, untouched by this delivery,
    are the wider half of the same proof.
    """
    now = datetime(2026, 9, 18, 13, 44, tzinfo=UTC)

    for period in ("week", "month", "quarter"):
        assert calendar_period_bounds(period, now) == (
            calendar_period_bounds_in_tz(period, now, "UTC")
        )


async def test_week_starts_at_local_midnight_not_utc_midnight() -> None:
    """Europe/Moscow: the week opens at 21:00 UTC Sunday.

    The whole point of BE-34 in one assertion. Moscow is UTC+3, so the
    master's Monday begins three hours before UTC's, and a practice held in
    those three hours belonged to the PREVIOUS week under the old bounds.
    """
    now = datetime(2026, 9, 18, 12, tzinfo=UTC)

    cur_start, cur_end, prev_start = calendar_period_bounds_in_tz(
        "week", now, "Europe/Moscow",
    )

    assert cur_start == datetime(2026, 9, 13, 21, tzinfo=UTC)
    assert cur_end == datetime(2026, 9, 20, 21, tzinfo=UTC)
    assert prev_start == datetime(2026, 9, 6, 21, tzinfo=UTC)


async def test_month_bounds_follow_the_master_zone_across_the_year_edge() -> None:
    """Pacific/Auckland in January: the month opens in the previous UTC year.

    Auckland is UTC+13 in January, so 1 January 00:00 local is 31 December
    11:00 UTC. A month built by replacing fields on a UTC instant cannot
    produce that, which is why the implementation converts once at the end.
    """
    now = datetime(2027, 1, 15, tzinfo=UTC)

    cur_start, cur_end, prev_start = calendar_period_bounds_in_tz(
        "month", now, "Pacific/Auckland",
    )

    assert cur_start == datetime(2026, 12, 31, 11, tzinfo=UTC)
    assert cur_end == datetime(2027, 1, 31, 11, tzinfo=UTC)
    assert prev_start == datetime(2026, 11, 30, 11, tzinfo=UTC)


async def test_dst_weeks_are_167_and_169_hours_and_stay_contiguous() -> None:
    """A DST week is 167 or 169 hours, and still joins its neighbours exactly.

    America/Santiago shifts at midnight, so the local day the clocks move is
    the hostile case: the week's own length changes. What must NOT change is
    that the previous window ends exactly where this one starts -- a gap would
    lose a practice and an overlap would count it twice.

    Both directions, because a week short by an hour and a week long by one
    fail differently, and the southern hemisphere runs them backwards from the
    European intuition: September springs FORWARD (167) and April falls BACK
    (169). The two instants are inside the transition weeks themselves --
    2026-09-06 and 2026-04-05 -- not merely near them.

    The first version of this test asserted 169 for the September week and was
    wrong twice over: the week it picked was the one AFTER the transition, and
    the direction was the northern one. Both numbers below are read off the
    zone database, not recalled.
    """
    spring = datetime(2026, 9, 2, 12, tzinfo=UTC)
    autumn = datetime(2026, 4, 2, 12, tzinfo=UTC)

    short_start, short_end, short_prev = calendar_period_bounds_in_tz(
        "week", spring, "America/Santiago",
    )
    assert short_end - short_start == timedelta(hours=167)
    assert short_start - short_prev == timedelta(hours=168)
    assert short_start <= spring < short_end

    long_start, long_end, long_prev = calendar_period_bounds_in_tz(
        "week", autumn, "America/Santiago",
    )
    assert long_end - long_start == timedelta(hours=169)
    assert long_start - long_prev == timedelta(hours=168)
    assert long_start <= autumn < long_end


# ===================================================================
# The summary itself
# ===================================================================


async def test_counts_every_practice_in_the_period_not_the_first_twenty(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """25 completed practices in the month are 25, which is the card's check.

    The number is not arbitrary: the screen this replaces loaded one page of
    twenty and summed what it got, so a master with twenty-five practices read
    twenty. Anything above twenty proves the page size is gone; twenty-five is
    the case the card names.
    """
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    inside = _inside("month")

    for _ in range(25):
        await _create_practice(db_session, master_id, scheduled_at=inside)

    body = await _analytics(client, master, period="month")
    assert body["practices_count"] == 25


async def test_rate_denominator_is_bookings_not_attendance(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A CONFIRMED booking counts in the denominator; ATTENDED is not required.

    This is the D4 bug, third occurrence. Between a practice ending and the
    attendance decision landing -- which a deferred Zoom practice can sit in
    for the whole deadline window -- every booking is still CONFIRMED while
    the check-in already exists. Scoping the denominator to ATTENDED reports
    a 0% check-in rate for a practice where everyone checked in.

    Two bookings, one CONFIRMED and one ATTENDED, one check-in each: the
    honest answer is 2 of 2, and the bug's answer is 1 of 1 -- which is why
    the count assertions sit next to the rate.
    """
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    practice = await _create_practice(
        db_session, master_id, scheduled_at=_inside("week"),
    )

    deferred = await _book(
        db_session, practice.id, await _participant(client),
        status=BookingStatus.CONFIRMED.value,
    )
    decided = await _book(
        db_session, practice.id, await _participant(client),
        status=BookingStatus.ATTENDED.value,
    )
    await _check_in(db_session, deferred, mood=9)
    await _check_in(db_session, decided, mood=5)

    body = await _analytics(client, master)
    assert body["bookings_count"] == 2
    assert body["checkins_count"] == 2
    assert body["checkin_rate_pct"] == 100


async def test_cancelled_bookings_leave_the_denominator(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A cancelled seat is not counted against the master.

    Paired assertion on one dataset: the two live bookings are counted and the
    cancelled one is not, so a denominator that returned 2 by losing the wrong
    row cannot pass.
    """
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    practice = await _create_practice(
        db_session, master_id, scheduled_at=_inside("week"),
    )

    await _book(db_session, practice.id, await _participant(client))
    await _book(
        db_session, practice.id, await _participant(client),
        status=BookingStatus.CONFIRMED.value,
    )
    await _book(
        db_session, practice.id, await _participant(client),
        status=BookingStatus.CANCELLED.value,
    )

    body = await _analytics(client, master)
    assert body["bookings_count"] == 2


async def test_pending_bookings_are_an_intention_not_a_booking(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """PENDING is the row's birth state, before the purchase settles.

    Same paired shape: one PENDING alongside one ATTENDED, and only the
    second is counted.
    """
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    practice = await _create_practice(
        db_session, master_id, scheduled_at=_inside("week"),
    )

    await _book(db_session, practice.id, await _participant(client))
    await _book(
        db_session, practice.id, await _participant(client),
        status=BookingStatus.PENDING.value,
    )

    body = await _analytics(client, master)
    assert body["bookings_count"] == 1


async def test_checkins_can_exceed_bookings_after_a_cancellation(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Check in, then cancel: the rate reads above 100%, and that is honest.

    Reachable, not hypothetical -- a check-in happens before the practice and
    a booking can be cancelled while it is still ahead, which leaves the
    check-in row behind. The owner's ruling keeps cancelled seats out of the
    denominator, so this is the ruling's visible consequence. Clamping it to
    100 would erase the only sign it happened.
    """
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    practice = await _create_practice(
        db_session, master_id, scheduled_at=_inside("week"),
    )

    stayed = await _book(db_session, practice.id, await _participant(client))
    left = await _book(db_session, practice.id, await _participant(client))
    await _check_in(db_session, stayed, mood=8)
    await _check_in(db_session, left, mood=4)
    left.status = BookingStatus.CANCELLED.value
    await db_session.commit()

    body = await _analytics(client, master)
    assert body["bookings_count"] == 1
    assert body["checkins_count"] == 2
    assert body["checkin_rate_pct"] == 200


async def test_post_checkins_are_not_counted(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Only PRE check-ins, the same half every other reader takes.

    A POST check-in is a SECOND row on the same booking, so counting it would
    put two in a numerator whose denominator counts that booking once. Nothing
    writes POST today; the assertion is what keeps the rate correct when
    something does.
    """
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    practice = await _create_practice(
        db_session, master_id, scheduled_at=_inside("week"),
    )

    booking = await _book(db_session, practice.id, await _participant(client))
    await _check_in(db_session, booking, mood=7)
    await _check_in(
        db_session, booking, mood=9, check_type=CheckType.POST.value,
    )

    body = await _analytics(client, master)
    assert body["checkins_count"] == 1
    assert body["checkins"]["mid"] == 1
    assert body["checkins"]["high"] == 0


async def test_distributions_use_the_shared_bucket_thresholds(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Scores land in low/mid/high and confused/good/fire by the 3 / 7 edges.

    The edge scores are chosen, not sampled: 3 and 4 straddle the first
    boundary and 7 and 8 the second, so an off-by-one in either direction
    moves a count. The thresholds themselves live in diary.insights_service --
    this asserts that this screen asks it rather than carrying a fourth copy.
    """
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    practice = await _create_practice(
        db_session, master_id, scheduled_at=_inside("week"),
    )

    for mood, rating in ((3, 3), (4, 4), (7, 7), (8, 8)):
        booking = await _book(
            db_session, practice.id, await _participant(client),
        )
        await _check_in(db_session, booking, mood=mood)
        await _leave_feedback(db_session, booking, rating=rating)

    body = await _analytics(client, master)
    assert body["checkins"] == {"low": 1, "mid": 2, "high": 1}
    assert body["feedbacks"] == {"confused": 1, "good": 2, "fire": 1}


async def test_empty_period_is_zeroes_and_null_deltas(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """No practices at all: counts 0, rates 0, deltas null.

    Rates are 0 and not null -- "nobody checked in out of nobody" is the
    honest empty, and it is the answer the admin dashboards already give. The
    DELTA is what goes null, because there is no base to compare against.
    """
    master = await _make_verified_master(client, db_session)

    body = await _analytics(client, master)

    assert body["practices_count"] == 0
    assert body["bookings_count"] == 0
    assert body["checkin_rate_pct"] == 0
    assert body["feedback_rate_pct"] == 0
    assert body["practices_delta_pct"] is None
    assert body["checkin_rate_delta_pp"] is None


async def test_rate_delta_is_in_points_and_the_previous_period_feeds_it(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Previous week 50%, this week 100%: the delta is 50 POINTS, not 100%.

    Two bookings and one check-in last week, two and two this week. A percent
    change of a percent would answer 100 here and would be wrong in a way
    nobody notices until the numbers are small. This also proves the previous
    window is populated at all: were it empty, rate_delta_pp would be null.
    """
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]

    past = await _create_practice(
        db_session, master_id, scheduled_at=_inside_previous("week"),
    )
    half = await _book(db_session, past.id, await _participant(client))
    await _book(db_session, past.id, await _participant(client))
    await _check_in(db_session, half, mood=6)

    now_practice = await _create_practice(
        db_session, master_id, scheduled_at=_inside("week"),
    )
    for _ in range(2):
        booking = await _book(
            db_session, now_practice.id, await _participant(client),
        )
        await _check_in(db_session, booking, mood=6)

    body = await _analytics(client, master)
    assert body["checkin_rate_pct"] == 100
    assert body["checkin_rate_delta_pp"] == 50
    assert body["practices_delta_pct"] == 0


async def test_previous_period_without_bookings_gives_a_null_rate_delta(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A previous period with practices but no bookings has no rate to compare.

    Its rate would compute as an honest 0, and reporting "+100 points" against
    that would read as a real jump from a real zero. The previous period had
    no denominator at all, so the delta is null while the COUNT delta still
    answers a number -- the two conventions differ on purpose.
    """
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]

    await _create_practice(
        db_session, master_id, scheduled_at=_inside_previous("week"),
    )

    practice = await _create_practice(
        db_session, master_id, scheduled_at=_inside("week"),
    )
    booking = await _book(db_session, practice.id, await _participant(client))
    await _check_in(db_session, booking, mood=6)

    body = await _analytics(client, master)
    assert body["checkin_rate_pct"] == 100
    assert body["checkin_rate_delta_pp"] is None
    assert body["practices_delta_pct"] == 0


async def test_only_completed_practices_are_counted(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A scheduled practice in the period contributes nothing, not even seats.

    Paired on one dataset: one completed and one scheduled practice, each with
    a booking. Counting the scheduled one would inflate the denominator and
    silently depress every rate on the screen.
    """
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    inside = _inside("week")

    done = await _create_practice(db_session, master_id, scheduled_at=inside)
    ahead = await _create_practice(
        db_session, master_id, scheduled_at=inside,
        status=PracticeStatus.SCHEDULED.value,
    )
    await _book(db_session, done.id, await _participant(client))
    await _book(db_session, ahead.id, await _participant(client))

    body = await _analytics(client, master)
    assert body["practices_count"] == 1
    assert body["bookings_count"] == 1


async def test_another_masters_practice_is_not_counted(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The summary is scoped to the caller, and the check is not vacuous.

    The second master's practice sits in the same period with the same shape,
    so a missing master_id filter would show 2 here.
    """
    master = await _make_verified_master(client, db_session)
    other = await _make_verified_master(
        client, db_session, telegram_id=69102,
    )
    inside = _inside("week")

    await _create_practice(
        db_session, master["user"]["id"], scheduled_at=inside,
    )
    await _create_practice(
        db_session, other["user"]["id"], scheduled_at=inside,
    )

    body = await _analytics(client, master)
    assert body["practices_count"] == 1


async def test_the_period_is_the_masters_calendar_not_utc(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A practice inside the master's month but outside UTC's is counted.

    Pacific/Auckland runs 12-13 hours ahead, so its month opens on the last
    day of the previous UTC month. A practice in that gap belongs to the
    master's period and used to fall out of it.

    The dashboard grid is asserted on the same instant, and its expected
    number is COMPUTED rather than assumed: for most of the month the two
    calendars disagree and the grid reads 0, but during the half-day when
    Auckland has already rolled into the next month and UTC has not, that same
    instant sits inside UTC's current month too and the grid reads 1. Both
    states are reachable, so neither may be a skip -- a skipped test is one
    that stopped running without saying so.
    """
    master = await _make_verified_master(
        client, db_session, timezone="Pacific/Auckland",
    )
    master_id = master["user"]["id"]

    local_start, _local_end, _prev = calendar_period_bounds_in_tz(
        "month", datetime.now(UTC), "Pacific/Auckland",
    )
    utc_start, _utc_end, _utc_prev = calendar_period_bounds(
        "month", datetime.now(UTC),
    )

    await _create_practice(db_session, master_id, scheduled_at=local_start)

    body = await _analytics(client, master, period="month")
    assert body["practices_count"] == 1

    grid = await client.get(
        "/api/v1/masters/me/stats?period=month",
        headers=auth_headers(master["session_token"]),
    )
    assert grid.status_code == 200
    assert grid.json()["practices_count"] == (0 if local_start < utc_start else 1)


async def test_quarter_is_accepted(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """period=quarter answers 200 and counts its own window.

    The sibling dashboard endpoint has accepted quarter since BE-28; refusing
    it here would leave one master screen able to ask for a period the other
    cannot. The count is asserted alongside the status so that "accepted" does
    not quietly mean "accepted and answered for some other window".
    """
    master = await _make_verified_master(client, db_session)

    await _create_practice(
        db_session, master["user"]["id"], scheduled_at=_inside("quarter"),
    )

    body = await _analytics(client, master, period="quarter")
    assert body["practices_count"] == 1


async def test_summary_requires_a_verified_master(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A plain user cannot read a master's analytics.

    get_current_master is the guard; this asserts the route actually carries
    it, which no other test in this file would notice.
    """
    data = await login_user(client, telegram_id=69103, first_name="Plain")

    response = await client.get(
        f"{ANALYTICS_URL}?period=week",
        headers=auth_headers(data["session_token"]),
    )

    assert response.status_code == 403
