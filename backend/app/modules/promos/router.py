# =============================================================================
# VELO Backend -- Promo Router (Phase 6.7)
# =============================================================================
#
# Master-facing endpoints for promo code management.
#
# ENDPOINTS:
#   POST  /api/v1/masters/me/promos           -- create a master promo
#   GET   /api/v1/masters/me/promos           -- list my promos (paginated)
#   PATCH /api/v1/masters/me/promos/{id}/deactivate -- soft-delete
#
# AUTH: get_current_master on all endpoints (verified master only).
# SESSION: POST/PATCH = get_db_session (write). GET = get_db_reader (read).
# =============================================================================

from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db_reader, get_db_session
from app.core.options import option_dependency
from app.modules.auth.dependencies import get_current_master
from app.modules.masters.models import MasterProfile
from app.modules.promos.schemas import (
    CreateMasterPromoRequest,
    PaginatedPromosResponse,
    PromoResponse,
)
from app.modules.promos.service import (
    create_master_promo,
    deactivate_promo,
    list_master_promos,
)
from app.modules.users.models import User

logger = structlog.get_logger()

router = APIRouter(
    prefix="/api/v1/masters",
    tags=["promos"],
    # BE-182: the option `payments` closes this router (app/core/options.py).
    dependencies=[option_dependency("payments")],
)


@router.post(
    "/me/promos",
    response_model=PromoResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_promo_endpoint(
    body: CreateMasterPromoRequest,
    master_tuple: tuple[User, MasterProfile] = Depends(
        get_current_master,
    ),
    session: AsyncSession = Depends(get_db_session),
) -> PromoResponse:
    """Create a master promo code.

    Master promos: the master absorbs the discount from their revenue.
    Code is automatically uppercased. Discount must be in the allowed list.
    """
    user, _profile = master_tuple
    promo = await create_master_promo(
        user=user, body=body, session=session,
    )
    await session.flush()
    await session.refresh(promo)
    return PromoResponse.model_validate(promo, from_attributes=True)


@router.get(
    "/me/promos",
    response_model=PaginatedPromosResponse,
)
async def list_my_promos_endpoint(
    master_tuple: tuple[User, MasterProfile] = Depends(
        get_current_master,
    ),
    session: AsyncSession = Depends(get_db_reader),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> PaginatedPromosResponse:
    """List promo codes created by the current master (newest first)."""
    user, _profile = master_tuple
    return await list_master_promos(
        user_id=user.id, session=session,
        limit=limit, offset=offset,
    )


@router.patch(
    "/me/promos/{promo_id}/deactivate",
    response_model=PromoResponse,
)
async def deactivate_promo_endpoint(
    promo_id: UUID,
    master_tuple: tuple[User, MasterProfile] = Depends(
        get_current_master,
    ),
    session: AsyncSession = Depends(get_db_session),
) -> PromoResponse:
    """Deactivate (soft-delete) a master promo code.

    Existing purchases with this promo keep their promo_id FK.
    The promo simply stops being usable for new purchases.
    """
    user, _profile = master_tuple
    promo = await deactivate_promo(
        promo_id=promo_id, user=user, session=session,
    )
    await session.flush()
    await session.refresh(promo)
    return PromoResponse.model_validate(promo, from_attributes=True)
