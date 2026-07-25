# =============================================================================
# VELO Backend -- Tests: Practice Insights (Phase 8.4)
# =============================================================================
#
# telegram_id range: 88000-88999
#
# Coverage:
#   - GET /practices/{id}/insights (happy path, distributions, counts)
#   - Master ownership check (not owner -> 404)
#   - Practice must be completed (400)
#   - Practice not found (404)
#   - No auth (401)
#   - Empty data (no checkins/feedbacks -> all zeros)
#   - Multiple users with different moods/ratings
#   - Comments count (only feedback comments)
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.bookings.models import Booking, BookingStatus
from app.modules.diary.models import Checkin, CheckType, Feedback
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice, PracticeStatus, PracticeType
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, login_user

INSIGHTS_URL = "/api/v1/practices/{practice_id}/insights"

# telegram_id range for this test file.
_TID_MIN = 88000
_TID_MAX = 88999


# ===================================================================
# Cleanup
# ===================================================================


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """Clean test data before/after each test in FK-safe order."""
    await _do_cleanup(db_session)
    yield
    await _do_cleanup(db_session)


async def _do_cleanup(session: AsyncSession) -> None:
    """Delete all test entities for telegram_id 88000-88999."""
    await session.rollback()

    user_ids_subq = (
        select(User.id).where(
            User.telegram_id.between(_TID_MIN, _TID_MAX),
        )
    )

    # 1. feedbacks (FK -> bookings, practices, users).
    await session.execute(
        Feedback.__table__.delete().where(
            Feedback.user_id.in_(user_ids_subq),
        )
    )
    # 2. checkins (FK -> bookings, practices, users).
    await session.execute(
        Checkin.__table__.delete().where(
            Checkin.user_id.in_(user_ids_subq),
        )
    )
    # 3. audit_logs for our users.
    from app.core.audit import AuditLog
    await session.execute(
        AuditLog.__table__.delete().where(
            AuditLog.actor_id.in_(user_ids_subq),
        )
    )
    # 4. bookings (FK -> practices, users).
    await session.execute(
        Booking.__table__.delete().where(
            Booking.user_id.in_(user_ids_subq),
        )
    )
    # 5. practices (FK -> master_profiles).
    await session.execute(
        Practice.__table__.delete().where(
            Practice.master_id.in_(user_ids_subq),
        )
    )
    # 6. master_profiles (FK -> users).
    await session.execute(
        MasterProfile.__table__.delete().where(
            MasterProfile.user_id.in_(user_ids_subq),
        )
    )
    # 7. users.
    await session.execute(
        User.__table__.delete().where(
            User.telegram_id.between(_TID_MIN, _TID_MAX),
        )
    )
    await session.commit()


# ===================================================================
# Helpers
# ===================================================================


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int = 88900,
) -> dict:
    """Create a verified master and return auth dict."""
    auth = await login_user(client, telegram_id=telegram_id, first_name="Master")
    user_id = auth["user"]["id"]

    user = await db_session.get(User, user_id)
    user.role = UserRole.MASTER
    await db_session.flush()

    profile = MasterProfile(
        user_id=user_id,
        data={
            "account": {"status": "verified"},
            "profile": {"bio": "Test master"},
        },
    )
    db_session.add(profile)
    await db_session.flush()

    return auth


