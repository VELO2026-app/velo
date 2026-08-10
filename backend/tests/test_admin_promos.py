# =============================================================================
# Test: Admin Promos -- Company promo CRUD (Phase 6.7, Batch 3)
# =============================================================================
#
# telegram_id ranges:
#   80001-80099 -- masters (for master promo creation in filter tests)
#   80900-80999 -- admins
#
# Scenarios tested:
#   CREATE:
#     - success (code uppercased, type=company, master_id=None)
#     - duplicate code (400)
#     - invalid discount (400)
#     - valid_until before valid_from (400)
#     - non-admin user (403)
#   LIST:
#     - empty list
#     - with items
#     - filter by type (company vs master)
#     - filter by is_active
#     - pagination (limit/offset)
#   DEACTIVATE:
#     - success (company promo)
#     - success (master promo, T5 -- widened from company-only)
#     - already inactive (409)
#     - not found (404)
#     - non-admin user (403)
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from tests.helpers import auth_headers, login_user, switch_self_to_master

# ---------------------------------------------------------------------------
# URLs
# ---------------------------------------------------------------------------
ADMIN_PROMOS_URL = "/api/v1/admin/promos"
DEACTIVATE_URL = "/api/v1/admin/promos/{promo_id}/deactivate"
# Master promo creation (for filter tests).
MASTER_PROMOS_URL = "/api/v1/masters/me/promos"
APPLY_URL = "/api/v1/masters/apply"
VERIFY_URL = "/api/v1/admin/masters/{user_id}/verify"

# ---------------------------------------------------------------------------
# Cleanup (dependency order: audit -> promos -> master_profiles ->
#   reset users -> delete users)
# ---------------------------------------------------------------------------
_TID_RANGE = (
    "SELECT id FROM users WHERE telegram_id BETWEEN 80000 AND 80999"
)

_CLEANUP_QUERIES = [
    # 1. Audit logs referencing our users.
    text(
        "DELETE FROM audit_logs WHERE actor_id IN (" + _TID_RANGE + ")"
    ),
    # 2. Promos (both company created by admin and master promos).
    text(
        "DELETE FROM promos WHERE master_id IN (" + _TID_RANGE + ") "
        "OR code LIKE 'TEST80%%'"
    ),
    # 3. Master profiles.
    text(
        "DELETE FROM master_profiles WHERE user_id IN "
        "(" + _TID_RANGE + ")"
    ),
    # 4. Reset roles.
    text(
        "UPDATE users SET role = 'user' "
        "WHERE telegram_id BETWEEN 80000 AND 80999"
    ),
    # 5. Delete users.
    text(
        "DELETE FROM users WHERE telegram_id BETWEEN 80000 AND 80999"
    ),
]


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
async def _cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """Clean up test data before and after each test."""
    for q in _CLEANUP_QUERIES:
        await db_session.execute(q)
    await db_session.commit()
    yield
    for q in _CLEANUP_QUERIES:
        await db_session.execute(q)
    await db_session.commit()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
async def _make_admin(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int = 80900,
) -> dict:
    """Create a user and promote to admin. Returns auth data."""
    auth = await login_user(
        client, telegram_id=telegram_id, first_name="Admin",
    )
    await db_session.execute(
        text(
            f"UPDATE users SET role = 'admin' "
            f"WHERE telegram_id = {telegram_id}"
        ),
    )
    await db_session.commit()
    # Re-login to pick up role in session.
    auth = await login_user(
        client, telegram_id=telegram_id, first_name="Admin",
    )
    return {
        "session_token": auth["session_token"],
        "user_id": auth["user"]["id"],
    }


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int = 80001,
) -> dict:
    """Create user, apply as master, verify via admin. Returns auth data."""
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

    # Admin verifies.
    admin = await _make_admin(client, db_session, telegram_id=80901)
    verify_resp = await client.post(
        VERIFY_URL.format(user_id=user_id),
        json={},
        headers=auth_headers(admin["session_token"]),
    )
    assert verify_resp.status_code == 200

    # Re-login to pick up role=master.
    await switch_self_to_master(client, auth["session_token"])
    auth = await login_user(client, telegram_id=telegram_id)
    return {
        "session_token": auth["session_token"],
        "user_id": user_id,
    }


def _valid_company_promo_body(code: str = "TEST80WELCOME") -> dict:
    """Minimal valid company promo creation payload."""
    return {
        "code": code,
        "discount_percent": 25,
        "valid_from": (
            datetime.now(timezone.utc) - timedelta(days=1)
        ).isoformat(),
        "valid_until": (
            datetime.now(timezone.utc) + timedelta(days=30)
        ).isoformat(),
    }


