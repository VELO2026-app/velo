# =============================================================================
# Tests: Promo CRUD -- Master Flow (Phase 6.7)
# =============================================================================
#
# telegram_id range: 79000-79999
#   79001-79099: masters
#   79900-79999: admin users (for verify flow)
#
# Scenarios tested:
#   - POST /masters/me/promos: create promo (success, duplicate code,
#     invalid discount, valid_until before valid_from, practice not owned)
#   - GET /masters/me/promos: list (empty, with items, pagination)
#   - PATCH /masters/me/promos/{id}/deactivate: success, already inactive,
#     not owned, not found
#   - Code uppercasing
#   - Non-master user -> 403
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.promos.models import Promo
from app.modules.users.models import User, UserRole
from tests.helpers import (
    auth_headers,
    login_user,
    full_cleanup_range,
    switch_self_to_master,
)

# ---------------------------------------------------------------------------
# URLs
# ---------------------------------------------------------------------------
PROMOS_URL = "/api/v1/masters/me/promos"
DEACTIVATE_URL = "/api/v1/masters/me/promos/{promo_id}/deactivate"
APPLY_URL = "/api/v1/masters/apply"
VERIFY_URL = "/api/v1/admin/masters/{user_id}/verify"

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

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
    """Full ORM cleanup for telegram_id 79000-79999."""
    await full_cleanup_range(session, 79000, 79999, delete_users=True)
    await session.commit()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
async def _create_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int = 79001,
) -> dict:
    """Create a user, apply as master, verify via admin. Returns session info."""
    auth = await login_user(client, telegram_id=telegram_id)
    token = auth["session_token"]

    await client.post(
        APPLY_URL,
        json={
            "profile": {
                "display_name": f"Master {telegram_id}",
                "email": f"m{telegram_id}@test.com",
            },
            "experience": {
                "methods": ["meditation"],
                "experience_years": 3,
            },
        },
        headers=auth_headers(token),
    )

    user_id = auth["user"]["id"]

    # Create admin and verify.
    admin_auth = await login_user(client, telegram_id=79900)
    await db_session.execute(
        update(User)
        .where(User.telegram_id == 79900)
        .values(role=UserRole.ADMIN.value)
    )
    await db_session.commit()
    admin_auth = await login_user(client, telegram_id=79900)

    verify_resp = await client.post(
        VERIFY_URL.format(user_id=user_id),
        json={},
        headers=auth_headers(admin_auth["session_token"]),
    )
    assert verify_resp.status_code == 200

    # T4 (PROMPT №295): approval sets status=verified but no longer flips role;
    # the applicant self-switches to master (capability path).
    await switch_self_to_master(client, auth["session_token"])

    # Re-login to pick up role=master.
    auth = await login_user(client, telegram_id=telegram_id)
    return {
        "session_token": auth["session_token"],
        "user_id": user_id,
    }


def _valid_promo_body(code: str = "SUMMER25") -> dict:
    """Minimal valid promo creation payload."""
    return {
        "code": code,
        "discount_percent": 25,
        "valid_from": (datetime.now(timezone.utc) - timedelta(days=1)).isoformat(),
        "valid_until": (datetime.now(timezone.utc) + timedelta(days=30)).isoformat(),
    }


# ---------------------------------------------------------------------------
# POST /masters/me/promos -- create
# ---------------------------------------------------------------------------


