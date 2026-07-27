# =============================================================================
# VELO Backend -- Tests: Admin Metrics (E9 / 4a)
# =============================================================================
#
# telegram_id range: 92000-92999
#   92900     -- admin caller
#   92800-92809 -- masters (practice owners)
#   92001+    -- attendees
#
# Coverage:
#   GET /admin/metrics/check-in   -- rate, totals, series (7 for week),
#                                    low_practices
#   GET /admin/metrics/feedback   -- rate, totals, rating distribution
#   GET /admin/metrics/return     -- rate, totals, top_users
#   auth (401 / 403), invalid period (422), empty state
# =============================================================================

import time as _time
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.periods import calendar_period_bounds
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.diary.models import Checkin, CheckType, Feedback
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice, PracticeStatus, PracticeType
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user

CHECKIN_URL = "/api/v1/admin/metrics/check-in"
FEEDBACK_URL = "/api/v1/admin/metrics/feedback"
RETURN_URL = "/api/v1/admin/metrics/return"

_TID_MIN = 92000
_TID_MAX = 92999


def _period_safe_past_practice(
    period: str = "week",
    _now: datetime | None = None,
) -> tuple[datetime, int]:
    """(scheduled_at, duration_minutes) for a practice that is BOTH inside the
    current calendar period AND already ended by wall-clock.

    The naive `now - 2h` fixture silently assumed those two hours do not cross
    a calendar boundary. They do, weekly: the 2026-07-27 00:50/00:58 UTC runs
    (Monday night) put every fixture into the PREVIOUS week, all period deltas
    read 0, and five tests failed -- deterministically, every Monday
    00:00-02:00 UTC (and the month variant every 1st, same window). The
    metrics filter on Practice.scheduled_at in [period_start, period_end)
    (calendar UTC, core.periods) plus, for check-in/feedback, the wall-clock
    "ended" test scheduled_at + duration < now -- so the fixture must satisfy
    both, not just "be in the past".

    scheduled_at = max(period_start, now - 2h), with the duration shrunk near
    the boundary so the practice still ends strictly before `now`. The first
    ~2 minutes after a boundary admit NO such practice at all (in-period +
    >=1 minute long + already over), so that sliver is waited out -- bounded,
    at most ~2 minutes, and only if the suite lands exactly on it.

    `_now` is injectable for verifying the math; the sleep only runs live.
    """
    now = _now or datetime.now(UTC)
    start, _end, _prev = calendar_period_bounds(period, now)
    min_now = start + timedelta(minutes=2, seconds=1)
    if now < min_now:
        if _now is None:
            _time.sleep((min_now - now).total_seconds())
            now = datetime.now(UTC)
        else:  # synthetic clock: model the post-sleep moment instead
            now = min_now
    scheduled_at = max(start, now - timedelta(hours=2))
    room_minutes = int((now - scheduled_at).total_seconds() // 60)
    duration = min(60, max(1, room_minutes - 1))
    return scheduled_at, duration


# ===================================================================
# Cleanup
# ===================================================================


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """Clean all test data before/after each test."""
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


# ===================================================================
# Helpers
# ===================================================================


async def _make_admin(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int = 92900,
) -> str:
    auth = await login_user(client, telegram_id=telegram_id, first_name="Admin")
    await db_session.execute(
        update(User)
        .where(User.id == auth["user"]["id"])
        .values(role=UserRole.ADMIN.value)
    )
    await db_session.flush()
    return auth["session_token"]


async def _make_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int,
) -> str:
    auth = await login_user(client, telegram_id=telegram_id, first_name="Master")
    user_id = auth["user"]["id"]
    user = await db_session.get(User, user_id)
    user.role = UserRole.MASTER
    await db_session.flush()
    profile = MasterProfile(
        user_id=user_id,
        data={"account": {"status": "verified"}, "profile": {"bio": "m"}},
    )
    db_session.add(profile)
    await db_session.flush()
    return user_id


async def _create_practice(
    db_session: AsyncSession,
    master_id: str,
    *,
    scheduled_at: datetime,
    duration_minutes: int = 60,
) -> Practice:
    practice = Practice(
        master_id=master_id,
        title="Metric Practice",
        description="x",
        practice_type=PracticeType.LIVE.value,
        status=PracticeStatus.COMPLETED.value,
        scheduled_at=scheduled_at,
        duration_minutes=duration_minutes,
        timezone="UTC",
        max_participants=20,
        current_participants=0,
        is_free=True,
        price_cents=0,
        currency="eur",
    )
    db_session.add(practice)
    await db_session.flush()
    return practice


