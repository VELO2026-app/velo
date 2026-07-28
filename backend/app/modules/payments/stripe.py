# =============================================================================
# VELO Backend -- Stripe Integration (Phase 6.3, CRITICAL-3, updated F5)
# =============================================================================
#
# Thin wrapper around Stripe SDK for:
#   1. Creating Checkout Sessions (topup flow)
#   2. Verifying webhook signatures
#   3. Handling completed/failed checkout events
#
# IDEMPOTENCY:
#   Webhook handlers check Payment.status before acting.
#   Duplicate webhooks for already-confirmed payments are no-ops.
#
# CRITICAL-3: handle_checkout_completed now verifies that the amount
#   Stripe actually charged (amount_total) matches what we expect
#   (payment.amount_cents). Mismatch -> payment marked as failed,
#   no balance credited. Defense-in-depth against key leaks or bugs.
#
# F5 STUB MODE:
#   When is_stripe_stub is True (STRIPE_SECRET_KEY="TEST"), topup
#   bypasses Stripe entirely: creates a confirmed Payment, credits
#   user balance via ledger, returns stripe_success_url as checkout_url.
#   This allows full end-to-end testing without real Stripe keys.
#
# SESSION RULES:
#   No session.commit() here (P-01). Caller handles transaction.
#
# TESTING:
#   Unit tests mock stripe module entirely (no real API calls).
#   Integration tests use Stripe Test Mode (separate test file).
# =============================================================================

import asyncio
from datetime import UTC, datetime
from uuid import UUID

import stripe
import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import record_audit
from app.core.config import settings
from app.core.exceptions import BadRequestError
from app.modules.payments.models import (
    CompanyLedgerType,
    Payment,
    PaymentDirection,
    PaymentStatus,
)
from app.modules.payments.service import record_company_ledger, record_user_ledger

logger = structlog.get_logger()


def _configure_stripe() -> None:
    """Set Stripe API key from settings.

    Called lazily -- not at import time, so tests can mock settings.
    """
    stripe.api_key = settings.stripe_secret_key


# ---------------------------------------------------------------------------
# Create Checkout Session
# ---------------------------------------------------------------------------


async def create_topup_session(
    *,
    user_id: UUID,
    amount_cents: int,
    currency: str,
    session: AsyncSession,
) -> tuple[Payment, str]:
    """Create a Stripe Checkout Session for balance topup.

    In stub mode (is_stripe_stub=True): skips Stripe, instantly
    confirms payment and credits user balance. Returns success URL.

    In real mode: creates pending Payment, calls Stripe API,
    returns Stripe checkout URL for redirect.

    Args:
        user_id: The user topping up.
        amount_cents: Amount in cents.
        currency: Currency code (e.g. "eur").
        session: Active DB session (caller manages transaction).

    Returns:
        Tuple of (Payment, checkout_url).

    Raises:
        BadRequestError: If Stripe API call fails.
    """
    # -- Stub mode: instant topup without Stripe --
    if settings.is_stripe_stub:
        return await _create_stub_topup(
            user_id=user_id,
            amount_cents=amount_cents,
            currency=currency,
            session=session,
        )

    # -- Real Stripe mode --
    _configure_stripe()

    # Step 1: Create pending Payment record.
    payment = Payment(
        user_id=user_id,
        direction=PaymentDirection.IN.value,
        amount_cents=amount_cents,
        currency=currency,
        status=PaymentStatus.PENDING.value,
    )
    session.add(payment)
    await session.flush()

    # Step 2: Create Stripe Checkout Session.
    # H-01 fix: stripe SDK is synchronous -- offload to thread pool
    # to avoid blocking the asyncio event loop (200ms-2s per call).
    try:
        checkout = await asyncio.to_thread(
            stripe.checkout.Session.create,
            mode="payment",
            payment_method_types=["card"],
            line_items=[
                {
                    "price_data": {
                        "currency": currency,
                        "unit_amount": amount_cents,
                        "product_data": {
                            "name": "VELO Balance Top-up",
                            "description": (
                                f"Top up {amount_cents / 100:.2f} "
                                f"{currency.upper()}"
                            ),
                        },
                    },
                    "quantity": 1,
                },
            ],
            metadata={
                "payment_id": str(payment.id),
                "user_id": str(user_id),
            },
            success_url=settings.stripe_success_url,
            cancel_url=settings.stripe_cancel_url,
        )
    except stripe.StripeError as exc:
        logger.error(
            "stripe_checkout_creation_failed",
            user_id=str(user_id),
            amount_cents=amount_cents,
            error=str(exc),
        )
        raise BadRequestError(
            "Failed to create payment session"
        ) from None

    # Step 3: Store Stripe session ID.
    payment.stripe_session_id = checkout.id
    await session.flush()

    # Step 4: Audit.
    await record_audit(
        event="payment_topup_created",
        actor_id=user_id,
        actor_type="user",
        target_type="payment",
        target_id=payment.id,
        data={
            "amount_cents": amount_cents,
            "currency": currency,
            "stripe_session_id": checkout.id,
        },
        session=session,
    )

    logger.info(
        "topup_session_created",
        payment_id=str(payment.id),
        user_id=str(user_id),
        amount_cents=amount_cents,
        stripe_session_id=checkout.id,
    )

    return payment, checkout.url


