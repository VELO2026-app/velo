# =============================================================================
# VELO Backend -- Purchase Router (Phase 6.4 + Backlog, updated 6.7 Batch 4)
# =============================================================================
#
# ENDPOINTS:
#   POST /api/v1/practices/{practice_id}/purchase          -- purchase
#   POST /api/v1/practices/{practice_id}/preview-purchase   -- preview pricing
#   GET  /api/v1/purchases/me                               -- my purchases
#
# Two routers:
#   router                -- prefix /api/v1/practices (purchase + preview)
#   purchases_user_router -- prefix /api/v1/purchases (user-facing list)
#
# AUTH: get_current_user.
# SESSION: POST purchase = get_db_session (write).
#          POST preview  = get_db_reader (read-only, no side effects).
#          GET list       = get_db_reader (read).
#
# 6.1 fix: removed redundant inline `from app.core.exceptions import
#   NotFoundError` inside preview_purchase_endpoint. NotFoundError is
#   already imported at module level.
# =============================================================================

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db_reader, get_db_session
from app.core.exceptions import NotFoundError
from app.modules.auth.dependencies import get_current_user
from app.modules.bookings.service import create_booking
from app.modules.payments.models import Purchase
from app.modules.payments.purchase import list_user_purchases
from app.modules.payments.schemas import (
    PaginatedPurchasesResponse,
    PreviewPurchaseRequest,
    PreviewPurchaseResponse,
    PurchaseRequest,
    PurchaseResponse,
    PurchaseWithPracticeResponse,
)
from app.modules.practices.models import Practice
from app.modules.practices.schemas import PracticeSummary
from app.modules.promos.models import Promo
from app.modules.promos.validation import calculate_discount, validate_promo
from app.modules.users.models import User

router = APIRouter(
    prefix="/api/v1/practices",
    tags=["purchases"],
)

purchases_user_router = APIRouter(
    prefix="/api/v1/purchases",
    tags=["purchases"],
)


@router.post(
    "/{practice_id}/purchase",
    response_model=PurchaseResponse,
    status_code=status.HTTP_201_CREATED,
)
async def purchase_practice_endpoint(
    practice_id: UUID,
    body: PurchaseRequest | None = None,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> PurchaseResponse:
    """Purchase a practice -- creates Booking + Purchase.

    Optional promo_code in request body to apply a discount.
    For free practices: paid_cents=0, ledger entries with amount=0.
    For paid practices: checks balance, deducts from user, freezes at master.

    Returns full purchase details including financial info.
    """
    # Validate promo if provided.
    promo: Promo | None = None
    if body and body.promo_code:
        # Load practice for validation (need master_id for scope check).
        practice = await session.get(Practice, practice_id)
        if not practice:
            raise NotFoundError("Practice not found")
        promo = await validate_promo(
            code=body.promo_code,
            practice=practice,
            user_id=user.id,
            session=session,
        )

    booking = await create_booking(user, practice_id, session, promo=promo)
    await session.flush()

    # Load the Purchase created inside create_booking.
    purchase = await session.get(Purchase, booking.purchase_id)
    await session.refresh(purchase)

    return PurchaseResponse.model_validate(purchase)


@router.post(
    "/{practice_id}/preview-purchase",
    response_model=PreviewPurchaseResponse,
)
async def preview_purchase_endpoint(
    practice_id: UUID,
    body: PreviewPurchaseRequest | None = None,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_reader),
) -> PreviewPurchaseResponse:
    """Preview purchase pricing with optional promo code.

    Read-only endpoint -- no booking, no purchase, no ledger entries.
    Shows what the user would pay with/without a promo code.
    """
    stmt = select(Practice).where(Practice.id == practice_id)
    result = await session.execute(stmt)
    practice = result.scalar_one_or_none()

    if not practice:
        raise NotFoundError("Practice not found")

    price_cents = practice.price_cents
    promo: Promo | None = None

    if body and body.promo_code:
        promo = await validate_promo(
            code=body.promo_code,
            practice=practice,
            user_id=user.id,
            session=session,
        )

    if promo:
        amount_cents, discount_cents, paid_cents = calculate_discount(
            promo, price_cents,
        )
        return PreviewPurchaseResponse(
            practice_id=practice.id,
            amount_cents=amount_cents,
            discount_cents=discount_cents,
            paid_cents=paid_cents,
            currency=practice.currency,
            promo_code=promo.code,
            promo_type=promo.type,
            discount_percent=promo.discount_percent,
        )

    return PreviewPurchaseResponse(
        practice_id=practice.id,
        amount_cents=price_cents,
        discount_cents=0,
        paid_cents=price_cents,
        currency=practice.currency,
    )


# ===================================================================
# Frontend Backlog: GET /me -- my purchases
# ===================================================================


@purchases_user_router.get(
    "/me",
    response_model=PaginatedPurchasesResponse,
)
async def list_my_purchases_endpoint(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_reader),
    status_filter: Literal["pending", "completed", "refunded", "cancelled"] | None = Query(
        default=None, alias="status",
    ),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> PaginatedPurchasesResponse:
    """List purchases for the current user.

    Returns paginated list with embedded PracticeSummary so the
    frontend can render purchase history cards.

    Optional ``status`` filter (e.g. ``?status=completed``).
    """
    items, total = await list_user_purchases(
        user,
        session,
        status_filter=status_filter,
        limit=limit,
        offset=offset,
    )

    # Resolve master display names for this page. The embedded PracticeSummary
    # has no ORM source for master_name (it lives on a different row), so
    # model_validate leaves it None -> list cards showed a "Мастер" fallback.
    # Fill it here with the same helper the single-booking/detail responses use.
    # Dedup by master_id so a master repeated across the page is looked up once.
    from app.modules.masters.service import get_master_display_name

    master_names: dict[UUID, str] = {}
    for row in items:
        mid = row[1].master_id
        if mid not in master_names:
            master_names[mid] = await get_master_display_name(mid, session)

    return PaginatedPurchasesResponse(
        items=[
            PurchaseWithPracticeResponse(
                id=p.id,
                practice_id=p.practice_id,
                booking_id=p.booking_id,
                user_id=p.user_id,
                amount_cents=p.amount_cents,
                discount_cents=p.discount_cents,
                paid_cents=p.paid_cents,
                currency=p.currency,
                commission_cents=p.commission_cents,
                status=p.status,
                promo_id=p.promo_id,
                completed_at=p.completed_at,
                created_at=p.created_at,
                updated_at=p.updated_at,
                # T-35: purchase history is not a Zoom entry point, and the
                # summary no longer carries a Zoom URL of any kind (the
                # zoom_link column and its fail-closed gate are gone).
                practice=PracticeSummary.from_practice(
                    practice,
                    master_name=master_names[practice.master_id],
                ),
            )
            for p, practice in items
        ],
        total=total,
        limit=limit,
        offset=offset,
    )