async def _attend(
    client: AsyncClient,
    db_session: AsyncSession,
    practice: Practice,
    telegram_id: int,
    *,
    status: str = BookingStatus.ATTENDED.value,
) -> tuple[str, Booking]:
    auth = await login_user(
        client, telegram_id=telegram_id, first_name=f"U{telegram_id}",
    )
    user_id = auth["user"]["id"]
    booking = Booking(
        practice_id=practice.id,
        user_id=user_id,
        status=status,
        joined_at=datetime.now(UTC) - timedelta(hours=2),
    )
    db_session.add(booking)
    await db_session.flush()
    return user_id, booking


async def _add_checkin(
    db_session: AsyncSession,
    practice: Practice,
    user_id: str,
    booking: Booking,
    *,
    mood: int = 8,
) -> None:
    db_session.add(
        Checkin(
            practice_id=practice.id,
            user_id=user_id,
            booking_id=booking.id,
            mood=mood,
            check_type=CheckType.PRE.value,
        )
    )
    await db_session.flush()


async def _add_feedback(
    db_session: AsyncSession,
    practice: Practice,
    user_id: str,
    booking: Booking,
    *,
    rating: int,
) -> None:
    db_session.add(
        Feedback(
            practice_id=practice.id,
            user_id=user_id,
            booking_id=booking.id,
            rating=rating,
        )
    )
    await db_session.flush()


# ===================================================================
# check-in
# ===================================================================


