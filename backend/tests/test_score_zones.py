# =============================================================================
# VELO Backend -- Tests: the five score zones (BE-77)
# =============================================================================
#
# telegram_id range: 72770-72799 (checked free against
# tests/telegram_id_bands.py before it was claimed).
#
# Owner decision (BE-77, 2026-10-02): every server surface splits a stored
# 1..10 mood / rating into ONE five-zone scale -- bad 1-2, low 3-4,
# neutral 5-6, good 7-8, fire 9-10, keyed like the frontend's moodScale.ts
# -- and "needs attention" is a rating of 1-4. diary.insights_service owns
# the boundaries; this file pins the source directly (there were no direct
# tests of it before), the one feed that had no attention test, and the
# notification emoji map's completeness.
#
# What this file does NOT build: a score outside 1..10. It is unreachable
# (ck_checkin_mood / ck_feedback_rating CHECKs, Query(ge=1, le=10), the
# request schemas), and a test that fabricated one would document the
# impossible (owner ruling at the BE-77 gate).
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.bookings.models import Booking, BookingStatus
from app.modules.diary.insights_service import (
    ATTENTION_RATING_MAX,
    score_zone,
    zone_counts,
)
from app.modules.diary.models import Feedback, ScoreZone
from app.modules.diary.notify_master import _BUCKET_EMOJI
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice, PracticeStatus, PracticeType
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user

MASTER_REVIEWS_URL = "/api/v1/masters/me/reviews"

_TID_MIN = 72770
_TID_MAX = 72799

# Each test owns its own ids: the cleanup's DELETE sits uncommitted in the
# test's session, so a second test re-inserting the SAME telegram_id through
# the app would wait on it (measured: a hang, not a failure).
_TID_MASTER_A, _TID_REVIEWERS_A = 72770, 72771
_TID_MASTER_B, _TID_REVIEWERS_B = 72780, 72781

# The whole grid, written out rather than computed: a computed expectation
# would share the formula under test.
_GRID: dict[int, ScoreZone] = {
    1: ScoreZone.BAD,
    2: ScoreZone.BAD,
    3: ScoreZone.LOW,
    4: ScoreZone.LOW,
    5: ScoreZone.NEUTRAL,
    6: ScoreZone.NEUTRAL,
    7: ScoreZone.GOOD,
    8: ScoreZone.GOOD,
    9: ScoreZone.FIRE,
    10: ScoreZone.FIRE,
}


# ===================================================================
# The source: score_zone / ATTENTION_RATING_MAX / zone_counts
# ===================================================================


def test_every_score_maps_to_its_zone() -> None:
    """1..10 -> zone, the full grid (boundaries 2|3, 4|5, 6|7, 8|9)."""
    assert {score: score_zone(score) for score in range(1, 11)} == _GRID


@pytest.mark.parametrize(
    ("below", "above"),
    [(2, 3), (4, 5), (6, 7), (8, 9)],
)
def test_each_boundary_separates_two_zones(below: int, above: int) -> None:
    """Both sides of every boundary, named one by one so a failure says which."""
    assert score_zone(below) is _GRID[below]
    assert score_zone(above) is _GRID[above]
    assert score_zone(below) is not score_zone(above)


def test_attention_is_ratings_one_to_four() -> None:
    """The threshold is the top of "low": 4 needs attention, 5 does not."""
    assert ATTENTION_RATING_MAX == 4
    attention = {s for s in range(1, 11) if s <= ATTENTION_RATING_MAX}
    assert attention == {1, 2, 3, 4}
    # The pair: the scores it names are exactly the two lowest zones.
    assert {score_zone(s) for s in attention} == {ScoreZone.BAD, ScoreZone.LOW}


def test_the_zone_keys_are_the_frontend_moodscale_keys() -> None:
    """The contract keys, in scale order (utils/moodScale.ts MOOD_SCALE_KEYS)."""
    assert [z.value for z in ScoreZone] == ["bad", "low", "neutral", "good", "fire"]


def test_zone_counts_empty_is_all_five_zeros() -> None:
    """EMPTINESS: no rows -> every zone present at 0, nothing else."""
    assert zone_counts([]) == {
        "bad": 0, "low": 0, "neutral": 0, "good": 0, "fire": 0,
    }


def test_zone_counts_repeat_folds_into_one_zone() -> None:
    """REPEAT: the same score many times, and two scores of one zone, add up."""
    assert zone_counts([(10, 7), (9, 3)]) == {
        "bad": 0, "low": 0, "neutral": 0, "good": 0, "fire": 10,
    }


def test_zone_counts_shortage_leaves_missing_zones_at_zero() -> None:
    """SHORTAGE: scores in only some zones -> the rest stay 0, all five keys."""
    assert zone_counts([(4, 1), (7, 2)]) == {
        "bad": 0, "low": 1, "neutral": 0, "good": 2, "fire": 0,
    }


