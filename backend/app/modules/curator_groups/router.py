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
from app.modules.auth.dependencies import get_current_master
from app.modules.curator_groups.schemas import (
    CreateCuratorGroupRequest,
    CuratorGroupListResponse,
    CuratorGroupMemberItem,
    CuratorGroupResponse,
    PaginatedCuratorGroupMembersResponse,
    UpdateCuratorGroupRequest,
)
from app.modules.curator_groups.service import (
    create_curator_group,
    delete_curator_group,
    get_group_counts,
    list_curator_group_members,
    list_curator_groups,
    remove_curator_group_member,
    update_curator_group,
)
from app.modules.masters.models import MasterProfile
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
