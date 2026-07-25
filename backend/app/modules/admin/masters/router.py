# =============================================================================
# VELO Backend -- Admin Masters Router (Phase 2.3, moved Phase 3.1)
# =============================================================================
#
# ENDPOINTS:
#   POST /api/v1/admin/masters/{user_id}/verify -- approve application
#   POST /api/v1/admin/masters/{user_id}/reject -- reject application
#
# AUTH: get_current_admin on every endpoint.
# SESSION: flush() + refresh(), no commit (P-01).
# =============================================================================

from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db_reader, get_db_session
from app.modules.admin.masters.schemas import (
    AdminMasterActionResponse,
    AdminMasterProfileUpdate,
    ApproveMethodChangeRequest,
    EditMasterMethodsRequest,
    InviteMasterResponse,
    MethodChangeActionResponse,
    PaginatedMethodChangeRequestsResponse,
    RejectMasterRequest,
    RejectMethodChangeRequest,
    RevokeMasterAdvisory,
    VerifyMasterRequest,
)
from app.modules.admin.masters.service import (
    approve_method_change,
    edit_master_methods,
    edit_master_profile,
    get_revoke_advisory,
    issue_master_invite,
    list_pending_method_changes,
    reject_master,
    reject_method_change,
    revoke_master,
    verify_master,
)
from app.modules.auth.dependencies import get_current_admin
from app.modules.users.models import User

logger = structlog.get_logger()

router = APIRouter(prefix="/masters")


@router.post(
    "/invite",
    response_model=InviteMasterResponse,
)
async def invite_master_endpoint(
    admin: User = Depends(get_current_admin),
) -> InviteMasterResponse:
    """Issue a generic one-time master invite link (Batch-INVITE).

    Account-agnostic: no target. The full deeplink is composed server-side
    from telegram_bot_url; only the token's sha256 is persisted (in Redis,
    no expiry) and burned by the first claim. 503 if telegram_bot_url unset.
    """
    invite_link, issued_at = await issue_master_invite(admin)
    return InviteMasterResponse(invite_link=invite_link, issued_at=issued_at)


# ---------------------------------------------------------------------------
# M3 (E19-FLAT): method change-request moderation
# ---------------------------------------------------------------------------
# NOTE: this static GET is declared before the dynamic /{user_id}/* routes so
# "method-change-requests" is never parsed as a user_id (route-order rule,
# mirrors admin/users/router.py).


@router.get(
    "/method-change-requests",
    response_model=PaginatedMethodChangeRequestsResponse,
)
async def list_method_change_requests_endpoint(
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_reader),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> PaginatedMethodChangeRequestsResponse:
    """List masters with a pending method change-request (newest first)."""
    return await list_pending_method_changes(
        session, limit=limit, offset=offset
    )


@router.post(
    "/{user_id}/verify",
    response_model=AdminMasterActionResponse,
)
async def verify_master_endpoint(
    user_id: UUID,
    body: VerifyMasterRequest,
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_session),
) -> AdminMasterActionResponse:
    """Verify a pending master application.

    Updates profile status to 'verified'. body.promote (ПРОМТ №503 commit 3):
    optional custom method labels to add to the taxonomy catalog -- absent/
    empty writes nothing, identical to before this field existed.
    """
    profile = await verify_master(
        user_id, admin, body.notes, session,
        promote=body.promote, master_only=body.master_only,
    )

    await session.flush()
    await session.refresh(profile)

    return AdminMasterActionResponse(
        user_id=profile.user_id,
        status=profile.data["account"]["status"],
    )


@router.get(
    "/{user_id}/revoke-preview",
    response_model=RevokeMasterAdvisory,
)
async def revoke_master_preview_endpoint(
    user_id: UUID,
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_reader),
) -> RevokeMasterAdvisory:
    """Advisory signals shown in the revoke confirm dialog (A1, read-only)."""
    return await get_revoke_advisory(user_id, session)


