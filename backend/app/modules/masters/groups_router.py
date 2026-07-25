# =============================================================================
# VELO Backend -- Master Groups Router (P1, ПРОМТ №590)
# =============================================================================
#
# Master-facing group CRUD + membership. Mounted as a SEPARATE router (like
# students_router.py) under the same /api/v1/masters prefix -- the {id}
# path segment here is a group id (uuid OR the "students"/"deleted"
# system slugs), never confused with students_router.py's {student_id}
# because the path shapes differ (/me/groups/... vs /me/students/...).
#
# AUTH: get_current_master on all endpoints (verified master only).
# SESSION: get_db_reader for the two GETs (read-only), get_db_session for
# every mutation (P-01 -- router flushes, service never commits).
# =============================================================================

from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db_reader, get_db_session
from app.modules.auth.dependencies import get_current_master, get_current_user
from app.modules.masters.groups_schemas import (
    AddGroupMemberRequest,
    CreateGroupRequest,
    GroupInviteResponse,
    GroupListItem,
    GroupListResponse,
    GroupMemberItem,
    GroupResponse,
    JoinGroupRequest,
    JoinGroupResponse,
    PaginatedGroupMembersResponse,
    RenameGroupRequest,
)
from app.modules.masters.groups_service import (
    add_group_member,
    count_group_members,
    create_group,
    delete_group,
    get_or_create_group_invite,
    join_group_by_token,
    list_group_members,
    list_master_groups,
    remove_group_member,
    rename_group,
)
from app.modules.masters.models import MasterProfile
from app.modules.users.models import User

logger = structlog.get_logger()

router = APIRouter(prefix="/api/v1/masters", tags=["master-groups"])


@router.get("/me/groups", response_model=GroupListResponse)
async def list_groups_endpoint(
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_reader),
) -> GroupListResponse:
    """«Ученики» first, then custom groups by created_at, then «Удалённые»
    (omitted entirely when empty)."""
    user, _profile = master_tuple
    items = await list_master_groups(user.id, session)
    return GroupListResponse(items=[GroupListItem(**item) for item in items])


@router.post("/me/groups", response_model=GroupResponse, status_code=201)
async def create_group_endpoint(
    body: CreateGroupRequest,
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_session),
) -> GroupResponse:
    """Create a custom group. 409 on a duplicate name for this master."""
    user, _profile = master_tuple
    group = await create_group(user.id, body.name, session)
    await session.flush()
    await session.refresh(group)
    return GroupResponse(id=group.id, name=group.name, members_count=0)


@router.patch("/me/groups/{group_id}", response_model=GroupResponse)
async def rename_group_endpoint(
    group_id: str,
    body: RenameGroupRequest,
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_session),
) -> GroupResponse:
    """Rename a custom group. 400 if group_id is a system slug, 409 on a
    duplicate name, 404 if the group doesn't exist / isn't this master's."""
    user, _profile = master_tuple
    group = await rename_group(user.id, group_id, body.name, session)
    await session.flush()
    count = await count_group_members(group.id, session)
    return GroupResponse(id=group.id, name=group.name, members_count=count)


@router.delete("/me/groups/{group_id}", status_code=204)
async def delete_group_endpoint(
    group_id: str,
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_session),
) -> None:
    """Delete a custom group (memberships cascade). 400 on a system slug,
    404 if the group doesn't exist / isn't this master's."""
    user, _profile = master_tuple
    await delete_group(user.id, group_id, session)
    await session.flush()


@router.get(
    "/me/groups/{group_id}/members", response_model=PaginatedGroupMembersResponse,
)
async def list_group_members_endpoint(
    group_id: str,
    search: str | None = Query(default=None, min_length=1, max_length=100),
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_reader),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> PaginatedGroupMembersResponse:
    """Members of "students" (derived) / "deleted" (blocked) / a custom
    group (membership rows) -- same paginated + searchable shape either
    way. Each item carries the student's tag against this master."""
    user, _profile = master_tuple
    items, total = await list_group_members(
        user.id, group_id, session, search=search, limit=limit, offset=offset,
    )
    return PaginatedGroupMembersResponse(
        items=[GroupMemberItem(**item) for item in items],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.post("/me/groups/{group_id}/members", status_code=204)
async def add_group_member_endpoint(
    group_id: str,
    body: AddGroupMemberRequest,
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_session),
) -> None:
    """ADD to a CUSTOM group (add-access, not move). 400 on a system slug,
    404 if the group or the student doesn't exist. Idempotent-safe."""
    user, _profile = master_tuple
    await add_group_member(user.id, group_id, body.student_user_id, session)
    await session.flush()


@router.delete("/me/groups/{group_id}/members/{student_user_id}", status_code=204)
async def remove_group_member_endpoint(
    group_id: str,
    student_user_id: UUID,
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_session),
) -> None:
    """Remove from a CUSTOM group. 400 on a system slug -- removing from
    "Ученики" is BLOCK, "Удалённые" is UNBLOCK (separate endpoints)."""
    user, _profile = master_tuple
    await remove_group_member(user.id, group_id, student_user_id, session)
    await session.flush()


# ===========================================================================
# P4 addenda (ПРОМТ №593): group invite links
# ===========================================================================


@router.post("/me/groups/{group_id}/invite", response_model=GroupInviteResponse)
async def create_group_invite_endpoint(
    group_id: str,
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_session),
) -> GroupInviteResponse:
    """Create-or-return the group's reusable invite link. 400 on a system
    slug, 404 if the group doesn't exist / isn't this master's. Idempotent
    -- repeat calls return the SAME url."""
    user, _profile = master_tuple
    invite_url = await get_or_create_group_invite(user.id, group_id, session)
    await session.flush()
    return GroupInviteResponse(invite_url=invite_url)


@router.post("/groups/join", response_model=JoinGroupResponse)
async def join_group_endpoint(
    body: JoinGroupRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> JoinGroupResponse:
    """Resolve a group-invite token and add the CALLER to that group.

    Not master-scoped (get_current_user, not get_current_master) -- the
    joiner is whoever opened the deeplink. 403 if the caller is currently
    blocked by that group's master; 404 on an unknown/invalid token.
    """
    result = await join_group_by_token(user.id, body.token, session)
    await session.flush()
    return JoinGroupResponse(**result)
