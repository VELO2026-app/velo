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

import secrets
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import ColumnElement, Select, and_, case, delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import (
    ConflictError,
    ForbiddenError,
    NotFoundError,
    VeloError,
)
from app.modules.curator_groups.models import (
    EVENT_DATA_ACTOR_NAME,
    EVENT_DATA_KIND,
    EVENT_DATA_TARGET_NAME,
    EVENT_DATA_TARGET_USER_ID,
    CuratorGroup,
    CuratorGroupEvent,
    CuratorGroupEventKind,
    CuratorGroupInvite,
    CuratorGroupMember,
    CuratorGroupTransfer,
    CuratorMemberKind,
)

# Read, not written: MasterStudent carries the curator's block (I-9), and
# the same row is what join_group_by_token checks in masters/. Importing a
# model does not modify its module.
from app.modules.masters.groups_models import MasterStudent
from app.modules.masters.models import MasterProfile

# Imported, never restated: "draft and deleted do not count" must have one
# home, or the roster and GET /masters/{id} will disagree about the same
# master. Reading from masters/service.py does not modify it -- six other
# modules already import from there, and there is no cycle.
from app.modules.masters.service import _NON_COUNTABLE_PRACTICE_STATUSES
from app.modules.practices.models import (
    Practice,
    PracticeAudienceCuratorGroup,
    PracticeStatus,
)
from app.modules.users.helpers import display_name
from app.modules.users.models import User

_NAME_TAKEN_CODE = "curator_group_name_taken"
_NO_CREATE_RIGHT_CODE = "group_creation_not_allowed"

# GT-15. THE ONE SPELLING of the admin-granted right, for the reason
# masters/models.py gives about its own JSONB: data is a dict with no model
# behind it, so a mistyped key does not fail -- it reads back as None and the
# gate silently opens or silently shuts. Written here once and imported by
# every writer (admin/masters verify + toggle, scripts/seed) and every reader
# (this module's gate, admin/users' list, the router's list response).
CAN_CREATE_GROUPS_KEY = "can_create_groups"


def master_can_create_groups(data: dict | None) -> bool:
    """Does this profile carry the admin-granted right to found a school?

    ABSENT AND false ARE THE SAME STATE and this function is the single
    place that says so. Verification writes the key only when the admin
    ticked the box, the admin toggle writes an explicit boolean either way,
    and a profile created by any other path (master apply, admin
    make-master, an older seed) has no key at all -- three origins, one
    meaning, no caller that has to remember which is which.

    Takes the dict, not the profile, so a caller holding a row from a join
    (admin/users' list) and a caller holding the ORM object (the router)
    ask the same question through the same body.
    """
    account = (data or {}).get("account") or {}
    return bool(account.get(CAN_CREATE_GROUPS_KEY))


def _can_create_groups_exists(
    user_id_col: ColumnElement | UUID,
) -> ColumnElement[bool]:
    """The same question as master_can_create_groups, asked in SQL.

    Twin of _verified_profile_exists below, and shaped like it on purpose:
    a boolean CLAUSE drops into a WHERE unchanged, and the gate needs the
    answer inside the writer's transaction without pulling the profile row
    into Python just to read one key.

    NULL-safe by construction: a profile with no such key extracts to NULL,
    CAST(NULL AS BOOLEAN) is NULL, and IS TRUE turns that into false. So
    "no key" and "false" answer identically here too -- the SQL half of the
    rule master_can_create_groups states in Python.

    Projects user_id, NOT id: MasterProfile's PRIMARY KEY IS user_id and it
    has no surrogate key at all.
    """
    return (
        select(MasterProfile.user_id)
        .where(
            MasterProfile.user_id == user_id_col,
            MasterProfile.data["account"][CAN_CREATE_GROUPS_KEY]
            .as_boolean()
            .is_(True),
        )
        .exists()
    )


def _verified_profile_exists(
    user_id_col: ColumnElement | UUID,
) -> ColumnElement[bool]:
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

    Takes a COLUMN or a plain id. Given a column it correlates to the outer
    query, which is how the roster, the counters and _active_group_clause
    use it; given a UUID it is a self-contained EXISTS that can be selected
    on its own, which is what the capability check (GT-3) needs. One
    predicate, two shapes, still one JSONB path.
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
    group: CuratorGroup,
    counts: tuple[int, int],
    transfer: dict | None = None,
) -> dict:
    """ORM row + its counts -> the dict the router validates into a schema."""
    masters_count, students_count = counts
    return {
        "id": group.id,
        "name": group.name,
        "description": group.description,
        "avatar_url": group.avatar_url,
        "masters_count": masters_count,
        "students_count": students_count,
        "transfer": transfer,
        "created_at": group.created_at,
    }


# ===========================================================================
# The school journal (GT-16)
#
# THIRTEEN kinds of event, written from twelve functions below. Everything
# that decides WHAT a record looks like lives here and in the model's
# docstring; the call sites decide only WHEN.
# ===========================================================================


def _record_group_event(
    group_id: UUID,
    actor: User,
    event: CuratorGroupEventKind,
    session: AsyncSession,
    *,
    data: dict[str, Any] | None = None,
) -> None:
    """Append one event to a school's journal, in the caller's transaction.

    SYNCHRONOUS AND IN THE SAME TRANSACTION as the action it records, not
    an outbox row and not a background task. An event written separately
    would survive a rollback that the action itself did not, and a journal
    that reports things which did not happen is worse than no journal --
    the reader has no way to tell which entries to distrust. The cost is
    one INSERT on operations that happen a handful of times in a school's
    life.

    NOT AWAITED, and that is not an oversight: this is session.add, which
    is synchronous. The INSERT goes out with the caller's flush, which is
    also what puts it inside the caller's transaction and inside any
    savepoint the caller opened.

    ONE function rather than twelve copies of session.add. Twelve copies
    would be twelve places to forget actor_name -- and a missing
    actor_name does not fail, it just leaves the journal saying that
    somebody did something.

    actor_name is stamped HERE, for every event, from the User the caller
    already holds: every one of the twelve call sites sits behind
    get_current_user or get_current_master, so the actor is in hand and no
    call site needs to look one up. See the model docstring for why the
    name is frozen into data instead of joined at read time.

    P-01: no commit. The caller's endpoint owns the transaction.

    WHY THE TWELVE WRITERS GAINED A KEYWORD-ONLY `actor: User` INSTEAD OF
    HAVING THEIR EXISTING UUID PARAMETER RETYPED. Retyping was the tidier
    shape -- one value instead of an id beside the object that contains
    it -- and it was measured and rejected: it means 53 substitutions
    inside eleven functions, two of which (accept_curator_group_transfer,
    join_curator_group_by_token) carry lost-race branches, in a delivery
    whose suite cannot be run where it is written. The redundancy that
    remains is bounded: `actor` and the acting id come off the same object
    one line apart at every call site, and the acting id is what each
    function's own ownership check already uses -- a mismatch would
    surface as a 404 long before it surfaced in the journal.
    """
    payload: dict[str, Any] = {
        EVENT_DATA_ACTOR_NAME: display_name(
            actor.first_name, actor.last_name,
        ),
    }
    if data:
        payload.update(data)

    session.add(
        CuratorGroupEvent(
            group_id=group_id,
            actor_id=actor.id,
            event=event.value,
            data=payload,
        )
    )


