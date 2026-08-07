# =============================================================================
# Tests: Withdrawals -- Master Flow (Phase 6.6)
# =============================================================================
#
# telegram_id range: 77000-77999
#   77001-77099: masters
#   77100-77199: regular users
#   77900-77999: admin users
#
# Scenarios tested:
#   - PATCH /me/payout: update payout details (success, not master)
#   - POST /me/withdraw: success, insufficient balance, no payout,
#     below minimum, fee >= amount
#   - GET /me/withdrawals: empty, with items, pagination
#   - Double-entry verification: available -> frozen on create
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import datetime, timezone

import pytest
from httpx import AsyncClient
from sqlalchemy import update, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.modules.masters.models import MasterProfile
from app.modules.payments.service import record_master_ledger
from app.modules.withdrawals.models import Withdrawal, WithdrawalStatus
from app.modules.users.models import User, UserRole
from tests.helpers import (
    auth_headers,
    fresh_execute,
    full_cleanup_range,
    login_user,
    switch_self_to_master,
)

# ---------------------------------------------------------------------------
# URLs
# ---------------------------------------------------------------------------
PAYOUT_URL = "/api/v1/masters/me/payout"
WITHDRAW_URL = "/api/v1/masters/me/withdraw"
WITHDRAWALS_URL = "/api/v1/masters/me/withdrawals"
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
    """Full ORM cleanup for telegram_id 77000-77999."""
    await full_cleanup_range(session, 77000, 77999, delete_users=True)
    await session.commit()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int = 77001,
) -> dict:
    """Create user, apply as master, verify via admin.

    Returns auth data dict with role=master (re-logged after verify).
    """
    # Create user and apply.
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
                "experience_years": 5,
            },
        },
        headers=auth_headers(token),
    )

    user_id = auth["user"]["id"]

    # Create admin and verify.
    admin_auth = await login_user(client, telegram_id=77900)
    await db_session.execute(
    update(User)
    .where(User.telegram_id == 77900)
    .values(role=UserRole.ADMIN.value)
)
    await db_session.commit()

    # Re-login admin to pick up new role in session.
    admin_auth = await login_user(client, telegram_id=77900)

    verify_resp = await client.post(
        VERIFY_URL.format(user_id=user_id),
        json={},
        headers=auth_headers(admin_auth["session_token"]),
    )
    assert verify_resp.status_code == 200

    # Re-login master to pick up updated role in session.
    await switch_self_to_master(client, auth["session_token"])
    auth = await login_user(client, telegram_id=telegram_id)

    return {
        "session_token": auth["session_token"],
        "user_id": user_id,
        "telegram_id": telegram_id,
    }


async def _give_available_balance(
    db_session: AsyncSession,
    user_id: str,
    amount_cents: int,
) -> None:
    """Credit available balance to a master via master_ledger."""
    from uuid import UUID

    await record_master_ledger(
        user_id=UUID(user_id),
        amount_cents=amount_cents,
        reason="test_credit",
        is_frozen=False,
        session=db_session,
    )
    await db_session.commit()


