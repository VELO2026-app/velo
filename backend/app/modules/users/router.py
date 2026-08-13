# =============================================================================
# VELO Backend — Users Router
# =============================================================================
#
# ENDPOINTS:
#   GET   /api/v1/users/me  — Get current user profile
#   PATCH /api/v1/users/me  — Update current user profile
#
# TD-029 fix: PATCH /users/me now uses get_current_user_write instead of
#   get_current_user. Both the dependency and the router declare
#   Depends(get_db_session), so FastAPI reuses the same session instance
#   for the entire request — one DB connection instead of two.
#   The service no longer needs session.merge().
#
# MASTER CAPABILITY: UserResponse cannot decide on its own whether an account
#   has a verified MasterProfile -- that needs the MasterProfile table -- so
#   EVERY endpoint here returning a UserResponse (GET / PATCH /me, POST /me/role)
#   funnels through _user_response_with_capability(), which computes it and sets
#   the response carrier. Capability, NOT a strict role==master check, so an
#   admin who is also a verified master is treated as one. DELETE /me returns
#   204 (no body) and does not need it.
#   ⚠ This carrier existed to gate master_notifications, which T-26 retired; it
#   is still REQUIRED because role_switch derives the allowed-role set from it.
#   The same pass also fills master_application.
# =============================================================================

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db_reader, get_db_session
from app.modules.auth.dependencies import get_current_user, get_current_user_write
from app.modules.users.models import User
from app.modules.users.schemas import (
    MasterApplicationInfo,
    RoleSwitchRequest,
    UserResponse,
    UserUpdate,
)
from app.modules.users.service import (
    get_master_account,
    reset_user_to_onboarding,
    switch_user_role,
    update_user,
)

router = APIRouter(prefix="/api/v1/users", tags=["users"])


async def _user_response_with_capability(
    user: User,
    session: AsyncSession,
) -> UserResponse:
    """Serialize a user and set the master-capability carrier.

    "Master capability" means a VERIFIED MasterProfile. UserResponse cannot
    derive that on its own (it needs another table), so every endpoint returning
    a UserResponse routes through here to set master_capability_in. Without it
    the carrier defaults to False and `role_switch` under-derives -- a verified
    master silently stops being offered MASTER as a switch target.

    The session may be the read or the write session for the request -- the
    capability lookup is a plain SELECT and works on either.
    """
    response = UserResponse.model_validate(user)
    # One MasterProfile load feeds BOTH the capability gate and the T5
    # application state (status + rejection reason) surfaced to a role='user'
    # applicant so the pending/reject screen renders without /masters/me.
    account = await get_master_account(user, session)
    response.master_capability_in = (account or {}).get("status") == "verified"
    if account is not None:
        response.master_application = MasterApplicationInfo(
            status=account.get("status", "pending"),
            rejection_reason=account.get("rejection_reason"),
        )
    return response


@router.get("/me", response_model=UserResponse)
async def get_me(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_reader),
) -> UserResponse:
    """Return the authenticated user's profile.

    The user is loaded by get_current_user (read-only session). The same
    get_db_reader session is reused here (FastAPI caches Depends within a
    request, so this is one DB connection, not two) to check master capability,
    which the role_switch block is derived from (see
    _user_response_with_capability).
    """
    return await _user_response_with_capability(user, session)


@router.patch("/me", response_model=UserResponse)
async def update_me(
    body: UserUpdate,
    user: User = Depends(get_current_user_write),
    session: AsyncSession = Depends(get_db_session),
) -> UserResponse:
    """Update the authenticated user's profile.

    TD-029: get_current_user_write and Depends(get_db_session) share
    the same session instance (FastAPI caches Depends within a request).
    The user is already bound to the write session — no merge needed.

    Only fields present in the request body are updated. The response is built
    with the master-capability carrier set, same as GET /me, so role_switch
    derives identically on both.
    """
    updated = await update_user(user, body, session)
    return await _user_response_with_capability(updated, session)


@router.post("/me/role", response_model=UserResponse)
async def switch_my_role(
    body: RoleSwitchRequest,
    user: User = Depends(get_current_user_write),
    session: AsyncSession = Depends(get_db_session),
) -> UserResponse:
    """Switch the caller's own role (capability-derived, A1=Б).

    Always on -- no feature flag. Security rests on the derived policy in
    switch_user_role: the allowed target set is computed from the caller's
    current role and master capability (derive_allowed_roles, shared with the
    role_switch block in GET /me). A plain user derives {USER} only, so the
    endpoint grants nothing; a non-admin can never switch to ADMIN. Targets
    outside the derived set -> 403. The role is rewritten on the User row in
    place, so every existing role guard keeps working unchanged on
    subsequent requests.

    get_current_user_write + Depends(get_db_session) share one session
    (TD-029), so the mutation and the user load use the same connection. The
    response carries master capability (a verified MasterProfile), which is
    role-independent, like GET /me.
    """
    updated = await switch_user_role(user, body.role, session)
    return await _user_response_with_capability(updated, session)


@router.delete("/me", status_code=status.HTTP_204_NO_CONTENT)
async def delete_me(
    user: User = Depends(get_current_user_write),
    session: AsyncSession = Depends(get_db_session),
) -> None:
    """Delete the authenticated user's account.

    MVP SEMANTICS (see reset_user_to_onboarding): this does NOT erase data or
    deactivate the account. It resets the onboarding flag so the next login
    sends the user through the welcome flow again, with their old data intact.
    The endpoint contract ("DELETE my account") is kept so that real deletion
    can later be implemented by changing only the service body.

    Returns 204 No Content. The frontend then logs the user out (which closes
    the Mini App in Telegram / redirects in standalone).
    """
    await reset_user_to_onboarding(user, session)
