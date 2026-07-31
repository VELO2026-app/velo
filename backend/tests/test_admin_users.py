# =============================================================================
# Test: Admin -- User and Master listings (Phase 3.2)
# =============================================================================
#
# telegram_id ranges:
#   58001-58099 -- regular users
#   58100-58199 -- master applicants
#   58900-58999 -- admin users
# =============================================================================

from collections.abc import AsyncGenerator

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, login_user, full_cleanup_range

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
USERS_URL = "/api/v1/admin/users"
MAKE_MASTER_URL = "/api/v1/admin/users/{user_id}/make-master"
MASTERS_LIST_URL = "/api/v1/admin/masters/list"
MASTERS_PENDING_URL = "/api/v1/admin/masters/pending"
MASTERS_REJECTED_URL = "/api/v1/admin/masters/rejected"
APPLY_URL = "/api/v1/masters/apply"


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
    """Full ORM cleanup for telegram_id 58000-58999."""
    await full_cleanup_range(session, 58000, 58999, delete_users=False)
    await session.commit()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _valid_apply_body() -> dict:
    return {
        "profile": {
            "display_name": "List Test Master",
            "email": "list@test.com",
            "phone": "+1234567890",
        },
        "experience": {
            "methods": ["yoga"],
            "experience_years": 3,
            "bio": "Test master for listings",
            "certifications": [],
        },
        "documents": [{"type": "certificate", "number": "LIST-001"}],
    }


async def _make_admin(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int = 58900,
) -> str:
    auth = await login_user(
        client, telegram_id=telegram_id, first_name="ListAdmin"
    )
    await db_session.execute(
        update(User)
        .where(User.id == auth["user"]["id"])
        .values(role=UserRole.ADMIN.value)
    )
    await db_session.commit()
    return auth["session_token"]


