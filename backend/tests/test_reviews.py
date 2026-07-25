# =============================================================================
# VELO Backend -- Tests: Practice Reviews (E1, NON-anonymous feedback)
# =============================================================================
#
# telegram_id range: 89000-89999
#
# Coverage:
#   - GET /practices/{id}/reviews (happy path: names, comments, buckets)
#   - rating -> bucket mapping (1-3 confused / 4-7 good / 8-10 fire)
#   - feedbacks without a comment are still listed
#   - newest-first ordering
#   - attention=true narrows to the negative bucket (rating 1-3)
#   - offset/limit pagination + total
#   - empty practice (no feedback -> empty list, total 0)
#   - master ownership check (not owner -> 404, P-08)
#   - regular user -> 404
#   - practice must be completed (400)
#   - practice not found (404)
#   - no auth (401)
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.bookings.models import Booking, BookingStatus
from app.modules.diary.models import Checkin, Feedback
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice, PracticeStatus, PracticeType
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, login_user

REVIEWS_URL = "/api/v1/practices/{practice_id}/reviews"

# telegram_id range for this test file.
_TID_MIN = 89000
_TID_MAX = 89999


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
    """Delete all test entities for telegram_id 89000-89999."""
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
    telegram_id: int = 89900,
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
        title="Reviews Practice",
        description="For reviews testing",
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


async def _add_review(
    client: AsyncClient,
    db_session: AsyncSession,
    practice: Practice,
    telegram_id: int,
    *,
    rating: int,
    comment: str | None = None,
    first_name: str | None = None,
    created_at: datetime | None = None,
) -> dict:
    """Register an attended participant who left a feedback (a "review").

    Creates user + attended booking + feedback directly in DB (bypassing the
    API time-window checks). `created_at` overrides the feedback timestamp so
    ordering can be asserted deterministically (otherwise all rows share the
    single transaction-time value from server_default).
    """
    auth = await login_user(
        client,
        telegram_id=telegram_id,
        first_name=first_name or f"User{telegram_id}",
    )
    user_id = auth["user"]["id"]

    booking = Booking(
        practice_id=practice.id,
        user_id=user_id,
        status=BookingStatus.ATTENDED.value,
        joined_at=datetime.now(UTC) - timedelta(hours=2),
    )
    db_session.add(booking)
    await db_session.flush()

    feedback = Feedback(
        practice_id=practice.id,
        user_id=user_id,
        booking_id=booking.id,
        rating=rating,
        comment=comment,
    )
    if created_at is not None:
        feedback.created_at = created_at
    db_session.add(feedback)
    await db_session.flush()

    return auth


# ===================================================================
# GET /practices/{id}/reviews -- happy path (names + comments + buckets)
# ===================================================================


