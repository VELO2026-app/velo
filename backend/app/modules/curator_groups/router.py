# =============================================================================
# VELO Backend -- Curator Groups Router (P1, tz-curator-groups.md 5.2)
# =============================================================================
#
# ENDPOINTS (curator-facing; the member-facing /api/v1/curator-groups router
# is GT-2 and will be a SECOND APIRouter object in this same file, included
# by its own line in main.py -- the shape practices_router /
# practices_public_router already uses):
#
#   GET    /api/v1/masters/me/curator-groups
#   POST   /api/v1/masters/me/curator-groups
#   PATCH  /api/v1/masters/me/curator-groups/{group_id}
#   DELETE /api/v1/masters/me/curator-groups/{group_id}
#   GET    /api/v1/masters/me/curator-groups/{group_id}/members
#   DELETE /api/v1/masters/me/curator-groups/{group_id}/members/{user_id}
#
# AUTH: get_current_master everywhere. That single dependency covers three
# of this feature's states at once -- no master profile, an unverified one,
# and a plain user -- so none of them needs code here (TZ 3.4).
#
# SESSION: get_db_reader on GET, get_db_session on mutations. The service
# never commits (P-01); these handlers flush.
#
# {group_id} and {user_id} are declared as UUID, not str: unlike
# masters/groups_router.py there are no system slugs to admit, so a
# malformed id is a 422 from FastAPI and never reaches a hand-written
# try/except UUID(...) branch.
# =============================================================================

from typing import Literal
from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db_reader, get_db_session
from app.modules.auth.dependencies import (
    get_current_master,
    get_current_user,
    get_current_user_write,
)
from app.modules.curator_groups.schemas import (
    CreateCuratorGroupInviteRequest,
    CreateCuratorGroupRequest,
    CuratorGroupInvitePreviewResponse,
    CuratorGroupInviteResponse,
    CuratorGroupListResponse,
    CuratorGroupMasterItem,
    CuratorGroupMemberItem,
    CuratorGroupMineItem,
    CuratorGroupMineResponse,
    CuratorGroupPageResponse,
    CuratorGroupResponse,
    CuratorMemberKindLiteral,
    JoinCuratorGroupRequest,
    JoinCuratorGroupResponse,
    PaginatedCuratorGroupMastersResponse,
    PaginatedCuratorGroupMembersResponse,
    UpdateCuratorGroupRequest,
)
from app.modules.curator_groups.service import (
    create_curator_group,
    delete_curator_group,
    get_curator_group_page,
    get_group_counts,
    get_or_create_curator_group_invite,
    join_curator_group_by_token,
    leave_curator_group,
    list_curator_group_members,
    list_curator_groups,
    list_group_masters,
    list_group_practice_master_ids,
    list_my_curator_groups,
    preview_curator_group_invite,
    remove_curator_group_member,
    revoke_curator_group_invite,
    update_curator_group,
)
from app.modules.masters.models import MasterProfile
from app.modules.practices.listing_service import list_public_practices
from app.modules.practices.schemas import PaginatedPracticesResponse
from app.modules.users.models import User

logger = structlog.get_logger()

router = APIRouter(prefix="/api/v1/masters", tags=["curator-groups"])


@router.get("/me/curator-groups", response_model=CuratorGroupListResponse)
async def list_curator_groups_endpoint(
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_reader),
) -> CuratorGroupListResponse:
    """Groups I curate, newest first. Empty list when I curate none."""
    user, _profile = master_tuple
    items = await list_curator_groups(user.id, session)
    return CuratorGroupListResponse(
        items=[CuratorGroupResponse(**item) for item in items],
    )


@router.post(
    "/me/curator-groups",
    response_model=CuratorGroupResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_curator_group_endpoint(
    body: CreateCuratorGroupRequest,
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_session),
) -> CuratorGroupResponse:
    """Create a group -- this is also how a verified master becomes a curator.

    409 curator_group_name_taken on a name this curator already uses; the
    SAME name under a different curator is fine (I-7). 422 on a blank or
    over-long name, from CuratorGroupNameStr.
    """
    user, _profile = master_tuple
    group = await create_curator_group(
        user.id, body.name, session, description=body.description,
    )
    await session.flush()
    await session.refresh(group)
    logger.info(
        "curator_group_created", group_id=str(group.id), curator_id=str(user.id),
    )
    # A group one statement old has no members; counting would be a query
    # asked to return zeros.
    return CuratorGroupResponse(
        id=group.id,
        name=group.name,
        description=group.description,
        masters_count=0,
        students_count=0,
        created_at=group.created_at,
    )


@router.patch(
    "/me/curator-groups/{group_id}", response_model=CuratorGroupResponse,
)
async def update_curator_group_endpoint(
    group_id: UUID,
    body: UpdateCuratorGroupRequest,
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_session),
) -> CuratorGroupResponse:
    """Rename and/or edit description. 404 if it is not my group or gone.

    `description` is partial: exclude_unset below is what distinguishes an
    absent key (leave the column) from an explicit null/empty one (write
    NULL).
    """
    user, _profile = master_tuple
    update_data = body.model_dump(exclude_unset=True)
    group = await update_curator_group(
        user.id,
        group_id,
        body.name,
        session,
        description=body.description,
        description_provided="description" in update_data,
    )
    await session.flush()
    masters_count, students_count = await get_group_counts(group.id, session)
    return CuratorGroupResponse(
        id=group.id,
        name=group.name,
        description=group.description,
        masters_count=masters_count,
        students_count=students_count,
        created_at=group.created_at,
    )


