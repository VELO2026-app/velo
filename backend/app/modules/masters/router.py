# =============================================================================
# VELO Backend -- Master Router (updated Phase F7 + CR-01)
# =============================================================================
#
# Endpoints:
#   POST   /api/v1/masters/apply          -- submit master application
#   DELETE /api/v1/masters/me/application -- withdraw a pending application (F4)
#   GET    /api/v1/masters/me             -- my master profile (Frontend Backlog)
#   PATCH  /api/v1/masters/me/payout      -- update payout details (Phase 6.6)
#   GET    /api/v1/masters/me/practices   -- list my practices (Phase 4.2)
#   GET    /api/v1/masters/{user_id}      -- public master profile (S-4)
#
# F7: _make_profile_response() now includes payout field extracted from
#   MasterProfile.data.get("payout"). Returns None when not configured.
#
# CR-01: _make_profile_response() now includes min_withdrawal_cents and
#   withdrawal_fee_cents from settings so frontend has a single source
#   of truth for financial limits.
#
# S-4 (Calendar iteration): GET /{user_id} returns the user-facing public
#   profile (MasterPublicResponse). It is declared AFTER all /me* routes so
#   the dynamic /{user_id} path never shadows the literal /me paths
#   (FastAPI matches routes in declaration order).
# =============================================================================

import copy
from typing import Literal
from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db_reader, get_db_session
from app.core.exceptions import BadRequestError
from app.modules.auth.dependencies import (
    get_current_master,
    get_current_user,
)
from app.modules.masters.models import MasterProfile
from app.modules.masters.schemas import (
    ClaimMasterInviteRequest,
    ClaimMasterInviteResponse,
    MasterApplyRequest,
    MasterApplyResponse,
    MasterLanguagesUpdate,
    MasterProfileResponse,
    MasterPublicResponse,
    MethodChangeRequest,
    MethodChangeRequestSubmit,
    PayoutDetails,
    PayoutDetailsUpdate,
)
from app.modules.masters.service import (
    apply_for_master,
    claim_master_invite,
    get_public_master_profile,
    submit_method_change_request,
    update_master_languages,
    withdraw_master_application,
)
from app.modules.practices.listing_service import list_master_practices
from app.modules.practices.schemas import PaginatedPracticesResponse
from app.modules.users.models import User

logger = structlog.get_logger()

router = APIRouter(prefix="/api/v1/masters", tags=["masters"])


def _make_profile_response(
    master_tuple: tuple[User, MasterProfile],
) -> MasterProfileResponse:
    """Build MasterProfileResponse from ORM objects.

    Extracts display fields from the JSONB ``data`` column and
    combines them with cached balance columns (frozen_cents,
    available_cents). The ``status`` field reflects the master's
    verification status (pending / verified / rejected).

    F7: payout field is extracted from data.get("payout").
    Returns None when master has not configured payout details yet.

    CR-01: min_withdrawal_cents and withdrawal_fee_cents are sourced
    from settings so the frontend does not need to hardcode them.
    """
    _user, profile = master_tuple
    data = profile.data
    account = data.get("account", {})
    prof = data.get("profile", {})

    # F7: extract payout details if configured.
    payout_raw = data.get("payout")
    payout = PayoutDetails(**payout_raw) if payout_raw else None

    # M3: project the pending / recently-rejected method-change request.
    mcr_raw = prof.get("method_change_request")
    method_change_request = (
        MethodChangeRequest(**mcr_raw) if mcr_raw else None
    )

    return MasterProfileResponse(
        user_id=profile.user_id,
        status=account.get("status", "pending"),
        display_name=prof.get("display_name"),
        bio=prof.get("bio"),
        methods=prof.get("methods", []),
        languages=prof.get("languages", []),
        experience_years=prof.get("experience_years"),
        frozen_cents=profile.frozen_cents,
        available_cents=profile.available_cents,
        min_withdrawal_cents=settings.min_withdrawal_cents,
        withdrawal_fee_cents=settings.withdrawal_fee_cents,
        payout=payout,
        created_at=profile.created_at,
        updated_at=profile.updated_at,
        # E14: surface the admin-captured reason from data.account so the
        # applicant's «Отказ» screen shows why (None unless rejected).
        rejection_reason=account.get("rejection_reason"),
        # M3: pending / recently-rejected method-change request (None if none).
        method_change_request=method_change_request,
    )