async def _set_payout_details(
    client: AsyncClient,
    token: str,
) -> dict:
    """Set default payout details for a master."""
    resp = await client.patch(
        PAYOUT_URL,
        json={
            "method": "bank_transfer",
            "details": {"iban": "DE89370400440532013000"},
        },
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    return resp.json()


# ===================================================================
# PATCH /me/payout
# ===================================================================


@pytest.mark.asyncio
async def test_payout_update_success(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Master can set and update payout details."""
    master = await _make_verified_master(client, db_session)

    resp = await client.patch(
        PAYOUT_URL,
        json={
            "method": "paypal",
            "details": {"email": "master@paypal.com"},
        },
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 200
    assert resp.json()["method"] == "paypal"


@pytest.mark.asyncio
async def test_payout_update_not_master(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Regular user cannot update payout details: 403."""
    data = await login_user(client, telegram_id=77100)
    token = data["session_token"]

    resp = await client.patch(
        PAYOUT_URL,
        json={"method": "bank_transfer", "details": {}},
        headers=auth_headers(token),
    )
    assert resp.status_code == 403


# ===================================================================
# POST /me/withdraw
# ===================================================================


@pytest.mark.asyncio
async def test_withdraw_success(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Master withdraws: 201, balance frozen, withdrawal created."""
    master = await _make_verified_master(client, db_session)
    await _set_payout_details(client, master["session_token"])
    await _give_available_balance(
        db_session, master["user_id"], 10000,
    )

    headers = auth_headers(master["session_token"])
    resp = await client.post(
        WITHDRAW_URL,
        json={"amount_cents": 5000},
        headers=headers,
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["amount_cents"] == 5000
    assert data["fee_cents"] == settings.withdrawal_fee_cents
    assert data["status"] == "pending"
    assert data["payout_details"]["method"] == "bank_transfer"

    # Verify balance changed: available should decrease by 5000.
    me = await client.get(
        "/api/v1/masters/me",
        headers=headers,
    )
    profile = me.json()
    assert profile["available_cents"] == 5000  # 10000 - 5000
    assert profile["frozen_cents"] == 5000

    # Verify double-entry: SUM(master_ledger) == 0 for withdrawal entries.
    # test_credit: +10000 (available)
    # withdrawal_hold: -5000 (available) + 5000 (frozen)
    # Net SUM must equal the initial credit (10000), nothing lost.
    db_session.expire_all()
    result = await fresh_execute(
        text(
            "SELECT "
            "  COALESCE(SUM(CASE WHEN is_frozen THEN amount_cents ELSE 0 END), 0) AS frozen, "
            "  COALESCE(SUM(CASE WHEN NOT is_frozen THEN amount_cents ELSE 0 END), 0) AS available, "
            "  COALESCE(SUM(amount_cents), 0) AS total "
            "FROM master_ledger "
            "WHERE user_id = :uid AND status = 'done'"
        ),
        {"uid": master["user_id"]},
    )
    row = result.one()
    assert row.frozen == 5000, f"frozen mismatch: {row.frozen}"
    assert row.available == 5000, f"available mismatch: {row.available}"
    assert row.total == 10000, f"total mismatch (should equal initial credit): {row.total}"


@pytest.mark.asyncio
async def test_withdraw_insufficient_balance(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Insufficient available balance: 400."""
    master = await _make_verified_master(client, db_session)
    await _set_payout_details(client, master["session_token"])
    await _give_available_balance(
        db_session, master["user_id"], 3000,
    )

    resp = await client.post(
        WITHDRAW_URL,
        json={"amount_cents": 5000},
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 400
    assert "Insufficient" in resp.json()["message"]


@pytest.mark.asyncio
async def test_withdraw_no_payout_details(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """No payout details configured: 400."""
    master = await _make_verified_master(client, db_session)
    await _give_available_balance(
        db_session, master["user_id"], 10000,
    )

    resp = await client.post(
        WITHDRAW_URL,
        json={"amount_cents": 5000},
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 400
    assert "Payout details" in resp.json()["message"]


@pytest.mark.asyncio
async def test_withdraw_below_minimum(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Amount below min_withdrawal_cents: 400."""
    master = await _make_verified_master(client, db_session)
    await _set_payout_details(client, master["session_token"])
    await _give_available_balance(
        db_session, master["user_id"], 10000,
    )

    resp = await client.post(
        WITHDRAW_URL,
        json={"amount_cents": 100},  # Below 5000 minimum
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 400
    assert "Minimum" in resp.json()["message"]


@pytest.mark.asyncio
async def test_withdraw_fee_exceeds_amount(
    client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Fee >= amount: 400 (master would receive nothing)."""
    # Override settings so fee >= min_withdrawal, allowing us to hit the guard.
    monkeypatch.setattr(settings, "min_withdrawal_cents", 100)
    monkeypatch.setattr(settings, "withdrawal_fee_cents", 500)

    master = await _make_verified_master(client, db_session)
    await _set_payout_details(client, master["session_token"])
    await _give_available_balance(
        db_session, master["user_id"], 10000,
    )

    # amount=500, fee=500 → fee >= amount → 400.
    resp = await client.post(
        WITHDRAW_URL,
        json={"amount_cents": 500},
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 400
    assert "fee" in resp.json()["message"].lower()


@pytest.mark.asyncio
async def test_withdraw_multiple_pending(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Master can create multiple pending withdrawals."""
    master = await _make_verified_master(client, db_session)
    await _set_payout_details(client, master["session_token"])
    await _give_available_balance(
        db_session, master["user_id"], 20000,
    )

    headers = auth_headers(master["session_token"])

    # First withdrawal.
    resp1 = await client.post(
        WITHDRAW_URL,
        json={"amount_cents": 5000},
        headers=headers,
    )
    assert resp1.status_code == 201

    # Second withdrawal (available: 20000 - 5000 = 15000).
    resp2 = await client.post(
        WITHDRAW_URL,
        json={"amount_cents": 5000},
        headers=headers,
    )
    assert resp2.status_code == 201

    # Check balances.
    me = await client.get(
        "/api/v1/masters/me",
        headers=headers,
    )
    profile = me.json()
    assert profile["available_cents"] == 10000  # 20000 - 5000 - 5000
    assert profile["frozen_cents"] == 10000


@pytest.mark.asyncio
async def test_withdraw_payout_snapshot(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Withdrawal stores a snapshot of payout details at creation time."""
    master = await _make_verified_master(client, db_session)
    await _set_payout_details(client, master["session_token"])
    await _give_available_balance(
        db_session, master["user_id"], 10000,
    )

    headers = auth_headers(master["session_token"])

    # Create withdrawal with bank_transfer details.
    resp = await client.post(
        WITHDRAW_URL,
        json={"amount_cents": 5000},
        headers=headers,
    )
    withdrawal_id = resp.json()["id"]
    original_details = resp.json()["payout_details"]

    # Now change payout details to PayPal.
    await client.patch(
        PAYOUT_URL,
        json={"method": "paypal", "details": {"email": "new@pp.com"}},
        headers=headers,
    )

    # Withdrawal should still have original bank_transfer snapshot.
    list_resp = await client.get(
        WITHDRAWALS_URL,
        headers=headers,
    )
    items = list_resp.json()["items"]
    found = [w for w in items if w["id"] == withdrawal_id]
    assert len(found) == 1
    assert found[0]["payout_details"]["method"] == "bank_transfer"


# ===================================================================
# GET /me/withdrawals
# ===================================================================


@pytest.mark.asyncio
async def test_list_withdrawals_empty(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """No withdrawals: returns empty list with total=0."""
    master = await _make_verified_master(client, db_session)

    resp = await client.get(
        WITHDRAWALS_URL,
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["items"] == []
    assert data["total"] == 0


@pytest.mark.asyncio
async def test_list_withdrawals_with_items(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """List returns created withdrawals, newest first."""
    master = await _make_verified_master(client, db_session)
    await _set_payout_details(client, master["session_token"])
    await _give_available_balance(
        db_session, master["user_id"], 20000,
    )
    headers = auth_headers(master["session_token"])

    # Create two withdrawals.
    await client.post(
        WITHDRAW_URL,
        json={"amount_cents": 5000},
        headers=headers,
    )
    await client.post(
        WITHDRAW_URL,
        json={"amount_cents": 6000},
        headers=headers,
    )

    resp = await client.get(
        WITHDRAWALS_URL,
        headers=headers,
    )
    data = resp.json()
    assert data["total"] == 2
    assert len(data["items"]) == 2
    # Newest first.
    assert data["items"][0]["amount_cents"] == 6000
    assert data["items"][1]["amount_cents"] == 5000


@pytest.mark.asyncio
async def test_list_withdrawals_pagination(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Pagination: limit and offset work correctly."""
    master = await _make_verified_master(client, db_session)
    await _set_payout_details(client, master["session_token"])
    await _give_available_balance(
        db_session, master["user_id"], 30000,
    )
    headers = auth_headers(master["session_token"])

    # Create 3 withdrawals.
    for _ in range(3):
        await client.post(
            WITHDRAW_URL,
            json={"amount_cents": 5000},
            headers=headers,
        )

    resp = await client.get(
        f"{WITHDRAWALS_URL}?limit=2&offset=0",
        headers=headers,
    )
    data = resp.json()
    assert data["total"] == 3
    assert len(data["items"]) == 2
    assert data["limit"] == 2
    assert data["offset"] == 0

    # Page 2.
    resp2 = await client.get(
        f"{WITHDRAWALS_URL}?limit=2&offset=2",
        headers=headers,
    )
    data2 = resp2.json()
    assert len(data2["items"]) == 1

# =============================================================================
# NEW TESTS (Batch 1, Phase F7) -- add to test_withdrawals.py
# =============================================================================
#
# Verifies that GET /api/v1/masters/me now returns the payout field
# introduced by F7 (MasterProfileResponse.payout).
#
# Add these two test functions to the existing test_withdrawals.py file,
# after the existing PATCH /me/payout tests.
# =============================================================================


@pytest.mark.asyncio
async def test_profile_payout_none_when_not_configured(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """GET /masters/me returns payout=null when payout not yet configured."""
    master = await _make_verified_master(client, db_session)

    resp = await client.get(
        "/api/v1/masters/me",
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 200
    profile = resp.json()
    # F7: payout field must be present and null before configuration.
    assert "payout" in profile
    assert profile["payout"] is None


@pytest.mark.asyncio
async def test_profile_payout_returned_after_update(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """GET /masters/me returns payout details after PATCH /me/payout."""
    master = await _make_verified_master(client, db_session)
    headers = auth_headers(master["session_token"])

    # Configure payout details.
    await client.patch(
        PAYOUT_URL,
        json={
            "method": "paypal",
            "details": {"email": "master@example.com"},
        },
        headers=headers,
    )

    # Profile must now reflect the configured payout.
    resp = await client.get(
        "/api/v1/masters/me",
        headers=headers,
    )
    assert resp.status_code == 200
    profile = resp.json()
    assert profile["payout"] is not None
    assert profile["payout"]["method"] == "paypal"
    assert profile["payout"]["details"]["email"] == "master@example.com"


# ===================================================================
# M3 (batch M): DELETE /me/payout -- clear the configured payout
# ===================================================================


@pytest.mark.asyncio
async def test_payout_delete_clears_method(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """DELETE /me/payout clears the configured payout (profile.payout -> None)."""
    master = await _make_verified_master(client, db_session)
    headers = auth_headers(master["session_token"])

    # Configure, then delete.
    await client.patch(
        PAYOUT_URL,
        json={"method": "paypal", "details": {"email": "master@example.com"}},
        headers=headers,
    )
    resp = await client.delete(PAYOUT_URL, headers=headers)
    assert resp.status_code == 204

    # Profile now reports no payout.
    profile = (await client.get("/api/v1/masters/me", headers=headers)).json()
    assert profile["payout"] is None


@pytest.mark.asyncio
async def test_payout_delete_idempotent_when_unset(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """DELETE /me/payout is a no-op (204) when nothing is configured."""
    master = await _make_verified_master(client, db_session)
    resp = await client.delete(
        PAYOUT_URL, headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 204