@router.delete(
    "/me/curator-groups/{group_id}", status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_curator_group_endpoint(
    group_id: UUID,
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_session),
) -> None:
    """Delete my group; memberships, invites and any transfer cascade.

    Never 409 (I-11). A second delete is a 404 -- the group is gone, and
    "gone" is indistinguishable from "never yours" by design (P-08).
    """
    user, _profile = master_tuple
    await delete_curator_group(user.id, group_id, session)
    await session.flush()
    logger.info(
        "curator_group_deleted", group_id=str(group_id), curator_id=str(user.id),
    )


@router.get(
    "/me/curator-groups/{group_id}/members",
    response_model=PaginatedCuratorGroupMembersResponse,
)
async def list_curator_group_members_endpoint(
    group_id: UUID,
    kind: Literal["master", "student"] | None = Query(default=None),
    search: str | None = Query(default=None, min_length=1, max_length=100),
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_reader),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> PaginatedCuratorGroupMembersResponse:
    """Roster of my group: masters and students, newest membership first.

    P-11: `kind` is a Literal, so an unknown value is a 422 from FastAPI
    rather than a hand-rolled Enum(value) lookup raising ValueError -> 500.

    A suspended master appears with is_visible=false (I-4).
    """
    user, _profile = master_tuple
    items, total = await list_curator_group_members(
        user.id,
        group_id,
        session,
        kind=kind,
        search=search,
        limit=limit,
        offset=offset,
    )
    return PaginatedCuratorGroupMembersResponse(
        items=[CuratorGroupMemberItem(**item) for item in items],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.delete(
    "/me/curator-groups/{group_id}/members/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def remove_curator_group_member_endpoint(
    group_id: UUID,
    user_id: UUID,
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_session),
) -> None:
    """Remove a member of either kind. Idempotent: a miss is still 204.

    404 only for a group that is not mine (or does not exist) -- never for
    the user, whose membership is exactly what the caller is asserting away.
    """
    user, _profile = master_tuple
    await remove_curator_group_member(user.id, group_id, user_id, session)
    await session.flush()


@router.post(
    "/me/curator-groups/{group_id}/invites",
    response_model=CuratorGroupInviteResponse,
)
async def create_curator_group_invite_endpoint(
    group_id: UUID,
    body: CreateCuratorGroupInviteRequest,
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_session),
) -> CuratorGroupInviteResponse:
    """Get (or mint) this group's reusable link for one kind.

    Repeat calls return the SAME url -- the curator expects the link they
    already shared to keep working. Rotation is revoke + create, on purpose.

    503 bot_url_not_configured when telegram_bot_url is unset: a link with
    an empty prefix would look valid and resolve nowhere.
    """
    user, _profile = master_tuple
    invite = await get_or_create_curator_group_invite(
        user.id, group_id, body.kind, session,
    )
    await session.flush()
    logger.info(
        "curator_group_invite_issued",
        group_id=str(group_id),
        kind=body.kind,
        curator_id=str(user.id),
    )
    return CuratorGroupInviteResponse(**invite)


@router.delete(
    "/me/curator-groups/{group_id}/invites/{kind}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def revoke_curator_group_invite_endpoint(
    group_id: UUID,
    kind: CuratorMemberKindLiteral,
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_session),
) -> None:
    """Revoke one kind of link. The other kind keeps working.

    Idempotent. Afterwards the old token resolves nowhere -- preview and
    join both read the same row, so there is no revocation list to keep.

    P-11: `kind` is a Literal in the path, so an unknown value is a 422 from
    FastAPI rather than a hand-rolled Enum() lookup raising into a 500.
    """
    user, _profile = master_tuple
    await revoke_curator_group_invite(user.id, group_id, kind, session)
    await session.flush()
    logger.info(
        "curator_group_invite_revoked",
        group_id=str(group_id),
        kind=kind,
        curator_id=str(user.id),
    )


# =============================================================================
# MEMBER-FACING ROUTER (GT-2, tz-curator-groups.md 5.2 "Участник")
# =============================================================================
#
#   GET    /api/v1/curator-groups/mine
#   GET    /api/v1/curator-groups/{group_id}
#   GET    /api/v1/curator-groups/{group_id}/masters
#   GET    /api/v1/curator-groups/{group_id}/practices
#   DELETE /api/v1/curator-groups/{group_id}/membership
#
# A SECOND APIRouter in this same file, as this module's header promised in
# GT-1 -- included by its own line in main.py, the shape practices_router /
# practices_public_router already uses. One file, because the two routers
# share a service layer and splitting them would only mean two imports of
# the same functions.
#
# AUTH: get_current_user, not get_current_master -- a student member is not
# a master and must still read the page. Authorization is the RELATION to
# the group, resolved in the service; there is no role check here at all.
#
# /mine is declared BEFORE /{group_id}: a static path must win over a
# dynamic sibling, or "mine" would be parsed as a group id and answer 422.
# =============================================================================

