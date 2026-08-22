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

from sqlalchemy import ColumnElement, Select, and_, case, delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, NotFoundError
from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupMember,
    CuratorMemberKind,
)
from app.modules.masters.models import MasterProfile

# Imported, never restated: "draft and deleted do not count" must have one
# home, or the roster and GET /masters/{id} will disagree about the same
# master. Reading from masters/service.py does not modify it -- six other
# modules already import from there, and there is no cycle.
from app.modules.masters.service import _NON_COUNTABLE_PRACTICE_STATUSES
from app.modules.practices.models import Practice
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


# ===========================================================================
# Member-facing reads (GT-2, tz-curator-groups.md 5.2 "Участник")
#
# EVERYTHING below is gated on the group being ACTIVE (I-6): a group whose
# curator is not verified right now is, for every member, indistinguishable
# from one that never existed. No row is touched to make that happen and
# none is touched to undo it -- re-verifying the curator brings the whole
# group back exactly as it was.
#
# The one deliberate exception is leave_curator_group: see its docstring.
# ===========================================================================


def _active_group_clause() -> ColumnElement[bool]:
    """True iff the (correlated) CuratorGroup's curator is verified NOW.

    This is I-6 in one expression, and it is the SAME expression the roster
    and the counters already use -- _verified_profile_exists, applied to the
    group's owner instead of to a member. The JSONB path to the account
    status stays written down exactly once in the tree.

    Correlated to the module-level CuratorGroup table: the calling query
    must select FROM CuratorGroup, the same contract
    practices/audience_service.py's clauses state for Practice.

    The CURATOR-facing endpoints (GT-1) deliberately do NOT call this:
    get_current_master already guarantees the caller is verified, so asking
    again would be a second answer to a settled question.
    """
    return _verified_profile_exists(CuratorGroup.curator_user_id)


# The relation value for someone who OWNS the group. A literal, because it
# is not a curator_group_member.kind: the curator has no row (I-2), so this
# string exists only in the CASE below and in the response schema's Literal.
CURATOR_RELATION = "curator"


def _relation_expr(user_id: UUID) -> ColumnElement:
    """SQL CASE: this viewer's tie to the correlated group.

    'curator' when they own it, otherwise the kind on their membership row,
    otherwise NULL -- and NULL is exactly "no relation", which the callers
    turn into a 404.

    The curator branch comes first and does not consult the membership
    table at all: I-2 keeps the curator out of curator_group_member, so
    there is no row to find and no chance of two answers for one person.
    """
    return case(
        (CuratorGroup.curator_user_id == user_id, CURATOR_RELATION),
        else_=CuratorGroupMember.kind,
    )


def _membership_outerjoin(user_id: UUID):
    """The (group, this user) membership row, or nothing -- as a join."""
    return (
        CuratorGroupMember,
        and_(
            CuratorGroupMember.group_id == CuratorGroup.id,
            CuratorGroupMember.user_id == user_id,
        ),
    )


async def _relation_or_404(
    group_id: UUID, user_id: UUID, session: AsyncSession,
) -> tuple[CuratorGroup, str]:
    """Resolve (group, my relation) in ONE query, or 404.

    Three different reasons to refuse -- the group does not exist, it is
    inactive, the caller has no tie to it -- collapse into one NotFoundError
    on purpose (P-08). Telling them apart would let anyone probe which group
    ids are real and which curators are currently suspended.

    One query rather than "load the group, then check membership": the
    second shape needs a 404 branch in each of the four read endpoints, and
    four branches drift. This one is called first thing by all four.
    """
    member_model, member_on = _membership_outerjoin(user_id)
    row = (
        await session.execute(
            select(CuratorGroup, _relation_expr(user_id).label("relation"))
            .outerjoin(member_model, member_on)
            .where(CuratorGroup.id == group_id, _active_group_clause())
        )
    ).one_or_none()

    if row is None or row[1] is None:
        raise NotFoundError("Curator group not found")
    return row[0], row[1]


def _curator_display_name(profile_data: dict | None, first_name: str | None):
    """Master display name: profile field, else the user's first name.

    Same lookup order as get_master_public (masters/service.py) -- read from
    its body, not guessed. Returns None when both are empty, which is what
    MasterPublicResponse.display_name already allows; the neutral «Участник»
    fallback in users/helpers.py is a rule about PARTICIPANTS and is
    deliberately not applied to masters.
    """
    prof = (profile_data or {}).get("profile", {})
    return prof.get("display_name") or first_name