@router.post(
    "/apply",
    response_model=MasterApplyResponse,
    status_code=status.HTTP_201_CREATED,
)
async def apply_master(
    body: MasterApplyRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> MasterApplyResponse:
    """Submit a master application.

    Collects profile, experience, and documents from a 3-step form.
    Creates a MasterProfile with status "pending". If a previous
    application was rejected, updates the existing profile.
    """
    profile = await apply_for_master(user, body, session)

    # flush() to get DB-generated defaults (created_at) without
    # explicit commit -- get_db_session commits on success after yield.
    await session.flush()
    await session.refresh(profile)

    return MasterApplyResponse(
        user_id=profile.user_id,
        status=profile.data["account"]["status"],
        created_at=profile.created_at,
    )


@router.delete(
    "/me/application",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def withdraw_master_application_endpoint(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> None:
    """Withdraw the caller's own pending master application (F4).

    get_current_user, not get_current_master: a pending applicant is still
    role='user' (role only escalates on self-switch after approval), so
    get_current_master's verified-only gate would reject them.

    Status flip only -- see withdraw_master_application's docstring for the
    product decision. 204, mirroring DELETE /users/me and DELETE
    /masters/me/payout.
    """
    await withdraw_master_application(user, session)
    await session.flush()


# ===================================================================
# Batch-INVITE: POST /invite/claim -- claim a one-time invite
# ===================================================================


@router.post(
    "/invite/claim",
    response_model=ClaimMasterInviteResponse,
)
async def claim_master_invite_endpoint(
    body: ClaimMasterInviteRequest,
    _user: User = Depends(get_current_user),
) -> ClaimMasterInviteResponse:
    """Claim a generic one-time master invite (deeplink master_onboarding__<token>).

    Any authenticated opener (auto-registered at login) may claim; the token
    is burned atomically in Redis (first claim wins, later claims 404). The
    application itself then goes through the regular apply wizard + admin
    approval loop -- nothing is verified here. get_current_user only pins the
    request to an authenticated user; no DB write happens.
    """
    claimed_at = await claim_master_invite(body.token)
    return ClaimMasterInviteResponse(claimed_at=claimed_at)


# ===================================================================
# Frontend Backlog: GET /me -- master profile
# ===================================================================


@router.get(
    "/me",
    response_model=MasterProfileResponse,
)
async def get_my_master_profile(
    master_tuple: tuple[User, MasterProfile] = Depends(
        get_current_master,
    ),
    session: AsyncSession = Depends(get_db_reader),
) -> MasterProfileResponse:
    """Return the current master's profile.

    Extracts display fields from the JSONB ``data`` column and
    combines them with cached balance columns (frozen_cents,
    available_cents). The ``status`` field reflects the master's
    verification status (pending / verified / rejected).

    F7: Response now includes payout field (None until configured).
    CR-01: Response now includes withdrawal limits from settings.
    """
    return _make_profile_response(master_tuple)


# ===================================================================
# Phase 6.6: PATCH /me/payout -- update payout details
# ===================================================================


@router.patch(
    "/me/payout",
    response_model=PayoutDetails,
)
async def update_payout_details(
    body: PayoutDetailsUpdate,
    master_tuple: tuple[User, MasterProfile] = Depends(
        get_current_master,
    ),
    session: AsyncSession = Depends(get_db_session),
) -> PayoutDetails:
    """Update master's payout details (bank, PayPal, etc.).

    Stored in MasterProfile.data.payout. Snapshotted into each
    Withdrawal at creation time (A+C pattern).
    """
    user, _profile = master_tuple

    # Re-load profile in the writer session.
    # get_current_master loads the object in its own session context
    # (reader); we need the profile bound to THIS session for
    # flush() + refresh() to work.
    profile = await session.get(MasterProfile, user.id)
    if not profile:
        raise BadRequestError("Master profile not found")

    payout_data = {
        "method": body.method,
        "details": body.details,
    }

    # P-03: deepcopy + set_jsonb for safe JSONB mutation.
    data = copy.deepcopy(profile.data)
    data["payout"] = payout_data
    profile.set_jsonb("data", data)

    await session.flush()
    await session.refresh(profile)

    logger.info(
        "payout_details_updated",
        user_id=str(profile.user_id),
        method=body.method,
    )

    return PayoutDetails(**payout_data)


# ===================================================================
# M3 (batch M): DELETE /me/payout -- clear the configured payout
# ===================================================================


@router.delete(
    "/me/payout",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_payout_details(
    master_tuple: tuple[User, MasterProfile] = Depends(
        get_current_master,
    ),
    session: AsyncSession = Depends(get_db_session),
) -> None:
    """Clear the master's configured payout details (remove data["payout"]).

    Mirrors update_payout_details' JSONB persist pattern (deepcopy + set_jsonb).
    Idempotent: a no-op when no payout is configured. Afterwards the profile's
    ``payout`` field projects as None (F7). Past withdrawals keep their own
    snapshotted payout_details, so clearing here does not touch history.
    """
    user, _profile = master_tuple

    # Re-load the profile in THIS writer session (mirrors update_payout_details).
    profile = await session.get(MasterProfile, user.id)
    if not profile:
        raise BadRequestError("Master profile not found")

    # P-03: deepcopy + set_jsonb for safe JSONB mutation.
    data = copy.deepcopy(profile.data)
    data.pop("payout", None)
    profile.set_jsonb("data", data)

    await session.flush()

    logger.info("payout_details_deleted", user_id=str(user.id))


# ===================================================================
# E16: PATCH /me/languages -- freely edit the master's language set
# ===================================================================


@router.patch(
    "/me/languages",
    response_model=MasterProfileResponse,
)
async def update_languages(
    body: MasterLanguagesUpdate,
    master_tuple: tuple[User, MasterProfile] = Depends(
        get_current_master,
    ),
    session: AsyncSession = Depends(get_db_session),
) -> MasterProfileResponse:
    """Replace the master's languages (E16, freely editable -- no moderation).

    Unlike methods (admin-approved), languages are a plain profile field:
    the sent flat list replaces data.profile.languages wholesale.
    """
    user, _profile = master_tuple

    # Re-load in the writer session (mirrors update_payout_details).
    profile = await session.get(MasterProfile, user.id)
    if not profile:
        raise BadRequestError("Master profile not found")

    await update_master_languages(profile, body.languages, session)

    await session.flush()
    await session.refresh(profile)

    return _make_profile_response((user, profile))


# ===================================================================
# M3 (E19-FLAT): POST /me/method-change-request -- request method change
# ===================================================================


@router.post(
    "/me/method-change-request",
    response_model=MasterProfileResponse,
    status_code=status.HTTP_201_CREATED,
)
async def submit_method_change(
    body: MethodChangeRequestSubmit,
    master_tuple: tuple[User, MasterProfile] = Depends(
        get_current_master,
    ),
    session: AsyncSession = Depends(get_db_session),
) -> MasterProfileResponse:
    """Submit a method change-request (FLAT branch, M3).

    A verified master proposes a new flat method set. It is stored pending
    under data.profile.method_change_request until an admin approves/rejects;
    the live data.profile.methods is NOT changed here. 409
    method_change_pending if one is already outstanding.

    Returns the refreshed profile so the caller sees the pending request
    projected on method_change_request.
    """
    user, _profile = master_tuple

    # Re-load in the writer session (mirrors update_payout_details): the
    # dependency loaded the profile via the reader, but flush()/refresh()
    # need the object bound to THIS write session.
    profile = await session.get(MasterProfile, user.id)
    if not profile:
        raise BadRequestError("Master profile not found")

    await submit_method_change_request(
        profile, body.proposed_methods, session
    )

    await session.flush()
    await session.refresh(profile)

    return _make_profile_response((user, profile))


# ===================================================================
# Phase 4.2: GET /me/practices -- my practices
# ===================================================================


# R-04 fix: PaginatedPracticesResponse (with total count),
# consistent with list_public_practices().
@router.get(
    "/me/practices",
    response_model=PaginatedPracticesResponse,
)
async def list_my_practices(
    master_tuple: tuple[User, MasterProfile] = Depends(
        get_current_master,
    ),
    session: AsyncSession = Depends(get_db_reader),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    status_filter: Literal[
        "draft", "scheduled", "live", "completed", "cancelled",
    ] | None = Query(default=None, alias="status"),
    bucket: Literal["upcoming", "past"] | None = Query(default=None),
) -> PaginatedPracticesResponse:
    """List practices owned by the current master.

    E3a: optional ?status= exact-match filter (never "deleted" -- that
    status is already excluded unconditionally). Omitted (and no `bucket`)
    -> unfiltered, futures-first, same as before this param existed.

    ?bucket= (T22-3/T22-5, ПРОМТ №561): "upcoming" (draft/scheduled/live,
    nearest first) or "past" (completed, most-recent first) -- the two
    master-list tabs, each with correct server-side ordering instead of one
    shared futures-first page split client-side. Takes priority over
    `status` when both are given (see list_master_practices docstring).
    """
    user, _profile = master_tuple
    return await list_master_practices(
        user, session, limit=limit, offset=offset, status=status_filter, bucket=bucket,
    )


# ===================================================================
# S-4 (Calendar iteration): GET /{user_id} -- public master profile
# ===================================================================
#
# IMPORTANT: this dynamic route is declared LAST, after every /me* route,
# so that the literal /me paths are matched first. FastAPI resolves routes
# in declaration order; a /{user_id} placed earlier would capture "me" as
# a (non-UUID) user_id and break GET /me.
@router.get(
    "/{user_id}",
    response_model=MasterPublicResponse,
)
async def get_public_master(
    user_id: UUID,
    _user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_reader),
) -> MasterPublicResponse:
    """Return a verified master's public profile.

    Any authenticated user may view. Only verified masters are exposed;
    pending / rejected / non-master ids resolve to 404. Includes live
    practices_count and reviews_count aggregates. Carries no financial
    or contact data (see MasterPublicResponse).
    """
    return await get_public_master_profile(user_id, session)
