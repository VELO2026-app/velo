# =============================================================================
# VELO Backend -- Curator Groups Service (P1, tz-curator-groups.md 5.2/5.4)
# =============================================================================
#
# OWNERSHIP IS THE ONLY AUTHORIZATION HERE. There is no get_current_curator
# and no is_curator flag (I-1, 3.3): the router's get_current_master already
# guarantees "verified master", and every function below re-resolves the
# group by (id, curator_user_id). A group belonging to somebody else and a
# group that does not exist both raise 404 with the same message (P-08) --
# a 403 on the former would confirm that the id is real.
#
# P-01: nothing here commits. The router flushes; get_db_session commits.
# =============================================================================

from uuid import UUID

from sqlalchemy import ColumnElement, Select, case, delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, NotFoundError
from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupMember,
    CuratorMemberKind,
)
from app.modules.masters.models import MasterProfile
from app.modules.users.helpers import display_name
from app.modules.users.models import User

_NAME_TAKEN_CODE = "curator_group_name_taken"


def _verified_profile_exists(user_id_col: ColumnElement) -> ColumnElement[bool]:
    """Correlated EXISTS: this user has a verified MasterProfile RIGHT NOW.

    ONE place where the JSONB path to the account status is spelled out, for
    the reason 5.4 gives: the same question is asked by the roster, by the
    masters_count, and (GT-2) by _active_group_clause over the group's
    curator. Three hand-written copies of
    data->'account'->>'status' = 'verified' would drift the day the status
    lives somewhere else.

    Written as a correlated EXISTS rather than an outer join to
    master_profiles on purpose: an EXISTS is a boolean CLAUSE, so it can be
    dropped into a WHERE, a CASE, or a counter's aggregate unchanged, which
    a join cannot. Cost is the same -- one bounded subquery per statement,
    never a query per row.

    The JSONB comparison mirrors admin/users/service.py::list_masters, which
    filters master rows by the identical expression.

    Projects user_id, NOT id: MasterProfile has no surrogate key -- its
    PRIMARY KEY IS user_id (masters/models.py), which is how the one-to-one
    with users is enforced at the database level. `MasterProfile.id` raises
    AttributeError at query-build time, i.e. inside the request, not at
    import.
    """
    return (
        select(MasterProfile.user_id)
        .where(
            MasterProfile.user_id == user_id_col,
            MasterProfile.data["account"]["status"].as_string() == "verified",
        )
        .exists()
    )


async def _get_group_or_404(
    curator_user_id: UUID, group_id: UUID, session: AsyncSession,
) -> CuratorGroup:
    """Resolve {id} to a group owned by THIS curator, or 404.

    No system-slug guard: unlike master_group, curator groups have no
    virtual members of the family ("Ученики"/"Удалённые" are a master_group
    concept), so {id} is always a real UUID and FastAPI has already rejected
    anything that is not one with a 422.
    """
    group = (
        await session.execute(
            select(CuratorGroup).where(
                CuratorGroup.id == group_id,
                CuratorGroup.curator_user_id == curator_user_id,
            )
        )
    ).scalar_one_or_none()
    if group is None:
        raise NotFoundError("Curator group not found")
    return group