# ===================================================================
# The notification emoji map
# ===================================================================


def test_emoji_map_covers_exactly_the_five_zones() -> None:
    """_BUCKET_EMOJI is indexed directly (no fallback): it must be complete.

    The owner chose a suite check over an import-time check (BE-77 gate):
    the map is read as `_BUCKET_EMOJI[zone]` inside the participant's write
    transaction, so a missing zone would be a KeyError there. This test is
    what keeps that impossible.
    """
    assert set(_BUCKET_EMOJI) == set(ScoreZone)


def test_emoji_map_is_the_owner_set() -> None:
    """The five emoji the owner decided (BE-77, decision 4), one per zone."""
    assert _BUCKET_EMOJI == {
        ScoreZone.BAD: "😣",
        ScoreZone.LOW: "😕",
        ScoreZone.NEUTRAL: "😐",
        ScoreZone.GOOD: "🙂",
        ScoreZone.FIRE: "🔥",
    }


# ===================================================================
# GET /masters/me/reviews?attention=true -- had no test before BE-77
# ===================================================================


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)


async def _make_verified_master(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int,
) -> dict:
    auth = await login_user(client, telegram_id=telegram_id, first_name="Master")
    user = await db_session.get(User, auth["user"]["id"])
    user.role = UserRole.MASTER
    db_session.add(
        MasterProfile(
            user_id=user.id,
            data={"account": {"status": "verified"}, "profile": {"bio": "m"}},
        )
    )
    await db_session.flush()
    return auth


async def _completed_practice(db_session: AsyncSession, master_id: str) -> Practice:
    practice = Practice(
        master_id=master_id,
        title="Zones Practice",
        description="x",
        practice_type=PracticeType.LIVE.value,
        status=PracticeStatus.COMPLETED.value,
        scheduled_at=datetime.now(UTC) - timedelta(hours=3),
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
    return practice


async def _review(
    client: AsyncClient,
    db_session: AsyncSession,
    practice: Practice,
    telegram_id: int,
    rating: int,
) -> None:
    auth = await login_user(client, telegram_id=telegram_id, first_name=f"R{rating}")
    booking = Booking(
        practice_id=practice.id,
        user_id=auth["user"]["id"],
        status=BookingStatus.ATTENDED.value,
        joined_at=datetime.now(UTC) - timedelta(hours=2),
    )
    db_session.add(booking)
    await db_session.flush()
    db_session.add(
        Feedback(
            practice_id=practice.id,
            user_id=auth["user"]["id"],
            booking_id=booking.id,
            rating=rating,
        )
    )
    await db_session.flush()


@pytest.mark.asyncio
async def test_master_reviews_attention_takes_four_not_five(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """attention=true on the cross-practice feed: 3 and 4 in, 5 out.

    The inputs straddle the new threshold (4|5) and include a 3, the old
    threshold's last member, so both the move from <= 3 and a move past 4
    are caught. The zone each item carries is asserted exactly.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER_A)
    practice = await _completed_practice(db_session, master["user"]["id"])
    for offset, rating in enumerate((3, 4, 5)):
        await _review(client, db_session, practice, _TID_REVIEWERS_A + offset, rating)
    await db_session.commit()

    headers = auth_headers(master["session_token"])

    everything = await client.get(MASTER_REVIEWS_URL, headers=headers)
    assert everything.status_code == 200
    assert everything.json()["total"] == 3

    attention = await client.get(
        MASTER_REVIEWS_URL, params={"attention": "true"}, headers=headers,
    )
    assert attention.status_code == 200
    data = attention.json()
    assert data["total"] == 2
    assert sorted(
        (item["reviewer_name"], item["rating"]) for item in data["items"]
    ) == [("R3", "low"), ("R4", "low")]


@pytest.mark.asyncio
async def test_master_reviews_attention_empty_when_all_ratings_are_fine(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """SHORTAGE on the filter: only 5+ ratings -> an empty attention page.

    Paired with the full feed carrying them, so "empty" is the filter's
    answer and not an empty fixture.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER_B)
    practice = await _completed_practice(db_session, master["user"]["id"])
    for offset, rating in enumerate((5, 9)):
        await _review(client, db_session, practice, _TID_REVIEWERS_B + offset, rating)
    await db_session.commit()

    headers = auth_headers(master["session_token"])
    everything = await client.get(MASTER_REVIEWS_URL, headers=headers)
    assert everything.json()["total"] == 2

    attention = await client.get(
        MASTER_REVIEWS_URL, params={"attention": "true"}, headers=headers,
    )
    assert attention.status_code == 200
    assert attention.json()["total"] == 0
    assert attention.json()["items"] == []
