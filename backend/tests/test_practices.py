# =============================================================================
# Test: Practices -- CRUD + Pricing + Public Feed (Phase 4.2 + 4.3/4.4)
# =============================================================================
#
# telegram_id ranges:
#   60001-60099 -- master users
#   60100-60199 -- regular users (non-master)
#   60900-60999 -- admin users
# =============================================================================

import asyncio
from collections.abc import AsyncGenerator
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User, UserRole
from app.modules.practices.models import (
    Practice,
    PracticeStatus,
    PracticeType,
)
from app.modules.payments.service import record_user_ledger
from tests.helpers import auth_headers, login_user, full_cleanup_range, switch_self_to_master

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
PRACTICES_URL = "/api/v1/practices"
MY_PRACTICES_URL = "/api/v1/masters/me/practices"
APPLY_URL = "/api/v1/masters/apply"
VERIFY_URL = "/api/v1/admin/masters/{user_id}/verify"


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
    """Full ORM cleanup for telegram_id 60000-60999."""
    await full_cleanup_range(session, 60000, 60999, delete_users=False)
    await session.commit()



# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _valid_practice_body(**overrides: object) -> dict:
    """Return a valid CreatePracticeRequest body."""
    base: dict = {
        "practice_type": "live",
        "direction": "meditation",
        "difficulty": "beginner",
        "title": "Morning Meditation",
        "description": "Guided breathwork session",
        "scheduled_at": (
            datetime.now(timezone.utc) + timedelta(days=7)
        ).isoformat(),
        "duration_minutes": 60,
        "timezone": "Europe/Moscow",
        "max_participants": 20,
        "is_free": True,
        "price_cents": 0,
        "currency": "eur",
    }
    base.update(overrides)
    return base


def _valid_apply_body() -> dict:
    """Return a valid MasterApplyRequest body."""
    return {
        "profile": {
            "display_name": "Test Master",
            "email": "master@test.com",
        },
        "experience": {
            # T21-6/T21-7 (ПРОМТ №547/548): _assert_master_confirmed_taxonomy
            # requires the calling master to hold the exact direction/style
            # being created or updated. Widened to cover exactly what THIS
            # file's own tests exercise (bare yoga + its 3 styles used here,
            # bare breathwork) -- raw VALUES, matching this fixture's own
            # pre-existing style and the value-canonical comparison chosen in
            # ПРОМТ №547, not "every direction in the catalog".
            "methods": [
                "meditation",
                "yoga",
                "yoga — kundalini",
                "yoga — hatha",
                "yoga — vinyasa",
                "breathwork",
            ],
            "experience_years": 5,
            "bio": "Experienced practitioner",
        },
        "documents": [],
    }


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int = 60001,
) -> dict:
    """Create user, apply as master, verify via admin.

    Returns auth data with role=master.
    """
    # Create user and submit application.
    auth = await login_user(
        client, telegram_id=telegram_id, first_name="Master",
    )
    await client.post(
        APPLY_URL,
        json=_valid_apply_body(),
        headers=auth_headers(auth["session_token"]),
    )

    # Promote admin user (telegram_id=60900).
    admin_auth = await login_user(
        client, telegram_id=60900, first_name="Admin",
    )
    await db_session.execute(
    update(User)
    .where(User.telegram_id == 60900)
    .values(role=UserRole.ADMIN.value)
)
    await db_session.commit()

    # Re-login admin to pick up new role in session.
    admin_auth = await login_user(
        client, telegram_id=60900, first_name="Admin",
    )

    user_id = auth["user"]["id"]
    verify_resp = await client.post(
        VERIFY_URL.format(user_id=user_id),
        json={},
        headers=auth_headers(admin_auth["session_token"]),
    )
    assert verify_resp.status_code == 200

    # Re-login to pick up master role in session.
    await switch_self_to_master(client, auth["session_token"])
    auth = await login_user(
        client, telegram_id=telegram_id, first_name="Master",
    )
    return auth


async def _create_and_publish(
    client: AsyncClient,
    auth: dict,
    **overrides: object,
) -> str:
    """Create a practice and transition status to scheduled.

    Returns practice_id.
    """
    body = _valid_practice_body(**overrides)
    create_resp = await client.post(
        PRACTICES_URL,
        json=body,
        headers=auth_headers(auth["session_token"]),
    )
    assert create_resp.status_code == 201
    practice_id = create_resp.json()["id"]

    patch_resp = await client.patch(
        f"{PRACTICES_URL}/{practice_id}",
        json={"status": "scheduled"},
        headers=auth_headers(auth["session_token"]),
    )
    assert patch_resp.status_code == 200
    return practice_id


async def _insert_practice_at(
    session: AsyncSession,
    master_id: str,
    *,
    scheduled_at: datetime,
    status: str = PracticeStatus.SCHEDULED.value,
    title: str = "Practice",
) -> Practice:
    """Insert a Practice row directly via ORM at an arbitrary scheduled_at.

    The public-feed time filter must drop practices that already started.
    The CreatePracticeRequest validator rejects a past scheduled_at, so the
    only honest way to test "started/past" practices is to write the row
    directly (the API can never produce one). taxonomy is set via set_jsonb
    for realism (and so the row looks like a real published practice).
    Cleaned up by full_cleanup_range (telegram 60000-60999) at teardown.
    """
    practice = Practice(
        master_id=master_id,
        practice_type=PracticeType.LIVE.value,
        status=status,
        title=title,
        description="Direct-insert practice",
        scheduled_at=scheduled_at,
        duration_minutes=60,
        timezone="UTC",
        max_participants=20,
        current_participants=0,
        is_free=True,
        price_cents=0,
        currency="eur",
    )
    practice.set_jsonb(
        "data",
        {
            "taxonomy": {
                "direction": "meditation",
                "difficulty": "beginner",
                "style": None,
            },
        },
    )
    session.add(practice)
    await session.flush()
    return practice


