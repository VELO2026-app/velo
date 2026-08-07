# =============================================================================
# Tests: Payment Topup (Phase 6.3)
# =============================================================================
#
# Unit tests for topup endpoint and Stripe integration.
# Stripe SDK is fully mocked -- no real API calls.
#
# telegram_id range: 73xxx (payments topup tests)
#
# Coverage:
#   - POST /api/v1/payments/topup (success, validation, auth)
#   - Webhook /webhooks/stripe (completed, expired, idempotency, sig)
#   - create_topup_session (service-level)
#   - handle_checkout_completed (ledger + balance update)
#   - handle_checkout_expired_or_failed
#
# FIXES applied:
#   - auth returns "session_token" not "token"
#   - expire_all() is sync (no await)
#   - patch settings.stripe_secret_key to bypass is_stripe_stub guard
# =============================================================================

import json
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import AuditLog
from app.core.config import settings
from app.modules.payments.models import (
    Payment,
    PaymentDirection,
    PaymentStatus,
    UserLedger,
)
from app.modules.payments.stripe import (
    create_topup_session,
    handle_checkout_completed,
    handle_checkout_expired_or_failed,
)
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, fresh_execute, login_user


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _create_user(
    session: AsyncSession, telegram_id: int,
) -> User:
    """Create a bare User row for payment tests."""
    user = User(
        telegram_id=telegram_id,
        first_name="PaymentTest",
        role=UserRole.USER,
    )
    session.add(user)
    await session.flush()
    return user


def _mock_stripe_checkout_session(
    session_id: str = "cs_test_123",
    url: str = "https://checkout.stripe.com/pay/cs_test_123",
) -> MagicMock:
    """Create a mock Stripe Checkout Session object."""
    mock_session = MagicMock()
    mock_session.id = session_id
    mock_session.url = url
    return mock_session


def _build_stripe_event(
    event_type: str,
    session_id: str = "cs_test_123",
    payment_intent: str = "pi_test_456",
    amount_total: int = 1000,
    currency: str = "eur",
) -> dict:
    """Build a fake Stripe webhook event dict."""
    return {
        "id": f"evt_test_{uuid4().hex[:8]}",
        "type": event_type,
        "data": {
            "object": {
                "id": session_id,
                "payment_intent": payment_intent,
                "amount_total": amount_total,
                "currency": currency,
                "customer_email": "test@example.com",
            },
        },
    }


def _bypass_stripe_stub():
    """Patch settings so is_stripe_stub returns False."""
    return patch.object(
        settings, "stripe_secret_key", "sk_test_not_stub",
    )


# ---------------------------------------------------------------------------
# Service-level tests (direct function calls)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_topup_session_success(
    db_session: AsyncSession,
) -> None:
    """create_topup_session creates Payment + calls Stripe."""
    user = await _create_user(db_session, telegram_id=73001)

    mock_checkout = _mock_stripe_checkout_session()

    with (
        patch(
            "app.modules.payments.stripe.stripe.checkout.Session.create",
            return_value=mock_checkout,
        ),
        _bypass_stripe_stub(),
    ):
        payment, url = await create_topup_session(
            user_id=user.id,
            amount_cents=1000,
            currency="eur",
            session=db_session,
        )

    assert payment.user_id == user.id
    assert payment.amount_cents == 1000
    assert payment.currency == "eur"
    assert payment.direction == PaymentDirection.IN.value
    assert payment.status == PaymentStatus.PENDING.value
    assert payment.stripe_session_id == "cs_test_123"
    assert url == "https://checkout.stripe.com/pay/cs_test_123"

    # Audit log created.
    stmt = select(AuditLog).where(
        AuditLog.event == "payment_topup_created",
        AuditLog.target_id == payment.id,
    )
    result = await db_session.execute(stmt)
    audit = result.scalar_one()
    assert audit.actor_id == user.id
    assert audit.actor_type == "user"


