# =============================================================================
# VELO Backend -- Admin Users Router (Phase 3.2, updated F8-fix)
# =============================================================================
#
# ENDPOINTS:
#   GET /api/v1/admin/users                 -- list all users
#   GET /api/v1/admin/masters/list          -- list all masters (with status filter)
#   GET /api/v1/admin/masters/pending       -- shortcut: pending applications
#   GET /api/v1/admin/masters/rejected      -- shortcut: rejected applications
#   GET /api/v1/admin/masters/{user_id}     -- single master by user_id (F8-fix W-1)
#
# NOTE: masters/list (not just /masters) to avoid path conflict with
#   POST /masters/{user_id}/verify in admin/masters/router.py.
#   FastAPI would confuse "pending" as a user_id UUID otherwise.
#
# ROUTE ORDER: static paths (/list, /pending, /rejected) MUST be registered
#   before the dynamic /{user_id} route so FastAPI does not swallow them.
#
# AUTH: get_current_admin on every endpoint.
# SESSION: get_db_reader -- all read-only.
# =============================================================================

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db_reader, get_db_session
from app.modules.admin.masters.schemas import AdminMasterActionResponse
from app.modules.admin.users.schemas import (
    AdminMasterDetail,
    AdminMasterListItem,
    PaginatedMastersResponse,
    PaginatedUsersResponse,
)
from app.modules.admin.users.service import (
    get_master_by_id,
    list_masters,
    list_users,
    make_master,
)
from app.modules.auth.dependencies import get_current_admin
from app.modules.users.models import User

router = APIRouter()


@router.get("/users", response_model=PaginatedUsersResponse)
async def get_users(
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_reader),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    role: str | None = Query(default=None),
    is_active: bool | None = Query(default=None),
) -> PaginatedUsersResponse:
    """List all users with optional filters and pagination."""
    return await list_users(
        session, limit=limit, offset=offset, role=role, is_active=is_active
    )


@router.post(
    "/users/{user_id}/make-master",
    response_model=AdminMasterActionResponse,
)
async def make_master_endpoint(
    user_id: UUID,
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_session),
) -> AdminMasterActionResponse:
    """Explicitly promote a user to master (admin all-users screen, PROMPT №292).

    Creates a verified MasterProfile if missing (or re-verifies a non-verified
    one) and sets role=master. 409 if the user is already a master. Distinct
    from POST /masters/{user_id}/verify (the application-approval path).
    """
    profile = await make_master(user_id, admin, session)

    await session.flush()
    await session.refresh(profile)

    return AdminMasterActionResponse(
        user_id=profile.user_id,
        status=profile.data["account"]["status"],
    )


@router.get("/masters/list", response_model=PaginatedMastersResponse)
async def get_masters(
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_reader),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    # L-04 fix: Literal validates status at FastAPI layer (422 on invalid).
    # Consistent with admin/reports/router.py (P-11).
    status: Literal["pending", "verified", "rejected"] | None = Query(
        default=None,
    ),
) -> PaginatedMastersResponse:
    """List all masters with optional status filter."""
    return await list_masters(
        session, limit=limit, offset=offset, status=status
    )


@router.get("/masters/pending", response_model=PaginatedMastersResponse)
async def get_pending_masters(
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_reader),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> PaginatedMastersResponse:
    """Shortcut: list master applications awaiting verification."""
    return await list_masters(
        session, limit=limit, offset=offset, status="pending"
    )


@router.get("/masters/rejected", response_model=PaginatedMastersResponse)
async def get_rejected_masters(
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_reader),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> PaginatedMastersResponse:
    """Shortcut: list rejected master applications."""
    return await list_masters(
        session, limit=limit, offset=offset, status="rejected"
    )


@router.get("/masters/{user_id}", response_model=AdminMasterDetail)
async def get_master(
    user_id: UUID,
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_reader),
) -> AdminMasterDetail:
    """Fetch a single master by user_id, with profile detail (T3).

    Feeds the admin review screen (methods / experience_years / bio). Also used
    as a fallback when router state is unavailable (direct URL / refresh).
    Returns 404 if the user has no MasterProfile.
    """
    return await get_master_by_id(user_id, session)