async def _counts_for_groups(
    group_ids: list[UUID], session: AsyncSession,
) -> dict[UUID, tuple[int, int]]:
    """(masters_count, students_count) for many groups in ONE query.

    One statement for the whole page, not one per group: the lesson of
    practices_count in admin/users/service.py::list_masters, where the
    per-row shape would have turned a 20-row page into 20 round trips.

    Returns a dict keyed by group id; a group with no rows at all is simply
    absent, and callers read it through .get(gid, (0, 0)) -- an empty group
    reports zeros rather than disappearing from the list.
    """
    if not group_ids:
        return {}

    is_visible_master = (
        CuratorGroupMember.kind == CuratorMemberKind.MASTER.value
    ) & _verified_profile_exists(CuratorGroupMember.user_id)

    rows = (
        await session.execute(
            select(
                CuratorGroupMember.group_id,
                func.coalesce(
                    func.sum(case((is_visible_master, 1), else_=0)), 0,
                ),
                func.coalesce(
                    func.sum(
                        case(
                            (
                                CuratorGroupMember.kind
                                == CuratorMemberKind.STUDENT.value,
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


def _group_payload(
    group: CuratorGroup, counts: tuple[int, int],
) -> dict:
    """ORM row + its counts -> the dict the router validates into a schema."""
    masters_count, students_count = counts
    return {
        "id": group.id,
        "name": group.name,
        "description": group.description,
        "masters_count": masters_count,
        "students_count": students_count,
        "created_at": group.created_at,
    }


# ===========================================================================
# Group CRUD
# ===========================================================================


async def list_curator_groups(
    curator_user_id: UUID, session: AsyncSession,
) -> list[dict]:
    """Every group this master curates, newest first.

    A master who curates nothing gets an empty list, never a 404: "you have
    no groups" is a legitimate answer for any verified master, since
    curatorship is not granted (I-1) and so has no "not a curator" state to
    report.
    """
    groups = list(
        (
            await session.execute(
                select(CuratorGroup)
                .where(CuratorGroup.curator_user_id == curator_user_id)
                .order_by(CuratorGroup.created_at.desc(), CuratorGroup.id)
            )
        )
        .scalars()
        .all()
    )
    counts = await _counts_for_groups([g.id for g in groups], session)
    return [_group_payload(g, counts.get(g.id, (0, 0))) for g in groups]


async def create_curator_group(
    curator_user_id: UUID,
    name: str,
    session: AsyncSession,
    description: str | None = None,
) -> CuratorGroup:
    """Create a group and thereby become its curator (I-1).

    The pre-check is the fast path that produces a clean 409; the UNIQUE
    index is the actual guard, and the IntegrityError backstop is what makes
    two simultaneous creates of the same name resolve to "one row, one 409"
    instead of a 500. Same three parts as create_group() in
    masters/groups_service.py -- and the reason all three exist is that the
    SELECT and the INSERT are not one atomic step.
    """
    existing = (
        await session.execute(
            select(CuratorGroup).where(
                CuratorGroup.curator_user_id == curator_user_id,
                CuratorGroup.name == name,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise ConflictError(
            f"A curator group named '{name}' already exists",
            code=_NAME_TAKEN_CODE,
        )

    group = CuratorGroup(
        curator_user_id=curator_user_id,
        name=name,
        description=_normalized_description(description),
    )
    try:
        async with session.begin_nested():
            session.add(group)
            await session.flush()
    except IntegrityError:
        raise ConflictError(
            f"A curator group named '{name}' already exists",
            code=_NAME_TAKEN_CODE,
        ) from None
    return group


def _normalized_description(description: str | None) -> str | None:
    """Blank or whitespace-only -> NULL, never "".

    Keeps "no description" a single unambiguous DB state, so no consumer has
    to treat "" and NULL as the same thing and no consumer can forget to.
    """
    return description.strip() if description and description.strip() else None


async def update_curator_group(
    curator_user_id: UUID,
    group_id: UUID,
    name: str,
    session: AsyncSession,
    *,
    description: str | None = None,
    description_provided: bool = False,
) -> CuratorGroup:
    """Rename and/or edit the description of one of my groups.

    description_provided comes from the router's own exclude_unset check --
    see UpdateCuratorGroupRequest. When it is False the column is not
    touched at all, byte for byte.

    Renaming to the group's CURRENT name is a no-op, not a self-conflict:
    the duplicate lookup runs only when the name actually changes, so the
    group's own row can never be mistaken for a competitor.
    """
    group = await _get_group_or_404(curator_user_id, group_id, session)

    if group.name != name:
        dup = (
            await session.execute(
                select(CuratorGroup).where(
                    CuratorGroup.curator_user_id == curator_user_id,
                    CuratorGroup.name == name,
                )
            )
        ).scalar_one_or_none()
        if dup is not None:
            raise ConflictError(
                f"A curator group named '{name}' already exists",
                code=_NAME_TAKEN_CODE,
            )
        group.name = name

    if description_provided:
        group.description = _normalized_description(description)

    try:
        async with session.begin_nested():
            await session.flush()
    except IntegrityError:
        raise ConflictError(
            f"A curator group named '{name}' already exists",
            code=_NAME_TAKEN_CODE,
        ) from None
    return group


async def delete_curator_group(
    curator_user_id: UUID, group_id: UUID, session: AsyncSession,
) -> None:
    """Delete a group. Members, invites and any pending transfer cascade.

    NEVER blocked (I-11) -- explicitly unlike delete_group() in
    masters/groups_service.py, which raises 409 group_in_use when the group
    is the sole audience of a practice. That ruling (2026-07-25) stands for
    student groups and is deliberately NOT carried over here: it would hand
    a member's practice a veto over the curator's own group.
    """
    group = await _get_group_or_404(curator_user_id, group_id, session)
    await session.delete(group)
    await session.flush()


# ===========================================================================
# Members
# ===========================================================================


def _member_base_query(group_id: UUID) -> Select:
    """Roster rows joined to their users, with live visibility computed.

    is_visible is a CASE, not a post-hoc Python flag: a student is visible
    unconditionally (they have no MasterProfile to check), a master is
    visible exactly when _verified_profile_exists says so. Computing it in
    SQL is what lets masters_count and this column come from one predicate.

    NO User.is_active FILTER. The precedent roster
    (_list_custom_group_members, masters/groups_service.py) does not filter
    on it either -- read from its body, not assumed. Adding one here would
    be inventing a rule the codebase does not have, and inventing it in the
    place least likely to be noticed.
    """
    return (
        select(
            User,
            CuratorGroupMember.kind,
            CuratorGroupMember.joined_at,
            case(
                (
                    CuratorGroupMember.kind == CuratorMemberKind.STUDENT.value,
                    True,
                ),
                else_=_verified_profile_exists(CuratorGroupMember.user_id),
            ).label("is_visible"),
        )
        .join(CuratorGroupMember, CuratorGroupMember.user_id == User.id)
        .where(CuratorGroupMember.group_id == group_id)
    )


async def list_curator_group_members(
    curator_user_id: UUID,
    group_id: UUID,
    session: AsyncSession,
    *,
    kind: str | None = None,
    search: str | None = None,
    limit: int = 20,
    offset: int = 0,
) -> tuple[list[dict], int]:
    """Paginated roster of one of my groups.

    A suspended master is a row with is_visible=false, NOT an omission: the
    curator needs to see that the person is still in the school but
    currently in the shadow, and re-verification brings them back without
    anyone touching a row (I-4).
    """
    group = await _get_group_or_404(curator_user_id, group_id, session)

    base = _member_base_query(group.id)
    if kind is not None:
        base = base.where(CuratorGroupMember.kind == kind)
    if search:
        full_name = func.concat(
            func.coalesce(User.first_name, ""),
            " ",
            func.coalesce(User.last_name, ""),
        )
        base = base.where(full_name.ilike(f"%{search}%"))

    total = (
        await session.execute(
            select(func.count()).select_from(base.order_by(None).subquery())
        )
    ).scalar_one()

    rows = (
        await session.execute(
            base.order_by(CuratorGroupMember.joined_at.desc(), User.id)
            .limit(limit)
            .offset(offset)
        )
    ).all()

    items = [
        {
            "user_id": user.id,
            "name": display_name(user.first_name, user.last_name),
            "avatar_url": user.avatar_url,
            "kind": kind_value,
            "joined_at": joined_at,
            "is_visible": bool(is_visible),
        }
        for user, kind_value, joined_at, is_visible in rows
    ]
    return items, total


async def remove_curator_group_member(
    curator_user_id: UUID,
    group_id: UUID,
    user_id: UUID,
    session: AsyncSession,
) -> None:
    """Remove a member. Idempotent -- no rowcount check, no 404 on a miss.

    Same shape as remove_group_member() in masters/groups_service.py: the
    caller asked for "this person is not in this group", and that is the
    state afterwards whether or not a row was there to delete.

    Passing the CURATOR's own user_id deletes nothing and still returns
    success -- the curator is not a member row (I-2), so there is no special
    branch for it. A branch would exist only to produce a different status
    code for a request that changes nothing either way.
    """
    group = await _get_group_or_404(curator_user_id, group_id, session)
    await session.execute(
        delete(CuratorGroupMember).where(
            CuratorGroupMember.group_id == group.id,
            CuratorGroupMember.user_id == user_id,
        )
    )


async def get_group_counts(
    group_id: UUID, session: AsyncSession,
) -> tuple[int, int]:
    """(masters_count, students_count) for ONE group -- create/patch replies."""
    counts = await _counts_for_groups([group_id], session)
    return counts.get(group_id, (0, 0))
