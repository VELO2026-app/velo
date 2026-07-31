# =============================================================================
# Test: Admin -- Platform statistics (Phase 3.1)
# =============================================================================
#
# telegram_id ranges:
#   57001-57099 -- regular users for stats
#   57900-57999 -- admin users
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, login_user, full_cleanup_range, switch_self_to_master

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
STATS_URL = "/api/v1/admin/stats"
APPLY_URL = "/api/v1/masters/apply"
VERIFY_URL = "/api/v1/admin/masters/{user_id}/verify"
PRACTICES_URL = "/api/v1/practices"


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
    """Full ORM cleanup for telegram_id 57000-57999."""
    await full_cleanup_range(session, 57000, 57999, delete_users=True)
    await session.commit()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _valid_apply_body() -> dict:
    """Minimal valid master application payload."""
    return {
        "profile": {
            "display_name": "Stats Test Master",
            "email": "stats@test.com",
            "phone": "+1234567890",
        },
        "experience": {
            "methods": ["meditation"],
            "experience_years": 5,
            "bio": "Test master for stats",
            "certifications": ["Cert A"],
        },
        "documents": [{"type": "certificate", "number": "CERT-001"}],
    }


def _valid_practice_body(**overrides: object) -> dict:
    """Return a valid CreatePracticeRequest body."""
    base: dict = {
        "practice_type": "live",
        "direction": "meditation",
        "difficulty": "beginner",
        "title": "Stats Test Practice",
        "description": "Practice created in stats test",
        "scheduled_at": (
            datetime.now(timezone.utc) + timedelta(days=7)
        ).isoformat(),
        "duration_minutes": 60,
        "timezone": "Europe/Berlin",
        "max_participants": 10,
        "is_free": True,
        "price_cents": 0,
        "currency": "eur",
    }
    base.update(overrides)
    return base


async def _make_admin(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int = 57900,
) -> str:
    """Create admin user, return session token."""
    auth = await login_user(
        client, telegram_id=telegram_id, first_name="StatsAdmin"
    )
    token = auth["session_token"]
    user_id = auth["user"]["id"]

    await db_session.execute(
        update(User)
        .where(User.id == user_id)
        .values(role=UserRole.ADMIN.value)
    )
    await db_session.commit()

    return token


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    master_telegram_id: int = 57040,
    admin_telegram_id: int = 57901,
) -> dict:
    """Create user, submit application, verify via admin. Returns auth data."""
    # Create master applicant.
    auth = await login_user(
        client,
        telegram_id=master_telegram_id,
        first_name=f"StatsMaster{master_telegram_id}",
    )
    await client.post(
        APPLY_URL,
        json=_valid_apply_body(),
        headers=auth_headers(auth["session_token"]),
    )

    # Verify via admin.
    admin_token = await _make_admin(
        client, db_session, telegram_id=admin_telegram_id,
    )
    verify_resp = await client.post(
        VERIFY_URL.format(user_id=auth["user"]["id"]),
        json={},
        headers=auth_headers(admin_token),
    )
    assert verify_resp.status_code == 200

    # Re-login so session reflects master role.
    await switch_self_to_master(client, auth["session_token"])
    auth = await login_user(
        client,
        telegram_id=master_telegram_id,
        first_name=f"StatsMaster{master_telegram_id}",
    )
    return auth