member_router = APIRouter(prefix="/api/v1/curator-groups", tags=["curator-groups"])


@member_router.get("/mine", response_model=CuratorGroupMineResponse)
async def list_my_curator_groups_endpoint(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_reader),
) -> CuratorGroupMineResponse:
    """Groups I belong to -- curated first, then by when I joined.

    Only ACTIVE groups (I-6): one whose curator is currently suspended
    disappears from this list and comes back on re-verification, with no row
    written either way.
    """
    items = await list_my_curator_groups(user.id, session)
    return CuratorGroupMineResponse(
        items=[CuratorGroupMineItem(**item) for item in items],
    )


@member_router.get(
    "/invites/{token}", response_model=CuratorGroupInvitePreviewResponse,
)
async def preview_curator_group_invite_endpoint(
    token: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_reader),
) -> CuratorGroupInvitePreviewResponse:
    """The card behind an invite link, and why joining is refused, if it is.

    DECLARED BEFORE /{group_id} ON PURPOSE: FastAPI matches routes in
    declaration order, so the dynamic sibling below would swallow "invites"
    and answer 422 for a path that is not a UUID.

    Refusals are described here, not raised -- except 404, which stays
    indistinguishable across unknown token, revoked token, inactive group
    and deleted group.
    """
    preview = await preview_curator_group_invite(token, user.id, session)
    return CuratorGroupInvitePreviewResponse(**preview)


@member_router.post("/join", response_model=JoinCuratorGroupResponse)
async def join_curator_group_endpoint(
    body: JoinCuratorGroupRequest,
    user: User = Depends(get_current_user_write),
    session: AsyncSession = Depends(get_db_session),
) -> JoinCuratorGroupResponse:
    """Join by token. Revalidates everything the preview showed.

    The preview is a hint and this is the gate: between the two the curator
    can be revoked, the link revoked and the joiner blocked, so nothing is
    taken on trust from the earlier call.

    404 invite_not_found | 409 own_group | 403 blocked_by_curator |
    403 master_required.
    """
    result = await join_curator_group_by_token(body.token, user.id, session)
    await session.flush()
    logger.info(
        "curator_group_joined",
        group_id=str(result["group_id"]),
        relation=result["relation"],
        already_member=result["already_member"],
        user_id=str(user.id),
    )
    return JoinCuratorGroupResponse(**result)


@member_router.get("/{group_id}", response_model=CuratorGroupPageResponse)
async def get_curator_group_page_endpoint(
    group_id: UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_reader),
) -> CuratorGroupPageResponse:
    """One group's page. 404 unless I have a relation to it and it is active.

    A group that does not exist, one whose curator is suspended, and one I
    simply do not belong to all answer identically (P-08).
    """
    page = await get_curator_group_page(group_id, user.id, session)
    return CuratorGroupPageResponse(**page)


@member_router.get(
    "/{group_id}/masters",
    response_model=PaginatedCuratorGroupMastersResponse,
)
async def list_group_masters_endpoint(
    group_id: UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_reader),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> PaginatedCuratorGroupMastersResponse:
    """The school's masters: the curator first, then visible members (I-4).

    Fields are a strict subset of MasterPublicResponse -- the isolation
    boundary is reused rather than restated.
    """
    items, total = await list_group_masters(
        group_id, user.id, session, limit=limit, offset=offset,
    )
    return PaginatedCuratorGroupMastersResponse(
        items=[CuratorGroupMasterItem(**item) for item in items],
        total=total,
        limit=limit,
        offset=offset,
    )


@member_router.get(
    "/{group_id}/practices", response_model=PaginatedPracticesResponse,
)
async def list_group_practices_endpoint(
    group_id: UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_reader),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> PaginatedPracticesResponse:
    """Upcoming practices by the school's masters.

    This is the PUBLIC FEED narrowed to a set of masters, not a new query:
    the status/time gate, the audience clause with its owner-bypass, the
    block clause and the per-user is_booked/is_paid flags all come from
    list_public_practices unchanged. A master who blocked this viewer
    contributes no practices even though they still appear in the roster
    above -- blocking hides practices, not people.
    """
    master_ids = await list_group_practice_master_ids(group_id, user.id, session)
    return await list_public_practices(
        session, user=user, limit=limit, offset=offset, master_ids=master_ids,
    )


@member_router.delete(
    "/{group_id}/membership", status_code=status.HTTP_204_NO_CONTENT,
)
async def leave_curator_group_endpoint(
    group_id: UUID,
    user: User = Depends(get_current_user_write),
    session: AsyncSession = Depends(get_db_session),
) -> None:
    """Leave a group. Idempotent; 409 curator_cannot_leave for the owner.

    Deliberately NOT gated on the group being active (I-5): a member of a
    group whose curator is suspended must still be able to walk out, and a
    404 here would trap them until an admin re-verified somebody else.
    """
    await leave_curator_group(group_id, user.id, session)
    await session.flush()
