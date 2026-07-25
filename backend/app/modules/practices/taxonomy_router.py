# =============================================================================
# VELO Backend -- Taxonomy Router (public/authenticated read) (R5 stage 3a)
# =============================================================================
#
# ENDPOINT:
#   GET /api/v1/taxonomy -- active-only direction/style catalog
#
# AUTH: get_current_user (ANY authenticated role, not admin-gated) -- masters
# need to read this to pick methods (MethodTaxonomyPicker, R5 stage 3b).
# Distinct from GET /api/v1/admin/taxonomy (admin-only, includes inactive).
#
# Reuses admin/taxonomy/service.list_active_taxonomy + its response schemas
# directly rather than duplicating them -- see that module's docstring for
# why a non-admin route imports from the "admin" package here.
# =============================================================================

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db_reader
from app.modules.admin.taxonomy.schemas import TaxonomyListResponse
from app.modules.admin.taxonomy.service import list_active_taxonomy
from app.modules.auth.dependencies import get_current_user
from app.modules.users.models import User

router = APIRouter(prefix="/api/v1/taxonomy", tags=["taxonomy"])


@router.get("", response_model=TaxonomyListResponse)
async def get_active_taxonomy_endpoint(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_reader),
) -> TaxonomyListResponse:
    """Active direction/style catalog (is_active=true only).

    T22-6 (ПРОМТ №561): scoped to the requesting user -- global rows plus
    their OWN master-scoped rows, if any. Every other master's private
    entries are excluded.
    """
    return await list_active_taxonomy(session, master_id=user.id)