async def _frozen_name(user_id: UUID, session: AsyncSession) -> str:
    """The display name of the OTHER party, read once to be frozen.

    Four events name two different people -- who removed whom, who offered
    the school to whom, who accepted it from whom, whose offer was
    declined. The actor's name is free (the caller holds the User), but
    the target's is not: nothing in curator_group_member or
    curator_group_transfer stores a name, so it has to be fetched.

    ONE SELECT BY PRIMARY KEY, and it is bought on purpose. The
    alternative is storing target_user_id alone, which leaves the journal
    reading "Мария удалила 9f3c..." -- exactly as useless as the reverse
    case that made the actor's name get frozen in the first place. These
    are operations that happen a few times in a school's life.

    display_name(first, last), NOT the master-profile lookup
    _curator_display_name uses. The tree holds two naming rules and this
    is a deliberate pick between them, the same one CuratorGroupTransferRef
    made and for the same reason: a journal entry is about a PERSON, not a
    public master card, and the profile-based rule can return None -- which
    would put "Мария удалила —" in the feed. display_name always yields
    something, falling back to the neutral «Участник».

    A user who no longer exists yields that same fallback rather than an
    error: the journal would rather say «Участник» than refuse to record
    what happened.
    """
    row = (
        await session.execute(
            select(User.first_name, User.last_name).where(
                User.id == user_id
            )
        )
    ).first()
    if row is None:
        return display_name(None, None)
    return display_name(row.first_name, row.last_name)


def _target_data(user_id: UUID, name: str) -> dict[str, Any]:
    """The frozen other-party pair, spelled once for its four writers."""
    return {
        EVENT_DATA_TARGET_USER_ID: str(user_id),
        EVENT_DATA_TARGET_NAME: name,
    }


# ===========================================================================
# Reading the journal (GT-16)
# ===========================================================================


async def list_curator_group_events(
    curator_user_id: UUID,
    group_id: UUID,
    session: AsyncSession,
    *,
    limit: int = 20,
    offset: int = 0,
) -> tuple[list[dict], int]:
    """One school's journal, newest first, for its curator only.

    THE CURATOR AND NOBODY ELSE. Not the master members, not the students:
    the feed says who was removed and who walked out, which is management
    information about people rather than a chronicle for the community to
    read about itself. Enforced by _get_group_or_404 on curator_user_id, so
    a member asking gets 404 and not 403 -- the same shape every curator
    endpoint uses (P-08), and 403 would confirm the school exists.

    ORDER BY seq DESC AND NOTHING ELSE. No tie-break, because seq is
    unique and there is nothing to break: a tie-break exists to rescue a
    sort key that is not an order, and the lesson from GT-9's shifting
    pages is better spent on not sorting by one. created_at is not in the
    ORDER BY at all -- two events from one PATCH share it to the byte (see
    the model docstring).

    total is a COUNT on every page request. Free today; see the delivery
    report's observations for why it will not stay free forever.
    """
    group = await _get_group_or_404(curator_user_id, group_id, session)

    base = select(CuratorGroupEvent).where(
        CuratorGroupEvent.group_id == group.id
    )

    total = (
        await session.execute(
            select(func.count()).select_from(base.subquery())
        )
    ).scalar_one()

    rows = (
        await session.execute(
            base.order_by(CuratorGroupEvent.seq.desc())
            .limit(limit)
            .offset(offset)
        )
    ).scalars().all()

    # NO JOIN TO users, deliberately -- see the model docstring. The
    # actor's name comes out of the row's own data, frozen when the thing
    # happened, so a person who has since renamed themselves or been
    # deleted still appears as they were. actor is never None: actor_id is
    # NOT NULL and every event kind is somebody's action.
    return (
        [
            {
                "id": row.id,
                "event": row.event,
                "actor": {
                    "user_id": row.actor_id,
                    "display_name": (row.data or {}).get(
                        EVENT_DATA_ACTOR_NAME
                    )
                    or display_name(None, None),
                },
                "data": row.data or {},
                "created_at": row.created_at,
            }
            for row in rows
        ],
        total,
    )


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
    group_ids = [g.id for g in groups]
    counts = await _counts_for_groups(group_ids, session)
    transfers = await _transfer_refs_for_groups(group_ids, session)
    return [
        _group_payload(g, counts.get(g.id, (0, 0)), transfers.get(g.id))
        for g in groups
    ]