async def _curator_refs(
    curator_ids: list[UUID], session: AsyncSession,
) -> dict[UUID, dict]:
    """Public reference for many curators in ONE query."""
    if not curator_ids:
        return {}
    rows = (
        await session.execute(
            select(User.id, User.first_name, User.avatar_url, MasterProfile.data)
            .outerjoin(MasterProfile, MasterProfile.user_id == User.id)
            .where(User.id.in_(curator_ids))
        )
    ).all()
    return {
        uid: {
            "user_id": uid,
            "display_name": _curator_display_name(data, first_name),
            "avatar_url": avatar_url,
        }
        for uid, first_name, avatar_url, data in rows
    }


async def list_my_curator_groups(
    user_id: UUID, session: AsyncSession,
) -> list[dict]:
    """Every ACTIVE group this user belongs to, curated ones first.

    Two queries plus the shared counter, not a UNION: the two sides live in
    different tables and carry different order keys (a curated group has no
    joined_at -- the curator never joined, they created it). A UNION would
    have to invent a column to sort by and would read worse for a list this
    short.

    A user who curates a group while suspended does not see it either: the
    group is inactive for EVERYONE including its owner, which is what makes
    "inactive" a property of the group rather than a per-viewer rule.
    """
    curated = list(
        (
            await session.execute(
                select(CuratorGroup)
                .where(
                    CuratorGroup.curator_user_id == user_id,
                    _active_group_clause(),
                )
                .order_by(CuratorGroup.created_at.desc(), CuratorGroup.id)
            )
        )
        .scalars()
        .all()
    )

    joined = (
        await session.execute(
            select(CuratorGroup, CuratorGroupMember.kind)
            .join(
                CuratorGroupMember,
                CuratorGroupMember.group_id == CuratorGroup.id,
            )
            .where(
                CuratorGroupMember.user_id == user_id,
                _active_group_clause(),
            )
            .order_by(CuratorGroupMember.joined_at.desc(), CuratorGroup.id)
        )
    ).all()

    groups = curated + [g for g, _kind in joined]
    counts = await _counts_for_groups([g.id for g in groups], session)
    refs = await _curator_refs([g.curator_user_id for g in groups], session)

    def _item(group: CuratorGroup, relation: str) -> dict:
        masters_count, students_count = counts.get(group.id, (0, 0))
        return {
            "id": group.id,
            "name": group.name,
            "description": group.description,
            "curator": refs[group.curator_user_id],
            "masters_count": masters_count,
            "students_count": students_count,
            "relation": relation,
        }

    return [_item(g, CURATOR_RELATION) for g in curated] + [
        _item(g, kind) for g, kind in joined
    ]


async def get_curator_group_page(
    group_id: UUID, user_id: UUID, session: AsyncSession,
) -> dict:
    """One group, as a member of it sees it."""
    group, relation = await _relation_or_404(group_id, user_id, session)
    masters_count, students_count = await get_group_counts(group.id, session)
    refs = await _curator_refs([group.curator_user_id], session)
    return {
        "id": group.id,
        "name": group.name,
        "description": group.description,
        "curator": refs[group.curator_user_id],
        "masters_count": masters_count,
        "students_count": students_count,
        "viewer": {"relation": relation},
        "created_at": group.created_at,
    }


async def _visible_master_ids(
    group_id: UUID, session: AsyncSession,
) -> list[UUID]:
    """Member masters who are verified RIGHT NOW, newest membership first.

    Same visibility rule as masters_count and as GT-1's is_visible: one
    predicate, so the roster, the counter and the practice feed cannot tell
    three different stories about the same person.
    """
    rows = (
        await session.execute(
            select(CuratorGroupMember.user_id)
            .where(
                CuratorGroupMember.group_id == group_id,
                CuratorGroupMember.kind == CuratorMemberKind.MASTER.value,
                _verified_profile_exists(CuratorGroupMember.user_id),
            )
            .order_by(
                CuratorGroupMember.joined_at.desc(), CuratorGroupMember.user_id,
            )
        )
    ).all()
    return [uid for (uid,) in rows]


async def _practices_counts(
    master_ids: list[UUID], session: AsyncSession,
) -> dict[UUID, int]:
    """Public practice count per master, ONE query for the whole page.

    get_master_public runs this same count for a single master and says in
    its own comment that the sequential shape is fine on a cold path
    (opening one profile). A roster page is not that path: one query per row
    would make the page cost grow with limit. Same lesson as practices_count
    in admin/users/service.py::list_masters.

    _NON_COUNTABLE_PRACTICE_STATUSES is IMPORTED, not restated: a second
    copy of "draft and deleted do not count" would drift, and then the
    roster and GET /masters/{id} would disagree about the same master.
    """
    if not master_ids:
        return {}
    rows = (
        await session.execute(
            select(Practice.master_id, func.count(Practice.id))
            .where(
                Practice.master_id.in_(master_ids),
                Practice.status.notin_(_NON_COUNTABLE_PRACTICE_STATUSES),
            )
            .group_by(Practice.master_id)
        )
    ).all()
    return {mid: int(n) for mid, n in rows}