async def _create_completed_practice(
    db_session: AsyncSession,
    master_id: str,
    *,
    scheduled_at: datetime | None = None,
    duration_minutes: int = 60,
) -> Practice:
    """Create a completed practice."""
    if scheduled_at is None:
        scheduled_at = datetime.now(UTC) - timedelta(hours=3)

    practice = Practice(
        master_id=master_id,
        title="Insights Practice",
        description="For insights testing",
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


async def _add_participant(
    client: AsyncClient,
    db_session: AsyncSession,
    practice: Practice,
    telegram_id: int,
    *,
    mood: str | None = None,
    rating: str | None = None,
    feedback_comment: str | None = None,
) -> dict:
    """Register a user as attended participant, optionally with checkin/feedback.

    Creates user, attended booking, and optionally checkin + feedback
    directly in DB (bypassing API time window checks).
    """
    auth = await login_user(
        client, telegram_id=telegram_id, first_name=f"User{telegram_id}",
    )
    user_id = auth["user"]["id"]

    # Create attended booking.
    booking = Booking(
        practice_id=practice.id,
        user_id=user_id,
        status=BookingStatus.ATTENDED.value,
        joined_at=datetime.now(UTC) - timedelta(hours=2),
    )
    db_session.add(booking)
    await db_session.flush()

    # Optional checkin (direct DB insert, bypassing time window).
    if mood is not None:
        checkin = Checkin(
            practice_id=practice.id,
            user_id=user_id,
            booking_id=booking.id,
            mood=mood,
            check_type=CheckType.PRE.value,
        )
        db_session.add(checkin)
        await db_session.flush()

    # Optional feedback (direct DB insert, bypassing time window).
    if rating is not None:
        feedback = Feedback(
            practice_id=practice.id,
            user_id=user_id,
            booking_id=booking.id,
            rating=rating,
            comment=feedback_comment,
        )
        db_session.add(feedback)
        await db_session.flush()

    return auth


# ===================================================================
# GET /practices/{id}/insights -- happy path (full data)
# ===================================================================


@pytest.mark.asyncio
async def test_insights_full_data(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Master sees correct distributions and counts."""
    master_auth = await _make_verified_master(
        client, db_session, telegram_id=88901,
    )
    practice = await _create_completed_practice(
        db_session, master_auth["user"]["id"],
    )

    # 5 participants with varied data.
    await _add_participant(
        client, db_session, practice, 88001,
        mood=9, rating=9, feedback_comment="Loved it!",
    )
    await _add_participant(
        client, db_session, practice, 88002,
        mood=9, rating=9,
    )
    await _add_participant(
        client, db_session, practice, 88003,
        mood=6, rating=6, feedback_comment="Solid session.",
    )
    await _add_participant(
        client, db_session, practice, 88004,
        mood=2, rating=2,
    )
    # Participant 5: attended but no checkin/feedback.
    await _add_participant(
        client, db_session, practice, 88005,
    )
    await db_session.commit()

    url = INSIGHTS_URL.format(practice_id=practice.id)
    resp = await client.get(
        url,
        headers=auth_headers(master_auth["session_token"]),
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["practice_id"] == str(practice.id)
    assert data["participants"] == 5

    assert data["checkins"]["high"] == 2
    assert data["checkins"]["mid"] == 1
    assert data["checkins"]["low"] == 1

    assert data["feedbacks"]["fire"] == 2
    assert data["feedbacks"]["good"] == 1
    assert data["feedbacks"]["confused"] == 1

    # Only 2 feedback comments (non-null).
    assert data["comments_count"] == 2


# ===================================================================
# GET /practices/{id}/insights -- empty data (all zeros)
# ===================================================================


@pytest.mark.asyncio
async def test_insights_empty_data(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Completed practice with no participants: all zeros."""
    master_auth = await _make_verified_master(
        client, db_session, telegram_id=88902,
    )
    practice = await _create_completed_practice(
        db_session, master_auth["user"]["id"],
    )
    await db_session.commit()

    url = INSIGHTS_URL.format(practice_id=practice.id)
    resp = await client.get(
        url,
        headers=auth_headers(master_auth["session_token"]),
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["participants"] == 0
    assert data["checkins"] == {"high": 0, "mid": 0, "low": 0}
    assert data["feedbacks"] == {"fire": 0, "good": 0, "confused": 0}
    assert data["comments_count"] == 0


# ===================================================================
# GET /practices/{id}/insights -- not the owner (404, P-08)
# ===================================================================


@pytest.mark.asyncio
async def test_insights_not_owner(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Another master tries to access insights: 404."""
    master1 = await _make_verified_master(
        client, db_session, telegram_id=88903,
    )
    master2 = await _make_verified_master(
        client, db_session, telegram_id=88904,
    )

    practice = await _create_completed_practice(
        db_session, master1["user"]["id"],
    )
    await db_session.commit()

    url = INSIGHTS_URL.format(practice_id=practice.id)
    resp = await client.get(
        url,
        headers=auth_headers(master2["session_token"]),
    )
    assert resp.status_code == 404


# ===================================================================
# GET /practices/{id}/insights -- regular user (403)
# ===================================================================


@pytest.mark.asyncio
async def test_insights_regular_user(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Regular user tries to access insights: 403 at the role guard.

    ПРОМТ №575: the endpoint switched from get_current_user to
    get_current_master (defense-in-depth), so a non-master is now rejected
    at the dependency before the handler (and the 404 ownership check in
    get_practice_insights) ever runs. See test_insights_not_owner below for
    the still-404 case of a DIFFERENT master querying this practice.
    """
    master_auth = await _make_verified_master(
        client, db_session, telegram_id=88905,
    )
    user_auth = await login_user(
        client, telegram_id=88006, first_name="RegularUser",
    )

    practice = await _create_completed_practice(
        db_session, master_auth["user"]["id"],
    )
    await db_session.commit()

    url = INSIGHTS_URL.format(practice_id=practice.id)
    resp = await client.get(
        url,
        headers=auth_headers(user_auth["session_token"]),
    )
    assert resp.status_code == 403


# ===================================================================
# GET /practices/{id}/insights -- practice not completed (400)
# ===================================================================


@pytest.mark.asyncio
async def test_insights_practice_not_completed(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Scheduled (not completed) practice: 400."""
    master_auth = await _make_verified_master(
        client, db_session, telegram_id=88906,
    )

    practice = Practice(
        master_id=master_auth["user"]["id"],
        title="Scheduled Practice",
        description="Not done",
        practice_type=PracticeType.LIVE.value,
        status=PracticeStatus.SCHEDULED.value,
        scheduled_at=datetime.now(UTC) + timedelta(hours=2),
        duration_minutes=60,
        timezone="UTC",
        max_participants=20,
        current_participants=0,
        is_free=True,
        price_cents=0,
        currency="eur",
    )
    db_session.add(practice)
    await db_session.commit()

    url = INSIGHTS_URL.format(practice_id=practice.id)
    resp = await client.get(
        url,
        headers=auth_headers(master_auth["session_token"]),
    )
    assert resp.status_code == 400


# ===================================================================
# GET /practices/{id}/insights -- practice not found (404)
# ===================================================================


@pytest.mark.asyncio
async def test_insights_practice_not_found(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Non-existent practice ID: 404."""
    master_auth = await _make_verified_master(
        client, db_session, telegram_id=88907,
    )
    # ПРОМТ №583: _make_verified_master only flushes -- the role=MASTER
    # change and the MasterProfile row must be COMMITTED before the request
    # below, which hits get_current_master through a separate DB connection.
    # Without this, the guard sees the old (non-master) role and rejects
    # with 403 before ever reaching the 404 not-found branch this test
    # means to exercise (mirrors test_insights_not_owner's own commit()).
    await db_session.commit()

    url = INSIGHTS_URL.format(practice_id=uuid4())
    resp = await client.get(
        url,
        headers=auth_headers(master_auth["session_token"]),
    )
    assert resp.status_code == 404


# ===================================================================
# GET /practices/{id}/insights -- no auth (401)
# ===================================================================


@pytest.mark.asyncio
async def test_insights_no_auth(
    client: AsyncClient,
) -> None:
    """No auth: 401."""
    url = INSIGHTS_URL.format(practice_id=uuid4())
    resp = await client.get(url)
    assert resp.status_code == 401


# ===================================================================
# GET /practices/{id}/insights -- only attended count as participants
# ===================================================================


@pytest.mark.asyncio
async def test_insights_only_attended_participants(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Only attended bookings count as participants, not confirmed/no_show."""
    master_auth = await _make_verified_master(
        client, db_session, telegram_id=88908,
    )
    practice = await _create_completed_practice(
        db_session, master_auth["user"]["id"],
    )

    # 1 attended.
    await _add_participant(
        client, db_session, practice, 88007,
        rating=9,
    )

    # 1 confirmed (not attended).
    user2 = await login_user(
        client, telegram_id=88008, first_name="Confirmed",
    )
    booking_confirmed = Booking(
        practice_id=practice.id,
        user_id=user2["user"]["id"],
        status=BookingStatus.CONFIRMED.value,
    )
    db_session.add(booking_confirmed)

    # 1 no_show.
    user3 = await login_user(
        client, telegram_id=88009, first_name="NoShow",
    )
    booking_noshow = Booking(
        practice_id=practice.id,
        user_id=user3["user"]["id"],
        status=BookingStatus.NO_SHOW.value,
    )
    db_session.add(booking_noshow)

    # 1 cancelled.
    user4 = await login_user(
        client, telegram_id=88010, first_name="Cancelled",
    )
    booking_cancelled = Booking(
        practice_id=practice.id,
        user_id=user4["user"]["id"],
        status=BookingStatus.CANCELLED.value,
    )
    db_session.add(booking_cancelled)

    await db_session.commit()

    url = INSIGHTS_URL.format(practice_id=practice.id)
    resp = await client.get(
        url,
        headers=auth_headers(master_auth["session_token"]),
    )

    assert resp.status_code == 200
    data = resp.json()
    # Only 1 attended booking counts.
    assert data["participants"] == 1
    assert data["feedbacks"]["fire"] == 1


# ===================================================================
# GET /practices/{id}/insights -- no user data exposed (anonymity)
# ===================================================================


@pytest.mark.asyncio
async def test_insights_no_user_data_exposed(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Response contains only aggregated numbers, no user info."""
    master_auth = await _make_verified_master(
        client, db_session, telegram_id=88909,
    )
    practice = await _create_completed_practice(
        db_session, master_auth["user"]["id"],
    )
    await _add_participant(
        client, db_session, practice, 88011,
        mood=9, rating=9, feedback_comment="Secret thoughts",
    )
    await db_session.commit()

    url = INSIGHTS_URL.format(practice_id=practice.id)
    resp = await client.get(
        url,
        headers=auth_headers(master_auth["session_token"]),
    )

    assert resp.status_code == 200
    data = resp.json()
    raw = resp.text

    # No user IDs, names, or comment texts in response.
    assert "user_id" not in data
    assert "comment" not in data
    assert "Secret thoughts" not in raw
    assert "booking_id" not in data

    # Only expected keys.
    expected_keys = {
        "practice_id", "participants", "checkins",
        "feedbacks", "comments_count",
    }
    assert set(data.keys()) == expected_keys