async def _create_stub_topup(
    *,
    user_id: UUID,
    amount_cents: int,
    currency: str,
    session: AsyncSession,
) -> tuple[Payment, str]:
    """Stub topup: instant confirmation without Stripe.

    Used when STRIPE_SECRET_KEY="TEST". Creates a confirmed Payment,
    credits user balance via ledger, returns success URL.

    This enables full end-to-end testing of the topup flow
    (frontend -> backend -> balance update) without Stripe keys.
    """
    now = datetime.now(UTC)

    # Create Payment record (already confirmed).
    payment = Payment(
        user_id=user_id,
        direction=PaymentDirection.IN.value,
        amount_cents=amount_cents,
        currency=currency,
        status=PaymentStatus.CONFIRMED.value,
        confirmed_at=now,
        stripe_session_id="STUB",
    )
    session.add(payment)
    await session.flush()

    # Credit user balance via double-entry ledger.
    await record_user_ledger(
        user_id=user_id,
        amount_cents=amount_cents,
        reason=f"payment:{payment.id}",
        session=session,
        notes="Stub topup (Stripe not configured)",
    )

    # Offsetting company entry: platform received money from user (liability).
    # Double-entry rule: user(+N) + company(-N) = 0.
    await record_company_ledger(
        amount_cents=-amount_cents,
        ledger_type=CompanyLedgerType.TOPUP.value,
        reason=f"topup:{payment.id}",
        reference_id=payment.id,
        session=session,
    )

    # Audit.
    await record_audit(
        event="payment_topup_stub_confirmed",
        actor_id=user_id,
        actor_type="user",
        target_type="payment",
        target_id=payment.id,
        data={
            "amount_cents": amount_cents,
            "currency": currency,
            "stub": True,
        },
        session=session,
    )

    logger.info(
        "topup_stub_confirmed",
        payment_id=str(payment.id),
        user_id=str(user_id),
        amount_cents=amount_cents,
    )

    return payment, settings.stripe_success_url


# ---------------------------------------------------------------------------
# Webhook Verification
# ---------------------------------------------------------------------------


def verify_webhook_signature(
    payload: bytes,
    sig_header: str,
) -> dict:
    """Verify Stripe webhook signature and return parsed event.

    Args:
        payload: Raw request body bytes.
        sig_header: Value of Stripe-Signature header.

    Returns:
        Parsed Stripe event dict.

    Raises:
        BadRequestError: If signature verification fails.
    """
    _configure_stripe()

    try:
        event = stripe.Webhook.construct_event(
            payload,
            sig_header,
            settings.stripe_webhook_secret,
        )
    except ValueError:
        logger.warning("stripe_webhook_invalid_payload")
        raise BadRequestError("Invalid payload") from None
    except stripe.SignatureVerificationError:
        logger.warning(
            "stripe_webhook_signature_failed",
            sig_header=sig_header[:20] + "...",
        )
        raise BadRequestError("Invalid signature") from None

    return event


# ---------------------------------------------------------------------------
# Event Handlers
# ---------------------------------------------------------------------------