async def _master_items(
    master_ids: list[UUID],
    curator_id: UUID,
    session: AsyncSession,
) -> list[dict]:
    """Roster rows for an explicit, already-ordered list of master ids."""
    if not master_ids:
        return []
    rows = (
        await session.execute(
            select(User.id, User.first_name, User.avatar_url, MasterProfile.data)
            .outerjoin(MasterProfile, MasterProfile.user_id == User.id)
            .where(User.id.in_(master_ids))
        )
    ).all()
    by_id = {uid: (first, avatar, data) for uid, first, avatar, data in rows}
    counts = await _practices_counts(master_ids, session)

    items = []
    for uid in master_ids:
        first_name, avatar_url, data = by_id.get(uid, (None, None, None))
        prof = (data or {}).get("profile", {})
        items.append(
            {
                "user_id": uid,
                "display_name": _curator_display_name(data, first_name),
                "avatar_url": avatar_url,
                "methods": prof.get("methods", []),
                "experience_years": prof.get("experience_years"),
                "practices_count": counts.get(uid, 0),
                "is_curator": uid == curator_id,
            }
        )
    return items


async def list_group_masters(
    group_id: UUID,
    user_id: UUID,
    session: AsyncSession,
    *,
    limit: int = 20,
    offset: int = 0,
) -> tuple[list[dict], int]:
    """The school's masters: the curator first, then visible members.

    THE CURATOR IS NOT A ROW. They are not in curator_group_member (I-2), so
    they are prepended here and counted in `total` -- which makes
    total == masters_count + 1 by construction, since masters_count counts
    exactly the member masters this function shows after the curator.

    PAGINATION treats the curator as index 0 of a virtual list. On the first
    page they take one slot and the page carries limit-1 members; on any
    later page the member window is shifted by one and the curator is NOT
    repeated. Getting this wrong duplicates a person across pages, which is
    the kind of bug that only shows up on a roster long enough to paginate.
    """
    group, _relation = await _relation_or_404(group_id, user_id, session)

    member_ids = await _visible_master_ids(group.id, session)
    total = len(member_ids) + 1

    if offset == 0:
        page_ids = [group.curator_user_id, *member_ids[: max(limit - 1, 0)]]
    else:
        start = offset - 1
        page_ids = member_ids[start : start + limit]

    return await _master_items(page_ids, group.curator_user_id, session), total


async def list_group_practice_master_ids(
    group_id: UUID, user_id: UUID, session: AsyncSession,
) -> list[UUID]:
    """Whose practices the group's feed shows: curator + visible masters.

    The SAME set the roster displays. A suspended master-member contributes
    nothing here for the same reason they vanish from the roster -- if the
    two rules were written separately, one page would list a master whose
    practices the page below refuses to show.

    Returned as a list for list_public_practices rather than resolved into
    practices here: this module writes NO query against `practices`. The
    feed already carries the status/time gate, the audience clause with its
    owner-bypass, the block clause, is_booked/is_paid, taxonomy, sorting and
    pagination -- any local re-implementation would reproduce a subset of
    that and drift the day the audience rules change, which is already
    scheduled (GT-11).
    """
    group, _relation = await _relation_or_404(group_id, user_id, session)
    visible = await _visible_master_ids(group.id, session)
    return [group.curator_user_id, *visible]


async def leave_curator_group(
    group_id: UUID, user_id: UUID, session: AsyncSession,
) -> None:
    """Leave a group. Idempotent, and NOT gated on the group being active.

    THE MISSING ACTIVITY CHECK IS THE POINT, not an oversight. I-5 gives
    every member the right to leave at any moment without anyone else's
    consent. Routing this through _relation_or_404 would answer 404 while
    the curator is suspended -- and the member would be stuck in a school
    they cannot leave until an admin re-verifies somebody else. The exit is
    therefore resolved by group id alone.

    Three outcomes, no fourth: my row exists -> deleted, 204; no row (never
    joined, already left, or no such group) -> 204; I am the curator -> 409.

    The curator cannot leave because leaving would orphan the group: the
    ways out are transferring it (GT-4) or deleting it (GT-1).
    """
    group = (
        await session.execute(
            select(CuratorGroup).where(CuratorGroup.id == group_id)
        )
    ).scalar_one_or_none()

    if group is None:
        # Nothing to leave. Not a 404: that would reveal which group ids
        # exist to anyone willing to try them.
        return

    if group.curator_user_id == user_id:
        raise ConflictError(
            "A curator cannot leave their own group",
            code="curator_cannot_leave",
        )

    await session.execute(
        delete(CuratorGroupMember).where(
            CuratorGroupMember.group_id == group.id,
            CuratorGroupMember.user_id == user_id,
        )
    )