# ---------------------------------------------------------------------------
# GET /admin/users -- auth checks
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_users_list_no_auth(client: AsyncClient) -> None:
    """No token: 401."""
    resp = await client.get(USERS_URL)
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_users_list_non_admin(client: AsyncClient) -> None:
    """Regular user: 403."""
    auth = await login_user(client, telegram_id=58001, first_name="NotAdmin")
    resp = await client.get(
        USERS_URL, headers=auth_headers(auth["session_token"])
    )
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# GET /admin/users -- pagination and response format
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_users_list_response_format(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Response has items, total, limit, offset."""
    token = await _make_admin(client, db_session)

    resp = await client.get(USERS_URL, headers=auth_headers(token))
    assert resp.status_code == 200
    data = resp.json()

    assert "items" in data
    assert "total" in data
    assert "limit" in data
    assert "offset" in data
    assert data["limit"] == 20
    assert data["offset"] == 0
    assert data["total"] >= 1  # at least the admin


@pytest.mark.asyncio
async def test_users_list_pagination(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Limit and offset work correctly."""
    token = await _make_admin(client, db_session)

    # Create a few users.
    for i in range(58010, 58015):
        await login_user(client, telegram_id=i, first_name=f"User{i}")

    resp = await client.get(
        f"{USERS_URL}?limit=2&offset=0", headers=auth_headers(token)
    )
    data = resp.json()
    assert len(data["items"]) == 2
    assert data["limit"] == 2
    assert data["offset"] == 0


# ---------------------------------------------------------------------------
# GET /admin/users -- role filter
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_users_list_filter_by_role(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Filter by role returns only matching users."""
    token = await _make_admin(client, db_session)

    resp = await client.get(
        f"{USERS_URL}?role=admin", headers=auth_headers(token)
    )
    data = resp.json()
    assert data["total"] >= 1
    for item in data["items"]:
        assert item["role"] == "admin"


# ---------------------------------------------------------------------------
# GET /admin/masters/list -- with applications
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_masters_list_all(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Masters list returns applicants with status."""
    token = await _make_admin(client, db_session)

    # Submit 2 applications.
    for tg_id in (58100, 58101):
        auth = await login_user(
            client, telegram_id=tg_id, first_name=f"Master{tg_id}"
        )
        await client.post(
            APPLY_URL,
            json=_valid_apply_body(),
            headers=auth_headers(auth["session_token"]),
        )

    resp = await client.get(
        MASTERS_LIST_URL, headers=auth_headers(token)
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] >= 2
    for item in data["items"]:
        assert "master_status" in item


# ---------------------------------------------------------------------------
# GET /admin/masters/pending -- shortcut
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_masters_pending_shortcut(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Pending shortcut returns only pending applications."""
    token = await _make_admin(client, db_session)

    # Submit application.
    auth = await login_user(
        client, telegram_id=58110, first_name="PendingMaster"
    )
    await client.post(
        APPLY_URL,
        json=_valid_apply_body(),
        headers=auth_headers(auth["session_token"]),
    )

    resp = await client.get(
        MASTERS_PENDING_URL, headers=auth_headers(token)
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] >= 1
    for item in data["items"]:
        assert item["master_status"] == "pending"


# ---------------------------------------------------------------------------
# GET /admin/masters/rejected -- shortcut
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_masters_rejected_shortcut(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Rejected shortcut returns only rejected applications."""
    token = await _make_admin(client, db_session)

    # Submit and reject application.
    auth = await login_user(
        client, telegram_id=58120, first_name="RejectMe"
    )
    await client.post(
        APPLY_URL,
        json=_valid_apply_body(),
        headers=auth_headers(auth["session_token"]),
    )
    user_id = auth["user"]["id"]
    await client.post(
        f"/api/v1/admin/masters/{user_id}/reject",
        json={"reason": "Not ready"},
        headers=auth_headers(token),
    )

    resp = await client.get(
        MASTERS_REJECTED_URL, headers=auth_headers(token)
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] >= 1
    for item in data["items"]:
        assert item["master_status"] == "rejected"


# ---------------------------------------------------------------------------
# GET /admin/masters/list?status=verified -- after verify
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_masters_list_verified_filter(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Status filter returns only verified masters."""
    token = await _make_admin(client, db_session)

    # Submit and verify application.
    auth = await login_user(
        client, telegram_id=58130, first_name="VerifyMe"
    )
    await client.post(
        APPLY_URL,
        json=_valid_apply_body(),
        headers=auth_headers(auth["session_token"]),
    )
    user_id = auth["user"]["id"]
    await client.post(
        f"/api/v1/admin/masters/{user_id}/verify",
        json={},
        headers=auth_headers(token),
    )

    resp = await client.get(
        f"{MASTERS_LIST_URL}?status=verified", headers=auth_headers(token)
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] >= 1
    for item in data["items"]:
        assert item["master_status"] == "verified"


# ---------------------------------------------------------------------------
# POST /admin/users/{user_id}/make-master (PROMPT №292)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_make_master_no_auth(client: AsyncClient) -> None:
    """No token: 401."""
    resp = await client.post(MAKE_MASTER_URL.format(user_id=1))
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_make_master_non_admin(client: AsyncClient) -> None:
    """Regular user: 403."""
    auth = await login_user(client, telegram_id=58051, first_name="NotAdmin")
    resp = await client.post(
        MAKE_MASTER_URL.format(user_id=auth["user"]["id"]),
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_make_master_success(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Admin promotes a plain user: 200, status verified, role becomes master."""
    token = await _make_admin(client, db_session)

    target = await login_user(
        client, telegram_id=58052, first_name="Promote"
    )
    user_id = target["user"]["id"]

    resp = await client.post(
        MAKE_MASTER_URL.format(user_id=user_id), headers=auth_headers(token)
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["user_id"] == user_id
    assert data["status"] == "verified"

    # The user now appears in the verified masters list.
    masters = await client.get(
        f"{MASTERS_LIST_URL}?status=verified", headers=auth_headers(token)
    )
    ids = [m["id"] for m in masters.json()["items"]]
    assert user_id in ids


@pytest.mark.asyncio
async def test_make_master_already_master_conflict(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Promoting an already-master user: 409 already_master."""
    token = await _make_admin(client, db_session)

    target = await login_user(
        client, telegram_id=58053, first_name="Twice"
    )
    user_id = target["user"]["id"]

    first = await client.post(
        MAKE_MASTER_URL.format(user_id=user_id), headers=auth_headers(token)
    )
    assert first.status_code == 200

    second = await client.post(
        MAKE_MASTER_URL.format(user_id=user_id), headers=auth_headers(token)
    )
    assert second.status_code == 409


@pytest.mark.asyncio
async def test_make_master_nonexistent_user(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Unknown user_id: 404."""
    token = await _make_admin(client, db_session)
    resp = await client.post(
        MAKE_MASTER_URL.format(
            user_id="00000000-0000-0000-0000-000000000000"
        ),
        headers=auth_headers(token),
    )
    assert resp.status_code == 404