@pytest.mark.asyncio
async def test_handle_checkout_completed_success(
    db_session: AsyncSession,
) -> None:
    """Successful webhook confirms payment and updates balance."""
    user = await _create_user(db_session, telegram_id=73002)
    assert user.balance_cents == 0

    # Create pending payment.
    payment = Payment(
        user_id=user.id,
        direction=PaymentDirection.IN.value,
        amount_cents=2500,
        currency="eur",
        status=PaymentStatus.PENDING.value,
        stripe_session_id="cs_test_completed_1",
    )
    db_session.add(payment)
    await db_session.flush()

    # Handle webhook event.
    event_data = {
        "id": "cs_test_completed_1",
        "payment_intent": "pi_test_789",
        "amount_total": 2500,
        "currency": "eur",
        "customer_email": "test@example.com",
    }

    result = await handle_checkout_completed(event_data, db_session)

    assert result is not None
    assert result.status == PaymentStatus.CONFIRMED.value
    assert result.confirmed_at is not None
    assert result.stripe_payment_intent_id == "pi_test_789"

    # Balance updated via user_ledger.
    await db_session.refresh(user)
    assert user.balance_cents == 2500

    # Ledger entry created.
    stmt = select(UserLedger).where(
        UserLedger.user_id == user.id,
        UserLedger.reason == f"payment:{payment.id}",
    )
    ledger_result = await db_session.execute(stmt)
    ledger = ledger_result.scalar_one()
    assert ledger.amount_cents == 2500

    # Audit log created.
    stmt = select(AuditLog).where(
        AuditLog.event == "payment_topup_confirmed",
        AuditLog.target_id == payment.id,
    )
    audit_result = await db_session.execute(stmt)
    audit = audit_result.scalar_one()
    assert audit.actor_type == "system"
    assert audit.actor_id is None


@pytest.mark.asyncio
async def test_handle_checkout_completed_idempotent(
    db_session: AsyncSession,
) -> None:
    """Duplicate webhook for confirmed payment is a no-op."""
    user = await _create_user(db_session, telegram_id=73003)

    payment = Payment(
        user_id=user.id,
        direction=PaymentDirection.IN.value,
        amount_cents=500,
        currency="eur",
        status=PaymentStatus.CONFIRMED.value,
        stripe_session_id="cs_test_idempotent_1",
    )
    db_session.add(payment)
    await db_session.flush()

    # Set up initial balance via a previous ledger entry.
    from app.modules.payments.service import record_user_ledger
    await record_user_ledger(
        user_id=user.id,
        amount_cents=500,
        reason=f"payment:{payment.id}",
        session=db_session,
    )
    await db_session.refresh(user)
    balance_before = user.balance_cents

    # Duplicate webhook.
    event_data = {"id": "cs_test_idempotent_1"}
    result = await handle_checkout_completed(event_data, db_session)

    assert result is not None
    assert result.status == PaymentStatus.CONFIRMED.value

    # Balance unchanged -- no duplicate ledger entry.
    await db_session.refresh(user)
    assert user.balance_cents == balance_before


@pytest.mark.asyncio
async def test_handle_checkout_completed_unknown_session(
    db_session: AsyncSession,
) -> None:
    """Webhook for unknown session_id returns None."""
    event_data = {"id": "cs_test_unknown_999"}
    result = await handle_checkout_completed(event_data, db_session)
    assert result is None


@pytest.mark.asyncio
async def test_handle_checkout_expired(
    db_session: AsyncSession,
) -> None:
    """Expired checkout session marks payment as failed."""
    user = await _create_user(db_session, telegram_id=73004)

    payment = Payment(
        user_id=user.id,
        direction=PaymentDirection.IN.value,
        amount_cents=1500,
        currency="eur",
        status=PaymentStatus.PENDING.value,
        stripe_session_id="cs_test_expired_1",
    )
    db_session.add(payment)
    await db_session.flush()

    event_data = {"id": "cs_test_expired_1"}
    result = await handle_checkout_expired_or_failed(
        event_data, db_session,
    )

    assert result is not None
    assert result.status == PaymentStatus.FAILED.value

    # Balance unchanged (still 0).
    await db_session.refresh(user)
    assert user.balance_cents == 0

    # Audit log for failure.
    stmt = select(AuditLog).where(
        AuditLog.event == "payment_topup_failed",
        AuditLog.target_id == payment.id,
    )
    audit_result = await db_session.execute(stmt)
    audit = audit_result.scalar_one()
    assert audit.actor_type == "system"


