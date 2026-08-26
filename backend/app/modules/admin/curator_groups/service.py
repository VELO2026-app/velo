# =============================================================================
# VELO Backend -- Admin Curator Groups Service (P4, GT-9)
# =============================================================================
#
# Read-only oversight of every school on the platform. There is no create,
# no edit and no delete here by decision (TZ 1, Q-ADMINDEL): a school belongs
# to its curator, and an admin who could rename or dissolve one would be a
# second owner nobody agreed to.
#
# ON THE DUPLICATED PREDICATE. _verified_profile_exists in
# app/modules/curator_groups/service.py answers exactly the question
# _profile_verified below answers, and this module deliberately does NOT
# import it: the underscore is not decoration, and reaching across a module
# boundary for a private helper would tie the admin panel to the internals
# of curator_groups for good. The twin is named here so the next reader
# finds both and knows the copy is a decision rather than an oversight.
#
# Inside THIS file the predicate is written once and applied twice -- to the
# curator for is_active and to the members for masters_count. A copy across
# the boundary is a considered trade; a copy in the same file would just be
# sloppiness.
# =============================================================================

from uuid import UUID

from sqlalchemy import Select, case, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from app.modules.admin.curator_groups.schemas import (
    AdminCuratorGroupCuratorRef,
    AdminCuratorGroupListItem,
    PaginatedAdminCuratorGroupsResponse,
)
from app.modules.curator_groups.models import CuratorGroup, CuratorGroupMember
from app.modules.masters.models import MasterProfile
from app.modules.users.helpers import display_name
from app.modules.users.models import User

_MEMBER_KIND_MASTER = "master"
_MEMBER_KIND_STUDENT = "student"


def _profile_verified(user_id_col: ColumnElement) -> ColumnElement[bool]:
    """Correlated EXISTS: this user has a verified MasterProfile right now.

    Projects user_id rather than id -- MasterProfile has no surrogate key,
    its PRIMARY KEY *is* user_id (masters/models.py), and reaching for
    MasterProfile.id raises AttributeError while the query is being built,
    i.e. inside the request.

    Twin: curator_groups/service.py::_verified_profile_exists. Same question,
    same JSONB path, deliberately not shared -- see this module's header.
    """
    return (
        select(MasterProfile.user_id)
        .where(
            MasterProfile.user_id == user_id_col,
            MasterProfile.data["account"]["status"].as_string() == "verified",
        )
        .exists()
    )


async def _member_counts(
    group_ids: list[UUID], session: AsyncSession,
) -> dict[UUID, tuple[int, int]]:
    """(masters_count, students_count) for a page of groups in ONE query.

    One statement for the whole page rather than one per group -- the shape
    _practices_counts_for_masters uses next door, and the lesson the curator
    line has now paid for twice.

    masters_count applies the visibility rule (I-4): a member whose master
    profile lapsed stops being counted while their row stays put, which is
    what the group's own page reports too.
    """
    if not group_ids:
        return {}

    visible_master = (
        CuratorGroupMember.kind == _MEMBER_KIND_MASTER
    ) & _profile_verified(CuratorGroupMember.user_id)

    rows = (
        await session.execute(
            select(
                CuratorGroupMember.group_id,
                func.coalesce(
                    func.sum(case((visible_master, 1), else_=0)), 0
                ),
                func.coalesce(
                    func.sum(
                        case(
                            (
                                CuratorGroupMember.kind
                                == _MEMBER_KIND_STUDENT,
                                1,
                            ),
                            else_=0,
                        )
                    ),
                    0,
                ),
            )
            .where(CuratorGroupMember.group_id.in_(group_ids))
            .group_by(CuratorGroupMember.group_id)
        )
    ).all()

    return {gid: (int(masters), int(students)) for gid, masters, students in rows}


def _base_query() -> Select:
    """Groups joined to their curators, newest first.

    created_at DESC matches every other admin listing that has a natural
    time order (masters, participants, promos, reports, users) -- read from
    their bodies, not assumed. The id tie-break is not decoration: without
    it two schools created in the same millisecond could swap places between
    two pages of the same listing, and a row would be shown twice or not at
    all.
    """
    return (
        select(CuratorGroup, User)
        .join(User, User.id == CuratorGroup.curator_user_id)
        .order_by(CuratorGroup.created_at.desc(), CuratorGroup.id)
    )


async def list_curator_groups_for_admin(
    session: AsyncSession,
    *,
    limit: int = 20,
    offset: int = 0,
) -> PaginatedAdminCuratorGroupsResponse:
    """Every school, active or frozen, with its counters.

    No status filter and no hidden exclusion: a frozen school is reported
    with is_active=false rather than dropped, because the admin looking at
    this list is the person who has to explain why it went quiet.
    """
    total = (
        await session.execute(
            select(func.count()).select_from(CuratorGroup)
        )
    ).scalar_one()

    rows = (
        await session.execute(_base_query().limit(limit).offset(offset))
    ).all()

    group_ids = [group.id for group, _curator in rows]
    counts = await _member_counts(group_ids, session)

    active_ids = set(
        (
            await session.execute(
                select(CuratorGroup.id).where(
                    CuratorGroup.id.in_(group_ids),
                    _profile_verified(CuratorGroup.curator_user_id),
                )
            )
        )
        .scalars()
        .all()
    )

    items = [
        AdminCuratorGroupListItem(
            id=group.id,
            name=group.name,
            curator=AdminCuratorGroupCuratorRef(
                user_id=curator.id,
                display_name=display_name(
                    curator.first_name, curator.last_name
                ),
            ),
            masters_count=counts.get(group.id, (0, 0))[0],
            students_count=counts.get(group.id, (0, 0))[1],
            is_active=group.id in active_ids,
            created_at=group.created_at,
        )
        for group, curator in rows
    ]

    return PaginatedAdminCuratorGroupsResponse(
        items=items,
        total=total,
        limit=limit,
        offset=offset,
    )