@pytest.mark.asyncio
async def test_reviews_happy_path(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Master sees named reviews with comment text and bucketed ratings."""
    master_auth = await _make_verified_master(
        client, db_session, telegram_id=89900,
    )
    practice = await _create_completed_practice(
        db_session, master_auth["user"]["id"],
    )

    alice = await _add_review(
        client, db_session, practice, 89001,
        rating=9, comment="Loved it!", first_name="Alice",
    )
    bob = await _add_review(
        client, db_session, practice, 89002,
        rating=6, comment="Solid session.", first_name="Bob",
    )
    carol = await _add_review(
        client, db_session, practice, 89003,
        rating=2, comment="Confusing.", first_name="Carol",
    )
    await db_session.commit()

    url = REVIEWS_URL.format(practice_id=practice.id)
    resp = await client.get(
        url,
        headers=auth_headers(master_auth["session_token"]),
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 3
    assert data["limit"] == 20
    assert data["offset"] == 0
    assert len(data["items"]) == 3

    # Index by reviewer name for assertions.
    by_name = {item["reviewer_name"]: item for item in data["items"]}
    assert set(by_name) == {"Alice", "Bob", "Carol"}

    # rating -> bucket mapping (8-10 fire / 4-7 good / 1-3 confused).
    assert by_name["Alice"]["rating"] == "fire"
    assert by_name["Bob"]["rating"] == "good"
    assert by_name["Carol"]["rating"] == "confused"

    # Comment text is exposed (de-anonymised, unlike insights).
    assert by_name["Alice"]["comment"] == "Loved it!"

    # Each item carries the full review shape (incl. the reviewer user_id).
    item = data["items"][0]
    assert set(item.keys()) == {
        "user_id", "reviewer_name", "avatar_url", "rating", "comment",
        "created_at",
    }

    # user_id points at the actual reviewer (E1 remainder).
    assert by_name["Alice"]["user_id"] == alice["user"]["id"]
    assert by_name["Bob"]["user_id"] == bob["user"]["id"]
    assert by_name["Carol"]["user_id"] == carol["user"]["id"]


# ===================================================================
# GET /practices/{id}/reviews -- feedback without a comment is still listed
# ===================================================================


@pytest.mark.asyncio
async def test_reviews_include_feedback_without_comment(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A feedback with no comment is included; comment renders as null."""
    master_auth = await _make_verified_master(
        client, db_session, telegram_id=89901,
    )
    practice = await _create_completed_practice(
        db_session, master_auth["user"]["id"],
    )

    await _add_review(
        client, db_session, practice, 89004,
        rating=8, comment=None, first_name="Dave",
    )
    await db_session.commit()

    url = REVIEWS_URL.format(practice_id=practice.id)
    resp = await client.get(
        url,
        headers=auth_headers(master_auth["session_token"]),
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["reviewer_name"] == "Dave"
    assert data["items"][0]["comment"] is None
    assert data["items"][0]["rating"] == "fire"


# ===================================================================
# GET /practices/{id}/reviews -- newest-first ordering
# ===================================================================


@pytest.mark.asyncio
async def test_reviews_newest_first(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Reviews are returned ordered by created_at descending."""
    master_auth = await _make_verified_master(
        client, db_session, telegram_id=89902,
    )
    practice = await _create_completed_practice(
        db_session, master_auth["user"]["id"],
    )

    base = datetime.now(UTC) - timedelta(hours=5)
    await _add_review(
        client, db_session, practice, 89005,
        rating=7, comment="oldest", first_name="Old",
        created_at=base,
    )
    await _add_review(
        client, db_session, practice, 89006,
        rating=7, comment="middle", first_name="Mid",
        created_at=base + timedelta(hours=1),
    )
    await _add_review(
        client, db_session, practice, 89007,
        rating=7, comment="newest", first_name="New",
        created_at=base + timedelta(hours=2),
    )
    await db_session.commit()

    url = REVIEWS_URL.format(practice_id=practice.id)
    resp = await client.get(
        url,
        headers=auth_headers(master_auth["session_token"]),
    )

    assert resp.status_code == 200
    names = [item["reviewer_name"] for item in resp.json()["items"]]
    assert names == ["New", "Mid", "Old"]


# ===================================================================
# GET /practices/{id}/reviews -- attention=true narrows to negative bucket
# ===================================================================


@pytest.mark.asyncio
async def test_reviews_attention_filter(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """attention=true returns only rating 1-3 (the confused bucket)."""
    master_auth = await _make_verified_master(
        client, db_session, telegram_id=89903,
    )
    practice = await _create_completed_practice(
        db_session, master_auth["user"]["id"],
    )

    # fire (9), good (5), confused (3), confused (1).
    await _add_review(client, db_session, practice, 89008, rating=9, first_name="F")
    await _add_review(client, db_session, practice, 89009, rating=5, first_name="G")
    await _add_review(client, db_session, practice, 89010, rating=3, first_name="C1")
    await _add_review(client, db_session, practice, 89011, rating=1, first_name="C2")
    await db_session.commit()

    url = REVIEWS_URL.format(practice_id=practice.id)

    # Without filter: all 4.
    resp_all = await client.get(
        url,
        headers=auth_headers(master_auth["session_token"]),
    )
    assert resp_all.status_code == 200
    assert resp_all.json()["total"] == 4

    # With attention: only the two confused (rating <= 3).
    resp_att = await client.get(
        url,
        params={"attention": "true"},
        headers=auth_headers(master_auth["session_token"]),
    )
    assert resp_att.status_code == 200
    data = resp_att.json()
    assert data["total"] == 2
    assert {item["reviewer_name"] for item in data["items"]} == {"C1", "C2"}
    assert all(item["rating"] == "confused" for item in data["items"])


# ===================================================================
# GET /practices/{id}/reviews -- pagination (offset/limit + total)
# ===================================================================


@pytest.mark.asyncio
async def test_reviews_pagination(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """limit/offset paginate while total reflects the full set."""
    master_auth = await _make_verified_master(
        client, db_session, telegram_id=89904,
    )
    practice = await _create_completed_practice(
        db_session, master_auth["user"]["id"],
    )

    base = datetime.now(UTC) - timedelta(hours=5)
    for i in range(3):
        await _add_review(
            client, db_session, practice, 89020 + i,
            rating=7, first_name=f"P{i}",
            created_at=base + timedelta(hours=i),
        )
    await db_session.commit()

    url = REVIEWS_URL.format(practice_id=practice.id)

    page1 = await client.get(
        url,
        params={"limit": 2, "offset": 0},
        headers=auth_headers(master_auth["session_token"]),
    )
    assert page1.status_code == 200
    d1 = page1.json()
    assert d1["total"] == 3
    assert len(d1["items"]) == 2

    page2 = await client.get(
        url,
        params={"limit": 2, "offset": 2},
        headers=auth_headers(master_auth["session_token"]),
    )
    assert page2.status_code == 200
    d2 = page2.json()
    assert d2["total"] == 3
    assert len(d2["items"]) == 1


# ===================================================================
# GET /practices/{id}/reviews -- empty practice (no feedback)
# ===================================================================


@pytest.mark.asyncio
async def test_reviews_empty(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Completed practice with no feedback: empty list, total 0."""
    master_auth = await _make_verified_master(
        client, db_session, telegram_id=89905,
    )
    practice = await _create_completed_practice(
        db_session, master_auth["user"]["id"],
    )
    await db_session.commit()

    url = REVIEWS_URL.format(practice_id=practice.id)
    resp = await client.get(
        url,
        headers=auth_headers(master_auth["session_token"]),
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 0
    assert data["items"] == []


# ===================================================================
# GET /practices/{id}/reviews -- not the owner (404, P-08)
# ===================================================================


@pytest.mark.asyncio
async def test_reviews_not_owner(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Another master cannot read this practice's reviews: 404."""
    master1 = await _make_verified_master(
        client, db_session, telegram_id=89906,
    )
    master2 = await _make_verified_master(
        client, db_session, telegram_id=89907,
    )
    practice = await _create_completed_practice(
        db_session, master1["user"]["id"],
    )
    await db_session.commit()

    url = REVIEWS_URL.format(practice_id=practice.id)
    resp = await client.get(
        url,
        headers=auth_headers(master2["session_token"]),
    )
    assert resp.status_code == 404


# ===================================================================
# GET /practices/{id}/reviews -- regular user (403)
# ===================================================================


@pytest.mark.asyncio
async def test_reviews_regular_user(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Regular (non-master) user cannot read reviews: 403 at the role guard.

    ПРОМТ №575: the endpoint switched from get_current_user to
    get_current_master (defense-in-depth), so a non-master is rejected at
    the dependency before the 404 ownership check ever runs. See
    test_reviews_not_owner above for the still-404 case of a DIFFERENT
    master querying this practice.
    """
    master_auth = await _make_verified_master(
        client, db_session, telegram_id=89908,
    )
    user_auth = await login_user(
        client, telegram_id=89012, first_name="RegularUser",
    )
    practice = await _create_completed_practice(
        db_session, master_auth["user"]["id"],
    )
    await db_session.commit()

    url = REVIEWS_URL.format(practice_id=practice.id)
    resp = await client.get(
        url,
        headers=auth_headers(user_auth["session_token"]),
    )
    assert resp.status_code == 403


# ===================================================================
# GET /practices/{id}/reviews -- practice not completed (400)
# ===================================================================


@pytest.mark.asyncio
async def test_reviews_practice_not_completed(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Scheduled (not completed) practice: 400."""
    master_auth = await _make_verified_master(
        client, db_session, telegram_id=89909,
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

    url = REVIEWS_URL.format(practice_id=practice.id)
    resp = await client.get(
        url,
        headers=auth_headers(master_auth["session_token"]),
    )
    assert resp.status_code == 400


# ===================================================================
# GET /practices/{id}/reviews -- practice not found (404)
# ===================================================================


@pytest.mark.asyncio
async def test_reviews_practice_not_found(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Non-existent practice ID: 404."""
    master_auth = await _make_verified_master(
        client, db_session, telegram_id=89910,
    )
    # ПРОМТ №583: _make_verified_master only flushes -- the role=MASTER
    # change and the MasterProfile row must be COMMITTED before the request
    # below, which hits get_current_master through a separate DB connection.
    # Without this, the guard sees the old (non-master) role and rejects
    # with 403 before ever reaching the 404 not-found branch this test
    # means to exercise (mirrors test_reviews_not_owner's own commit()).
    await db_session.commit()

    url = REVIEWS_URL.format(practice_id=uuid4())
    resp = await client.get(
        url,
        headers=auth_headers(master_auth["session_token"]),
    )
    assert resp.status_code == 404


# ===================================================================
# GET /practices/{id}/reviews -- no auth (401)
# ===================================================================


@pytest.mark.asyncio
async def test_reviews_no_auth(
    client: AsyncClient,
) -> None:
    """No auth: 401."""
    url = REVIEWS_URL.format(practice_id=uuid4())
    resp = await client.get(url)
    assert resp.status_code == 401