# ---------------------------------------------------------------------------
# GET /admin/stats -- no auth
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_stats_no_auth(client: AsyncClient) -> None:
    """No Authorization header: 401."""
    resp = await client.get(STATS_URL)
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# GET /admin/stats -- non-admin
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_stats_non_admin(client: AsyncClient) -> None:
    """Regular user (not admin): 403."""
    auth = await login_user(client, telegram_id=57010, first_name="NotAdmin")
    resp = await client.get(
        STATS_URL, headers=auth_headers(auth["session_token"])
    )
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# GET /admin/stats -- basic counts
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_stats_basic_counts(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Stats reflect actual user and master counts."""
    admin_token = await _make_admin(client, db_session)

    # Baseline: at least the admin user exists.
    resp1 = await client.get(
        STATS_URL, headers=auth_headers(admin_token)
    )
    assert resp1.status_code == 200
    data1 = resp1.json()
    baseline_users = data1["users_count"]
    baseline_masters = data1["masters_count"]

    # Create 2 regular users.
    await login_user(client, telegram_id=57001, first_name="User1")
    await login_user(client, telegram_id=57002, first_name="User2")

    resp2 = await client.get(
        STATS_URL, headers=auth_headers(admin_token)
    )
    data2 = resp2.json()
    assert data2["users_count"] == baseline_users + 2
    assert data2["masters_count"] == baseline_masters


# ---------------------------------------------------------------------------
# GET /admin/stats -- pending verifications
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_stats_pending_verifications(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Pending count reflects actual pending master applications."""
    admin_token = await _make_admin(client, db_session)

    # Baseline pending count.
    resp1 = await client.get(
        STATS_URL, headers=auth_headers(admin_token)
    )
    baseline_pending = resp1.json()["pending_verifications"]

    # Submit 2 master applications.
    for tg_id in (57020, 57021):
        auth = await login_user(
            client, telegram_id=tg_id, first_name=f"Applicant{tg_id}"
        )
        await client.post(
            APPLY_URL,
            json=_valid_apply_body(),
            headers=auth_headers(auth["session_token"]),
        )

    resp2 = await client.get(
        STATS_URL, headers=auth_headers(admin_token)
    )
    assert resp2.json()["pending_verifications"] == baseline_pending + 2


# ---------------------------------------------------------------------------
# GET /admin/stats -- masters count after verification
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_stats_masters_count_after_verify(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Admin-verify grants master CAPABILITY, not role (T4, PROMPT №295).

    verify sets the profile status=verified but does NOT flip User.role, so
    masters_count (COUNT role=='master') is UNCHANGED at verify -- only the
    pending application clears. The count rises only once the applicant enters
    master mode (self-switch via POST /users/me/role), exercised here with the
    shared switch_self_to_master helper.
    """
    admin_token = await _make_admin(client, db_session)

    # Create applicant and submit application.
    applicant_auth = await login_user(
        client, telegram_id=57030, first_name="ToVerify"
    )
    await client.post(
        APPLY_URL,
        json=_valid_apply_body(),
        headers=auth_headers(applicant_auth["session_token"]),
    )

    # Stats before verification.
    resp1 = await client.get(
        STATS_URL, headers=auth_headers(admin_token)
    )
    before = resp1.json()

    # Verify the applicant (grants capability; role stays 'user').
    user_id = applicant_auth["user"]["id"]
    verify_resp = await client.post(
        f"/api/v1/admin/masters/{user_id}/verify",
        json={},
        headers=auth_headers(admin_token),
    )
    assert verify_resp.status_code == 200

    # After verify: masters_count UNCHANGED (no role flip); pending clears.
    resp2 = await client.get(
        STATS_URL, headers=auth_headers(admin_token)
    )
    after_verify = resp2.json()
    assert after_verify["masters_count"] == before["masters_count"]
    assert (
        after_verify["pending_verifications"]
        == before["pending_verifications"] - 1
    )

    # The applicant self-switches into master mode -> now role='master'.
    await switch_self_to_master(client, applicant_auth["session_token"])

    resp3 = await client.get(
        STATS_URL, headers=auth_headers(admin_token)
    )
    after_switch = resp3.json()
    assert after_switch["masters_count"] == before["masters_count"] + 1
    assert (
        after_switch["pending_verifications"]
        == before["pending_verifications"] - 1
    )


# ---------------------------------------------------------------------------
# GET /admin/stats -- practices_count reflects real practice count
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_stats_practices_count(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """practices_count increases when a master creates a practice.

    Phase 4.1: practices_count is a real COUNT(*) from the practices table,
    not a stub. Test uses baseline+delta to stay independent of seed data.
    """
    admin_token = await _make_admin(client, db_session, telegram_id=57900)

    # Baseline: whatever is already in the DB (may include seed data).
    resp1 = await client.get(
        STATS_URL, headers=auth_headers(admin_token)
    )
    assert resp1.status_code == 200
    baseline = resp1.json()["practices_count"]

    # Create a verified master and let them create a practice.
    master_auth = await _make_verified_master(
        client,
        db_session,
        master_telegram_id=57040,
        admin_telegram_id=57901,
    )
    create_resp = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(),
        headers=auth_headers(master_auth["session_token"]),
    )
    assert create_resp.status_code == 201

    # practices_count must have increased by exactly 1.
    resp2 = await client.get(
        STATS_URL, headers=auth_headers(admin_token)
    )
    assert resp2.json()["practices_count"] == baseline + 1