async def create_curator_group(
    curator_user_id: UUID,
    name: str,
    session: AsyncSession,
    description: str | None = None,
    *,
    actor: User,
) -> CuratorGroup:
    """Create a group and thereby become its curator (I-1).

    GT-15: THE ONE GATE ON THE RIGHT TO FOUND A SCHOOL. The flag means
    exactly "may found a NEW school", never "may own one" -- accepting a
    transfer still makes a flagless master a curator, deliberately, because
    a curator who wants to hand their school over must have someone to hand
    it to, and gating the transfer would leave schools locked to owners who
    want out with deletion as the only exit. The other nine curator
    endpoints do not ask this question at all: they are about a school that
    already exists.

    Nor does the flag freeze anything. Revoking it closes this function and
    nothing else; the admin lever that freezes what a master already built
    is revoke_master, which exists and is proven, and a second way to do
    the same thing would be two mechanisms obliged to agree.

    ASKED BEFORE THE NAME IS LOOKED UP, not after: a master with no right
    must not be able to learn from the status code whether some name is
    already taken under their own account.

    The pre-check is the fast path that produces a clean 409; the UNIQUE
    index is the actual guard, and the IntegrityError backstop is what makes
    two simultaneous creates of the same name resolve to "one row, one 409"
    instead of a 500. Same three parts as create_group() in
    masters/groups_service.py -- and the reason all three exist is that the
    SELECT and the INSERT are not one atomic step.
    """
    allowed = (
        await session.execute(
            select(_can_create_groups_exists(curator_user_id))
        )
    ).scalar()
    if not allowed:
        # Deliberately NOT master_profile_not_verified: this master IS
        # verified, and the frontend owes them a different sentence.
        raise ForbiddenError(
            "Creating curator groups is not allowed for this master",
            code=_NO_CREATE_RIGHT_CODE,
        )

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

    # GT-16. AFTER the savepoint closes, not inside it. Inside, a name
    # collision would roll the event back with the group -- the correct
    # outcome, and what the twin asserts -- but writing it here means the
    # entry cannot outlive its subject even if the savepoint's shape
    # changes later.
    _record_group_event(
        group.id, actor, CuratorGroupEventKind.GROUP_CREATED, session,
    )
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
    avatar_url: str | None = None,
    avatar_url_provided: bool = False,
    actor: User,
) -> CuratorGroup:
    """Rename and/or edit the description or the avatar of one of my groups.

    description_provided comes from the router's own exclude_unset check --
    see UpdateCuratorGroupRequest. When it is False the column is not
    touched at all, byte for byte. avatar_url_provided (GT-17) is the same
    mechanism for the same reason.

    THE AVATAR ARRIVES HERE AS A str, ALREADY NORMALISED AND VALIDATED.
    The schema owns the url rules -- https only, and a length check against
    what the column actually holds -- so this function has no "is it a
    url" branch and no "did it fit" branch. Neither state can reach it.
    The router does the str() conversion, because what the schema hands it
    is a Pydantic AnyUrl and the column takes text.

    Renaming to the group's CURRENT name is a no-op, not a self-conflict:
    the duplicate lookup runs only when the name actually changes, so the
    group's own row can never be mistaken for a competitor.

    GT-16, EXTENDED BY GT-17: UP TO THREE SEPARATE EVENTS, not one "group
    updated". One PATCH can change all three fields, and they are not the
    same news: a rename is something the school's members may need to be
    told about, a description edit is not, and an avatar change is its own
    third thing. One combined event would force the
    notification work to reopen `data` and re-derive which of the two
    happened -- a decision this function already has in hand and can
    simply record. Each is written only if that field ACTUALLY changed,
    so renaming to the current name (the no-op above) writes nothing.

    They land in one transaction and therefore share created_at to the
    byte; their relative order in the feed comes from seq, which is why
    seq exists (see the model docstring). That order carries no meaning
    between them -- the three changes are independent.
    """
    group = await _get_group_or_404(curator_user_id, group_id, session)
    old_name = group.name
    old_description = group.description
    old_avatar_url = group.avatar_url

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

    if avatar_url_provided:
        # No normalisation step of its own: the schema already turned ""
        # and whitespace into None, so what arrives is either a validated
        # url or the absence of one. _normalized_description exists because
        # a description is free text the schema cannot judge; a url is not.
        group.avatar_url = avatar_url

    try:
        async with session.begin_nested():
            await session.flush()
    except IntegrityError:
        raise ConflictError(
            f"A curator group named '{name}' already exists",
            code=_NAME_TAKEN_CODE,
        ) from None

    # GT-16. Recorded from the values captured BEFORE the assignments
    # above -- after them the old name exists nowhere, and a journal entry
    # whose old_name equals its new_name says nothing happened.
    if old_name != group.name:
        _record_group_event(
            group.id, actor, CuratorGroupEventKind.GROUP_RENAMED, session,
            data={"old_name": old_name, "new_name": group.name},
        )
    if old_description != group.description:
        _record_group_event(
            group.id,
            actor,
            CuratorGroupEventKind.GROUP_DESCRIPTION_CHANGED,
            session,
        )
    if old_avatar_url != group.avatar_url:
        # Written on any real change, INCLUDING removal -- taking the
        # picture down is a change the curator made and may want to see.
        # Not written when the same url is sent again, and this is the one
        # comparison that only works because the schema stores the
        # NORMALISED form: "https://example.com" and
        # "https://example.com/" are the same picture, and if raw text were
        # stored they would compare unequal and the feed would report a
        # change that did not happen.
        _record_group_event(
            group.id,
            actor,
            CuratorGroupEventKind.GROUP_AVATAR_CHANGED,
            session,
            data={"had_avatar_before": old_avatar_url is not None},
        )
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
    *,
    actor: User,
) -> None:
    """Remove a member. Idempotent -- no 404 on a miss.

    Same shape as remove_group_member() in masters/groups_service.py: the
    caller asked for "this person is not in this group", and that is the
    state afterwards whether or not a row was there to delete.

    Passing the CURATOR's own user_id deletes nothing and still returns
    success -- the curator is not a member row (I-2), so there is no special
    branch for it. A branch would exist only to produce a different status
    code for a request that changes nothing either way.

    GT-16: THE DELETE NOW RETURNS `kind`, WHICH IS WHY IT IS NOT A BARE
    DELETE ANY MORE. The idempotence above is unchanged -- a miss is still
    success -- but the journal needs two things this function used to
    throw away: whether a row died at all (or a second removal of the same
    person would write a second "member removed" for somebody who was
    already gone) and what kind of member it was (which lives only in the
    row being deleted). RETURNING answers both inside the same statement,
    so nothing extra is queried.
    """
    group = await _get_group_or_404(curator_user_id, group_id, session)
    removed = (
        await session.execute(
            delete(CuratorGroupMember)
            .where(
                CuratorGroupMember.group_id == group.id,
                CuratorGroupMember.user_id == user_id,
            )
            .returning(CuratorGroupMember.kind)
        )
    ).first()

    # GT-4: one of the TWO points where a pending transfer dies with its
    # addressee (TZ 3.4). Removing the person you offered the group to
    # retracts the offer in the same transaction -- otherwise it would sit
    # there addressed to somebody no longer in the group.
    transfer_cancelled = await _drop_pending_transfer_for(
        group.id, user_id, session,
    )

    if removed is None:
        # Nothing was there. No event: the journal records what happened,
        # and nothing happened.
        return

    data = {
        EVENT_DATA_KIND: removed.kind,
        **_target_data(user_id, await _frozen_name(user_id, session)),
    }
    if transfer_cancelled:
        data["transfer_cancelled"] = True
    _record_group_event(
        group.id, actor, CuratorGroupEventKind.MEMBER_REMOVED, session,
        data=data,
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
    group_ids = [g.id for g in groups]
    counts = await _counts_for_groups(group_ids, session)
    refs = await _curator_refs([g.curator_user_id for g in groups], session)
    transfers = await _transfer_refs_for_groups(group_ids, session)

    def _item(group: CuratorGroup, relation: str) -> dict:
        masters_count, students_count = counts.get(group.id, (0, 0))
        offer = transfers.get(group.id)
        return {
            "id": group.id,
            "name": group.name,
            "description": group.description,
            "avatar_url": group.avatar_url,
            "curator": refs[group.curator_user_id],
            "masters_count": masters_count,
            "students_count": students_count,
            "relation": relation,
            # True only for the person the group is being offered TO. The
            # curator sees False on their own pending offer: this flag says
            # "somebody is waiting on you", and nobody is waiting on them.
            "transfer_offered": (
                offer is not None and offer["to_user_id"] == user_id
            ),
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
        "avatar_url": group.avatar_url,
        "curator": refs[group.curator_user_id],
        "masters_count": masters_count,
        "students_count": students_count,
        "viewer": {"relation": relation},
        "transfer": await _transfer_for_viewer(group, user_id, session),
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
    group_id: UUID,
    user_id: UUID,
    session: AsyncSession,
    *,
    actor: User,
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

    GT-16: the actor and the member are THE SAME PERSON here, so this
    event carries no target pair -- "X left" is a whole sentence. Written
    only when a row actually died, for the same reason as member_removed.
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

    left = (
        await session.execute(
            delete(CuratorGroupMember)
            .where(
                CuratorGroupMember.group_id == group.id,
                CuratorGroupMember.user_id == user_id,
            )
            .returning(CuratorGroupMember.kind)
        )
    ).first()

    # GT-4: the OTHER of the two points (TZ 3.4). Note this runs even
    # though the function above deliberately never checked whether the
    # group is active -- walking out of an inactive group still retracts
    # the offer made to you. Auto-cancel follows the membership, not the
    # group's visibility.
    transfer_cancelled = await _drop_pending_transfer_for(
        group.id, user_id, session,
    )

    if left is None:
        return

    data: dict[str, Any] = {EVENT_DATA_KIND: left.kind}
    if transfer_cancelled:
        data["transfer_cancelled"] = True
    _record_group_event(
        group.id, actor, CuratorGroupEventKind.MEMBER_LEFT, session,
        data=data,
    )


# ===========================================================================
# Invite links and joining (GT-3, tz-curator-groups.md 3.4 / 5.2)
#
# A group has TWO reusable links, one per kind, held apart by
# UNIQUE (group_id, kind). Everything below is the master_group invite
# machinery parameterised by that kind -- read from the body of
# get_or_create_group_invite / join_group_by_token, not from their names.
# ===========================================================================


_INVITE_DEEPLINK_KIND = "curator_group_invite__"


async def _has_master_capability(user_id: UUID, session: AsyncSession) -> bool:
    """Does this account hold master CAPABILITY right now?

    Capability, not role: a verified master browsing in user mode
    (role=user) still joins a master link as a master, because the profile
    is what makes them a teacher and the role is only which zone of the app
    they happen to be looking at.

    users/service.py::user_has_master_capability answers the same question
    in a different layer -- it takes a loaded User and runs its own SELECT
    for the /users/me role-switch block. This is NOT a duplicate of it: it
    reuses _verified_profile_exists, so the JSONB path to the account status
    is still written down exactly once in this module, and it runs inside
    the caller's transaction alongside the other join checks rather than
    opening its own read.
    """
    return bool(
        (
            await session.execute(select(_verified_profile_exists(user_id)))
        ).scalar()
    )


async def _blocked_by_curator(
    curator_user_id: UUID, user_id: UUID, session: AsyncSession,
) -> bool:
    """Has the curator blocked this person (I-9)?

    Same row and same question as join_group_by_token's own block guard: a
    block must not be walked around by re-opening an invite link the person
    already had in a chat.
    """
    row = (
        await session.execute(
            select(MasterStudent.id).where(
                MasterStudent.master_id == curator_user_id,
                MasterStudent.student_user_id == user_id,
                MasterStudent.blocked_at.is_not(None),
            )
        )
    ).scalar_one_or_none()
    return row is not None


async def _membership_row(
    group_id: UUID, user_id: UUID, session: AsyncSession,
) -> CuratorGroupMember | None:
    return (
        await session.execute(
            select(CuratorGroupMember).where(
                CuratorGroupMember.group_id == group_id,
                CuratorGroupMember.user_id == user_id,
            )
        )
    ).scalar_one_or_none()


async def get_or_create_curator_group_invite(
    curator_user_id: UUID,
    group_id: UUID,
    kind: str,
    session: AsyncSession,
    *,
    actor: User,
) -> dict:
    """Create-or-return the group's link for ONE kind.

    Idempotent by design, not by accident: the curator taps «Пригласить»
    again expecting the link they already pasted into a channel to keep
    working, not a fresh one that silently kills it. Rotating is a separate,
    explicit action (revoke, then create).

    The bot-url guard runs FIRST, before the group is even resolved -- same
    order as get_or_create_group_invite, and for the same reason: composing
    a link with an empty prefix produces a broken url that looks like a
    working one, which is worse than an honest 503.

    Raises:
        VeloError 503 (bot_url_not_configured): telegram_bot_url unset.
        NotFoundError: the group is not this curator's, or does not exist.
    """
    if not settings.telegram_bot_url:
        raise VeloError(
            message="telegram_bot_url is not configured",
            code="bot_url_not_configured",
            status_code=503,
        )

    group = await _get_group_or_404(curator_user_id, group_id, session)

    existing = (
        await session.execute(
            select(CuratorGroupInvite).where(
                CuratorGroupInvite.group_id == group.id,
                CuratorGroupInvite.kind == kind,
            )
        )
    ).scalar_one_or_none()

    if existing is None:
        token = secrets.token_urlsafe(32)
        invite = CuratorGroupInvite(group_id=group.id, kind=kind, token=token)
        try:
            async with session.begin_nested():
                session.add(invite)
                await session.flush()
            # GT-16: ONLY when a link was actually minted. This endpoint is
            # create-or-return, so the curator's second press of «Пригласить»
            # returns the same token and must not add a line to the feed.
            #
            # THE TOKEN IS NOT RECORDED, HERE OR ANYWHERE. It is a raw
            # secret and the journal is a readable, paginated list; only the
            # link's KIND goes in. Do not add the token for debugging -- see
            # the model docstring.
            _record_group_event(
                group.id,
                actor,
                CuratorGroupEventKind.INVITE_CREATED,
                session,
                data={EVENT_DATA_KIND: kind},
            )
        except IntegrityError:
            # Lost a concurrent create race for this (group, kind). The
            # winner's row is the answer -- returning a second token would
            # mean two live links where the constraint allows one.
            existing = (
                await session.execute(
                    select(CuratorGroupInvite).where(
                        CuratorGroupInvite.group_id == group.id,
                        CuratorGroupInvite.kind == kind,
                    )
                )
            ).scalar_one()
            token = existing.token
    else:
        token = existing.token

    return {
        "kind": kind,
        "invite_url": (
            f"{settings.telegram_bot_url}"
            f"?startapp={_INVITE_DEEPLINK_KIND}{token}"
        ),
    }


async def revoke_curator_group_invite(
    curator_user_id: UUID,
    group_id: UUID,
    kind: str,
    session: AsyncSession,
    *,
    actor: User,
) -> None:
    """Drop the link of ONE kind. Idempotent; the other kind is untouched.

    After this the next create mints a NEW token, and the old link stops
    resolving everywhere -- preview and join alike, since both go through
    the same row. That is the whole rotation story: there is no revocation
    list, because a revoked link has no row to find.

    GT-16: recorded, and this is one of the two events the journal exists
    for most plainly -- "why did the link I handed out stop working" has
    no other answer once the row is gone. Only when a row actually died:
    revoking a link that was never minted changes nothing.
    """
    group = await _get_group_or_404(curator_user_id, group_id, session)
    revoked = (
        await session.execute(
            delete(CuratorGroupInvite)
            .where(
                CuratorGroupInvite.group_id == group.id,
                CuratorGroupInvite.kind == kind,
            )
            .returning(CuratorGroupInvite.kind)
        )
    ).first()
    if revoked is not None:
        _record_group_event(
            group.id,
            actor,
            CuratorGroupEventKind.INVITE_REVOKED,
            session,
            data={EVENT_DATA_KIND: revoked.kind},
        )


async def _resolve_invite_or_404(
    token: str, session: AsyncSession,
) -> tuple[CuratorGroupInvite, CuratorGroup]:
    """Token -> (invite, group), or 404.

    FOUR different failures collapse into one answer: the token was never
    real, it was revoked, the group is inactive (I-6), or the group is gone.
    Telling them apart would let anyone holding an old link watch a
    curator's verification status change.

    Deleted groups need no branch of their own -- ON DELETE CASCADE removed
    the invite row along with the group, so a token from a deleted group is
    indistinguishable from garbage at the storage level, not just in the
    response.
    """
    row = (
        await session.execute(
            select(CuratorGroupInvite, CuratorGroup)
            .join(CuratorGroup, CuratorGroup.id == CuratorGroupInvite.group_id)
            .where(CuratorGroupInvite.token == token, _active_group_clause())
        )
    ).one_or_none()
    if row is None:
        raise NotFoundError("Invite not found", code="invite_not_found")
    return row[0], row[1]


async def preview_curator_group_invite(
    token: str, user_id: UUID, session: AsyncSession,
) -> dict:
    """What the person sees before deciding, and why they cannot, if so.

    PREVIEW IS A HINT, JOIN IS THE GATE. Everything checked here is checked
    again by join, because the world moves between opening the card and
    tapping the button: the curator can be revoked, the link revoked, the
    person blocked. Preview exists so the screen can explain a refusal, not
    so join can skip one.

    The refusal order mirrors join's exactly (see join_curator_group_by_token
    for why it is that order); the only difference is that this function
    returns the reason and that one raises it.
    """
    invite, group = await _resolve_invite_or_404(token, session)
    masters_count, students_count = await get_group_counts(group.id, session)
    refs = await _curator_refs([group.curator_user_id], session)

    member = await _membership_row(group.id, user_id, session)
    relation = member.kind if member is not None else None
    reason: str | None = None

    if group.curator_user_id == user_id:
        reason = "own_group"
    elif await _blocked_by_curator(group.curator_user_id, user_id, session):
        reason = "blocked_by_curator"
    elif invite.kind == CuratorMemberKind.MASTER.value and not (
        await _has_master_capability(user_id, session)
    ):
        reason = "master_required"
    elif member is not None and not _is_upgrade(invite.kind, member.kind):
        # Already inside and this link would change nothing. The upgrade
        # case deliberately falls through with reason=None: the link still
        # does something for a student holding a master invite.
        reason = "already_member"

    return {
        "group": {
            "id": group.id,
            "name": group.name,
            "description": group.description,
            # GT-17. THE MOST LOAD-BEARING PLACE THE AVATAR GOES, and the
            # only one a grep for "school" would miss: this is the card a
            # person reads before deciding whether to join, where a picture
            # says more than the name does. It is also a NESTED dict passed
            # to a nested model by **, which the AST check over
            # `Schema(...)` kwargs cannot see into -- so losing this key
            # would fail nowhere. Covered by its own test, not by a line in
            # a list of places.
            "avatar_url": group.avatar_url,
            "curator_name": refs[group.curator_user_id]["display_name"],
            "masters_count": masters_count,
            "students_count": students_count,
        },
        "kind": invite.kind,
        "can_join": reason is None,
        "reason": reason,
        "relation": relation,
    }


def _is_upgrade(invite_kind: str, member_kind: str) -> bool:
    """Would this link promote an existing member?

    Only one direction exists: student -> master. There is no demotion --
    a master member opening a student link keeps their kind (TZ 3.4), so
    holding a master relation is never something a link can take away.
    """
    return (
        invite_kind == CuratorMemberKind.MASTER.value
        and member_kind == CuratorMemberKind.STUDENT.value
    )


async def join_curator_group_by_token(
    token: str,
    user_id: UUID,
    session: AsyncSession,
    *,
    actor: User,
) -> dict:
    """Join a group by invite token, or say why not.

    THE ORDER OF THE CHECKS IS A DECISION, not the order they happened to
    be written in, because the answer for someone who trips two of them at
    once depends on it:

      1. token / activity -- 404, and it hides everything below it
      2. own_group (409)  -- BEFORE the block check, so a curator's answer
         cannot depend on whether a stale master_student row happens to
         exist for them
      3. blocked (403)    -- BEFORE capability, because a block is about
         THIS school while master_required is a property of the account:
         a blocked person must not be told "you merely need verification",
         which reads as an invitation to go get verified and come back
      4. capability (403) -- only for a master link
      5. membership       -- last: it decides what to write, not whether to

    Idempotent. Joining twice returns the same row, and the second call
    reports already_member=true without touching joined_at.

    KNOWN CAVEAT on a lost race: two simultaneous first joins by one person
    both observe "no row", one wins the insert and the other catches the
    IntegrityError. Both then report already_member=false, though only one
    of them created anything. The row is correct either way -- the flag is
    computed from what the request observed before writing, which is what
    its docstring in the schema says it means, and no caller does anything
    destructive with it.

    GT-16: TWO of the thirteen event kinds are written here, and WHICH ONE
    follows the same branch that decides `relation`, never the link's kind:

      - a first join writes member_joined ONCE, carrying the kind the row
        was created with. A master link used by a newcomer is one
        member_joined with kind='master', NOT a member_joined followed by
        a member_promoted -- nobody was promoted, they arrived as a
        master.
      - a master link used by an existing student writes member_promoted
        and nothing else. They did not join; they were already here.
      - a master link used by an existing MASTER writes nothing at all.
        Idempotent above means idempotent in the journal too, or pressing
        the same link twice would fill the feed.
      - the lost-race branch writes member_promoted only if the upgrade
        actually applied. The row the winner created is the winner's news
        and the winner recorded it; this request writes only what IT
        changed, which is the promotion or nothing.
    """
    invite, group = await _resolve_invite_or_404(token, session)

    if group.curator_user_id == user_id:
        raise ConflictError(
            "This is your own group", code="own_group",
        )

    if await _blocked_by_curator(group.curator_user_id, user_id, session):
        raise ForbiddenError(
            "The curator has restricted your access",
            code="blocked_by_curator",
        )

    if invite.kind == CuratorMemberKind.MASTER.value and not (
        await _has_master_capability(user_id, session)
    ):
        raise ForbiddenError(
            "This link is for verified masters",
            code="master_required",
        )

    member = await _membership_row(group.id, user_id, session)

    if member is None:
        row = CuratorGroupMember(
            group_id=group.id, user_id=user_id, kind=invite.kind,
        )
        try:
            async with session.begin_nested():
                session.add(row)
                await session.flush()
            relation = invite.kind
            _record_group_event(
                group.id,
                actor,
                CuratorGroupEventKind.MEMBER_JOINED,
                session,
                data={EVENT_DATA_KIND: invite.kind},
            )
        except IntegrityError:
            # Lost a concurrent join. The winner's row is the answer; if it
            # is a student row and this was a master link, the upgrade still
            # applies -- otherwise the loser of the race would silently be
            # denied the promotion the link grants.
            winner = await _membership_row(group.id, user_id, session)
            promoted = winner is not None and _is_upgrade(
                invite.kind, winner.kind,
            )
            if promoted:
                winner.kind = CuratorMemberKind.MASTER.value
                await session.flush()
            relation = winner.kind if winner is not None else invite.kind
            if promoted:
                _record_group_event(
                    group.id,
                    actor,
                    CuratorGroupEventKind.MEMBER_PROMOTED,
                    session,
                )
        already_member = False
    else:
        already_member = True
        if _is_upgrade(invite.kind, member.kind):
            # The ONLY mutation of an existing membership row in this
            # module. joined_at is deliberately NOT refreshed: the person
            # has been in this school since the day they walked in, and
            # kind describes their role, not their arrival.
            member.kind = CuratorMemberKind.MASTER.value
            await session.flush()
            _record_group_event(
                group.id,
                actor,
                CuratorGroupEventKind.MEMBER_PROMOTED,
                session,
            )
        relation = member.kind

    return {
        "group_id": group.id,
        "relation": relation,
        "already_member": already_member,
    }


# ===========================================================================
# Transfer of ownership (GT-4, tz-curator-groups.md 3.4 / 3.5)
#
# curator_group_transfer has held one invariant since GT-1 and no writer:
# UNIQUE (group_id) -- at most one pending offer per group. This section is
# that writer. A row IS the offer: cancelling is a DELETE, declining is a
# DELETE, and "no offer" is the absence of a row rather than a state anyone
# has to interpret.
# ===========================================================================


async def _pending_transfer(
    group_id: UUID, session: AsyncSession,
) -> CuratorGroupTransfer | None:
    return (
        await session.execute(
            select(CuratorGroupTransfer).where(
                CuratorGroupTransfer.group_id == group_id
            )
        )
    ).scalar_one_or_none()


async def _transfer_refs_for_groups(
    group_ids: list[UUID], session: AsyncSession,
) -> dict[UUID, dict]:
    """Pending offers for many groups in ONE query, keyed by group.

    Batched for the same reason the counters are: the curator's list can
    hold any number of groups, and a lookup per row would turn one page
    into N round trips. Groups without an offer are simply absent, and
    callers read the dict through .get() -- "no offer" is the absence of a
    row, here as in the table.

    to_display_name comes from users/helpers.py::display_name, NOT the
    master-profile rule -- see CuratorGroupTransferRef's docstring.
    """
    if not group_ids:
        return {}
    rows = (
        await session.execute(
            select(
                CuratorGroupTransfer.group_id,
                CuratorGroupTransfer.to_user_id,
                CuratorGroupTransfer.requested_at,
                User.first_name,
                User.last_name,
            )
            .outerjoin(User, User.id == CuratorGroupTransfer.to_user_id)
            .where(CuratorGroupTransfer.group_id.in_(group_ids))
        )
    ).all()
    return {
        gid: {
            "to_user_id": to_user_id,
            "to_display_name": display_name(first_name, last_name),
            "requested_at": requested_at,
        }
        for gid, to_user_id, requested_at, first_name, last_name in rows
    }


async def _transfer_ref(
    transfer: CuratorGroupTransfer | None, session: AsyncSession,
) -> dict | None:
    """One offer in the shape the responses report, or None."""
    if transfer is None:
        return None
    refs = await _transfer_refs_for_groups([transfer.group_id], session)
    return refs.get(transfer.group_id)


async def get_group_transfer_ref(
    group_id: UUID, session: AsyncSession,
) -> dict | None:
    """This group's pending offer, or None -- for the curator's own replies.

    Public because the router builds CuratorGroupResponse by hand on create
    and patch; every other caller goes through the batched form, which is
    what the list endpoint needs. No viewer filter here: the two callers are
    curator-only endpoints behind get_current_master with ownership already
    resolved. The page endpoint, which IS read by non-owners, goes through
    _transfer_for_viewer instead.
    """
    refs = await _transfer_refs_for_groups([group_id], session)
    return refs.get(group_id)


async def _drop_pending_transfer_for(
    group_id: UUID, user_id: UUID, session: AsyncSession,
) -> bool:
    """Drop the offer if it was addressed to this person leaving the group.

    TZ 3.4 names EXACTLY TWO points where an offer disappears because its
    addressee is gone -- leave and remove_member -- and this helper is why
    there are two call sites and not two copies. A third copy would be the
    one that gets forgotten when the rule changes.

    Scoped to (group, addressee): somebody else walking out of the same
    group must not cancel a pending offer they have nothing to do with.

    RETURNS WHETHER AN OFFER ACTUALLY DIED, and THE RESULT HAS A READER --
    the journal (GT-16). The departure event carries transfer_cancelled
    only when there was something to cancel; without this return value the
    call site would have to either guess or run its own SELECT. Do not
    narrow this back to None on the grounds that nothing uses it.

    The retraction is deliberately NOT an event of its own: it has no
    actor. Nobody cancelled the offer -- it stopped having an addressee,
    which is a consequence of the departure and belongs inside that
    departure's record.
    """
    result = await session.execute(
        delete(CuratorGroupTransfer).where(
            CuratorGroupTransfer.group_id == group_id,
            CuratorGroupTransfer.to_user_id == user_id,
        )
    )
    return bool(result.rowcount)


async def offer_curator_group_transfer(
    curator_user_id: UUID,
    group_id: UUID,
    to_user_id: UUID,
    session: AsyncSession,
    *,
    actor: User,
) -> dict:
    """Offer the group to a visible master member of it.

    THE ELIGIBLE SET IS EXACTLY THE ROSTER (I-10): kind='master' and
    verified right now. Reusing _visible_master_ids rather than writing a
    second membership query is what keeps "who can receive this group" and
    "who is shown as a teacher of this school" from ever disagreeing.

    A student, a stranger, a suspended master and the curator themselves all
    get the SAME 404 -- the curator already knows who is in their group, so
    distinguishing the cases would buy nothing and would leak the
    verification status of a member who is currently in the shadow.

    A second offer while one is pending is a 409, never a silent overwrite:
    the first addressee may already be looking at the banner, and replacing
    the offer under them would retract it without anyone saying so.
    """
    group = await _get_group_or_404(curator_user_id, group_id, session)

    if await _pending_transfer(group.id, session) is not None:
        raise ConflictError(
            "This group already has a pending transfer",
            code="transfer_pending",
        )

    if to_user_id not in await _visible_master_ids(group.id, session):
        raise NotFoundError(
            "Transfer target is not a member of this group",
            code="transfer_target_not_member",
        )

    transfer = CuratorGroupTransfer(group_id=group.id, to_user_id=to_user_id)
    try:
        async with session.begin_nested():
            session.add(transfer)
            await session.flush()
    except IntegrityError:
        # Lost a race with another offer on the same group. UNIQUE
        # (group_id) is the real guard; the pre-check above is the fast
        # path that produces a clean 409 instead of a 500.
        raise ConflictError(
            "This group already has a pending transfer",
            code="transfer_pending",
        ) from None

    # Re-read rather than hand-building the dict: the row was just flushed,
    # so this reports what the table holds, not what we meant to put there.
    refs = await _transfer_refs_for_groups([group.id], session)

    # GT-16: the addressee's frozen name comes FREE here -- the re-read
    # above already computed it for the reply, by the same
    # display_name(first, last) rule the journal uses. This is the one
    # target of four that costs no extra query.
    _record_group_event(
        group.id,
        actor,
        CuratorGroupEventKind.TRANSFER_OFFERED,
        session,
        data=_target_data(to_user_id, refs[group.id]["to_display_name"]),
    )
    return refs[group.id]


async def cancel_curator_group_transfer(
    curator_user_id: UUID,
    group_id: UUID,
    session: AsyncSession,
    *,
    actor: User,
) -> None:
    """Withdraw the pending offer. Idempotent: no offer -> still 204.

    GT-16: RETURNING carries the addressee out of the row being deleted --
    after the DELETE nothing remembers who the offer was for, and the
    journal entry has to say. It also answers whether there was an offer
    at all, so cancelling nothing writes nothing.

    Distinct from the auto-retraction inside leave/remove, which is not an
    event: that one has no actor. This one does -- the curator changed
    their mind.
    """
    group = await _get_group_or_404(curator_user_id, group_id, session)
    cancelled = (
        await session.execute(
            delete(CuratorGroupTransfer)
            .where(CuratorGroupTransfer.group_id == group.id)
            .returning(CuratorGroupTransfer.to_user_id)
        )
    ).first()
    if cancelled is not None:
        _record_group_event(
            group.id,
            actor,
            CuratorGroupEventKind.TRANSFER_CANCELLED,
            session,
            data=_target_data(
                cancelled.to_user_id,
                await _frozen_name(cancelled.to_user_id, session),
            ),
        )


async def _transfer_for_viewer(
    group: CuratorGroup, viewer_id: UUID, session: AsyncSession,
) -> dict | None:
    """The offer as THIS viewer is allowed to see it (TZ 5.2).

    Two people see it: the curator, who made it, and the addressee, who has
    to answer it. Everyone else gets None -- not a redacted object, not a
    missing key. A member who is not part of the deal does not learn that
    one is under way.
    """
    transfer = await _pending_transfer(group.id, session)
    if transfer is None:
        return None
    if viewer_id not in (group.curator_user_id, transfer.to_user_id):
        return None
    return await _transfer_ref(transfer, session)


async def accept_curator_group_transfer(
    group_id: UUID,
    user_id: UUID,
    session: AsyncSession,
    *,
    actor: User,
) -> dict:
    """Become the curator of this group. One transaction, seven steps.

    THE ORDER IS THE CONTRACT (TZ 3.5), and every check happens BEFORE the
    first mutation:

      1. the offer exists and is addressed to the caller; the group is
         active; the caller is a verified master right now; the caller has
         no group of their own by this name
      2. curator_user_id := caller
      3. the caller's own member row is deleted (I-2: a curator is not a
         member of their own group)
      4. the previous curator gets a member row, kind='master', joined_at
         = now()
      5. the offer row is deleted
      6. invite links and every other membership are left alone -- the
         tokens already in people's chats keep working
      7. the reply is the group page as the NEW curator sees it

    THE NAME COLLISION IS CHECKED IN STEP 1, NOT CAUGHT IN STEP 2. UNIQUE
    (curator_user_id, name) would raise on the rename-by-ownership at step
    2 -- after which three more mutations would already be queued behind a
    broken transaction. Asking first turns a rollback into a clean 409.

    STEP 4 CREATES A kind='master' ROW WITHOUT A CAPABILITY GATE, unlike
    join, which insists on it (I-3). That is deliberate and not an
    oversight: the previous curator's verified status was the precondition
    for the group being ACTIVE, and an inactive group never reaches step 1 --
    so by the time step 4 runs, their capability has just been proven by the
    call itself. I-3 governs joining by link; a transfer is not a join.

    404 covers "no offer", "not addressed to you" and "group inactive"
    alike: accept changes who owns a school, so it must not confirm that an
    offer exists to somebody probing group ids.

    GT-16: the event's target is THE PREVIOUS CURATOR, and it is read from
    previous_curator_id -- the local captured at step 2, BEFORE the
    assignment. This is the one place in the module where that matters
    enough to say out loud: after `group.curator_user_id = user_id` the
    previous owner exists nowhere in this function's reach, so taking "the
    group's curator" at record time would write the ACTOR as the target
    and the feed would read "Пётр принял школу от Петра". The capture is
    not a convenience; moving the record above it, or re-reading the group
    instead, silently produces that sentence.
    """
    group, _relation = await _relation_or_404(group_id, user_id, session)

    transfer = await _pending_transfer(group.id, session)
    if transfer is None or transfer.to_user_id != user_id:
        raise NotFoundError("Transfer not found", code="transfer_not_found")

    if not await _has_master_capability(user_id, session):
        raise ForbiddenError(
            "Only a verified master can take over a group",
            code="master_required",
        )

    clash = (
        await session.execute(
            select(CuratorGroup.id).where(
                CuratorGroup.curator_user_id == user_id,
                CuratorGroup.name == group.name,
            )
        )
    ).scalar_one_or_none()
    if clash is not None:
        raise ConflictError(
            f"You already curate a group named '{group.name}'",
            code=_NAME_TAKEN_CODE,
        )

    previous_curator_id = group.curator_user_id

    group.curator_user_id = user_id

    await session.execute(
        delete(CuratorGroupMember).where(
            CuratorGroupMember.group_id == group.id,
            CuratorGroupMember.user_id == user_id,
        )
    )

    session.add(
        CuratorGroupMember(
            group_id=group.id,
            user_id=previous_curator_id,
            kind=CuratorMemberKind.MASTER.value,
        )
    )

    await session.execute(
        delete(CuratorGroupTransfer).where(
            CuratorGroupTransfer.group_id == group.id
        )
    )

    _record_group_event(
        group.id,
        actor,
        CuratorGroupEventKind.TRANSFER_ACCEPTED,
        session,
        data=_target_data(
            previous_curator_id,
            await _frozen_name(previous_curator_id, session),
        ),
    )

    await session.flush()

    return await get_curator_group_page(group.id, user_id, session)


async def decline_curator_group_transfer(
    group_id: UUID,
    user_id: UUID,
    session: AsyncSession,
    *,
    actor: User,
) -> None:
    """Refuse the offer. Idempotent, and silent about offers not yours.

    DECLINE ANSWERS 204 WHERE ACCEPT ANSWERS 404, and the asymmetry is the
    point. Accept changes who owns a school, so it has to tell "there is no
    offer" apart from "the offer is not yours" -- and it refuses to, which
    is what closes off probing. Decline changes nothing: refusing something
    that was never offered to you leaves the world in the state you asked
    for, so reporting success is honest and reveals nothing about whether an
    offer existed.

    Not gated on the group being active, for the same reason leave is not:
    an answer the addressee is entitled to give must not depend on somebody
    else's verification status.

    GT-16: THIS FUNCTION DELIBERATELY NEVER LOADED THE GROUP, and the
    journal needs it to -- but only after the DELETE reports that an offer
    really died. curator_group_transfer has three columns (group_id,
    to_user_id, requested_at) and no from_user_id: whoever offered is
    IMPLICITLY the group's curator, so the target of this event cannot be
    read out of the row being deleted. Hence one SELECT, and it runs only
    on the path that writes -- declining an offer that was never made
    still costs nothing and still answers 204.

    The 204-vs-404 asymmetry above is untouched: the SELECT decides what
    to record, never what to answer.
    """
    declined = (
        await session.execute(
            delete(CuratorGroupTransfer)
            .where(
                CuratorGroupTransfer.group_id == group_id,
                CuratorGroupTransfer.to_user_id == user_id,
            )
            .returning(CuratorGroupTransfer.group_id)
        )
    ).first()
    if declined is None:
        return

    offered_by = (
        await session.execute(
            select(CuratorGroup.curator_user_id).where(
                CuratorGroup.id == declined.group_id
            )
        )
    ).scalar_one_or_none()
    if offered_by is None:
        # The group vanished under us -- the FK would refuse the event
        # anyway, and there is no school left to hold a journal.
        return

    _record_group_event(
        declined.group_id,
        actor,
        CuratorGroupEventKind.TRANSFER_DECLINED,
        session,
        data=_target_data(
            offered_by, await _frozen_name(offered_by, session),
        ),
    )


# ===========================================================================
# Advisory previews (P5/GT-12, tz-curator-groups.md 8.5)
#
# Three read-only counts behind three confirm dialogs. NOTHING HERE BLOCKS
# ANYTHING: leave, remove_curator_group_member and delete_curator_group are
# byte-for-byte unchanged, and a caller who never asks these questions gets
# the same behaviour as before. The point is that the person doing something
# irreversible sees its price first.
# ===========================================================================


_UPCOMING_PRACTICE_STATUSES = (
    PracticeStatus.SCHEDULED.value,
    PracticeStatus.LIVE.value,
)


async def _upcoming_practices_targeting_group(
    group_id: UUID,
    master_ids: list[UUID],
    session: AsyncSession,
) -> int:
    """Upcoming practices by these masters that target this school.

    "UPCOMING" IS THE FEED'S OWN DEFINITION, read from the body of
    list_public_practices rather than reinvented: status in
    {scheduled, live} AND scheduled_at strictly in the future. Strictly --
    a practice starting this instant is not upcoming, and the feed says so
    with `>` rather than `>=`.

    A DRAFT IS NOT COUNTED. It is visible to nobody but its author, so its
    audience is nobody's business yet; counting it would inflate the number
    in the dialog with practices that were never reaching the school in the
    first place.

    Each occurrence of a series counts on its own -- every child carries its
    own audience rows and its own date, so "how many sessions go dark" is a
    count of sessions, not of series.

    An empty master list yields 0 without a query: the school has nobody who
    could be pointing a practice at it.
    """
    if not master_ids:
        return 0
    return (
        await session.execute(
            select(func.count(Practice.id))
            .join(
                PracticeAudienceCuratorGroup,
                PracticeAudienceCuratorGroup.practice_id == Practice.id,
            )
            .where(
                PracticeAudienceCuratorGroup.group_id == group_id,
                Practice.master_id.in_(master_ids),
                Practice.status.in_(_UPCOMING_PRACTICE_STATUSES),
                Practice.scheduled_at > datetime.now(UTC),
            )
        )
    ).scalar_one()


async def leave_preview(
    group_id: UUID, user_id: UUID, session: AsyncSession,
) -> dict:
    """What this person switches off by leaving the school.

    Resolved through _relation_or_404, so a stranger gets the same 404 the
    group page gives them, and an INACTIVE school gives 404 too. That last
    part is asymmetric with leave() itself, which deliberately does not
    check activity (I-5: a member of a frozen school must still be able to
    walk out). The asymmetry is a decision, not an oversight: an advisory
    does not have to be reachable wherever the action is, and a second,
    softer resolver here would be a copy of the access rule that drifts from
    the original. Practical consequence for the frontend: on a frozen school
    the exit dialog shows no advice while the button still works.

    THE CURATOR GETS A NUMBER, not a 409. They cannot leave (the group would
    be orphaned), but they are the one person who might hand the school over
    instead, and seeing the price of walking away is exactly the input for
    that decision. Refusing to answer would hide from the owner facts about
    their own school.
    """
    group, _relation = await _relation_or_404(group_id, user_id, session)
    count = await _upcoming_practices_targeting_group(
        group.id, [user_id], session,
    )
    return {"upcoming_practices_targeting_group": count}


async def remove_member_preview(
    curator_user_id: UUID,
    group_id: UUID,
    user_id: UUID,
    session: AsyncSession,
) -> dict:
    """What the curator switches off by removing this member.

    404 only for a group that is not this curator's -- never for the member.
    remove_curator_group_member answers 204 for somebody who is not in the
    group, and an advisory that refused the same target would be stricter
    than the action it is advising about.
    """
    group = await _get_group_or_404(curator_user_id, group_id, session)
    count = await _upcoming_practices_targeting_group(
        group.id, [user_id], session,
    )
    return {"upcoming_practices_targeting_group": count}


async def delete_group_preview(
    curator_user_id: UUID, group_id: UUID, session: AsyncSession,
) -> dict:
    """What deleting the school costs -- people and practices.

    The practice count spans EVERY master of the school: the visible member
    masters plus the curator, who holds no membership row (I-2) and would be
    missed by a literal read of the roster. Their own practices go dark with
    the school like anyone else's.

    masters_count / students_count come from get_group_counts, the same
    helper the group page uses, so the dialog cannot report a different
    school size than the page behind it.
    """
    group = await _get_group_or_404(curator_user_id, group_id, session)
    masters_count, students_count = await get_group_counts(group.id, session)
    master_ids = [
        group.curator_user_id,
        *await _visible_master_ids(group.id, session),
    ]
    count = await _upcoming_practices_targeting_group(
        group.id, master_ids, session,
    )
    return {
        "masters_count": masters_count,
        "students_count": students_count,
        "upcoming_practices_targeting_group": count,
    }
