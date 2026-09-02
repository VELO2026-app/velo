# =============================================================================
# VELO Backend -- Tests: Master Stats SEMANTICS (GT-20)
# =============================================================================
#
# telegram_id ranges:
#   66801        -- the master under test
#   66802        -- a second master (isolation check)
#   66810-66812  -- participants
#
# WHY THIS FILE EXISTS, next to test_master_stats.py. That file pins the shape
# of GET /masters/me/stats: auth, periods, deltas, income passthrough. This one
# pins what the two numbers MEAN, because the bug it was written for produced
# valid JSON with the wrong number in it. FE-50: a master with five practices
# scheduled and none conducted saw "5" under a tile labelled "Практик".
# FE-53: a student registered and checked in and the participant count did not
# move.
#
# The rule under test (GT-20):
#   practices_count    -- Practice.status == COMPLETED, scheduled_at in the
#                         calendar period. Nothing else counts: not scheduled,
#                         not live, not cancelled, not draft, not deleted.
#   participants_count -- DISTINCT users with an ATTENDED booking on those
#                         practices. Unchanged: it counts who came, not who
#                         signed up, which is why FE-53 was never a defect.
#
# Every test asserts a CONCRETE number. "Not counted" is always paired with a
# "counted" assertion on the same data, so a query that returns zero for the
# wrong reason cannot pass as correct behaviour.
#
# UNREACHABLE STATES DELIBERATELY NOT TESTED. "Deleted after completion" and
# "cancelled after completion" have no test here because the transitions do not
# exist: DELETED is reachable only from DRAFT (practices/service.py
# _VALID_TRANSITIONS), and cancellation is gated on scheduled/live
# (practices/cancel_service.py _CANCELLABLE_PRACTICE_STATUSES). Building either
# by hand would test a state the product cannot produce.
# =============================================================================

import itertools
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.periods import calendar_period_bounds
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice, PracticeStatus, PracticeType
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user

STATS_URL = "/api/v1/masters/me/stats"

