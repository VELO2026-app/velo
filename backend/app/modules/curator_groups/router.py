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

from app.core.config import settings
from app.core.database import get_db_reader, get_db_session
from app.core.exceptions import NotFoundError
from app.modules.auth.dependencies import (
    get_current_master,
    get_current_user,
    get_current_user_write,
)
from app.modules.curator_groups.schemas import (
    CreateCuratorGroupInviteRequest,
    CreateCuratorGroupRequest,
    CuratorGroupDeletePreviewResponse,
    CuratorGroupEventActor,
    CuratorGroupEventItem,
    CuratorGroupInvitePreviewResponse,
    CuratorGroupInviteResponse,
    CuratorGroupLeavePreviewResponse,
    CuratorGroupListResponse,
    CuratorGroupMasterItem,
    CuratorGroupMemberItem,
    CuratorGroupMineItem,
    CuratorGroupMineResponse,
    CuratorGroupPageResponse,
    CuratorGroupRemovePreviewResponse,
    CuratorGroupResponse,
    CuratorGroupTransferRef,
    CuratorMemberKindLiteral,
    JoinCuratorGroupRequest,
    JoinCuratorGroupResponse,
    OfferCuratorGroupTransferRequest,
    PaginatedCuratorGroupEventsResponse,
    PaginatedCuratorGroupMastersResponse,
    PaginatedCuratorGroupMembersResponse,
    UpdateCuratorGroupRequest,
)
from app.modules.curator_groups.service import (
    accept_curator_group_transfer,
    cancel_curator_group_transfer,
    create_curator_group,
    decline_curator_group_transfer,
    delete_curator_group,
    delete_group_preview,
    get_curator_group_page,
    get_group_counts,
    get_group_transfer_ref,
    get_or_create_curator_group_invite,
    join_curator_group_by_token,
    leave_curator_group,
    leave_preview,
    list_curator_group_events,
    list_curator_group_members,
    list_curator_groups,
    list_group_masters,
    list_group_practice_master_ids,
    list_my_curator_groups,
    master_can_create_groups,
    offer_curator_group_transfer,
    preview_curator_group_invite,
    remove_curator_group_member,
    remove_member_preview,
    revoke_curator_group_invite,
    update_curator_group,
)
from app.modules.masters.models import MasterProfile
from app.modules.practices.listing_service import list_public_practices
from app.modules.practices.schemas import PaginatedPracticesResponse
from app.modules.users.models import User

logger = structlog.get_logger()


def _require_curator_groups_enabled() -> None:
    """The schools killswitch, checked ONCE PER ROUTER (GT-19).

    Mounted as a router-level dependency on both routers in this module,
    which is 23 of the feature's 24 operations in two lines. The
    alternative -- the same `if` copied into 23 endpoints -- is 23 places
    to forget one, and a forgotten one does not fail any test that only
    checks the endpoints somebody remembered. The 24th operation, the
    admin list of schools, stays available deliberately; see the flag's
    own comment in core/config.py.

    404, NOT 503, AND NO MACHINE CODE. A 503 announces that the feature
    exists and is broken, which invites retries during the incident the
    flag was pulled for; a dedicated code would become the one reliable
    way to detect that the killswitch is down. To a client, schools simply
    do not exist -- indistinguishable from a build that never had them.

    RUNS BEFORE THE PATH DEPENDENCIES, and that is observable rather than
    assumed: measured with a two-dependency FastAPI app before this was
    written, the router dependency fired and the path dependency was never
    called. The consequence matters for the tests -- with the flag off an
    UNAUTHENTICATED caller gets 404, not 401/403, and so does a plain user
    where get_current_master would otherwise answer 403. Any test
    expecting 403 on these paths while the flag is off is wrong about the
    layer, not about the code.

    Reads settings directly, like the six other boolean toggles in this
    codebase; there is no shared helper, because the audience side
    (practices/audience_service.py) needs a SQL-shaped answer, not a
    dependency, and one abstraction over two different shapes would fit
    neither.
    """
    if not settings.curator_groups_enabled:
        raise NotFoundError("Not found")


router = APIRouter(
    prefix="/api/v1/masters",
    tags=["curator-groups"],
    dependencies=[Depends(_require_curator_groups_enabled)],
)