# ---------------------------------------------------------------------------
# GET /practices -- public feed time gate (Batch 2)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_list_practices_excludes_started_and_past(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Default public feed hides started/past practices (Batch 2).

    Only a practice that has NOT started yet is bookable, so only the future
    one is returned. The started (10 min ago) and past (2 h ago) practices --
    both still status=scheduled because no one finalized them -- must be
    excluded. Scoped to this test's master via master_id to stay independent
    of seed data.
    """
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]
    now = datetime.now(timezone.utc)

    await _insert_practice_at(
        db_session, master_id,
        scheduled_at=now + timedelta(days=7), title="Future",
    )
    await _insert_practice_at(
        db_session, master_id,
        scheduled_at=now - timedelta(minutes=10), title="JustStarted",
    )
    await _insert_practice_at(
        db_session, master_id,
        scheduled_at=now - timedelta(hours=2), title="Past",
    )
    await db_session.commit()

    user_auth = await login_user(
        client, telegram_id=60108, first_name="Viewer",
    )
    resp = await client.get(
        f"{PRACTICES_URL}?master_id={master_id}",
        headers=auth_headers(user_auth["session_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["title"] == "Future"


@pytest.mark.asyncio
async def test_list_practices_explicit_status_bypasses_time_gate(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """An explicit ?status= request is NOT time-gated (Batch 2).

    The future-only filter applies only to the default feed. When a caller
    asks for a specific status, a started/past practice in that status is
    still returned -- the gate must not leak into the explicit-status path.
    """
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]
    now = datetime.now(timezone.utc)

    # A live practice that already started 10 min ago.
    await _insert_practice_at(
        db_session, master_id,
        scheduled_at=now - timedelta(minutes=10),
        status=PracticeStatus.LIVE.value,
        title="StartedLive",
    )
    await db_session.commit()

    user_auth = await login_user(
        client, telegram_id=60109, first_name="Viewer",
    )
    resp = await client.get(
        f"{PRACTICES_URL}?master_id={master_id}&status=live",
        headers=auth_headers(user_auth["session_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["title"] == "StartedLive"


# ===================================================================
# PHASE 4.2 TESTS -- CRUD
# ===================================================================


# ---------------------------------------------------------------------------
# POST /practices -- success
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_create_practice_success(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Verified master can create a practice."""
    auth = await _make_verified_master(client, db_session)

    resp = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(),
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["title"] == "Morning Meditation"
    assert data["status"] == "draft"
    assert data["is_free"] is True
    assert data["price_cents"] == 0
    assert data["currency"] == "eur"


