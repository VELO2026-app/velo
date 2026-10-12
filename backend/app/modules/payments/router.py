# =============================================================================
# VELO Backend -- Payments Router (Phase 6.3)
# =============================================================================
#
# ENDPOINTS:
#   POST /api/v1/payments/topup -- create Stripe Checkout Session for topup
#
# AUTH: get_current_user_write on mutating endpoints (TD-029 / Fix 2.2).
#   get_current_user loads the user in a short session of its own, closed
#   before the endpoint runs (BE-146): the object is detached, a snapshot
#   from before this transaction -- any access to fields like balance_cents
#   would read that snapshot. get_current_user_write loads the user via the
#   same get_db_session instance (FastAPI caches Depends within a request),
#   so both user and session share one connection and one transaction.
# SESSION: get_db_session (write) -- creates Payment + audit records.
# =============================================================================

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db_session
from app.modules.auth.dependencies import get_current_user_write
from app.modules.payments.schemas import TopupRequest, TopupResponse
from app.modules.payments.stripe import create_topup_session
from app.modules.users.models import User

router = APIRouter(
    prefix="/api/v1/payments", tags=["payments"],
)


@router.post(
    "/topup",
    response_model=TopupResponse,
    status_code=status.HTTP_201_CREATED,
)
async def topup_endpoint(
    body: TopupRequest,
    user: User = Depends(get_current_user_write),
    session: AsyncSession = Depends(get_db_session),
) -> TopupResponse:
    """Create a Stripe Checkout Session for balance top-up.

    Returns a checkout URL that the frontend should redirect to.
    """
    payment, checkout_url = await create_topup_session(
        user_id=user.id,
        amount_cents=body.amount_cents,
        currency=settings.default_currency,
        session=session,
    )
    await session.flush()
    await session.refresh(payment)

    return TopupResponse(
        payment_id=payment.id,
        checkout_url=checkout_url,
        amount_cents=payment.amount_cents,
        currency=payment.currency,
    )