@pytest.mark.asyncio
async def test_handle_expired_idempotent(
    db_session: AsyncSession,
) -> None:
    """Duplicate expired webhook for already-failed payment is a no-op."""
    user = await _create_user(db_session, telegram_id=73005)

    payment = Payment(
        user_id=user.id,
        direction=PaymentDirection.IN.value,
        amount_cents=300,
        currency="eur",
        status=PaymentStatus.FAILED.value,
        stripe_session_id="cs_test_expired_idem",
    )
    db_session.add(payment)
    await db_session.flush()

    event_data = {"id": "cs_test_expired_idem"}
    result = await handle_checkout_expired_or_failed(
        event_data, db_session,
    )

    assert result is not None
    assert result.status == PaymentStatus.FAILED.value


# ---------------------------------------------------------------------------
# Router-level tests (HTTP via test client)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_topup_endpoint_success(client: AsyncClient) -> None:
    """POST /api/v1/payments/topup returns 201 + checkout URL."""
    user_data = await login_user(client, telegram_id=73010)
    token = user_data["session_token"]

    mock_session_id = f"cs_test_router_{uuid4().hex[:8]}"
    mock_checkout = _mock_stripe_checkout_session(
        session_id=mock_session_id,
        url=f"https://checkout.stripe.com/pay/{mock_session_id}",
    )

    with (
        patch(
            "app.modules.payments.stripe.stripe.checkout.Session.create",
            return_value=mock_checkout,
        ),
        _bypass_stripe_stub(),
    ):
        response = await client.post(
            "/api/v1/payments/topup",
            json={"amount_cents": 1000},
            headers=auth_headers(token),
        )

    assert response.status_code == 201
    data = response.json()
    assert data["amount_cents"] == 1000
    assert data["currency"] == "eur"
    assert data["checkout_url"] == (
        f"https://checkout.stripe.com/pay/{mock_session_id}"
    )
    assert "payment_id" in data