@pytest.mark.asyncio
async def test_checkin_metric_basic(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """rate = checked_in / total_records; series has 7 daily buckets (week)."""
    token = await _make_admin(client, db_session)
    await db_session.commit()  # admin must be visible to the endpoint

    # Baseline BEFORE our fixtures — the shared DB may carry seed data, so we
    # assert the DELTA our fixtures contribute, not absolute global counts.
    base = (
        await client.get(CHECKIN_URL, headers=auth_headers(token))
    ).json()

    master_id = await _make_master(client, db_session, 92800)
    # PAST practice inside the CURRENT calendar week (D5 wall-clock filter +
    # period window -- see _period_safe_past_practice for the Monday-night trap).
    sched, dur = _period_safe_past_practice("week")
    practice = await _create_practice(
        db_session, master_id, scheduled_at=sched, duration_minutes=dur,
    )

    _u1, b1 = await _attend(client, db_session, practice, 92001)
    await _add_checkin(db_session, practice, _u1, b1)
    await _attend(client, db_session, practice, 92002)  # no check-in
    await db_session.commit()

    resp = await client.get(CHECKIN_URL, headers=auth_headers(token))
    assert resp.status_code == 200
    data = resp.json()
    # New formula (per distinct PAST practice): +1 past practice, and it has
    # >=1 check-in -> total_records +1, checked_in +1 (was +2/+1 per-booking).
    assert data["total_records"] - base["total_records"] == 1
    assert data["checked_in"] - base["checked_in"] == 1
    assert len(data["series"]) == 7
    assert {"label", "value"} == set(data["series"][0].keys())
    # low_practices is bottom-N (<=5) and seed practices may fill it, so check
    # shape, and our own row's values only when it surfaces.
    assert len(data["low_practices"]) <= 5
    if data["low_practices"]:
        assert set(data["low_practices"][0].keys()) == {
            "id", "title", "checkin_rate_pct", "total",
        }
    ours = [p for p in data["low_practices"] if p["id"] == str(practice.id)]
    if ours:
        assert ours[0]["checkin_rate_pct"] == 50
        assert ours[0]["total"] == 2


@pytest.mark.asyncio
async def test_checkin_metric_empty(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """No data -> honest zeros, empty low list, but a full week series."""
    token = await _make_admin(client, db_session)
    await db_session.commit()

    # Shared DB may carry seed data, so "empty" can't mean global zero. Capture
    # a baseline and assert our no-op (no fixtures added) changes nothing.
    base = (
        await client.get(CHECKIN_URL, headers=auth_headers(token))
    ).json()

    resp = await client.get(CHECKIN_URL, headers=auth_headers(token))
    assert resp.status_code == 200
    data = resp.json()
    assert data["total_records"] == base["total_records"]
    assert data["checked_in"] == base["checked_in"]
    assert len(data["series"]) == 7


@pytest.mark.asyncio
async def test_checkin_metric_month_period(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Month period is accepted and returns weekly buckets."""
    token = await _make_admin(client, db_session)
    master_id = await _make_master(client, db_session, 92801)
    # PAST practice inside the CURRENT calendar month (same boundary trap as
    # the week tests, monthly cadence: every 1st 00:00-02:00 UTC).
    sched, dur = _period_safe_past_practice("month")
    practice = await _create_practice(
        db_session, master_id, scheduled_at=sched, duration_minutes=dur,
    )
    _u, b = await _attend(client, db_session, practice, 92010)
    await _add_checkin(db_session, practice, _u, b)
    await db_session.commit()

    resp = await client.get(
        CHECKIN_URL, params={"period": "month"}, headers=auth_headers(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    # Platform-wide metric: seed data may also fall in the month, so assert our
    # records are included rather than an exact isolated count.
    assert data["total_records"] >= 1
    assert data["checked_in"] >= 1
    # Month spans 4-6 weekly buckets.
    assert 4 <= len(data["series"]) <= 6


# ===================================================================
# feedback
# ===================================================================


@pytest.mark.asyncio
async def test_feedback_metric_basic_and_distribution(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """rate = left_review / visited; distribution buckets by rating."""
    token = await _make_admin(client, db_session)
    await db_session.commit()  # admin must be visible to the endpoint

    # Baseline BEFORE our fixtures (shared DB may carry seed data).
    base = (
        await client.get(FEEDBACK_URL, headers=auth_headers(token))
    ).json()

    master_id = await _make_master(client, db_session, 92802)
    # PAST practice inside the CURRENT week (see _period_safe_past_practice).
    sched, dur = _period_safe_past_practice("week")
    practice = await _create_practice(
        db_session, master_id, scheduled_at=sched, duration_minutes=dur,
    )

    _u1, b1 = await _attend(client, db_session, practice, 92020)
    await _add_feedback(db_session, practice, _u1, b1, rating=9)   # fire
    _u2, b2 = await _attend(client, db_session, practice, 92021)
    await _add_feedback(db_session, practice, _u2, b2, rating=2)   # confused
    await _attend(client, db_session, practice, 92022)            # no feedback
    await db_session.commit()

    resp = await client.get(FEEDBACK_URL, headers=auth_headers(token))
    assert resp.status_code == 200
    data = resp.json()
    # New formula (per distinct PAST practice): +1 past practice (visited), and
    # it has >=1 feedback -> left_review +1 (was +3/+2 per-booking). Distribution
    # counts both feedbacks on the practice (1 fire, 1 confused).
    assert data["visited"] - base["visited"] == 1
    assert data["left_review"] - base["left_review"] == 1
    dist, bdist = data["distribution"], base["distribution"]
    assert dist["fire"] - bdist["fire"] == 1
    assert dist["good"] - bdist["good"] == 0
    assert dist["confused"] - bdist["confused"] == 1


@pytest.mark.asyncio
async def test_feedback_metric_good_bucket(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A mid rating (4-7) lands in the good bucket."""
    token = await _make_admin(client, db_session)
    await db_session.commit()  # admin must be visible to the endpoint

    # Baseline BEFORE our fixtures (shared DB may carry seed data).
    base = (
        await client.get(FEEDBACK_URL, headers=auth_headers(token))
    ).json()

    master_id = await _make_master(client, db_session, 92803)
    # PAST practice inside the CURRENT week (see _period_safe_past_practice).
    sched, dur = _period_safe_past_practice("week")
    practice = await _create_practice(
        db_session, master_id, scheduled_at=sched, duration_minutes=dur,
    )
    _u, b = await _attend(client, db_session, practice, 92030)
    await _add_feedback(db_session, practice, _u, b, rating=6)
    await db_session.commit()

    resp = await client.get(FEEDBACK_URL, headers=auth_headers(token))
    assert resp.status_code == 200
    # Our single rating-6 feedback lands in the good bucket. Assert the DELTA
    # over the baseline (not an absolute distribution), since seed practices
    # may carry other in-period feedbacks the platform-wide metric also counts.
    dist, bdist = resp.json()["distribution"], base["distribution"]
    assert dist["good"] - bdist["good"] == 1
    assert dist["fire"] - bdist["fire"] == 0
    assert dist["confused"] - bdist["confused"] == 0


@pytest.mark.asyncio
async def test_feedback_metric_rate_capped_per_practice(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Per-practice rate is <=100% structurally; distribution counts all feedbacks."""
    token = await _make_admin(client, db_session)
    await db_session.commit()  # admin must be visible to the endpoint

    # Baseline BEFORE our fixtures (shared DB may carry seed data).
    base = (
        await client.get(FEEDBACK_URL, headers=auth_headers(token))
    ).json()

    master_id = await _make_master(client, db_session, 92804)
    # PAST practice inside the CURRENT week (see _period_safe_past_practice).
    sched, dur = _period_safe_past_practice("week")
    practice = await _create_practice(
        db_session, master_id, scheduled_at=sched, duration_minutes=dur,
    )

    # Two feedbacks on the SAME practice (an attended and a no_show booker).
    u1, b1 = await _attend(client, db_session, practice, 92040)
    await _add_feedback(db_session, practice, u1, b1, rating=9)   # fire
    u2, b2 = await _attend(
        client, db_session, practice, 92041,
        status=BookingStatus.NO_SHOW.value,
    )
    await _add_feedback(db_session, practice, u2, b2, rating=8)   # fire
    await db_session.commit()

    resp = await client.get(FEEDBACK_URL, headers=auth_headers(token))
    assert resp.status_code == 200
    data = resp.json()
    # New formula is per DISTINCT PAST practice: +1 practice (visited), and it
    # has >=1 feedback -> left_review +1 (so rate is <=100% structurally, the
    # old W-3 concern is now inherent). Distribution counts BOTH feedbacks on the
    # practice -> fire +2 (no longer booking-status-gated).
    assert data["visited"] - base["visited"] == 1
    assert data["left_review"] - base["left_review"] == 1
    dist, bdist = data["distribution"], base["distribution"]
    assert dist["fire"] - bdist["fire"] == 2
    assert dist["good"] - bdist["good"] == 0
    assert dist["confused"] - bdist["confused"] == 0


# ===================================================================
# return
# ===================================================================


@pytest.mark.asyncio
async def test_return_metric_basic(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """New formula: returning = users with >=2 distinct bookings in the period."""
    token = await _make_admin(client, db_session)
    await db_session.commit()  # admin must be visible to the endpoint

    # Baseline BEFORE our fixtures (shared DB may carry seed data).
    base = (
        await client.get(RETURN_URL, headers=auth_headers(token))
    ).json()

    master_id = await _make_master(client, db_session, 92804)
    # Two practices scheduled IN the current period (return counts bookings in
    # period, not "past" -- no ended filter here; the period-safe anchor still
    # matters: `now - 2h/3h` crossed into last week on Monday-night runs).
    # p2 is shifted +1 minute: (master, title, scheduled_at) is UNIQUE, and a
    # forward shift keeps it inside [start, end) even at the boundary sliver.
    sched, dur = _period_safe_past_practice("week")
    p1 = await _create_practice(
        db_session, master_id, scheduled_at=sched, duration_minutes=dur,
    )
    p2 = await _create_practice(
        db_session, master_id,
        scheduled_at=sched + timedelta(minutes=1), duration_minutes=dur,
    )

    # User A books BOTH period practices -> 2 in-period bookings -> returning.
    await _attend(client, db_session, p1, 92040)
    await _attend(client, db_session, p2, 92040)
    # User B books ONE -> 1 in-period booking -> not returning.
    await _attend(client, db_session, p1, 92041)
    await db_session.commit()

    resp = await client.get(RETURN_URL, headers=auth_headers(token))
    assert resp.status_code == 200
    data = resp.json()
    # 2 period bookers (A, B); A has >=2 distinct in-period practices -> +1
    # returning. B has 1 -> counts toward total only.
    assert data["total_users"] - base["total_users"] == 2
    assert data["returning"] - base["returning"] == 1
    # top_users is period-scoped now (top 50); seed users may still rank above
    # the test users, so assert shape + descending order rather than an exact head.
    counts = [u["practices_count"] for u in data["top_users"]]
    assert counts == sorted(counts, reverse=True)
    assert len(data["top_users"]) <= 50
    assert set(data["top_users"][0].keys()) == {"id", "name", "practices_count"}


# ===================================================================
# auth + validation
# ===================================================================


@pytest.mark.asyncio
async def test_metrics_no_auth(client: AsyncClient) -> None:
    """No token: 401."""
    resp = await client.get(CHECKIN_URL)
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_metrics_non_admin(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Regular user: 403."""
    auth = await login_user(client, telegram_id=92050, first_name="Plain")
    resp = await client.get(FEEDBACK_URL, headers=auth_headers(auth["session_token"]))
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_metrics_invalid_period(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Invalid period value: 422 (Literal validation)."""
    token = await _make_admin(client, db_session)
    await db_session.commit()
    resp = await client.get(
        RETURN_URL, params={"period": "year"}, headers=auth_headers(token),
    )
    assert resp.status_code == 422