async def handle_checkout_completed(
    event_data: dict,
    session: AsyncSession,
) -> Payment | None:
    """Handle checkout.session.completed webhook event.

    1. Look up Payment by stripe_session_id.
    2. Skip if already confirmed (idempotency).
    3. CRITICAL-3: Verify amount_total matches payment.amount_cents.
    4. Update Payment status -> confirmed.
    5. Record user_ledger entry (balance topup).
    6. Record audit event.

    Args:
        event_data: The Stripe event data object (checkout session).
        session: Active DB session.

    Returns:
        Updated Payment, or None if skipped (idempotent).
    """
    stripe_session_id = event_data.get("id")
    if not stripe_session_id:
        logger.warning("stripe_webhook_missing_session_id")
        return None

    # Look up payment by stripe_session_id.
    stmt = (
        select(Payment)
        .where(Payment.stripe_session_id == stripe_session_id)
        .with_for_update()
    )
    result = await session.execute(stmt)
    payment = result.scalar_one_or_none()

    if not payment:
        logger.warning(
            "stripe_webhook_payment_not_found",
            stripe_session_id=stripe_session_id,
        )
        return None

    # Idempotency: skip if already confirmed.
    if payment.status == PaymentStatus.CONFIRMED.value:
        logger.info(
            "stripe_webhook_already_confirmed",
            payment_id=str(payment.id),
            stripe_session_id=stripe_session_id,
        )
        return payment

    # CRITICAL-3: Verify Stripe charged the expected amount.
    # Stripe amount_total is in cents of the session currency.
    # If it doesn't match our record, something is wrong -- mark
    # payment as failed and do NOT credit user balance.
    stripe_amount = event_data.get("amount_total")
    if stripe_amount is not None and stripe_amount != payment.amount_cents:
        logger.critical(
            "stripe_amount_mismatch",
            payment_id=str(payment.id),
            expected_cents=payment.amount_cents,
            stripe_cents=stripe_amount,
            stripe_session_id=stripe_session_id,
        )
        payment.status = PaymentStatus.FAILED.value
        payment.stripe_metadata = {
            "stripe_event": {
                "customer_email": event_data.get("customer_email"),
                "amount_total": stripe_amount,
                "currency": event_data.get("currency"),
            },
            "failure_reason": "amount_mismatch",
        }

        await record_audit(
            event="payment_topup_amount_mismatch",
            actor_id=None,
            actor_type="system",
            target_type="payment",
            target_id=payment.id,
            data={
                "expected_cents": payment.amount_cents,
                "stripe_cents": stripe_amount,
                "stripe_session_id": stripe_session_id,
            },
            session=session,
        )
        return payment

    # Update payment.
    now = datetime.now(UTC)
    payment.status = PaymentStatus.CONFIRMED.value
    payment.confirmed_at = now
    payment.stripe_payment_intent_id = event_data.get(
        "payment_intent"
    )
    payment.stripe_metadata = {
        "stripe_event": {
            "customer_email": event_data.get("customer_email"),
            "amount_total": event_data.get("amount_total"),
            "currency": event_data.get("currency"),
        },
    }

    # Record user_ledger entry (actual balance topup).
    await record_user_ledger(
        user_id=payment.user_id,
        amount_cents=payment.amount_cents,
        reason=f"payment:{payment.id}",
        session=session,
        notes=f"Stripe topup, session={stripe_session_id}",
    )

    # Offsetting company entry: platform received money from user (liability).
    # Double-entry rule: user(+N) + company(-N) = 0.
    await record_company_ledger(
        amount_cents=-payment.amount_cents,
        ledger_type=CompanyLedgerType.TOPUP.value,
        reason=f"topup:{payment.id}",
        reference_id=payment.id,
        session=session,
    )

    # Comms (T1, dictionary §2): wallet.topup_confirmed to the wallet
    # owner (velo context, ID-4) -- rides the webhook's transaction,
    # so a retried Stripe event that short-circuits on the idempotency
    # guard above never double-emits.
    from app.core.events.notify import emit_notification
    amount_text = f"{payment.amount_cents / 100:.2f}"
    await emit_notification(
        session,
        type="wallet.topup_confirmed",
        target_type="user",
        target_value=str(payment.user_id),
        title="Баланс пополнен",
        body=f"Ваш баланс пополнен на €{amount_text}.",
        action_data={
            "action": "open_wallet",
            "params": {},
            "amount": amount_text,
        },
    )

    # Audit.
    await record_audit(
        event="payment_topup_confirmed",
        actor_id=None,
        actor_type="system",
        target_type="payment",
        target_id=payment.id,
        data={
            "amount_cents": payment.amount_cents,
            "currency": payment.currency,
            "stripe_session_id": stripe_session_id,
            "stripe_payment_intent_id": payment.stripe_payment_intent_id,
        },
        session=session,
    )

    logger.info(
        "topup_confirmed",
        payment_id=str(payment.id),
        user_id=str(payment.user_id),
        amount_cents=payment.amount_cents,
    )

    return payment


async def handle_checkout_expired_or_failed(
    event_data: dict,
    session: AsyncSession,
) -> Payment | None:
    """Handle checkout.session.expired or payment failure events.

    1. Look up Payment by stripe_session_id.
    2. Skip if already in terminal state (idempotency).
    3. Update Payment status -> failed.
    4. Record audit event.

    Args:
        event_data: The Stripe event data object.
        session: Active DB session.

    Returns:
        Updated Payment, or None if skipped.
    """
    stripe_session_id = event_data.get("id")
    if not stripe_session_id:
        logger.warning("stripe_webhook_missing_session_id")
        return None

    stmt = (
        select(Payment)
        .where(Payment.stripe_session_id == stripe_session_id)
        .with_for_update()
    )
    result = await session.execute(stmt)
    payment = result.scalar_one_or_none()

    if not payment:
        logger.warning(
            "stripe_webhook_payment_not_found",
            stripe_session_id=stripe_session_id,
        )
        return None

    # Idempotency: skip if already in terminal state.
    terminal = {
        PaymentStatus.CONFIRMED.value,
        PaymentStatus.FAILED.value,
        PaymentStatus.REFUNDED.value,
    }
    if payment.status in terminal:
        logger.info(
            "stripe_webhook_already_terminal",
            payment_id=str(payment.id),
            status=payment.status,
        )
        return payment

    payment.status = PaymentStatus.FAILED.value

    # Audit.
    await record_audit(
        event="payment_topup_failed",
        actor_id=None,
        actor_type="system",
        target_type="payment",
        target_id=payment.id,
        data={
            "amount_cents": payment.amount_cents,
            "currency": payment.currency,
            "stripe_session_id": stripe_session_id,
            "reason": "checkout_expired_or_failed",
        },
        session=session,
    )

    logger.info(
        "topup_failed",
        payment_id=str(payment.id),
        user_id=str(payment.user_id),
    )

    return payment