_TID_MIN = 66800
_TID_MAX = 66999


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
    """Full ORM cleanup for telegram_id 66800-66999, users included.

    delete_users=True: this file creates its own masters and participants
    inside its own band and shares no fixture users with any other file, so
    leaving User rows behind would only accumulate them.
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
    telegram_id: int = 66801,
) -> dict:
    """Create a verified master via login + direct DB setup."""
    data = await login_user(
        client, telegram_id=telegram_id, first_name="Master",
    )
    user_id = data["user"]["id"]

    user = (
        await db_session.execute(select(User).where(User.id == user_id))
    ).scalar_one()
    user.role = UserRole.MASTER.value
    await db_session.flush()

    profile = MasterProfile(
        user_id=UUID(user_id),
        data={"account": {"status": "verified"}},
    )
    db_session.add(profile)
    await db_session.commit()
    return data


_practice_counter = itertools.count()


async def _create_practice(
    db_session: AsyncSession,
    master_id: str,
    *,
    scheduled_at: datetime,
    status: str,
) -> Practice:
    """Create one practice for the master at the given schedule and status.

    `status` is REQUIRED here, unlike the helper in test_master_stats.py which
    defaults to COMPLETED. Every test in this file exists to pin what a given
    status does to the counters, so a default would let a test silently assert
    the wrong state's number.

    Titles carry a counter suffix: MIG1
    (uq_practice_master_title_scheduled_recurrence) is a partial unique index
    on (master_id, title, scheduled_at, recurrence), and several tests below
    put two practices on the SAME slot on purpose. No test asserts a title.
    """
    practice = Practice(
        master_id=UUID(master_id),
        practice_type=PracticeType.LIVE.value,
        status=status,
        title=f"Semantics Practice {next(_practice_counter)}",
        scheduled_at=scheduled_at,
        duration_minutes=60,
        timezone="UTC",
    )
    db_session.add(practice)
    await db_session.flush()
    await db_session.commit()
    return practice


async def _book(
    db_session: AsyncSession,
    practice_id: UUID,
    user_id: str,
    status: str,
) -> None:
    """Add one booking for the participant on the practice at `status`."""
    booking = Booking(
        practice_id=practice_id,
        user_id=UUID(user_id),
        status=status,
    )
    db_session.add(booking)
    await db_session.commit()


async def _stats(client: AsyncClient, master: dict, period: str = "week") -> dict:
    """GET the stats grid for this master and return the parsed body."""
    resp = await client.get(
        f"{STATS_URL}?period={period}",
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 200
    return resp.json()


# ===================================================================
# Empty input (PUSTOTA on both counters)
# ===================================================================


async def test_master_without_practices(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """No practices at all -> 0 and 0, both deltas null.

    The counters return a number, not None and not an error: COUNT over zero
    matching rows in a non-grouped aggregate still yields one row of zero.
    """
    master = await _make_verified_master(client, db_session)

    body = await _stats(client, master)
    assert body["practices_count"] == 0
    assert body["participants_count"] == 0
    assert body["practices_delta_pct"] is None
    assert body["participants_delta_pct"] is None


# ===================================================================
# practices_count -- FE-50
# ===================================================================


async def test_scheduled_zero_then_completed_one(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Five scheduled practices count 0; one completed one counts 1.

    This is FE-50 in a single test, and the "no X" half is paired with the
    "there is Y" half on the SAME data: after the completed practice lands,
    the same query on the same five scheduled rows returns 1, not 0. A query
    that returned zero because it matched nothing at all could pass the first
    assertion but never the second.
    """
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    now = datetime.now(UTC)

    for _ in range(5):
        await _create_practice(
            db_session, master_id,
            scheduled_at=now,
            status=PracticeStatus.SCHEDULED.value,
        )

    assert (await _stats(client, master))["practices_count"] == 0

    await _create_practice(
        db_session, master_id,
        scheduled_at=now,
        status=PracticeStatus.COMPLETED.value,
    )

    assert (await _stats(client, master))["practices_count"] == 1


