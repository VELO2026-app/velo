# =============================================================================
# VELO Backend -- Tests: Diary Feedbacks (Phase 8.2)
# =============================================================================
#
# telegram_id range: 86000-86999
#
# Coverage:
#   - POST /practices/{id}/feedback (upsert)
#   - GET /users/me/feedbacks (paginated, filtered)
#   - Practice must be completed
#   - Booking must be attended
#   - Window validation (72h after practice end)
#   - Upsert semantics (create, then update)
#   - Comment length validation
#   - Auth checks (401, no booking 404)
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.diary.models import Feedback
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice, PracticeStatus, PracticeType
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, login_user, full_cleanup_range

FEEDBACK_URL = "/api/v1/practices/{practice_id}/feedback"
MY_FEEDBACKS_URL = "/api/v1/users/me/feedbacks"

# telegram_id range for this test file.

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """Clean all test data before/after each test (TD-032: ORM, no raw SQL)."""
    await _do_cleanup(db_session)
    yield
    await _do_cleanup(db_session)


async def _do_cleanup(session: AsyncSession) -> None:
    """Full ORM cleanup for telegram_id 86000-86999."""
    await full_cleanup_range(session, 86000, 86999, delete_users=True)
    await session.commit()

# ===================================================================
# Helpers
# ===================================================================


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int = 86900,
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
    """Create a completed practice for testing.

    Defaults to a practice that ended 1 hour ago
    (well within the 72h feedback window).
    """
    if scheduled_at is None:
        # Ended 1 hour ago: scheduled 2h ago, duration 60 min.
        scheduled_at = datetime.now(UTC) - timedelta(hours=2)

    practice = Practice(
        master_id=master_id,
        title="Test Practice",
        description="Test description",
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


async def _create_attended_booking(
    db_session: AsyncSession,
    user_id: str,
    practice_id,
) -> Booking:
    """Create an attended booking for testing."""
    booking = Booking(
        practice_id=practice_id,
        user_id=user_id,
        status=BookingStatus.ATTENDED.value,
        joined_at=datetime.now(UTC) - timedelta(hours=2),
    )
    db_session.add(booking)
    await db_session.flush()
    return booking


# ===================================================================
# POST /practices/{id}/feedback -- happy path (create)
# ===================================================================


@pytest.mark.asyncio
async def test_feedback_create_success(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Create a new feedback: 200, rating saved."""
    master_auth = await _make_verified_master(
        client, db_session, telegram_id=86901,
    )
    auth = await login_user(client, telegram_id=86001, first_name="User")

    practice = await _create_completed_practice(
        db_session, master_auth["user"]["id"],
    )
    await _create_attended_booking(
        db_session, auth["user"]["id"], practice.id,
    )
    await db_session.commit()

    url = FEEDBACK_URL.format(practice_id=practice.id)
    resp = await client.post(
        url,
        json={"rating": 9, "comment": "Amazing practice!"},
        headers=auth_headers(auth["session_token"]),
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["rating"] == 9
    assert data["comment"] == "Amazing practice!"
    assert data["practice_id"] == str(practice.id)
    assert data["user_id"] == auth["user"]["id"]


# ===================================================================
# POST /practices/{id}/feedback -- resubmission forbidden (immutable)
# ===================================================================


@pytest.mark.asyncio
async def test_feedback_resubmission_rejected(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A second feedback for the same (practice, user) is rejected (409).

    Feedback is a recorded data point: it can never be overwritten. The
    original rating/comment must remain exactly as first submitted.
    """
    master_auth = await _make_verified_master(
        client, db_session, telegram_id=86902,
    )
    auth = await login_user(client, telegram_id=86002, first_name="User2")

    practice = await _create_completed_practice(
        db_session, master_auth["user"]["id"],
    )
    await _create_attended_booking(
        db_session, auth["user"]["id"], practice.id,
    )
    await db_session.commit()

    url = FEEDBACK_URL.format(practice_id=practice.id)
    headers = auth_headers(auth["session_token"])

    # First feedback -- recorded.
    resp1 = await client.post(
        url, json={"rating": 6, "comment": "first and only"},
        headers=headers,
    )
    assert resp1.status_code == 200
    feedback_id = resp1.json()["id"]

    # Second feedback -- must be rejected, original untouched.
    resp2 = await client.post(
        url,
        json={"rating": 9, "comment": "tampered"},
        headers=headers,
    )
    assert resp2.status_code == 409

    # Verify the stored row is still the first one, unchanged.
    detail = await client.get(
        f"{MY_FEEDBACKS_URL}/{feedback_id}", headers=headers,
    )
    assert detail.status_code == 200
    data = detail.json()
    assert data["id"] == feedback_id
    assert data["rating"] == 6
    assert data["comment"] == "first and only"


# ===================================================================
# POST /practices/{id}/feedback -- no attended booking (404)
# ===================================================================


@pytest.mark.asyncio
async def test_feedback_no_attended_booking(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """No attended booking for this practice: 404."""
    master_auth = await _make_verified_master(
        client, db_session, telegram_id=86903,
    )
    auth = await login_user(client, telegram_id=86003, first_name="User3")

    practice = await _create_completed_practice(
        db_session, master_auth["user"]["id"],
    )
    await db_session.commit()

    url = FEEDBACK_URL.format(practice_id=practice.id)
    resp = await client.post(
        url,
        json={"rating": 6},
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 404


# ===================================================================
# POST /practices/{id}/feedback -- confirmed but not attended (404)
# ===================================================================


@pytest.mark.asyncio
async def test_feedback_confirmed_not_attended(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Confirmed (not attended) booking: 404."""
    master_auth = await _make_verified_master(
        client, db_session, telegram_id=86904,
    )
    auth = await login_user(client, telegram_id=86004, first_name="User4")

    practice = await _create_completed_practice(
        db_session, master_auth["user"]["id"],
    )
    # Create confirmed (not attended) booking.
    booking = Booking(
        practice_id=practice.id,
        user_id=auth["user"]["id"],
        status=BookingStatus.CONFIRMED.value,
    )
    db_session.add(booking)
    await db_session.commit()

    url = FEEDBACK_URL.format(practice_id=practice.id)
    resp = await client.post(
        url,
        json={"rating": 6},
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 404


# ===================================================================
# POST /practices/{id}/feedback -- practice not completed (400)
# ===================================================================


@pytest.mark.asyncio
async def test_feedback_practice_not_completed(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Practice is scheduled (not completed): 400."""
    master_auth = await _make_verified_master(
        client, db_session, telegram_id=86905,
    )
    auth = await login_user(client, telegram_id=86005, first_name="User5")

    # Create a scheduled (not completed) practice.
    practice = Practice(
        master_id=master_auth["user"]["id"],
        title="Scheduled Practice",
        description="Not done yet",
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
    await db_session.flush()

    # Create attended booking (edge case: booking somehow attended
    # for non-completed practice -- service should still reject).
    await _create_attended_booking(
        db_session, auth["user"]["id"], practice.id,
    )
    await db_session.commit()

    url = FEEDBACK_URL.format(practice_id=practice.id)
    resp = await client.post(
        url,
        json={"rating": 9},
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 400


# ===================================================================
# POST /practices/{id}/feedback -- window closed (400)
# ===================================================================


@pytest.mark.asyncio
async def test_feedback_window_closed(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Practice ended > 72h ago: feedback window closed, 400."""
    master_auth = await _make_verified_master(
        client, db_session, telegram_id=86906,
    )
    auth = await login_user(client, telegram_id=86006, first_name="User6")

    # Practice ended 4 days ago (well outside 72h window).
    practice = await _create_completed_practice(
        db_session,
        master_auth["user"]["id"],
        scheduled_at=datetime.now(UTC) - timedelta(days=5),
        duration_minutes=60,
    )
    await _create_attended_booking(
        db_session, auth["user"]["id"], practice.id,
    )
    await db_session.commit()

    url = FEEDBACK_URL.format(practice_id=practice.id)
    resp = await client.post(
        url,
        json={"rating": 6},
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 400


# ===================================================================
# POST /practices/{id}/feedback -- no auth (401)
# ===================================================================


@pytest.mark.asyncio
async def test_feedback_no_auth(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """No Authorization header: 401."""
    url = FEEDBACK_URL.format(practice_id=uuid4())
    resp = await client.post(url, json={"rating": 9})
    assert resp.status_code == 401


# ===================================================================
# POST /practices/{id}/feedback -- invalid rating (422)
# ===================================================================


@pytest.mark.asyncio
async def test_feedback_invalid_rating(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Invalid rating value: 422."""
    auth = await login_user(client, telegram_id=86007, first_name="User7")
    url = FEEDBACK_URL.format(practice_id=uuid4())
    resp = await client.post(
        url,
        json={"rating": 11},
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 422


# ===================================================================
# POST /practices/{id}/feedback -- comment too long (422)
# ===================================================================


@pytest.mark.asyncio
async def test_feedback_comment_too_long(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Comment exceeds 1000 chars: 422."""
    auth = await login_user(client, telegram_id=86008, first_name="User8")
    url = FEEDBACK_URL.format(practice_id=uuid4())
    resp = await client.post(
        url,
        json={"rating": 9, "comment": "x" * 1001},
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 422


# ===================================================================
# POST /practices/{id}/feedback -- without comment (200)
# ===================================================================


@pytest.mark.asyncio
async def test_feedback_without_comment(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Feedback without comment: 200, comment is null."""
    master_auth = await _make_verified_master(
        client, db_session, telegram_id=86907,
    )
    auth = await login_user(client, telegram_id=86009, first_name="User9")

    practice = await _create_completed_practice(
        db_session, master_auth["user"]["id"],
    )
    await _create_attended_booking(
        db_session, auth["user"]["id"], practice.id,
    )
    await db_session.commit()

    url = FEEDBACK_URL.format(practice_id=practice.id)
    resp = await client.post(
        url,
        json={"rating": 2},
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["rating"] == 2
    assert data["comment"] is None


# ===================================================================
# GET /users/me/feedbacks -- list success
# ===================================================================


@pytest.mark.asyncio
async def test_list_feedbacks_success(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """List feedbacks: returns paginated response."""
    master_auth = await _make_verified_master(
        client, db_session, telegram_id=86908,
    )
    auth = await login_user(client, telegram_id=86010, first_name="User10")

    # Create 2 completed practices with attended bookings.
    for i in range(2):
        practice = await _create_completed_practice(
            db_session,
            master_auth["user"]["id"],
            scheduled_at=datetime.now(UTC) - timedelta(hours=2 + i),
        )
        await _create_attended_booking(
            db_session, auth["user"]["id"], practice.id,
        )

    await db_session.commit()

    # Submit feedbacks via API.
    # We need the practice IDs, so query them.
    result = await db_session.execute(
        select(Practice)
        .where(Practice.master_id == master_auth["user"]["id"])
        .order_by(Practice.scheduled_at.desc())
    )
    practices = list(result.scalars().all())

    for p in practices:
        url = FEEDBACK_URL.format(practice_id=p.id)
        resp = await client.post(
            url,
            json={"rating": 9},
            headers=auth_headers(auth["session_token"]),
        )
        assert resp.status_code == 200

    # List feedbacks.
    resp = await client.get(
        MY_FEEDBACKS_URL,
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 2
    assert len(data["items"]) == 2
    assert "limit" in data
    assert "offset" in data


# ===================================================================
# GET /users/me/feedbacks -- filter by practice_id
# ===================================================================


@pytest.mark.asyncio
async def test_list_feedbacks_filter_practice(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Filter feedbacks by practice_id."""
    master_auth = await _make_verified_master(
        client, db_session, telegram_id=86909,
    )
    auth = await login_user(client, telegram_id=86011, first_name="User11")

    # Two practices.
    p1 = await _create_completed_practice(
        db_session,
        master_auth["user"]["id"],
        scheduled_at=datetime.now(UTC) - timedelta(hours=3),
    )
    p2 = await _create_completed_practice(
        db_session,
        master_auth["user"]["id"],
        scheduled_at=datetime.now(UTC) - timedelta(hours=2),
    )
    await _create_attended_booking(db_session, auth["user"]["id"], p1.id)
    await _create_attended_booking(db_session, auth["user"]["id"], p2.id)
    await db_session.commit()

    # Submit feedbacks.
    for p in [p1, p2]:
        url = FEEDBACK_URL.format(practice_id=p.id)
        await client.post(
            url,
            json={"rating": 6},
            headers=auth_headers(auth["session_token"]),
        )

    # Filter by p1.
    resp = await client.get(
        f"{MY_FEEDBACKS_URL}?practice_id={p1.id}",
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["practice_id"] == str(p1.id)


# ===================================================================
# GET /users/me/feedbacks -- filter by rating
# ===================================================================


@pytest.mark.asyncio
async def test_list_feedbacks_filter_rating(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Filter feedbacks by rating."""
    master_auth = await _make_verified_master(
        client, db_session, telegram_id=86910,
    )
    auth = await login_user(client, telegram_id=86012, first_name="User12")

    # Two practices, different ratings.
    p1 = await _create_completed_practice(
        db_session,
        master_auth["user"]["id"],
        scheduled_at=datetime.now(UTC) - timedelta(hours=3),
    )
    p2 = await _create_completed_practice(
        db_session,
        master_auth["user"]["id"],
        scheduled_at=datetime.now(UTC) - timedelta(hours=2),
    )
    await _create_attended_booking(db_session, auth["user"]["id"], p1.id)
    await _create_attended_booking(db_session, auth["user"]["id"], p2.id)
    await db_session.commit()

    # Raw 9 for p1, raw 2 for p2 (the filter is the raw 1..10 score).
    await client.post(
        FEEDBACK_URL.format(practice_id=p1.id),
        json={"rating": 9},
        headers=auth_headers(auth["session_token"]),
    )
    await client.post(
        FEEDBACK_URL.format(practice_id=p2.id),
        json={"rating": 2},
        headers=auth_headers(auth["session_token"]),
    )

    # Filter by fire.
    resp = await client.get(
        f"{MY_FEEDBACKS_URL}?rating=9",
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["rating"] == 9


# ===================================================================
# GET /users/me/feedbacks -- pagination
# ===================================================================


@pytest.mark.asyncio
async def test_list_feedbacks_pagination(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Pagination limit/offset works correctly."""
    master_auth = await _make_verified_master(
        client, db_session, telegram_id=86911,
    )
    auth = await login_user(client, telegram_id=86013, first_name="User13")

    # Three practices.
    practices = []
    for i in range(3):
        p = await _create_completed_practice(
            db_session,
            master_auth["user"]["id"],
            scheduled_at=datetime.now(UTC) - timedelta(hours=2 + i),
        )
        await _create_attended_booking(
            db_session, auth["user"]["id"], p.id,
        )
        practices.append(p)
    await db_session.commit()

    # Submit feedbacks.
    for p in practices:
        await client.post(
            FEEDBACK_URL.format(practice_id=p.id),
            json={"rating": 6},
            headers=auth_headers(auth["session_token"]),
        )

    # Page 1.
    resp = await client.get(
        f"{MY_FEEDBACKS_URL}?limit=2&offset=0",
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 3
    assert len(data["items"]) == 2
    assert data["limit"] == 2
    assert data["offset"] == 0

    # Page 2.
    resp2 = await client.get(
        f"{MY_FEEDBACKS_URL}?limit=2&offset=2",
        headers=auth_headers(auth["session_token"]),
    )
    assert resp2.status_code == 200
    data2 = resp2.json()
    assert len(data2["items"]) == 1


# ===================================================================
# GET /users/me/feedbacks -- no auth (401)
# ===================================================================


@pytest.mark.asyncio
async def test_list_feedbacks_no_auth(
    client: AsyncClient,
) -> None:
    """No auth: 401."""
    resp = await client.get(MY_FEEDBACKS_URL)
    assert resp.status_code == 401