@router.post(
    "/{user_id}/revoke",
    response_model=RevokeMasterAdvisory,
)
async def revoke_master_endpoint(
    user_id: UUID,
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_session),
) -> RevokeMasterAdvisory:
    """Revoke a master's capability, preserving all data (A1, operator Б).

    Mirrors CLI `velo setrole <tg> user` (set_role.py to_user): role -> user
    (if master) + profile soft-frozen (status=suspended, is_accepting=false).
    Never blocks on the advisory guard signals. Re-grant = the existing
    "Сделать мастером" make_master re-verify branch.
    """
    advisory = await revoke_master(user_id, admin, session)
    await session.flush()
    return advisory


@router.patch(
    "/{user_id}/methods",
    response_model=AdminMasterActionResponse,
)
async def edit_master_methods_endpoint(
    user_id: UUID,
    body: EditMasterMethodsRequest,
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_session),
) -> AdminMasterActionResponse:
    """Admin edits a master's methods during review (T3, ПРОМТ №293).

    Overwrites data.profile.methods with the validated flat list (min 1).
    Distinct from the master's own method-change request (M3 approve/reject).
    """
    profile = await edit_master_methods(user_id, body.methods, admin, session)

    await session.flush()
    await session.refresh(profile)

    return AdminMasterActionResponse(
        user_id=profile.user_id,
        status=profile.data["account"]["status"],
    )


@router.patch(
    "/{user_id}/profile",
    response_model=AdminMasterActionResponse,
)
async def edit_master_profile_endpoint(
    user_id: UUID,
    body: AdminMasterProfileUpdate,
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_session),
) -> AdminMasterActionResponse:
    """Admin edits ANY master-authored profile field (batch H).

    Partial update: only the keys the client sends are applied, to both
    MasterProfile.data.profile.* and User.first_name/last_name. Works on a master
    in ANY status (mirrors edit_master_methods, no gate). Distinct from the
    master's own edits (languages / method-change request) and from verify/reject.
    """
    profile = await edit_master_profile(user_id, body, admin, session)

    await session.flush()
    await session.refresh(profile)

    return AdminMasterActionResponse(
        user_id=profile.user_id,
        status=profile.data["account"]["status"],
    )


@router.post(
    "/{user_id}/reject",
    response_model=AdminMasterActionResponse,
)
async def reject_master_endpoint(
    user_id: UUID,
    body: RejectMasterRequest,
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_session),
) -> AdminMasterActionResponse:
    """Reject a pending master application.

    Stores rejection reason. User can reapply later.
    """
    profile = await reject_master(user_id, admin, body.reason, session)

    await session.flush()
    await session.refresh(profile)

    return AdminMasterActionResponse(
        user_id=profile.user_id,
        status=profile.data["account"]["status"],
    )


@router.post(
    "/{user_id}/method-change-request/approve",
    response_model=MethodChangeActionResponse,
)
async def approve_method_change_endpoint(
    user_id: UUID,
    body: ApproveMethodChangeRequest = ApproveMethodChangeRequest(),
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_session),
) -> MethodChangeActionResponse:
    """Approve a master's pending method change-request.

    Copies the proposed methods into the live set and clears the request.
    body.promote (R5 stage 4): optional custom method labels to add to the
    taxonomy catalog -- absent/empty is identical to pre-stage-4 behavior.
    """
    await approve_method_change(
        user_id, admin, session,
        promote=body.promote, master_only=body.master_only,
    )

    await session.flush()

    return MethodChangeActionResponse(user_id=user_id, status="approved")


@router.post(
    "/{user_id}/method-change-request/reject",
    response_model=MethodChangeActionResponse,
)
async def reject_method_change_endpoint(
    user_id: UUID,
    body: RejectMethodChangeRequest,
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_session),
) -> MethodChangeActionResponse:
    """Reject a master's pending method change-request (with a reason)."""
    await reject_method_change(user_id, admin, body.reason, session)

    await session.flush()

    return MethodChangeActionResponse(user_id=user_id, status="rejected")