# ===================================================================
# POST /admin/promos -- create company promo
# ===================================================================


@pytest.mark.asyncio
async def test_create_company_promo_success(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Admin creates a company promo: 201, type=company, master_id=None."""
    admin = await _make_admin(client, db_session)

    resp = await client.post(
        ADMIN_PROMOS_URL,
        json=_valid_company_promo_body("TEST80NEW"),
        headers=auth_headers(admin["session_token"]),
    )
    assert resp.status_code == 201
    data = resp.json()

    assert data["code"] == "TEST80NEW"
    assert data["type"] == "company"
    assert data["master_id"] is None
    assert data["practice_id"] is None
    assert data["discount_percent"] == 25
    assert data["is_active"] is True
    assert data["used_count"] == 0


@pytest.mark.asyncio
async def test_create_company_promo_uppercases_code(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Code is automatically uppercased."""
    admin = await _make_admin(client, db_session)

    resp = await client.post(
        ADMIN_PROMOS_URL,
        json=_valid_company_promo_body("test80lower"),
        headers=auth_headers(admin["session_token"]),
    )
    assert resp.status_code == 201
    assert resp.json()["code"] == "TEST80LOWER"


@pytest.mark.asyncio
async def test_create_company_promo_duplicate_code(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Duplicate code: 400."""
    admin = await _make_admin(client, db_session)

    body = _valid_company_promo_body("TEST80DUP")
    resp1 = await client.post(
        ADMIN_PROMOS_URL, json=body,
        headers=auth_headers(admin["session_token"]),
    )
    assert resp1.status_code == 201

    resp2 = await client.post(
        ADMIN_PROMOS_URL, json=body,
        headers=auth_headers(admin["session_token"]),
    )
    assert resp2.status_code == 400
    assert "already exists" in resp2.json()["message"]


@pytest.mark.asyncio
async def test_create_company_promo_invalid_discount(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Invalid discount percent: 400."""
    admin = await _make_admin(client, db_session)

    body = _valid_company_promo_body("TEST80BAD")
    body["discount_percent"] = 33  # Not in [5, 25, 50, 75, 100].

    resp = await client.post(
        ADMIN_PROMOS_URL, json=body,
        headers=auth_headers(admin["session_token"]),
    )
    assert resp.status_code == 400
    assert "Discount must be one of" in resp.json()["message"]


@pytest.mark.asyncio
async def test_create_company_promo_invalid_validity(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """valid_until before valid_from: 400."""
    admin = await _make_admin(client, db_session)

    now = datetime.now(timezone.utc)
    body = _valid_company_promo_body("TEST80INV")
    body["valid_from"] = (now + timedelta(days=10)).isoformat()
    body["valid_until"] = (now + timedelta(days=5)).isoformat()

    resp = await client.post(
        ADMIN_PROMOS_URL, json=body,
        headers=auth_headers(admin["session_token"]),
    )
    assert resp.status_code == 400
    assert "valid_until" in resp.json()["message"]


@pytest.mark.asyncio
async def test_create_company_promo_with_options(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Create with max_uses and first_purchase_only."""
    admin = await _make_admin(client, db_session)

    body = _valid_company_promo_body("TEST80OPTS")
    body["max_uses"] = 100
    body["first_purchase_only"] = True

    resp = await client.post(
        ADMIN_PROMOS_URL, json=body,
        headers=auth_headers(admin["session_token"]),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["max_uses"] == 100
    assert data["first_purchase_only"] is True


@pytest.mark.asyncio
async def test_create_company_promo_not_admin(
    client: AsyncClient,
) -> None:
    """Non-admin user: 403."""
    auth = await login_user(client, telegram_id=80010, first_name="User")

    resp = await client.post(
        ADMIN_PROMOS_URL,
        json=_valid_company_promo_body("TEST80NOPE"),
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 403


# ===================================================================
# GET /admin/promos -- list all promos
# ===================================================================


@pytest.mark.asyncio
async def test_list_promos_empty(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The list endpoint returns a well-formed, correctly-paginated response.

    Does NOT assert the database is empty -- /admin/promos is global (every
    company promo, not scoped to this test's own users), and this is a
    shared, human-used TEST database: the cleanup fixture above only removes
    promos it created itself (own users, or code LIKE 'TEST80%') and cannot
    know about a promo the operator created by hand through the admin UI with
    an arbitrary code. test_list_promos_with_items below covers the
    has-our-own-data case; this test only guards the response SHAPE and the
    documented pagination defaults, which hold regardless of what else is in
    the table.
    """
    admin = await _make_admin(client, db_session)

    resp = await client.get(
        ADMIN_PROMOS_URL,
        headers=auth_headers(admin["session_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data["items"], list)
    assert len(data["items"]) <= data["limit"]
    assert data["total"] >= len(data["items"])
    assert data["limit"] == 20
    assert data["offset"] == 0


@pytest.mark.asyncio
async def test_list_promos_with_items(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Admin sees all created promos."""
    admin = await _make_admin(client, db_session)
    headers = auth_headers(admin["session_token"])

    # Create 2 company promos.
    await client.post(
        ADMIN_PROMOS_URL,
        json=_valid_company_promo_body("TEST80A"),
        headers=headers,
    )
    await client.post(
        ADMIN_PROMOS_URL,
        json=_valid_company_promo_body("TEST80B"),
        headers=headers,
    )

    resp = await client.get(ADMIN_PROMOS_URL, headers=headers)
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] >= 2

    codes = [p["code"] for p in data["items"]]
    assert "TEST80A" in codes
    assert "TEST80B" in codes


@pytest.mark.asyncio
async def test_list_promos_carries_master_name(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """T5: master-type items carry the owning master's name; company items don't.

    login_user's default first_name is "TestUser" (no last_name set) --
    asserted against that, not a hardcoded fixture name.
    """
    admin = await _make_admin(client, db_session)
    admin_headers = auth_headers(admin["session_token"])

    await client.post(
        ADMIN_PROMOS_URL,
        json=_valid_company_promo_body("TEST80NAME"),
        headers=admin_headers,
    )

    master = await _make_verified_master(client, db_session, telegram_id=80002)
    await client.post(
        MASTER_PROMOS_URL,
        json={
            "code": "TEST80MNAME",
            "discount_percent": 5,
            "valid_from": (
                datetime.now(timezone.utc) - timedelta(days=1)
            ).isoformat(),
        },
        headers=auth_headers(master["session_token"]),
    )

    resp = await client.get(ADMIN_PROMOS_URL, headers=admin_headers)
    assert resp.status_code == 200
    items = {p["code"]: p for p in resp.json()["items"]}

    assert items["TEST80NAME"]["master_first_name"] is None
    assert items["TEST80NAME"]["master_last_name"] is None
    assert items["TEST80MNAME"]["master_first_name"] == "TestUser"


@pytest.mark.asyncio
async def test_list_promos_filter_by_type(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Filter by type: company vs master."""
    admin = await _make_admin(client, db_session)
    admin_headers = auth_headers(admin["session_token"])

    # Create a company promo.
    await client.post(
        ADMIN_PROMOS_URL,
        json=_valid_company_promo_body("TEST80COMP"),
        headers=admin_headers,
    )

    # Create a master promo (need a verified master).
    master = await _make_verified_master(client, db_session)
    master_body = {
        "code": "TEST80MAST",
        "discount_percent": 5,
        "valid_from": (
            datetime.now(timezone.utc) - timedelta(days=1)
        ).isoformat(),
    }
    await client.post(
        MASTER_PROMOS_URL,
        json=master_body,
        headers=auth_headers(master["session_token"]),
    )

    # Filter: company only.
    resp_company = await client.get(
        f"{ADMIN_PROMOS_URL}?type=company",
        headers=admin_headers,
    )
    assert resp_company.status_code == 200
    types_company = [p["type"] for p in resp_company.json()["items"]]
    assert all(t == "company" for t in types_company)

    # Filter: master only.
    resp_master = await client.get(
        f"{ADMIN_PROMOS_URL}?type=master",
        headers=admin_headers,
    )
    assert resp_master.status_code == 200
    types_master = [p["type"] for p in resp_master.json()["items"]]
    assert all(t == "master" for t in types_master)


@pytest.mark.asyncio
async def test_list_promos_filter_by_is_active(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Filter by is_active: active vs inactive."""
    admin = await _make_admin(client, db_session)
    headers = auth_headers(admin["session_token"])

    # Create and deactivate one promo.
    resp1 = await client.post(
        ADMIN_PROMOS_URL,
        json=_valid_company_promo_body("TEST80ACT"),
        headers=headers,
    )
    assert resp1.status_code == 201

    resp2 = await client.post(
        ADMIN_PROMOS_URL,
        json=_valid_company_promo_body("TEST80DEACT"),
        headers=headers,
    )
    assert resp2.status_code == 201
    deact_id = resp2.json()["id"]

    await client.patch(
        DEACTIVATE_URL.format(promo_id=deact_id),
        headers=headers,
    )

    # Filter: active only.
    resp_active = await client.get(
        f"{ADMIN_PROMOS_URL}?is_active=true",
        headers=headers,
    )
    assert resp_active.status_code == 200
    active_codes = [p["code"] for p in resp_active.json()["items"]]
    assert "TEST80ACT" in active_codes
    assert "TEST80DEACT" not in active_codes

    # Filter: inactive only.
    resp_inactive = await client.get(
        f"{ADMIN_PROMOS_URL}?is_active=false",
        headers=headers,
    )
    assert resp_inactive.status_code == 200
    inactive_codes = [p["code"] for p in resp_inactive.json()["items"]]
    assert "TEST80DEACT" in inactive_codes
    assert "TEST80ACT" not in inactive_codes


@pytest.mark.asyncio
async def test_list_promos_pagination(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Pagination: limit and offset work."""
    admin = await _make_admin(client, db_session)
    headers = auth_headers(admin["session_token"])

    # Create 3 promos.
    for i in range(3):
        await client.post(
            ADMIN_PROMOS_URL,
            json=_valid_company_promo_body(f"TEST80PAG{i}"),
            headers=headers,
        )

    # Page 1: limit=2, offset=0.
    resp1 = await client.get(
        f"{ADMIN_PROMOS_URL}?limit=2&offset=0",
        headers=headers,
    )
    assert resp1.status_code == 200
    data1 = resp1.json()
    assert len(data1["items"]) == 2
    assert data1["total"] >= 3

    # Page 2: limit=2, offset=2.
    resp2 = await client.get(
        f"{ADMIN_PROMOS_URL}?limit=2&offset=2",
        headers=headers,
    )
    assert resp2.status_code == 200
    data2 = resp2.json()
    assert len(data2["items"]) >= 1

    # No overlap between pages.
    ids1 = {p["id"] for p in data1["items"]}
    ids2 = {p["id"] for p in data2["items"]}
    assert ids1.isdisjoint(ids2)


@pytest.mark.asyncio
async def test_list_promos_not_admin(
    client: AsyncClient,
) -> None:
    """Non-admin user: 403."""
    auth = await login_user(client, telegram_id=80020, first_name="User")

    resp = await client.get(
        ADMIN_PROMOS_URL,
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 403


# ===================================================================
# PATCH /admin/promos/{id}/deactivate -- deactivate company promo
# ===================================================================


@pytest.mark.asyncio
async def test_deactivate_company_promo_success(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Admin deactivates a company promo: is_active=False."""
    admin = await _make_admin(client, db_session)
    headers = auth_headers(admin["session_token"])

    # Create.
    resp = await client.post(
        ADMIN_PROMOS_URL,
        json=_valid_company_promo_body("TEST80DEL"),
        headers=headers,
    )
    assert resp.status_code == 201
    promo_id = resp.json()["id"]

    # Deactivate.
    resp2 = await client.patch(
        DEACTIVATE_URL.format(promo_id=promo_id),
        headers=headers,
    )
    assert resp2.status_code == 200
    assert resp2.json()["is_active"] is False
    assert resp2.json()["code"] == "TEST80DEL"


@pytest.mark.asyncio
async def test_deactivate_already_inactive(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Deactivating an already inactive promo: 409."""
    admin = await _make_admin(client, db_session)
    headers = auth_headers(admin["session_token"])

    resp = await client.post(
        ADMIN_PROMOS_URL,
        json=_valid_company_promo_body("TEST80INACT"),
        headers=headers,
    )
    promo_id = resp.json()["id"]

    # First deactivation.
    await client.patch(
        DEACTIVATE_URL.format(promo_id=promo_id),
        headers=headers,
    )

    # Second deactivation: 409.
    resp2 = await client.patch(
        DEACTIVATE_URL.format(promo_id=promo_id),
        headers=headers,
    )
    assert resp2.status_code == 409
    assert "already inactive" in resp2.json()["message"]


@pytest.mark.asyncio
async def test_deactivate_not_found(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Deactivating a non-existent promo: 404."""
    admin = await _make_admin(client, db_session)

    resp = await client.patch(
        DEACTIVATE_URL.format(promo_id=str(uuid4())),
        headers=auth_headers(admin["session_token"]),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_deactivate_master_promo_success(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """T5: admin CAN deactivate a master's promo (widened from company-only).

    Operator's explicit ask (2026-07-14): admin sees and deactivates every
    master's promos, not just company ones.
    """
    # Create a master promo.
    master = await _make_verified_master(client, db_session)
    master_body = {
        "code": "TEST80MPRO",
        "discount_percent": 5,
        "valid_from": (
            datetime.now(timezone.utc) - timedelta(days=1)
        ).isoformat(),
    }
    resp = await client.post(
        MASTER_PROMOS_URL,
        json=master_body,
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 201
    master_promo_id = resp.json()["id"]

    # Admin deactivates it.
    admin = await _make_admin(client, db_session, telegram_id=80902)
    resp2 = await client.patch(
        DEACTIVATE_URL.format(promo_id=master_promo_id),
        headers=auth_headers(admin["session_token"]),
    )
    assert resp2.status_code == 200
    assert resp2.json()["is_active"] is False
    assert resp2.json()["type"] == "master"


@pytest.mark.asyncio
async def test_deactivate_not_admin(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Non-admin user cannot deactivate: 403."""
    admin = await _make_admin(client, db_session)

    # Create a company promo with admin.
    resp = await client.post(
        ADMIN_PROMOS_URL,
        json=_valid_company_promo_body("TEST80NOADM"),
        headers=auth_headers(admin["session_token"]),
    )
    promo_id = resp.json()["id"]

    # Regular user tries to deactivate.
    user = await login_user(client, telegram_id=80030, first_name="User")
    resp2 = await client.patch(
        DEACTIVATE_URL.format(promo_id=promo_id),
        headers=auth_headers(user["session_token"]),
    )
    assert resp2.status_code == 403


# ===================================================================
# CreateCompanyPromoRequest.valid_from -- default-on-omit regression
# (C2, PROMPT №387): pydantic v2 does NOT run a mode="before" validator
# against a field's default unless validate_default=True is set. Omitting
# valid_from silently left it None instead of defaulting to now(UTC).
# ===================================================================


class TestValidFromDefaultsOnOmit:
    """CreateCompanyPromoRequest.valid_from must default to now(UTC) when
    the field is omitted entirely -- not just when it's explicitly null."""

    def test_omitted_defaults_to_now(self) -> None:
        """Field absent from the payload -> defaults to current UTC time."""
        from app.modules.admin.promos.schemas import CreateCompanyPromoRequest

        before = datetime.now(timezone.utc)
        req = CreateCompanyPromoRequest(code="OMITTED1", discount_percent=10)
        after = datetime.now(timezone.utc)

        assert req.valid_from is not None
        assert before <= req.valid_from <= after

    def test_explicit_null_defaults_to_now(self) -> None:
        """Field explicitly sent as null -> also defaults to current UTC
        time (this case already worked before the fix; must keep working)."""
        from app.modules.admin.promos.schemas import CreateCompanyPromoRequest

        before = datetime.now(timezone.utc)
        req = CreateCompanyPromoRequest(
            code="EXPLNULL1", discount_percent=10, valid_from=None
        )
        after = datetime.now(timezone.utc)

        assert req.valid_from is not None
        assert before <= req.valid_from <= after

    def test_explicit_datetime_is_kept(self) -> None:
        """An explicit valid_from is passed through unchanged, not
        overridden by the default-to-now behavior."""
        from app.modules.admin.promos.schemas import CreateCompanyPromoRequest

        explicit = datetime(2030, 1, 1, tzinfo=timezone.utc)
        req = CreateCompanyPromoRequest(
            code="EXPLDT1", discount_percent=10, valid_from=explicit
        )

        assert req.valid_from == explicit


@pytest.mark.asyncio
async def test_create_company_promo_omitted_valid_from_defaults_to_now(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """End-to-end (C2 regression): POSTing a company promo with no
    valid_from key at all in the JSON body must succeed and the created
    promo's valid_from must be ~now, not null -- omitting the field is the
    documented, intended way to create an "active immediately" promo."""
    admin = await _make_admin(client, db_session)

    body = _valid_company_promo_body("TEST80OMIT")
    del body["valid_from"]

    before = datetime.now(timezone.utc)
    resp = await client.post(
        ADMIN_PROMOS_URL,
        json=body,
        headers=auth_headers(admin["session_token"]),
    )
    after = datetime.now(timezone.utc)

    assert resp.status_code == 201
    data = resp.json()
    assert data["valid_from"] is not None
    valid_from = datetime.fromisoformat(data["valid_from"])
    assert before <= valid_from <= after