async def test_live_practice_not_counted(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A practice running right now counts 0, a completed one counts 1.

    LIVE is set by the lifecycle worker while the session is in progress and
    has not been settled yet. The master will not see her own practice in the
    tile while she is running it -- intended, see the service module header.
    """
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    now = datetime.now(UTC)

    await _create_practice(
        db_session, master_id,
        scheduled_at=now,
        status=PracticeStatus.LIVE.value,
    )
    assert (await _stats(client, master))["practices_count"] == 0

    await _create_practice(
        db_session, master_id,
        scheduled_at=now,
        status=PracticeStatus.COMPLETED.value,
    )
    assert (await _stats(client, master))["practices_count"] == 1


async def test_draft_and_deleted_not_counted(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Draft and deleted practices count 0; a completed one counts 1."""
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    now = datetime.now(UTC)

    for status in (
        PracticeStatus.DRAFT.value,
        PracticeStatus.DELETED.value,
    ):
        await _create_practice(
            db_session, master_id, scheduled_at=now, status=status,
        )
    assert (await _stats(client, master))["practices_count"] == 0

    await _create_practice(
        db_session, master_id,
        scheduled_at=now,
        status=PracticeStatus.COMPLETED.value,
    )
    assert (await _stats(client, master))["practices_count"] == 1


async def test_cancelled_counted_in_neither(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A cancelled practice counts in neither tile, a completed one in both.

    Both halves on the same data: the cancelled practice contributes 0/0, and
    the completed practice with one attendee then reads 1/1 through the same
    two queries.
    """
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    now = datetime.now(UTC)

    cancelled = await _create_practice(
        db_session, master_id,
        scheduled_at=now,
        status=PracticeStatus.CANCELLED.value,
    )
    user = await login_user(client, telegram_id=66810, first_name="P1")
    await _book(
        db_session, cancelled.id, user["user"]["id"],
        BookingStatus.CANCELLED.value,
    )

    body = await _stats(client, master)
    assert body["practices_count"] == 0
    assert body["participants_count"] == 0

    done = await _create_practice(
        db_session, master_id,
        scheduled_at=now,
        status=PracticeStatus.COMPLETED.value,
    )
    await _book(
        db_session, done.id, user["user"]["id"],
        BookingStatus.ATTENDED.value,
    )

    body = await _stats(client, master)
    assert body["practices_count"] == 1
    assert body["participants_count"] == 1


async def test_two_completed_practices_on_one_slot_count_twice(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Two completed practices at the same instant count 2, not 1.

    POVTOR on the practices input: the aggregate counts rows, it does not
    collapse duplicates by slot.
    """
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    now = datetime.now(UTC)

    for _ in range(2):
        await _create_practice(
            db_session, master_id,
            scheduled_at=now,
            status=PracticeStatus.COMPLETED.value,
        )

    assert (await _stats(client, master))["practices_count"] == 2


async def test_other_master_practice_not_counted(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Another master's completed practice contributes 0 to this master.

    Paired: the same request reads 1 once this master has a completed practice
    of her own, so the zero is the master_id filter working rather than an
    empty table.
    """
    master = await _make_verified_master(client, db_session)
    other = await _make_verified_master(client, db_session, telegram_id=66802)
    master_id = master["user"]["id"]
    now = datetime.now(UTC)

    other_practice = await _create_practice(
        db_session, other["user"]["id"],
        scheduled_at=now,
        status=PracticeStatus.COMPLETED.value,
    )
    user = await login_user(client, telegram_id=66811, first_name="P2")
    await _book(
        db_session, other_practice.id, user["user"]["id"],
        BookingStatus.ATTENDED.value,
    )

    body = await _stats(client, master)
    assert body["practices_count"] == 0
    assert body["participants_count"] == 0

    await _create_practice(
        db_session, master_id,
        scheduled_at=now,
        status=PracticeStatus.COMPLETED.value,
    )
    assert (await _stats(client, master))["practices_count"] == 1


# ===================================================================
# participants_count -- FE-53
# ===================================================================


async def test_completed_with_confirmed_booking_only(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Completed practice, booking still CONFIRMED -> 1 practice, 0 attendees.

    This is the legal window FE-53 was reported from, seen from the other end.
    A booking becomes ATTENDED only when the attendance verdict lands, which
    with live Zoom tracking is deferred until after the session ends. Until
    then the practice has happened and nobody is an attendee yet, so the two
    tiles disagreeing is correct rather than a stale number.
    """
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    now = datetime.now(UTC)

    practice = await _create_practice(
        db_session, master_id,
        scheduled_at=now,
        status=PracticeStatus.COMPLETED.value,
    )
    user = await login_user(client, telegram_id=66810, first_name="P1")
    await _book(
        db_session, practice.id, user["user"]["id"],
        BookingStatus.CONFIRMED.value,
    )

    body = await _stats(client, master)
    assert body["practices_count"] == 1
    assert body["participants_count"] == 0


async def test_attended_counts_one_participant(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Verdict in and the person came -> 1 practice, 1 participant."""
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    now = datetime.now(UTC)

    practice = await _create_practice(
        db_session, master_id,
        scheduled_at=now,
        status=PracticeStatus.COMPLETED.value,
    )
    user = await login_user(client, telegram_id=66810, first_name="P1")
    await _book(
        db_session, practice.id, user["user"]["id"],
        BookingStatus.ATTENDED.value,
    )

    body = await _stats(client, master)
    assert body["practices_count"] == 1
    assert body["participants_count"] == 1


async def test_completed_with_zero_attendees(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A completed practice with no bookings at all -> 1 practice, 0 people.

    PUSTOTA on the participants input, and the pair the practices counter
    needs: the zero next door is accompanied by a practices_count of 1 on the
    same data, so "0 participants" cannot be read as "nothing was counted".
    """
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    now = datetime.now(UTC)

    await _create_practice(
        db_session, master_id,
        scheduled_at=now,
        status=PracticeStatus.COMPLETED.value,
    )

    body = await _stats(client, master)
    assert body["practices_count"] == 1
    assert body["participants_count"] == 0


async def test_no_show_not_a_participant(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A NO_SHOW booking on a completed practice -> 1 practice, 0 people.

    NO_SHOW is the other half of the same verdict that produces ATTENDED, so
    this pins that the counter reads the verdict rather than merely noticing
    that one was reached.
    """
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    now = datetime.now(UTC)

    practice = await _create_practice(
        db_session, master_id,
        scheduled_at=now,
        status=PracticeStatus.COMPLETED.value,
    )
    user = await login_user(client, telegram_id=66810, first_name="P1")
    await _book(
        db_session, practice.id, user["user"]["id"],
        BookingStatus.NO_SHOW.value,
    )

    body = await _stats(client, master)
    assert body["practices_count"] == 1
    assert body["participants_count"] == 0


async def test_bookings_present_but_none_attended(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Three bookings, none ATTENDED -> 0 participants, then 1 when one is.

    NEKHVATKA on the participants input: the booking rows exist and the join
    matches them, but no row carries the status the counter wants. The second
    half proves the zero came from the status filter and not from the join.
    """
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    now = datetime.now(UTC)

    practice = await _create_practice(
        db_session, master_id,
        scheduled_at=now,
        status=PracticeStatus.COMPLETED.value,
    )
    u1 = await login_user(client, telegram_id=66810, first_name="P1")
    u2 = await login_user(client, telegram_id=66811, first_name="P2")
    u3 = await login_user(client, telegram_id=66812, first_name="P3")

    await _book(
        db_session, practice.id, u1["user"]["id"],
        BookingStatus.PENDING.value,
    )
    await _book(
        db_session, practice.id, u2["user"]["id"],
        BookingStatus.CONFIRMED.value,
    )
    await _book(
        db_session, practice.id, u3["user"]["id"],
        BookingStatus.CANCELLED.value,
    )

    body = await _stats(client, master)
    assert body["practices_count"] == 1
    assert body["participants_count"] == 0

    second = await _create_practice(
        db_session, master_id,
        scheduled_at=now,
        status=PracticeStatus.COMPLETED.value,
    )
    await _book(
        db_session, second.id, u1["user"]["id"],
        BookingStatus.ATTENDED.value,
    )

    assert (await _stats(client, master))["participants_count"] == 1


async def test_distinct_participant_across_two_practices(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """One person attending two completed practices -> 2 practices, 1 person.

    POVTOR on the participants input: DISTINCT on Booking.user_id. The
    practices number moving to 2 while the people number stays at 1 is what
    makes this a repeat rather than two different attendees.
    """
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    now = datetime.now(UTC)

    first = await _create_practice(
        db_session, master_id,
        scheduled_at=now,
        status=PracticeStatus.COMPLETED.value,
    )
    second = await _create_practice(
        db_session, master_id,
        scheduled_at=now,
        status=PracticeStatus.COMPLETED.value,
    )
    user = await login_user(client, telegram_id=66810, first_name="P1")
    await _book(
        db_session, first.id, user["user"]["id"],
        BookingStatus.ATTENDED.value,
    )
    await _book(
        db_session, second.id, user["user"]["id"],
        BookingStatus.ATTENDED.value,
    )

    body = await _stats(client, master)
    assert body["practices_count"] == 2
    assert body["participants_count"] == 1


# ===================================================================
# Periods and deltas -- one rule for both windows
# ===================================================================


async def test_previous_period_practice_not_in_current(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A practice completed last week counts 1 this week, not 2."""
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    now = datetime.now(UTC)

    await _create_practice(
        db_session, master_id,
        scheduled_at=now,
        status=PracticeStatus.COMPLETED.value,
    )
    await _create_practice(
        db_session, master_id,
        scheduled_at=now - timedelta(days=7),
        status=PracticeStatus.COMPLETED.value,
    )

    assert (await _stats(client, master))["practices_count"] == 1


async def test_delta_uses_same_rule_both_periods(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Current 1 completed vs previous 2 completed + 2 scheduled -> -50.

    The number is the whole point. The previous week holds four practices, two
    of which never finished. Counting the previous window by the OLD rule
    would make the base 4 and the delta -75; counting it by the same rule as
    the current window makes the base 2 and the delta -50. A test that only
    asserted "a delta exists" would pass either way.

    The two unfinished practices sitting in a past week are a reachable state:
    autofinalize claims overdue practices with no lower time bound, so a
    scheduled row survives in the past exactly as long as the worker is down.
    """
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    now = datetime.now(UTC)
    last_week = now - timedelta(days=7)

    await _create_practice(
        db_session, master_id,
        scheduled_at=now,
        status=PracticeStatus.COMPLETED.value,
    )
    for _ in range(2):
        await _create_practice(
            db_session, master_id,
            scheduled_at=last_week,
            status=PracticeStatus.COMPLETED.value,
        )
    for _ in range(2):
        await _create_practice(
            db_session, master_id,
            scheduled_at=last_week,
            status=PracticeStatus.SCHEDULED.value,
        )

    body = await _stats(client, master)
    assert body["practices_count"] == 1
    assert body["practices_delta_pct"] == -50


async def test_delta_null_when_both_periods_are_zero(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Scheduled-only in both weeks -> 0 with a null delta, not 0 percent.

    Under the old rule this data read 1 against a base of 1 and a delta of 0.
    Under the new rule both windows are empty, the base is non-positive, and
    period_delta_pct returns null so the client shows "--".
    """
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    now = datetime.now(UTC)

    await _create_practice(
        db_session, master_id,
        scheduled_at=now,
        status=PracticeStatus.SCHEDULED.value,
    )
    await _create_practice(
        db_session, master_id,
        scheduled_at=now - timedelta(days=7),
        status=PracticeStatus.SCHEDULED.value,
    )

    body = await _stats(client, master)
    assert body["practices_count"] == 0
    assert body["practices_delta_pct"] is None


async def test_period_start_is_inclusive(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A practice completed exactly at the period start counts 1.

    The window is the half-open [cur_start, cur_end) from core.periods, so the
    first instant of the week belongs to the week.
    """
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    cur_start, _cur_end, _prev_start = calendar_period_bounds(
        "week", datetime.now(UTC),
    )

    await _create_practice(
        db_session, master_id,
        scheduled_at=cur_start,
        status=PracticeStatus.COMPLETED.value,
    )

    assert (await _stats(client, master))["practices_count"] == 1


async def test_period_start_is_exclusive_for_the_previous_window(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """One second before the period start belongs to last week -> 0 and -100.

    The other side of the same boundary as the test above, and the reason both
    exist: if the comparison were inclusive at both ends, this practice would
    land in the current window too and the count would be 1 with a delta of 0.
    The delta of -100 also shows the previous window picked it up, so the row
    was moved rather than dropped.

    Deliberately not tested at the far end of the window: a practice cannot be
    COMPLETED before it has run, so a completed row at cur_end would be a
    state the product cannot produce.
    """
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    cur_start, _cur_end, _prev_start = calendar_period_bounds(
        "week", datetime.now(UTC),
    )

    await _create_practice(
        db_session, master_id,
        scheduled_at=cur_start - timedelta(seconds=1),
        status=PracticeStatus.COMPLETED.value,
    )

    body = await _stats(client, master)
    assert body["practices_count"] == 0
    assert body["practices_delta_pct"] == -100