@pytest.mark.asyncio
async def test_topup_below_minimum(client: AsyncClient) -> None:
    """Amount below MIN_TOPUP_CENTS is rejected (422)."""
    user_data = await login_user(client, telegram_id=73011)
    token = user_data["session_token"]

    response = await client.post(
        "/api/v1/payments/topup",
        json={"amount_cents": 50},  # Below 100 minimum.
        headers=auth_headers(token),
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_topup_above_maximum(client: AsyncClient) -> None:
    """Amount above MAX_TOPUP_CENTS is rejected (422)."""
    user_data = await login_user(client, telegram_id=73012)
    token = user_data["session_token"]

    response = await client.post(
        "/api/v1/payments/topup",
        json={"amount_cents": 100000},  # Above 50000 max.
        headers=auth_headers(token),
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_topup_unauthenticated(client: AsyncClient) -> None:
    """Topup without auth returns 401."""
    response = await client.post(
        "/api/v1/payments/topup",
        json={"amount_cents": 1000},
    )
    assert response.status_code == 401


# ---------------------------------------------------------------------------
# Webhook router tests (HTTP via test client)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_webhook_missing_signature(client: AsyncClient) -> None:
    """Webhook without Stripe-Signature header returns 400."""
    response = await client.post(
        "/webhooks/stripe",
        content=b"{}",
    )
    assert response.status_code == 400
    assert "Missing" in response.json()["error"]


@pytest.mark.asyncio
async def test_webhook_invalid_signature(client: AsyncClient) -> None:
    """Webhook with bad signature returns 400."""
    with patch(
        "app.modules.payments.stripe.stripe.Webhook.construct_event",
        side_effect=Exception("Invalid signature"),
    ):
        response = await client.post(
            "/webhooks/stripe",
            content=b'{"type": "checkout.session.completed"}',
            headers={"stripe-signature": "t=123,v1=bad"},
        )

    assert response.status_code == 400


@pytest.mark.asyncio
async def test_webhook_unhandled_event(client: AsyncClient) -> None:
    """Webhook with unhandled event type returns 200 (ignored)."""
    fake_event = {
        "id": "evt_test_unhandled",
        "type": "payment_intent.created",
        "data": {"object": {}},
    }

    with patch(
        "app.modules.payments.webhook_router.verify_webhook_signature",
        return_value=fake_event,
    ):
        response = await client.post(
            "/webhooks/stripe",
            content=json.dumps(fake_event).encode(),
            headers={"stripe-signature": "t=123,v1=valid"},
        )

    assert response.status_code == 200
    assert response.json()["status"] == "ignored"


@pytest.mark.asyncio
async def test_webhook_checkout_completed_e2e(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Full webhook flow: signature verified -> payment confirmed."""
    # Create user via login (upsert -- safe on repeated runs).
    user_data = await login_user(client, telegram_id=73030)
    user_id = user_data["user"]["id"]

    # Unique session id to avoid constraint violation on re-runs.
    session_id = f"cs_test_e2e_webhook_{uuid4().hex[:8]}"

    # Record balance before topup (may be non-zero from previous runs).
    stmt = select(User).where(User.id == user_id)
    result = await db_session.execute(stmt)
    balance_before = result.scalar_one().balance_cents

    # Create pending payment visible to webhook's own session.
    payment = Payment(
        user_id=user_id,
        direction=PaymentDirection.IN.value,
        amount_cents=5000,
        currency="eur",
        status=PaymentStatus.PENDING.value,
        stripe_session_id=session_id,
    )
    db_session.add(payment)
    await db_session.commit()
    payment_id = payment.id  # Save before expire.

    fake_event = _build_stripe_event(
        event_type="checkout.session.completed",
        session_id=session_id,
        amount_total=5000,
    )

    with patch(
        "app.modules.payments.webhook_router.verify_webhook_signature",
        return_value=fake_event,
    ):
        response = await client.post(
            "/webhooks/stripe",
            content=json.dumps(fake_event).encode(),
            headers={"stripe-signature": "t=123,v1=valid"},
        )

    assert response.status_code == 200
    assert response.json()["status"] == "processed"

    # Verify payment confirmed in DB.
    db_session.expire_all()
    stmt = select(Payment).where(Payment.id == payment_id)
    result = await fresh_execute(stmt)
    confirmed_payment = result.scalar_one()
    assert confirmed_payment.status == PaymentStatus.CONFIRMED.value

    # Verify balance increased by topup amount.
    stmt = select(User).where(User.id == user_id)
    result = await db_session.execute(stmt)
    updated_user = result.scalar_one()
    assert updated_user.balance_cents == balance_before + 5000


@pytest.mark.asyncio
async def test_webhook_checkout_expired_e2e(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Expired checkout session marks payment as failed via webhook."""
    # Create user via login (upsert -- safe on repeated runs).
    user_data = await login_user(client, telegram_id=73031)
    user_id = user_data["user"]["id"]

    # Unique session id to avoid constraint violation on re-runs.
    session_id = f"cs_test_e2e_expired_{uuid4().hex[:8]}"

    payment = Payment(
        user_id=user_id,
        direction=PaymentDirection.IN.value,
        amount_cents=3000,
        currency="eur",
        status=PaymentStatus.PENDING.value,
        stripe_session_id=session_id,
    )
    db_session.add(payment)
    await db_session.commit()
    payment_id = payment.id  # Save before expire.

    fake_event = _build_stripe_event(
        event_type="checkout.session.expired",
        session_id=session_id,
    )

    with patch(
        "app.modules.payments.webhook_router.verify_webhook_signature",
        return_value=fake_event,
    ):
        response = await client.post(
            "/webhooks/stripe",
            content=json.dumps(fake_event).encode(),
            headers={"stripe-signature": "t=123,v1=valid"},
        )

    assert response.status_code == 200

    db_session.expire_all()
    stmt = select(Payment).where(Payment.id == payment_id)
    result = await fresh_execute(stmt)
    failed_payment = result.scalar_one()
    assert failed_payment.status == PaymentStatus.FAILED.value