async def test_create_promo_success(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Master can create a promo code."""
    master = await _create_verified_master(client, db_session)
    body = _valid_promo_body("TESTCODE1")

    resp = await client.post(
        PROMOS_URL,
        json=body,
        headers=auth_headers(master["session_token"]),
    )

    assert resp.status_code == 201
    data = resp.json()
    assert data["code"] == "TESTCODE1"
    assert data["type"] == "master"
    assert data["discount_percent"] == 25
    assert data["master_id"] == master["user_id"]
    assert data["is_active"] is True
    assert data["used_count"] == 0


async def test_create_promo_code_uppercased(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Promo code is automatically uppercased."""
    master = await _create_verified_master(client, db_session)
    body = _valid_promo_body("lowercase")

    resp = await client.post(
        PROMOS_URL,
        json=body,
        headers=auth_headers(master["session_token"]),
    )

    assert resp.status_code == 201
    assert resp.json()["code"] == "LOWERCASE"


async def test_create_promo_duplicate_code(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Duplicate code returns 400."""
    master = await _create_verified_master(client, db_session)

    body = _valid_promo_body("DUPE1")
    resp1 = await client.post(
        PROMOS_URL, json=body,
        headers=auth_headers(master["session_token"]),
    )
    assert resp1.status_code == 201

    resp2 = await client.post(
        PROMOS_URL, json=body,
        headers=auth_headers(master["session_token"]),
    )
    assert resp2.status_code == 400
    assert "already exists" in resp2.json()["message"]


async def test_create_promo_invalid_discount(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Discount not in allowed list returns 400."""
    master = await _create_verified_master(client, db_session)
    body = _valid_promo_body("BAD1")
    body["discount_percent"] = 33  # Not in [5, 25, 50, 75, 100].

    resp = await client.post(
        PROMOS_URL, json=body,
        headers=auth_headers(master["session_token"]),
    )

    assert resp.status_code == 400
    assert "Discount must be one of" in resp.json()["message"]


async def test_create_promo_valid_until_before_valid_from(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """valid_until before valid_from returns 400."""
    master = await _create_verified_master(client, db_session)
    now = datetime.now(timezone.utc)
    body = _valid_promo_body("BAD2")
    body["valid_from"] = (now + timedelta(days=10)).isoformat()
    body["valid_until"] = (now + timedelta(days=5)).isoformat()

    resp = await client.post(
        PROMOS_URL, json=body,
        headers=auth_headers(master["session_token"]),
    )

    assert resp.status_code == 400
    assert "valid_until" in resp.json()["message"]


async def test_create_promo_omitted_valid_from_defaults_to_now(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """R6 regression (PROMPT №390): POSTing a master promo with NO valid_from
    key at all in the JSON body must succeed (201), not 500. Before the fix,
    pydantic's before-validator never ran against the omitted default (needs
    validate_default=True), so valid_from stayed None all the way to
    `valid_until <= body.valid_from` in promos/service.py -- a guaranteed
    TypeError, since MasterNewPromocodeView.vue's real request never sends
    valid_from and always sends valid_until.
    """
    master = await _create_verified_master(client, db_session)
    body = _valid_promo_body("TESTOMIT1")
    del body["valid_from"]

    before = datetime.now(timezone.utc)
    resp = await client.post(
        PROMOS_URL, json=body,
        headers=auth_headers(master["session_token"]),
    )
    after = datetime.now(timezone.utc)

    assert resp.status_code == 201
    data = resp.json()
    assert data["valid_from"] is not None
    valid_from = datetime.fromisoformat(data["valid_from"])
    assert before <= valid_from <= after


async def test_create_promo_not_master(
    client: AsyncClient,
) -> None:
    """Non-master user gets 403."""
    user = await login_user(client, telegram_id=79050)
    body = _valid_promo_body("NOPE1")

    resp = await client.post(
        PROMOS_URL, json=body,
        headers=auth_headers(user["session_token"]),
    )

    assert resp.status_code == 403


async def test_create_promo_with_max_uses(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Promo with max_uses is stored correctly."""
    master = await _create_verified_master(client, db_session)
    body = _valid_promo_body("LIMITED1")
    body["max_uses"] = 10

    resp = await client.post(
        PROMOS_URL, json=body,
        headers=auth_headers(master["session_token"]),
    )

    assert resp.status_code == 201
    assert resp.json()["max_uses"] == 10


async def test_create_promo_first_purchase_only(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """first_purchase_only flag is stored correctly."""
    master = await _create_verified_master(client, db_session)
    body = _valid_promo_body("FIRST1")
    body["first_purchase_only"] = True

    resp = await client.post(
        PROMOS_URL, json=body,
        headers=auth_headers(master["session_token"]),
    )

    assert resp.status_code == 201
    assert resp.json()["first_purchase_only"] is True


# ---------------------------------------------------------------------------
# GET /masters/me/promos -- list
# ---------------------------------------------------------------------------


async def test_list_promos_empty(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Empty list when master has no promos."""
    master = await _create_verified_master(client, db_session)

    resp = await client.get(
        PROMOS_URL,
        headers=auth_headers(master["session_token"]),
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["items"] == []
    assert data["total"] == 0


async def test_list_promos_with_items(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """List returns created promos in newest-first order."""
    master = await _create_verified_master(client, db_session)
    headers = auth_headers(master["session_token"])

    # Create two promos.
    await client.post(
        PROMOS_URL, json=_valid_promo_body("LIST1"), headers=headers,
    )
    await client.post(
        PROMOS_URL, json=_valid_promo_body("LIST2"), headers=headers,
    )

    resp = await client.get(PROMOS_URL, headers=headers)
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 2
    assert len(data["items"]) == 2
    # Newest first.
    assert data["items"][0]["code"] == "LIST2"
    assert data["items"][1]["code"] == "LIST1"


async def test_list_promos_pagination(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Pagination works: limit=1 returns one item, total=2."""
    master = await _create_verified_master(client, db_session)
    headers = auth_headers(master["session_token"])

    await client.post(
        PROMOS_URL, json=_valid_promo_body("PAGE1"), headers=headers,
    )
    await client.post(
        PROMOS_URL, json=_valid_promo_body("PAGE2"), headers=headers,
    )

    resp = await client.get(
        PROMOS_URL, headers=headers, params={"limit": 1, "offset": 0},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 2
    assert len(data["items"]) == 1


async def test_list_promos_isolation(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Master only sees their own promos, not other masters'."""
    master1 = await _create_verified_master(client, db_session, telegram_id=79002)
    master2 = await _create_verified_master(client, db_session, telegram_id=79003)

    await client.post(
        PROMOS_URL, json=_valid_promo_body("MINE1"),
        headers=auth_headers(master1["session_token"]),
    )
    await client.post(
        PROMOS_URL, json=_valid_promo_body("THEIRS1"),
        headers=auth_headers(master2["session_token"]),
    )

    resp = await client.get(
        PROMOS_URL, headers=auth_headers(master1["session_token"]),
    )
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["code"] == "MINE1"


# ---------------------------------------------------------------------------
# PATCH /masters/me/promos/{id}/deactivate
# ---------------------------------------------------------------------------


async def test_deactivate_promo_success(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Master can deactivate their own promo."""
    master = await _create_verified_master(client, db_session)
    headers = auth_headers(master["session_token"])

    create_resp = await client.post(
        PROMOS_URL, json=_valid_promo_body("DEACT1"), headers=headers,
    )
    promo_id = create_resp.json()["id"]

    resp = await client.patch(
        DEACTIVATE_URL.format(promo_id=promo_id), headers=headers,
    )

    assert resp.status_code == 200
    assert resp.json()["is_active"] is False


async def test_deactivate_promo_already_inactive(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Deactivating already-inactive promo returns 400."""
    master = await _create_verified_master(client, db_session)
    headers = auth_headers(master["session_token"])

    create_resp = await client.post(
        PROMOS_URL, json=_valid_promo_body("DEACT2"), headers=headers,
    )
    promo_id = create_resp.json()["id"]

    # First deactivation.
    await client.patch(
        DEACTIVATE_URL.format(promo_id=promo_id), headers=headers,
    )

    # Second deactivation.
    resp = await client.patch(
        DEACTIVATE_URL.format(promo_id=promo_id), headers=headers,
    )
    assert resp.status_code == 400
    assert "already deactivated" in resp.json()["message"]


async def test_deactivate_promo_not_owned(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Master cannot deactivate another master's promo."""
    master1 = await _create_verified_master(client, db_session, telegram_id=79004)
    master2 = await _create_verified_master(client, db_session, telegram_id=79005)

    create_resp = await client.post(
        PROMOS_URL, json=_valid_promo_body("OTHER1"),
        headers=auth_headers(master1["session_token"]),
    )
    promo_id = create_resp.json()["id"]

    # Master2 tries to deactivate master1's promo.
    resp = await client.patch(
        DEACTIVATE_URL.format(promo_id=promo_id),
        headers=auth_headers(master2["session_token"]),
    )
    assert resp.status_code == 404


async def test_deactivate_promo_not_found(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Non-existent promo returns 404."""
    master = await _create_verified_master(client, db_session)
    fake_id = "00000000-0000-0000-0000-000000000000"

    resp = await client.patch(
        DEACTIVATE_URL.format(promo_id=fake_id),
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 404