# ---------------------------------------------------------------------------
# POST /practices -- not a master (403)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_create_practice_not_master(
    client: AsyncClient,
) -> None:
    """Regular user cannot create practice: 403."""
    auth = await login_user(
        client, telegram_id=60101, first_name="User",
    )
    resp = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(),
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# POST /practices -- no auth (401)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_create_practice_no_auth(
    client: AsyncClient,
) -> None:
    """No auth token: 401."""
    resp = await client.post(PRACTICES_URL, json=_valid_practice_body())
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# POST /practices -- invalid duration (422)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_create_practice_invalid_duration(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Duration out of allowed range: 422."""
    auth = await _make_verified_master(client, db_session)

    body = _valid_practice_body(duration_minutes=9999)
    resp = await client.post(
        PRACTICES_URL,
        json=body,
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# POST /practices -- concurrent double-submit (A4 V7 / ПРОМТ №571)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_concurrent_duplicate_creates_yield_exactly_one_practice(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A4 V7: two genuinely CONCURRENT POST /practices for the same
    (master, title, scheduled_at, recurrence) -- the double-tap / two-tabs
    shape -- must yield exactly one Practice row, not two.

    Before the fix, create_practice's dedup check
    (_find_recent_duplicate_practice) is a pure in-app SELECT-then-INSERT:
    both requests' SELECT can run before either commits, so both see
    nothing and both INSERT -- each independently triggering Zoom meeting
    creation under the single shared S2S host identity (A4 finding #1,
    platform-wide Zoom-quota blast radius). This discriminates the real
    break specifically: it is indifferent to the window-check's own
    time-based logic (both requests fire in the same instant, trivially
    inside any window) and fails ONLY if the concurrency itself -- not the
    dedup key matching -- is left open. A sequential double-call (await
    then await) would stay green even on the broken code, because the
    second call's SELECT would see the first call's already-committed row;
    this test relies on asyncio.gather to make the two requests genuinely
    overlap.

    asyncio.gather against the SAME AsyncClient genuinely races at the DB
    level: each request resolves get_db_session independently (a fresh
    session/transaction per request, see core/database.py), so neither
    request's SELECT can see the other's uncommitted INSERT -- this is not
    a serialized double-call dressed up as concurrent.
    """
    master = await _make_verified_master(client, db_session, telegram_id=60051)
    body = _valid_practice_body(title="Concurrent Race Practice")

    responses = await asyncio.gather(
        client.post(
            PRACTICES_URL, json=body, headers=auth_headers(master["session_token"]),
        ),
        client.post(
            PRACTICES_URL, json=body, headers=auth_headers(master["session_token"]),
        ),
    )
    for resp in responses:
        assert resp.status_code == 201, resp.text

    practice_ids = {r.json()["id"] for r in responses}
    assert len(practice_ids) == 1, (
        f"expected both concurrent creates to resolve to the SAME practice "
        f"id, got {len(practice_ids)} distinct ids -- the TOCTOU race was "
        f"not closed"
    )

    count = (
        await db_session.execute(
            select(func.count()).select_from(Practice).where(
                Practice.master_id == UUID(master["user"]["id"]),
                Practice.title == "Concurrent Race Practice",
            )
        )
    ).scalar_one()
    assert count == 1, (
        f"expected exactly one Practice row after the concurrent double-"
        f"submit, found {count}"
    )

    # A4 V6: the LOSING side of the race must be told it lost -- exactly one
    # of the two responses is honestly marked deduplicated, never both
    # (that would mean nothing was ever actually created) and never neither
    # (that would mean the race-lost path forgot to set the flag).
    deduplicated_flags = [r.json()["deduplicated"] for r in responses]
    assert deduplicated_flags.count(True) == 1, (
        f"expected exactly one response marked deduplicated=true, got {deduplicated_flags}"
    )
    assert deduplicated_flags.count(False) == 1


@pytest.mark.asyncio
async def test_create_practice_window_dedup_marks_the_second_response(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A4 V6: a SEQUENTIAL retry within practice_duplicate_submit_window_
    minutes (the ПРОМТ №559 case this dedup check was built for -- a
    frontend timeout, not a race) must be marked deduplicated=true on the
    SECOND response. Before this field existed, the second POST returned
    200-shaped success with no way for the master to tell it apart from a
    genuine new practice -- they would believe two practices/series exist
    when only one does.
    """
    master = await _make_verified_master(client, db_session, telegram_id=60052)
    body = _valid_practice_body(title="Sequential Retry Practice")

    first = await client.post(
        PRACTICES_URL, json=body, headers=auth_headers(master["session_token"]),
    )
    assert first.status_code == 201
    assert first.json()["deduplicated"] is False

    second = await client.post(
        PRACTICES_URL, json=body, headers=auth_headers(master["session_token"]),
    )
    assert second.status_code == 201
    assert second.json()["id"] == first.json()["id"]
    assert second.json()["deduplicated"] is True

    count = (
        await db_session.execute(
            select(func.count()).select_from(Practice).where(
                Practice.master_id == UUID(master["user"]["id"]),
                Practice.title == "Sequential Retry Practice",
            )
        )
    ).scalar_one()
    assert count == 1


# ---------------------------------------------------------------------------
# GET /practices/{id} -- success
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_get_practice_success(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Any authenticated user can view a scheduled practice."""
    master_auth = await _make_verified_master(client, db_session)

    practice_id = await _create_and_publish(client, master_auth)

    user_auth = await login_user(
        client, telegram_id=60101, first_name="Viewer",
    )
    resp = await client.get(
        f"{PRACTICES_URL}/{practice_id}",
        headers=auth_headers(user_auth["session_token"]),
    )
    assert resp.status_code == 200
    assert resp.json()["id"] == practice_id


# ---------------------------------------------------------------------------
# GET /practices/{id} -- draft hidden from non-owner (404)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_get_practice_draft_hidden(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Draft practice invisible to non-owner: 404."""
    master_auth = await _make_verified_master(client, db_session)

    create_resp = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(),
        headers=auth_headers(master_auth["session_token"]),
    )
    assert create_resp.status_code == 201
    practice_id = create_resp.json()["id"]

    user_auth = await login_user(
        client, telegram_id=60102, first_name="Stranger",
    )
    resp = await client.get(
        f"{PRACTICES_URL}/{practice_id}",
        headers=auth_headers(user_auth["session_token"]),
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# PATCH /practices/{id} -- success
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_update_practice_success(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Master can update their own practice."""
    auth = await _make_verified_master(client, db_session)

    create_resp = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(),
        headers=auth_headers(auth["session_token"]),
    )
    assert create_resp.status_code == 201
    practice_id = create_resp.json()["id"]

    resp = await client.patch(
        f"{PRACTICES_URL}/{practice_id}",
        json={"title": "Evening Yoga"},
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 200
    assert resp.json()["title"] == "Evening Yoga"


# ---------------------------------------------------------------------------
# PATCH /practices/{id} -- not owner (404, P-08)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_update_practice_not_owner(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Non-owner master cannot update practice: 404 (P-08)."""
    master_auth = await _make_verified_master(
        client, db_session, telegram_id=60002,
    )

    create_resp = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(),
        headers=auth_headers(master_auth["session_token"]),
    )
    assert create_resp.status_code == 201
    practice_id = create_resp.json()["id"]

    other_auth = await _make_verified_master(
        client, db_session, telegram_id=60003,
    )

    resp = await client.patch(
        f"{PRACTICES_URL}/{practice_id}",
        json={"title": "Hijacked"},
        headers=auth_headers(other_auth["session_token"]),
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# DELETE /practices/{id} -- draft success
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_delete_draft_practice(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Master can delete a draft practice (status -> deleted)."""
    auth = await _make_verified_master(client, db_session)

    create_resp = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(),
        headers=auth_headers(auth["session_token"]),
    )
    assert create_resp.status_code == 201
    practice_id = create_resp.json()["id"]

    resp = await client.delete(
        f"{PRACTICES_URL}/{practice_id}",
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "deleted"


# ---------------------------------------------------------------------------
# DELETE /practices/{id} -- non-draft (400)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_delete_non_draft_practice(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Cannot delete a scheduled practice: 400."""
    auth = await _make_verified_master(client, db_session)

    practice_id = await _create_and_publish(client, auth)

    resp = await client.delete(
        f"{PRACTICES_URL}/{practice_id}",
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# DELETE /practices/{id} -- not owner (404, P-08)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_delete_practice_not_owner(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Non-owner master cannot delete practice: 404 (P-08)."""
    master_auth = await _make_verified_master(
        client, db_session, telegram_id=60006,
    )

    create_resp = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(),
        headers=auth_headers(master_auth["session_token"]),
    )
    assert create_resp.status_code == 201
    practice_id = create_resp.json()["id"]

    other_auth = await _make_verified_master(
        client, db_session, telegram_id=60007,
    )

    resp = await client.delete(
        f"{PRACTICES_URL}/{practice_id}",
        headers=auth_headers(other_auth["session_token"]),
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# PATCH /practices/{id} -- invalid status transition (400)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_update_practice_invalid_transition(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """completed is not a PATCH-able status (Batch 1: it is reached only by the
    lifecycle worker), so PATCH status=completed is rejected at the schema
    layer -> 422."""
    auth = await _make_verified_master(client, db_session)

    create_resp = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(),
        headers=auth_headers(auth["session_token"]),
    )
    assert create_resp.status_code == 201
    practice_id = create_resp.json()["id"]

    resp = await client.patch(
        f"{PRACTICES_URL}/{practice_id}",
        json={"status": "completed"},
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_update_practice_manual_start_and_finish_forbidden(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Batch 1: scheduled -> live and live -> completed are no longer PATCH-able
    (both are driven by the lifecycle worker). PATCH status="live"/"completed"
    is rejected at the schema layer (422). Publishing (draft -> scheduled) still
    works."""
    auth = await _make_verified_master(client, db_session)

    create_resp = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(),
        headers=auth_headers(auth["session_token"]),
    )
    assert create_resp.status_code == 201
    practice_id = create_resp.json()["id"]

    # Publish: draft -> scheduled (this PATCH is still allowed).
    pub = await client.patch(
        f"{PRACTICES_URL}/{practice_id}",
        json={"status": "scheduled"},
        headers=auth_headers(auth["session_token"]),
    )
    assert pub.status_code == 200

    # Manual start is forbidden: "live" is not a patch-allowed status -> 422.
    start = await client.patch(
        f"{PRACTICES_URL}/{practice_id}",
        json={"status": "live"},
        headers=auth_headers(auth["session_token"]),
    )
    assert start.status_code == 422

    # Manual finish is forbidden too: "completed" -> 422.
    finish = await client.patch(
        f"{PRACTICES_URL}/{practice_id}",
        json={"status": "completed"},
        headers=auth_headers(auth["session_token"]),
    )
    assert finish.status_code == 422


# ---------------------------------------------------------------------------
# PATCH /practices/{id} -- null NOT NULL field (400, P-02)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_update_practice_null_not_null_field(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Setting NOT NULL field to null: 400."""
    auth = await _make_verified_master(client, db_session)

    create_resp = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(),
        headers=auth_headers(auth["session_token"]),
    )
    assert create_resp.status_code == 201
    practice_id = create_resp.json()["id"]

    resp = await client.patch(
        f"{PRACTICES_URL}/{practice_id}",
        json={"scheduled_at": None},
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# GET /masters/me/practices -- success
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_list_master_practices(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Master sees their own practices (excluding deleted).

    R-04: response is now PaginatedPracticesResponse with total/limit/offset.
    """
    auth = await _make_verified_master(client, db_session)

    # Create 2 practices.
    for _ in range(2):
        r = await client.post(
            PRACTICES_URL,
            json=_valid_practice_body(),
            headers=auth_headers(auth["session_token"]),
        )
        assert r.status_code == 201

    resp = await client.get(
        MY_PRACTICES_URL,
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 2
    assert len(data["items"]) == 2
    assert "limit" in data
    assert "offset" in data


# ---------------------------------------------------------------------------
# GET /masters/me/practices -- E3a status filter
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_list_master_practices_status_filter(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """?status= restricts the master's own list to an exact status match.

    One practice stays "draft" (the create default), the other is published
    to "scheduled". Omitting the filter still returns both (unchanged
    behavior); each explicit status returns only its own practice.
    """
    auth = await _make_verified_master(client, db_session)

    draft_resp = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(),
        headers=auth_headers(auth["session_token"]),
    )
    assert draft_resp.status_code == 201

    scheduled_resp = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(),
        headers=auth_headers(auth["session_token"]),
    )
    assert scheduled_resp.status_code == 201
    scheduled_id = scheduled_resp.json()["id"]
    pub = await client.patch(
        f"{PRACTICES_URL}/{scheduled_id}",
        json={"status": "scheduled"},
        headers=auth_headers(auth["session_token"]),
    )
    assert pub.status_code == 200

    unfiltered = await client.get(
        MY_PRACTICES_URL,
        headers=auth_headers(auth["session_token"]),
    )
    assert unfiltered.json()["total"] == 2

    draft_only = await client.get(
        MY_PRACTICES_URL,
        params={"status": "draft"},
        headers=auth_headers(auth["session_token"]),
    )
    assert draft_only.status_code == 200
    draft_data = draft_only.json()
    assert draft_data["total"] == 1
    assert draft_data["items"][0]["status"] == "draft"

    scheduled_only = await client.get(
        MY_PRACTICES_URL,
        params={"status": "scheduled"},
        headers=auth_headers(auth["session_token"]),
    )
    assert scheduled_only.status_code == 200
    scheduled_data = scheduled_only.json()
    assert scheduled_data["total"] == 1
    assert scheduled_data["items"][0]["id"] == scheduled_id


# ---------------------------------------------------------------------------
# GET /masters/me/practices -- T22-3/T22-5 bucket ordering (ПРОМТ №561)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_list_master_practices_bucket_upcoming_nearest_first(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """?bucket=upcoming orders NEAREST FIRST -- including against a real
    series and a standalone occurrence stretching years out (T22-3: the old
    shared futures-first cursor put the far-future tail on page 1, making a
    far-future occurrence read as "nearest").
    """
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]
    now = datetime.now(timezone.utc)

    # Real weekly series (cap=40, ~39 weeks out) -- exercises the actual
    # generation engine, not just direct inserts.
    await _create_and_publish(
        client, auth,
        practice_type="series",
        direction="yoga",
        scheduled_at=(now + timedelta(days=30)).isoformat(),
        recurrence={"period": "weekly", "days": [1], "end": "after_count", "count": 40},
    )
    # A standalone occurrence genuinely years out (beyond any series cap),
    # covering the literal "stretching years out" production shape.
    await _insert_practice_at(
        db_session, master_id,
        scheduled_at=now + timedelta(days=730), title="YearsOut",
    )
    # The nearest of everything -- must be item [0].
    nearest = await _insert_practice_at(
        db_session, master_id,
        scheduled_at=now + timedelta(days=1), title="Nearest",
    )
    # The direct inserts above live in db_session's OWN transaction/connection
    # (tests/conftest.py's db_session fixture is a real, separate AsyncSession
    # against the real Postgres DB -- not a transaction shared with `client`,
    # which gets its own session per request via get_db_session()). Without
    # committing here, "YearsOut" and "Nearest" are invisible to the request
    # below and only the series root/children (committed inside the API calls
    # above) come back -- exactly the missing-commit bug this test had.
    await db_session.commit()

    resp = await client.get(
        MY_PRACTICES_URL,
        params={"bucket": "upcoming", "limit": 100},
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()

    scheduled_ats = [item["scheduled_at"] for item in data["items"]]
    assert scheduled_ats == sorted(scheduled_ats), "upcoming bucket must be ascending (nearest first)"
    assert data["items"][0]["id"] == str(nearest.id)
    # The 2-years-out occurrence is present but sorts LAST, not first.
    assert data["items"][-1]["title"] == "YearsOut"


@pytest.mark.asyncio
async def test_list_master_practices_bucket_past_most_recent_first(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """?bucket=past orders MOST RECENT FIRST and includes completed only
    (T22-5: the old shared cursor buried every completed practice behind the
    whole future backlog, needing many "Показать ещё" taps before any showed).
    """
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]
    now = datetime.now(timezone.utc)

    oldest = await _insert_practice_at(
        db_session, master_id,
        scheduled_at=now - timedelta(days=60),
        status=PracticeStatus.COMPLETED.value,
        title="Oldest",
    )
    most_recent = await _insert_practice_at(
        db_session, master_id,
        scheduled_at=now - timedelta(days=1),
        status=PracticeStatus.COMPLETED.value,
        title="MostRecent",
    )
    await _insert_practice_at(
        db_session, master_id,
        scheduled_at=now - timedelta(days=30),
        status=PracticeStatus.COMPLETED.value,
        title="Middle",
    )
    # A far-future scheduled practice must NEVER appear in "past".
    await _insert_practice_at(
        db_session, master_id,
        scheduled_at=now + timedelta(days=30), title="StillUpcoming",
    )
    # See the "upcoming" bucket test above: db_session is its own real
    # transaction, separate from the request's session -- without a commit
    # here the request sees none of these rows (total would read 0).
    await db_session.commit()

    resp = await client.get(
        MY_PRACTICES_URL,
        params={"bucket": "past", "limit": 100},
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()

    assert data["total"] == 3
    assert all(item["status"] == "completed" for item in data["items"])
    assert data["items"][0]["id"] == str(most_recent.id)
    assert data["items"][-1]["id"] == str(oldest.id)


@pytest.mark.asyncio
async def test_list_master_practices_bucket_excludes_cancelled(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A cancelled practice appears in NEITHER bucket (it did not happen) --
    server-side enforcement of the rule the client used to apply by omission.
    """
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]
    now = datetime.now(timezone.utc)

    await _insert_practice_at(
        db_session, master_id,
        scheduled_at=now + timedelta(days=5),
        status=PracticeStatus.CANCELLED.value,
        title="CancelledFuture",
    )
    await _insert_practice_at(
        db_session, master_id,
        scheduled_at=now - timedelta(days=5),
        status=PracticeStatus.CANCELLED.value,
        title="CancelledPast",
    )

    upcoming = await client.get(
        MY_PRACTICES_URL,
        params={"bucket": "upcoming"},
        headers=auth_headers(auth["session_token"]),
    )
    past = await client.get(
        MY_PRACTICES_URL,
        params={"bucket": "past"},
        headers=auth_headers(auth["session_token"]),
    )
    assert upcoming.json()["total"] == 0
    assert past.json()["total"] == 0


# ===================================================================
# PHASE 4.3/4.4 TESTS -- PRICING
# ===================================================================


# ---------------------------------------------------------------------------
# POST /practices -- paid practice success
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_create_paid_practice(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Master creates a paid practice: is_free=False, price > 0."""
    auth = await _make_verified_master(client, db_session)

    resp = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(
            is_free=False,
            price_cents=1500,
        ),
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["is_free"] is False
    assert data["price_cents"] == 1500
    assert data["currency"] == "eur"


# ---------------------------------------------------------------------------
# POST /practices -- free forces price_cents=0
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_create_free_practice_forces_zero_price(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """is_free=True forces price_cents=0 even if client sends 500."""
    auth = await _make_verified_master(client, db_session)

    resp = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(
            is_free=True,
            price_cents=500,
        ),
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 201
    assert resp.json()["price_cents"] == 0


# ---------------------------------------------------------------------------
# POST /practices -- paid with price=0 (400)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_create_paid_practice_zero_price(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """is_free=False with price_cents=0: 400."""
    auth = await _make_verified_master(client, db_session)

    resp = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(
            is_free=False,
            price_cents=0,
        ),
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# PATCH /practices -- change to paid
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_update_practice_to_paid(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Master changes free practice to paid via PATCH."""
    auth = await _make_verified_master(client, db_session)

    create_resp = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(),
        headers=auth_headers(auth["session_token"]),
    )
    assert create_resp.status_code == 201
    practice_id = create_resp.json()["id"]

    resp = await client.patch(
        f"{PRACTICES_URL}/{practice_id}",
        json={"is_free": False, "price_cents": 2000},
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 200
    assert resp.json()["is_free"] is False
    assert resp.json()["price_cents"] == 2000


# ---------------------------------------------------------------------------
# PATCH /practices -- set is_free=True forces price to 0
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_update_practice_to_free_zeroes_price(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Setting is_free=True on a paid practice zeroes price_cents."""
    auth = await _make_verified_master(client, db_session)

    create_resp = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(
            is_free=False,
            price_cents=2000,
        ),
        headers=auth_headers(auth["session_token"]),
    )
    assert create_resp.status_code == 201
    practice_id = create_resp.json()["id"]

    resp = await client.patch(
        f"{PRACTICES_URL}/{practice_id}",
        json={"is_free": True},
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 200
    assert resp.json()["is_free"] is True
    assert resp.json()["price_cents"] == 0


# ===================================================================
# PHASE 4.3 TESTS -- PUBLIC FEED
# ===================================================================


# ---------------------------------------------------------------------------
# GET /practices -- basic list (only scheduled/live)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_list_practices_public(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Public feed returns only scheduled/live practices.

    Scoped to this test's master via master_id filter to stay
    independent of seed data present in the database.
    """
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]

    # Create 1 draft (should NOT appear) and 1 scheduled.
    await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(title="Draft"),
        headers=auth_headers(auth["session_token"]),
    )
    await _create_and_publish(
        client, auth, title="Published",
    )

    user_auth = await login_user(
        client, telegram_id=60103, first_name="Viewer",
    )
    resp = await client.get(
        f"{PRACTICES_URL}?master_id={master_id}",
        headers=auth_headers(user_auth["session_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["title"] == "Published"
    assert "limit" in data
    assert "offset" in data


# ---------------------------------------------------------------------------
# GET /practices -- filter by practice_type
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_list_practices_filter_type(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Filter by practice_type returns only matching.

    Scoped to this test's master via master_id filter to stay
    independent of seed data present in the database.
    """
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]

    await _create_and_publish(
        client, auth, practice_type="live", title="Live",
    )
    await _create_and_publish(
        client, auth,
        practice_type="one_on_one",
        title="OneOnOne",
    )

    user_auth = await login_user(
        client, telegram_id=60104, first_name="Viewer",
    )
    resp = await client.get(
        f"{PRACTICES_URL}?practice_type=live&master_id={master_id}",
        headers=auth_headers(user_auth["session_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["title"] == "Live"


# ---------------------------------------------------------------------------
# GET /practices -- filter by master_id
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_list_practices_filter_master(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Filter by master_id returns only their practices."""
    master1 = await _make_verified_master(
        client, db_session, telegram_id=60004,
    )
    master2 = await _make_verified_master(
        client, db_session, telegram_id=60005,
    )

    await _create_and_publish(
        client, master1, title="M1 Practice",
    )
    await _create_and_publish(
        client, master2, title="M2 Practice",
    )

    m1_id = master1["user"]["id"]
    user_auth = await login_user(
        client, telegram_id=60105, first_name="Viewer",
    )
    resp = await client.get(
        f"{PRACTICES_URL}?master_id={m1_id}",
        headers=auth_headers(user_auth["session_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["title"] == "M1 Practice"


# ---------------------------------------------------------------------------
# GET /practices -- sort by price_cents
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_list_practices_sort_price(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Sort by price_cents ascending.

    Scoped to this test's master via master_id filter to stay
    independent of seed data present in the database.
    """
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]

    await _create_and_publish(
        client, auth,
        title="Expensive",
        is_free=False,
        price_cents=5000,
    )
    await _create_and_publish(
        client, auth,
        title="Cheap",
        is_free=False,
        price_cents=500,
    )
    await _create_and_publish(
        client, auth,
        title="Free",
        is_free=True,
    )

    user_auth = await login_user(
        client, telegram_id=60106, first_name="Viewer",
    )
    resp = await client.get(
        f"{PRACTICES_URL}?sort_by=price_cents&sort_order=asc&master_id={master_id}",
        headers=auth_headers(user_auth["session_token"]),
    )
    assert resp.status_code == 200
    items = resp.json()["items"]
    assert len(items) == 3
    prices = [i["price_cents"] for i in items]
    assert prices == sorted(prices)


# ---------------------------------------------------------------------------
# GET /practices -- pagination
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_list_practices_pagination(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Pagination limit/offset works correctly.

    Scoped to this test's master via master_id filter to stay
    independent of seed data present in the database.
    """
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]

    for i in range(3):
        await _create_and_publish(
            client, auth, title=f"Practice {i}",
        )

    user_auth = await login_user(
        client, telegram_id=60107, first_name="Viewer",
    )
    resp = await client.get(
        f"{PRACTICES_URL}?master_id={master_id}&limit=2&offset=0",
        headers=auth_headers(user_auth["session_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 3
    assert len(data["items"]) == 2
    assert data["limit"] == 2
    assert data["offset"] == 0

    # Page 2.
    resp2 = await client.get(
        f"{PRACTICES_URL}?master_id={master_id}&limit=2&offset=2",
        headers=auth_headers(user_auth["session_token"]),
    )
    assert resp2.status_code == 200
    data2 = resp2.json()
    assert len(data2["items"]) == 1


# ---------------------------------------------------------------------------
# GET /practices -- no auth (401)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_list_practices_no_auth(
    client: AsyncClient,
) -> None:
    """Public feed requires authentication: 401."""
    resp = await client.get(PRACTICES_URL)
    assert resp.status_code == 401

# ===================================================================
# CALENDAR ITERATION -- taxonomy storage, feed filters, user flags
# ===================================================================
#
# Uses telegram_id range 60xxx (masters 600xx, viewers 601xx) like the
# rest of this module. Feed tests scope to the test's own master via
# master_id= to stay independent of seed data.

_BOOKINGS_URL = "/api/v1/bookings"
_PURCHASE_URL = "/api/v1/practices/{practice_id}/purchase"


# ---------------------------------------------------------------------------
# Taxonomy storage -- create persists data.taxonomy, surfaced in response
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_create_persists_taxonomy(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Create with direction/difficulty/style -> returned in response + GET."""
    auth = await _make_verified_master(client, db_session)
    resp = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(
            direction="yoga", difficulty="high", style="kundalini",
        ),
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["direction"] == "yoga"
    assert data["difficulty"] == "high"
    assert data["style"] == "kundalini"

    # Re-fetch via GET to confirm it is persisted (not just echoed).
    pid = data["id"]
    get_resp = await client.get(
        f"{PRACTICES_URL}/{pid}",
        headers=auth_headers(auth["session_token"]),
    )
    assert get_resp.status_code == 200
    got = get_resp.json()
    assert got["direction"] == "yoga"
    assert got["difficulty"] == "high"
    assert got["style"] == "kundalini"


@pytest.mark.asyncio
async def test_create_without_style_returns_null(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """style is optional -> omitted -> null in response."""
    auth = await _make_verified_master(client, db_session)
    body = _valid_practice_body()
    body.pop("style", None)  # ensure absent
    resp = await client.post(
        PRACTICES_URL,
        json=body,
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 201
    assert resp.json()["style"] is None


@pytest.mark.asyncio
async def test_update_merges_taxonomy(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """PATCH difficulty only -> direction/style preserved (JSONB merge)."""
    auth = await _make_verified_master(client, db_session)
    create = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(
            direction="yoga", difficulty="beginner", style="hatha",
        ),
        headers=auth_headers(auth["session_token"]),
    )
    pid = create.json()["id"]

    patch = await client.patch(
        f"{PRACTICES_URL}/{pid}",
        json={"difficulty": "high"},
        headers=auth_headers(auth["session_token"]),
    )
    assert patch.status_code == 200
    data = patch.json()
    assert data["difficulty"] == "high"      # changed
    assert data["direction"] == "yoga"       # preserved
    assert data["style"] == "hatha"          # preserved


@pytest.mark.asyncio
async def test_update_style_rejected_for_wrong_direction(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """PATCH a style not valid for the STORED direction -> 400 (W-1).

    The practice is stored as yoga; "silence" is a meditation-only style.
    The Pydantic model validator passes (no direction in the request -> flat
    union check), so the service must catch the cross-direction mismatch
    against the stored direction.
    """
    auth = await _make_verified_master(client, db_session)
    create = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(
            direction="yoga", difficulty="beginner", style="hatha",
        ),
        headers=auth_headers(auth["session_token"]),
    )
    pid = create.json()["id"]

    patch = await client.patch(
        f"{PRACTICES_URL}/{pid}",
        json={"style": "silence"},  # meditation style, invalid for yoga
        headers=auth_headers(auth["session_token"]),
    )
    assert patch.status_code == 400


@pytest.mark.asyncio
async def test_update_style_rejected_for_styleless_direction(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """PATCH a style onto a direction that admits no styles -> 400 (W-1).

    breathwork has no styles; setting any style on a stored breathwork
    practice (without re-sending direction) must be rejected by the service.
    """
    auth = await _make_verified_master(client, db_session)
    create = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(direction="breathwork", difficulty="beginner"),
        headers=auth_headers(auth["session_token"]),
    )
    pid = create.json()["id"]

    patch = await client.patch(
        f"{PRACTICES_URL}/{pid}",
        json={"style": "hatha"},  # any style is invalid for breathwork
        headers=auth_headers(auth["session_token"]),
    )
    assert patch.status_code == 400


@pytest.mark.asyncio
async def test_update_style_accepted_for_same_direction(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Positive control: a style valid for the stored direction still works.

    Guards against the W-1 fix being too strict (rejecting legitimate
    same-direction style changes). yoga accepts "vinyasa".
    """
    auth = await _make_verified_master(client, db_session)
    create = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(
            direction="yoga", difficulty="beginner", style="hatha",
        ),
        headers=auth_headers(auth["session_token"]),
    )
    pid = create.json()["id"]

    patch = await client.patch(
        f"{PRACTICES_URL}/{pid}",
        json={"style": "vinyasa"},  # valid yoga style
        headers=auth_headers(auth["session_token"]),
    )
    assert patch.status_code == 200
    assert patch.json()["style"] == "vinyasa"
    assert patch.json()["direction"] == "yoga"


# ---------------------------------------------------------------------------
# Feed filter -- direction (single + multi)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_filter_direction_single(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """direction=yoga returns only yoga practices (scoped to master)."""
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]
    await _create_and_publish(client, auth, direction="yoga", title="Y")
    await _create_and_publish(
        client, auth, direction="meditation", title="M",
    )

    viewer = await login_user(client, telegram_id=60110, first_name="V")
    resp = await client.get(
        f"{PRACTICES_URL}?direction=yoga&master_id={master_id}",
        headers=auth_headers(viewer["session_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["title"] == "Y"


@pytest.mark.asyncio
async def test_filter_direction_multi(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Multi direction (yoga + breathwork) returns both, excludes meditation."""
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]
    await _create_and_publish(client, auth, direction="yoga", title="Y")
    await _create_and_publish(
        client, auth, direction="breathwork", title="B",
    )
    await _create_and_publish(
        client, auth, direction="meditation", title="M",
    )

    viewer = await login_user(client, telegram_id=60111, first_name="V")
    resp = await client.get(
        f"{PRACTICES_URL}?direction=yoga&direction=breathwork"
        f"&master_id={master_id}",
        headers=auth_headers(viewer["session_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 2
    titles = {item["title"] for item in data["items"]}
    assert titles == {"Y", "B"}


# ---------------------------------------------------------------------------
# Feed filter -- difficulty
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_filter_difficulty(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """difficulty=high returns only high practices."""
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]
    await _create_and_publish(client, auth, difficulty="high", title="H")
    await _create_and_publish(
        client, auth, difficulty="beginner", title="Beg",
    )

    viewer = await login_user(client, telegram_id=60112, first_name="V")
    resp = await client.get(
        f"{PRACTICES_URL}?difficulty=high&master_id={master_id}",
        headers=auth_headers(viewer["session_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["title"] == "H"


# ---------------------------------------------------------------------------
# Feed filter -- style (free-form exact match)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_filter_style(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """style filter matches the exact stored style string."""
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]
    # Taxonomy v2 (2026-05-28): styles are direction-conditional.
    # kundalini & hatha are yoga styles, so the direction must be yoga
    # (default _valid_practice_body direction = meditation, not compatible).
    await _create_and_publish(
        client, auth, direction="yoga", style="kundalini", title="K",
    )
    await _create_and_publish(
        client, auth, direction="yoga", style="hatha", title="X",
    )

    viewer = await login_user(client, telegram_id=60113, first_name="V")
    resp = await client.get(
        f"{PRACTICES_URL}?style=hatha&master_id={master_id}",
        headers=auth_headers(viewer["session_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["title"] == "X"


# ---------------------------------------------------------------------------
# Feed filter -- style multi-select (B-4, 2026-05-29)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_filter_style_multi(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """B-4: style now accepts list[str] — repeated ?style=A&style=B returns
    practices matching ANY of the values (OR within facet).
    """
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]
    # Three yoga practices with different styles; we'll select two.
    await _create_and_publish(
        client, auth, direction="yoga", style="kundalini", title="K",
    )
    await _create_and_publish(
        client, auth, direction="yoga", style="hatha", title="H",
    )
    await _create_and_publish(
        client, auth, direction="yoga", style="vinyasa", title="V",
    )

    viewer = await login_user(client, telegram_id=60116, first_name="V")
    # Multi-select: repeated query param.
    resp = await client.get(
        f"{PRACTICES_URL}?style=hatha&style=vinyasa&master_id={master_id}",
        headers=auth_headers(viewer["session_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 2
    titles = sorted(item["title"] for item in data["items"])
    assert titles == ["H", "V"]


# NOTE (B-4, superseded by T2 follow-up 2026-07-15): a style-validation HTTP
# test was prototyped (test_filter_style_validation_rejects_unknown) but
# FastAPI's AfterValidator behaviour on a `list[str] | None` Query param
# turned out not to raise the expected 422 in our setup -- invalid styles
# already silently returned an empty result set via `.in_()`, regardless of
# the validator. T2 made that the deliberate, documented contract instead of
# an accidental one: direction/style filters are no longer membership-
# validated at all (practices/router.py's query-param comment block), on the
# grounds that a filter is a query, not a security boundary -- so there is
# nothing left here to keep "defence-in-depth" for. The multi-select happy
# path is covered by test_filter_style_multi above.


# ---------------------------------------------------------------------------
# Feed filter -- duration_bucket (short < 60 <= long)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_filter_duration_bucket(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """short = duration < 60, long = duration >= 60."""
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]
    await _create_and_publish(
        client, auth, duration_minutes=45, title="Short",
    )
    await _create_and_publish(
        client, auth, duration_minutes=90, title="Long",
    )

    viewer = await login_user(client, telegram_id=60114, first_name="V")

    short_resp = await client.get(
        f"{PRACTICES_URL}?duration_bucket=short&master_id={master_id}",
        headers=auth_headers(viewer["session_token"]),
    )
    assert short_resp.status_code == 200
    short_data = short_resp.json()
    assert short_data["total"] == 1
    assert short_data["items"][0]["title"] == "Short"

    long_resp = await client.get(
        f"{PRACTICES_URL}?duration_bucket=long&master_id={master_id}",
        headers=auth_headers(viewer["session_token"]),
    )
    assert long_resp.json()["total"] == 1
    assert long_resp.json()["items"][0]["title"] == "Long"


# ---------------------------------------------------------------------------
# Feed filter -- time_of_day (local-hour bucket in practice timezone)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_filter_time_of_day(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """time_of_day buckets by the practice's local hour.

    Practices are created in UTC timezone with explicit UTC hours, so the
    local hour equals the UTC hour:
      08:00 -> morning [5,12), 14:00 -> day [12,17), 20:00 -> evening [17,24).
    """
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]

    def _at_hour(hour: int) -> str:
        # Next occurrence of `hour` UTC, safely in the future (+7 days).
        base = datetime.now(timezone.utc) + timedelta(days=7)
        return base.replace(
            hour=hour, minute=0, second=0, microsecond=0,
        ).isoformat()

    await _create_and_publish(
        client, auth, timezone="UTC",
        scheduled_at=_at_hour(8), title="Morning",
    )
    await _create_and_publish(
        client, auth, timezone="UTC",
        scheduled_at=_at_hour(14), title="Day",
    )
    await _create_and_publish(
        client, auth, timezone="UTC",
        scheduled_at=_at_hour(20), title="Evening",
    )

    viewer = await login_user(client, telegram_id=60115, first_name="V")
    resp = await client.get(
        f"{PRACTICES_URL}?time_of_day=morning&master_id={master_id}",
        headers=auth_headers(viewer["session_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["title"] == "Morning"


# ---------------------------------------------------------------------------
# Feed filter -- time_of_day buckets by the VIEWER'S timezone (F5 / Batch 5d)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_filter_time_of_day_uses_viewer_timezone(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """time_of_day buckets by the VIEWER'S profile timezone, not the practice's.

    A single practice is created in UTC at 08:00 UTC (the practice timezone is
    fixed). Two viewers ask for it through different time_of_day facets:
      - a UTC viewer sees local hour 08 -> morning [5,12);
      - an Asia/Bangkok (+7) viewer sees local hour 15 -> day [12,17).
    So `morning` returns it only to the UTC viewer and `day` returns it only to
    the Bangkok viewer. Because the practice timezone never changes, this proves
    the bucket is decided by the viewer's timezone, not the practice's.
    """
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]

    # 08:00 UTC, safely in the future so the default feed gate keeps it.
    base = datetime.now(timezone.utc) + timedelta(days=7)
    at_0800_utc = base.replace(hour=8, minute=0, second=0, microsecond=0)
    await _insert_practice_at(
        db_session, master_id,
        scheduled_at=at_0800_utc, title="Eight",
    )
    await db_session.commit()

    # Two viewers; set their profile timezones explicitly via ORM (the column
    # is a plain String, default "UTC"). telegram 60100-60199 = regular users.
    utc_viewer = await login_user(
        client, telegram_id=60116, first_name="UtcViewer",
    )
    bkk_viewer = await login_user(
        client, telegram_id=60117, first_name="BkkViewer",
    )
    await db_session.execute(
        update(User)
        .where(User.telegram_id == 60117)
        .values(timezone="Asia/Bangkok")
    )
    # 60116 keeps the default "UTC"; set it explicitly for clarity/robustness.
    await db_session.execute(
        update(User)
        .where(User.telegram_id == 60116)
        .values(timezone="UTC")
    )
    await db_session.commit()

    # UTC viewer: morning returns it, day does not.
    r = await client.get(
        f"{PRACTICES_URL}?time_of_day=morning&master_id={master_id}",
        headers=auth_headers(utc_viewer["session_token"]),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    assert body["items"][0]["title"] == "Eight"

    r = await client.get(
        f"{PRACTICES_URL}?time_of_day=day&master_id={master_id}",
        headers=auth_headers(utc_viewer["session_token"]),
    )
    assert r.status_code == 200
    assert r.json()["total"] == 0

    # Bangkok viewer (+7): same practice now falls in "day", not "morning".
    r = await client.get(
        f"{PRACTICES_URL}?time_of_day=day&master_id={master_id}",
        headers=auth_headers(bkk_viewer["session_token"]),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    assert body["items"][0]["title"] == "Eight"

    r = await client.get(
        f"{PRACTICES_URL}?time_of_day=morning&master_id={master_id}",
        headers=auth_headers(bkk_viewer["session_token"]),
    )
    assert r.status_code == 200
    assert r.json()["total"] == 0


# ---------------------------------------------------------------------------
# Feed filter -- combined facets are AND-ed (direction + practice_type)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_filter_combined_facets_and(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Across facets conditions AND: yoga AND live matches only that one."""
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]
    await _create_and_publish(
        client, auth, direction="yoga", practice_type="live", title="YL",
    )
    await _create_and_publish(
        client, auth, direction="yoga", practice_type="replay", title="YR",
    )
    await _create_and_publish(
        client, auth,
        direction="meditation", practice_type="live", title="ML",
    )

    viewer = await login_user(client, telegram_id=60116, first_name="V")
    resp = await client.get(
        f"{PRACTICES_URL}?direction=yoga&practice_type=live"
        f"&master_id={master_id}",
        headers=auth_headers(viewer["session_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["title"] == "YL"


# ---------------------------------------------------------------------------
# User flags -- is_booked / is_paid
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_flags_not_booked(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A viewer who has not booked sees is_booked=False, is_paid=False."""
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]
    await _create_and_publish(client, auth, title="P")

    viewer = await login_user(client, telegram_id=60117, first_name="V")
    resp = await client.get(
        f"{PRACTICES_URL}?master_id={master_id}",
        headers=auth_headers(viewer["session_token"]),
    )
    assert resp.status_code == 200
    item = resp.json()["items"][0]
    assert item["is_booked"] is False
    assert item["is_paid"] is False


@pytest.mark.asyncio
async def test_flags_booked_free(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Booked a FREE practice -> is_booked=True, is_paid=False (variant 1)."""
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]
    pid = await _create_and_publish(client, auth, is_free=True, title="Free")

    viewer = await login_user(client, telegram_id=60118, first_name="V")
    book = await client.post(
        _BOOKINGS_URL,
        json={"practice_id": pid},
        headers=auth_headers(viewer["session_token"]),
    )
    assert book.status_code == 201

    resp = await client.get(
        f"{PRACTICES_URL}?master_id={master_id}",
        headers=auth_headers(viewer["session_token"]),
    )
    item = next(i for i in resp.json()["items"] if i["id"] == pid)
    assert item["is_booked"] is True
    assert item["is_paid"] is False


@pytest.mark.asyncio
async def test_flags_booked_paid(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Booked a PAID practice -> is_booked=True, is_paid=True (variant 1)."""
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]
    pid = await _create_and_publish(
        client, auth, is_free=False, price_cents=5000, title="Paid",
    )

    viewer = await login_user(client, telegram_id=60119, first_name="V")
    viewer_id = viewer["user"]["id"]

    # Fund the viewer's balance, then purchase (creates a booking).
    from app.core.database import get_session_factory
    factory = get_session_factory()
    async with factory() as topup_session:
        await record_user_ledger(
            user_id=UUID(viewer_id),
            amount_cents=10000,
            reason="test:topup",
            session=topup_session,
        )
        await topup_session.commit()

    purchase = await client.post(
        _PURCHASE_URL.format(practice_id=pid),
        headers=auth_headers(viewer["session_token"]),
    )
    assert purchase.status_code == 201

    resp = await client.get(
        f"{PRACTICES_URL}?master_id={master_id}",
        headers=auth_headers(viewer["session_token"]),
    )
    item = next(i for i in resp.json()["items"] if i["id"] == pid)
    assert item["is_booked"] is True
    assert item["is_paid"] is True