@router.get("/me/curator-groups", response_model=CuratorGroupListResponse)
async def list_curator_groups_endpoint(
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_reader),
) -> CuratorGroupListResponse:
    """Groups I curate, newest first. Empty list when I curate none.

    GT-15: also answers whether I may found a NEW one. Read off the profile
    get_current_master already loaded -- that dependency and this endpoint
    both take get_db_reader, so it is the same session and the same object,
    and the answer costs no query at all. This is the one place a curator
    endpoint reads the flag; the gate itself is in the service, and the
    other nine endpoints do not consult it (see create_curator_group).
    """
    user, profile = master_tuple
    items = await list_curator_groups(user.id, session)
    return CuratorGroupListResponse(
        items=[CuratorGroupResponse(**item) for item in items],
        can_create_groups=master_can_create_groups(profile.data),
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
        actor=user,
    )
    await session.flush()
    await session.refresh(group)
    logger.info(
        "curator_group_created", group_id=str(group.id), curator_id=str(user.id),
    )
    # A group one statement old has no members and cannot have a pending
    # transfer; counting or looking either up would be queries asked to
    # return nothing. It has no picture either -- creation does not take
    # one (GT-17) -- and that is stated rather than left to the default,
    # like the two counters above.
    return CuratorGroupResponse(
        id=group.id,
        name=group.name,
        description=group.description,
        avatar_url=None,
        masters_count=0,
        students_count=0,
        transfer=None,
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
    """Rename, edit description, set or clear the avatar. 404 if not mine.

    `description` and `avatar_url` are partial: exclude_unset below is what
    distinguishes an absent key (leave the column) from an explicit
    null/empty one (write NULL).

    `name` IS STILL REQUIRED -- a school always has one -- so every avatar
    change also carries a name, and the client is expected to send the
    current one. Sending a stale one renames the school back and now says
    so in the journal; see the delivery report's observations.

    str(body.avatar_url) HERE, NOT IN THE SERVICE: the schema hands over a
    Pydantic AnyUrl (normalised -- punycode host, percent-encoded path)
    and the column takes text. Converting at the boundary keeps the
    service's parameter a plain `str | None`, so nothing downstream has to
    know a url type exists.
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
        avatar_url=(
            str(body.avatar_url) if body.avatar_url is not None else None
        ),
        avatar_url_provided="avatar_url" in update_data,
        actor=user,
    )
    await session.flush()
    masters_count, students_count = await get_group_counts(group.id, session)
    # A rename does not touch a pending offer, but the reply carries it:
    # this endpoint returns CuratorGroupResponse, and that schema has one
    # field set for everyone who receives it (see its docstring).
    return CuratorGroupResponse(
        id=group.id,
        name=group.name,
        description=group.description,
        avatar_url=group.avatar_url,
        masters_count=masters_count,
        students_count=students_count,
        transfer=await get_group_transfer_ref(group.id, session),
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


@router.get(
    "/me/curator-groups/{group_id}/journal",
    response_model=PaginatedCuratorGroupEventsResponse,
)
async def list_curator_group_events_endpoint(
    group_id: UUID,
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_reader),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> PaginatedCuratorGroupEventsResponse:
    """What has happened in my school, newest first (GT-16).

    THE CURATOR ONLY -- a master member or a student asking gets 404, from
    the ownership check in the service, not 403: the journal reports who
    was removed and who walked out, and 403 would confirm to a stranger
    that the school exists.

    Built with NAMED arguments rather than Schema(**item), unlike most of
    this router: the item carries a nested actor object, and **-splatting a
    dict past a nested model is exactly the call shape a static check
    cannot see into.
    """
    user, _profile = master_tuple
    items, total = await list_curator_group_events(
        user.id, group_id, session, limit=limit, offset=offset,
    )
    return PaginatedCuratorGroupEventsResponse(
        items=[
            CuratorGroupEventItem(
                id=item["id"],
                event=item["event"],
                actor=CuratorGroupEventActor(
                    user_id=item["actor"]["user_id"],
                    display_name=item["actor"]["display_name"],
                ),
                data=item["data"],
                created_at=item["created_at"],
            )
            for item in items
        ],
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
    await remove_curator_group_member(
        user.id, group_id, user_id, session, actor=user,
    )
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
        user.id, group_id, body.kind, session, actor=user,
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
    await revoke_curator_group_invite(
        user.id, group_id, kind, session, actor=user,
    )
    await session.flush()
    logger.info(
        "curator_group_invite_revoked",
        group_id=str(group_id),
        kind=kind,
        curator_id=str(user.id),
    )


@router.post(
    "/me/curator-groups/{group_id}/transfer",
    response_model=CuratorGroupTransferRef,
)
async def offer_curator_group_transfer_endpoint(
    group_id: UUID,
    body: OfferCuratorGroupTransferRequest,
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_session),
) -> CuratorGroupTransferRef:
    """Offer the group to one of its visible master members (I-10).

    409 transfer_pending when an offer is already open -- a second offer
    never silently replaces the first. 404 transfer_target_not_member for a
    student, a stranger, a suspended master or the curator themselves,
    indistinguishably.
    """
    user, _profile = master_tuple
    ref = await offer_curator_group_transfer(
        user.id, group_id, body.to_user_id, session, actor=user,
    )
    await session.flush()
    logger.info(
        "curator_group_transfer_offered",
        group_id=str(group_id),
        to_user_id=str(body.to_user_id),
        curator_id=str(user.id),
    )
    return CuratorGroupTransferRef(**ref)


@router.delete(
    "/me/curator-groups/{group_id}/transfer",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def cancel_curator_group_transfer_endpoint(
    group_id: UUID,
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_session),
) -> None:
    """Withdraw the pending offer. Idempotent: no offer is still 204."""
    user, _profile = master_tuple
    await cancel_curator_group_transfer(
        user.id, group_id, session, actor=user,
    )
    await session.flush()
    logger.info(
        "curator_group_transfer_cancelled",
        group_id=str(group_id),
        curator_id=str(user.id),
    )


@router.get(
    "/me/curator-groups/{group_id}/members/{user_id}/remove-preview",
    response_model=CuratorGroupRemovePreviewResponse,
)
async def remove_member_preview_endpoint(
    group_id: UUID,
    user_id: UUID,
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_reader),
) -> CuratorGroupRemovePreviewResponse:
    """How many upcoming practices this member aims at the school.

    ADVISORY: nothing is blocked and nothing is written. Removal itself is
    unchanged and still idempotent, so this answers 0 rather than 404 for a
    target who is not in the group.
    """
    user, _profile = master_tuple
    preview = await remove_member_preview(user.id, group_id, user_id, session)
    return CuratorGroupRemovePreviewResponse(**preview)


@router.get(
    "/me/curator-groups/{group_id}/delete-preview",
    response_model=CuratorGroupDeletePreviewResponse,
)
async def delete_group_preview_endpoint(
    group_id: UUID,
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_reader),
) -> CuratorGroupDeletePreviewResponse:
    """What deleting this school costs -- members and upcoming practices.

    ADVISORY: deletion is still never blocked (I-11).
    """
    user, _profile = master_tuple
    preview = await delete_group_preview(user.id, group_id, session)
    return CuratorGroupDeletePreviewResponse(**preview)



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

member_router = APIRouter(
    prefix="/api/v1/curator-groups",
    tags=["curator-groups"],
    dependencies=[Depends(_require_curator_groups_enabled)],
)


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
    result = await join_curator_group_by_token(
        body.token, user.id, session, actor=user,
    )
    await session.flush()
    logger.info(
        "curator_group_joined",
        group_id=str(result["group_id"]),
        relation=result["relation"],
        already_member=result["already_member"],
        user_id=str(user.id),
    )
    return JoinCuratorGroupResponse(**result)


@member_router.post(
    "/{group_id}/transfer/accept", response_model=CuratorGroupPageResponse,
)
async def accept_curator_group_transfer_endpoint(
    group_id: UUID,
    user: User = Depends(get_current_user_write),
    session: AsyncSession = Depends(get_db_session),
) -> CuratorGroupPageResponse:
    """Take over the group. One transaction, checks before mutations.

    404 transfer_not_found covers "no offer", "not addressed to you" and
    "group inactive" alike -- accept changes who owns a school, so it must
    not confirm that an offer exists to somebody guessing at group ids.
    403 master_required if the caller is no longer verified; 409
    curator_group_name_taken if they already curate a group by this name,
    checked BEFORE anything is written.
    """
    page = await accept_curator_group_transfer(
        group_id, user.id, session, actor=user,
    )
    await session.flush()
    logger.info(
        "curator_group_transfer_accepted",
        group_id=str(group_id),
        new_curator_id=str(user.id),
    )
    return CuratorGroupPageResponse(**page)


@member_router.post(
    "/{group_id}/transfer/decline", status_code=status.HTTP_204_NO_CONTENT,
)
async def decline_curator_group_transfer_endpoint(
    group_id: UUID,
    user: User = Depends(get_current_user_write),
    session: AsyncSession = Depends(get_db_session),
) -> None:
    """Refuse the offer. Idempotent, and 204 even if it was not yours.

    Where accept answers 404 to a non-addressee, decline answers 204: it
    changes nothing, so reporting success is honest and says nothing about
    whether an offer existed.
    """
    await decline_curator_group_transfer(
        group_id, user.id, session, actor=user,
    )
    await session.flush()


@member_router.get(
    "/{group_id}/leave-preview",
    response_model=CuratorGroupLeavePreviewResponse,
)
async def leave_preview_endpoint(
    group_id: UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_reader),
) -> CuratorGroupLeavePreviewResponse:
    """How many of MY upcoming practices target this school.

    ADVISORY: leaving is unchanged and still unconditional (I-5). Declared
    with a static suffix under the dynamic {group_id}, so unlike /mine and
    /invites/{token} it needs no special ordering -- but it is kept next to
    the page route it belongs to rather than at the end of the file.

    The curator gets a number too: they cannot leave, and that is exactly
    why the price of leaving is what they weigh a transfer against.
    """
    preview = await leave_preview(group_id, user.id, session)
    return CuratorGroupLeavePreviewResponse(**preview)


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
    await leave_curator_group(group_id, user.id, session, actor=user)
    await session.flush()
