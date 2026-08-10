# =============================================================================
# VELO Backend -- Stripe Webhook Router (Phase 6.3, Batch 3 fix)
# =============================================================================
#
# ENDPOINT:
#   POST /webhooks/stripe -- receives Stripe webhook events
#
# NO AUTH: Stripe authenticates via webhook signature (Stripe-Signature
#   header). No Bearer token or session required.
#
# RAW BODY: Stripe signature verification requires the raw request body
#   (bytes), not parsed JSON. We use Request.body() before any parsing.
#
# SESSION MANAGEMENT:
#   Webhook cannot use Depends(get_db_session) because there is no auth
#   dependency chain. We create a session manually via get_session_factory()
#   and manage commit/rollback explicitly.
#
# IDEMPOTENCY: Handlers skip already-processed events (safe to retry).
#
# ERROR STRATEGY (M-03):
#   - Signature invalid → 400 (Stripe won't retry 4xx).
#   - Unhandled event type → 200 (acknowledged, ignored).
#   - Handler succeeds → 200.
#   - Transient error (DB down, network) → 500 (Stripe WILL retry).
#   Handlers are idempotent, so retries are safe. Returning 200 on
#   transient errors would cause payments to be stuck in pending forever.
#
# HANDLED EVENTS:
#   checkout.session.completed -- topup confirmed
#   checkout.session.expired   -- topup failed (session timed out)
# =============================================================================

import structlog
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.core.database import get_session_factory
from app.core.exceptions import BadRequestError
from app.modules.payments.stripe import (
    handle_checkout_completed,
    handle_checkout_expired_or_failed,
    verify_webhook_signature,
)

logger = structlog.get_logger()

webhook_router = APIRouter(
    prefix="/webhooks", tags=["webhooks"],
)

# Events we handle. Others are logged and ignored.
_HANDLED_EVENTS = {
    "checkout.session.completed",
    "checkout.session.expired",
}


@webhook_router.post("/stripe")
async def stripe_webhook(request: Request) -> JSONResponse:
    """Receive and process Stripe webhook events.

    1. Read raw body (required for signature verification).
    2. Verify signature using Stripe-Signature header.
    3. Dispatch to event-specific handler.
    4. Return 200 on success, 500 on transient failure (M-03).

    Stripe retries on 5xx with exponential backoff (up to 3 days).
    Handlers are idempotent, so retries are safe.
    """
    # Step 1: Raw body.
    payload = await request.body()

    # Step 2: Signature verification.
    sig_header = request.headers.get("stripe-signature", "")
    if not sig_header:
        logger.warning("stripe_webhook_missing_signature")
        return JSONResponse(
            status_code=400,
            content={"error": "Missing Stripe-Signature header"},
        )

    try:
        event = verify_webhook_signature(payload, sig_header)
    except BadRequestError:
        # Expected: invalid signature / payload. stripe.py already logs the
        # specific reason one frame down. Return 400 -- Stripe won't retry.
        return JSONResponse(
            status_code=400,
            content={"error": "Invalid signature"},
        )
    except Exception:
        # Unanticipated -- e.g. a _configure_stripe() misconfiguration, not a
        # bad signature. A 400 here would be a lie about what happened, and
        # Stripe won't retry a 4xx, so the event would be lost silently.
        # Follow the file's own strategy for transient/unexpected failures.
        logger.exception("stripe_webhook_verify_unexpected_error")
        return JSONResponse(
            status_code=500,
            content={"error": "Internal error"},
        )

    event_type = event.get("type", "unknown")
    event_id = event.get("id", "unknown")

    logger.info(
        "stripe_webhook_received",
        event_type=event_type,
        event_id=event_id,
    )

    # Step 3: Skip unhandled events.
    if event_type not in _HANDLED_EVENTS:
        logger.info(
            "stripe_webhook_unhandled_event",
            event_type=event_type,
        )
        return JSONResponse(
            status_code=200,
            content={"status": "ignored"},
        )

    # Step 4: Process with manual session management.
    factory = get_session_factory()
    session = factory()
    try:
        event_data = event.get("data", {}).get("object", {})

        if event_type == "checkout.session.completed":
            await handle_checkout_completed(event_data, session)
        elif event_type == "checkout.session.expired":
            await handle_checkout_expired_or_failed(
                event_data, session,
            )

        await session.commit()

        logger.info(
            "stripe_webhook_processed",
            event_type=event_type,
            event_id=event_id,
        )
    except Exception:
        await session.rollback()
        logger.exception(
            "stripe_webhook_processing_error",
            event_type=event_type,
            event_id=event_id,
        )
        # M-03 fix: return 500 on transient errors so Stripe retries.
        # Handlers are idempotent (skip already-processed events),
        # so retries are safe. Returning 200 here would cause payments
        # to be stuck in pending state forever if DB is temporarily down.
        return JSONResponse(
            status_code=500,
            content={"error": "processing_failed"},
        )
    finally:
        await session.close()

    return JSONResponse(
        status_code=200,
        content={"status": "processed"},
    )
