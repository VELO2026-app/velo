# =============================================================================
# VELO Backend -- Practice Service (Phase 4.2 + 4.3/4.4, updated Phase 6.5,
#                                   updated Frontend F3 prep, + Calendar taxonomy)
# =============================================================================
#
# Business logic for practice CRUD (master-facing) and public listing.
#
# MASTER_NAME / MASTER_METHODS (Frontend F3 prep, DS-sprint):
#   practice_to_response() builds PracticeResponse with master_name and
#   master_methods. master_name is the full "First Last" name, built by
#   master_full_name() from User.first_name + User.last_name in every JOIN /
#   mutation path (MVP rule: Telegram name, surname appended only if present).
#   master_methods come from MasterProfile.data via OUTER JOIN; get_practice()
#   outer-joins MasterProfile to return methods. If MasterProfile is missing,
#   master_methods defaults to [].
#   List functions pass master_methods=[] (methods not shown in list cards).
#
# CALENDAR TAXONOMY (Calendar iteration):
#   direction / style / difficulty are catalog facets stored in the
#   Practice.data JSONB sandbox under data.taxonomy (schema-on-read). They
#   are NOT columns:
#     - create_practice() writes them into data.taxonomy via set_jsonb().
#     - update_practice() handles them in a SEPARATE JSONB branch -- they are
#       pulled out of update_data BEFORE the setattr() loop, otherwise
#       setattr(practice, "direction", ...) would create a dead Python
#       attribute that never reaches the DB (same trap as onboarding_completed
#       in users/service.py).
#     - practice_to_response() extracts them back out for the API response.
#   JSONB SAFETY: always deepcopy + set_jsonb("data", ...). Never mutate
#   practice.data in place (SQLAlchemy would miss the change).
#
# OWNERSHIP:
#   create_practice makes the caller the master, unless a school curator
#   names a verified master of that school (BE-102,
#   _effective_master_id_or_4xx) -- the practice is then that master's.
#   All mutating operations (update, delete, cancel) verify master_id == user.id.
#   Non-owners receive 404 (P-08: do not reveal resource existence).
#   get_practice() applies visibility rules: draft/deleted only for owner.
#
# STATE MACHINE:
#   draft          -> scheduled, deleted   (via PATCH)
#   scheduled      -> live                  (auto, by schedule -- NOT via PATCH)
#   scheduled/live -> completed             (auto, by schedule -- NOT via PATCH)
#   completed      -> (terminal)
#   cancelled      -> (terminal)
#   deleted        -> (terminal)
#
# IMPORTANT (Phase 6.5):
#   scheduled -> cancelled and live -> cancelled are NOT allowed via PATCH.
#   The ONLY path to cancelled is through cancel_practice() which handles
#   refunds for all active bookings.
#
# IMPORTANT (Batch 1 -- lifecycle automation):
#   scheduled -> live and live -> completed are NO LONGER allowed via PATCH
#   either. Both are performed by the background lifecycle worker
#   (bookings/autofinalize.py) as the system, driven by the clock:
#     start:  scheduled -> live      once scheduled_at passes;
#     finish: scheduled/live -> completed once scheduled_at + duration passes
#             (auto_finalize_practice runs the full settlement core).
#   So PATCH only ever drives draft -> scheduled (publish) and draft -> deleted.
#
# PRICING (Phase 4.3/4.4):
#   is_free=True  -> price_cents forced to 0 (service overrides any value)
#   is_free=False -> price_cents must be > 0 (service raises 400)
#
# CONCURRENCY:
#   update_practice(), delete_practice(), and cancel_practice() use
#   with_for_update() (P-12) to prevent lost updates on status transitions.
#
# PRACTICE ROW ORDER (the ONE record of it; every other place points here):
#   A writer that holds MORE THAN ONE practice row in a transaction takes
#   ALL of them in ONE statement, ORDER BY Practice.id, FOR UPDATE -- and
#   takes no practice row before or after that statement. LockRows sits
#   above the Sort in that plan (EXPLAIN, BE-64 follow-up), so the rows are
#   locked in id order. Two such writers then meet at the lowest common id
#   and the second waits holding nothing it shares with the first; a
#   writer of ONE practice cannot close a cycle among practices at all.
#   Rows a writer must decide on (status, right, the series boundary) are
#   read WITHOUT a lock first and re-checked on the locked rows -- with
#   populate_existing=True wherever the read already put the row in the
#   session (BE-85).
#
#   Writers of several practices and where they take them:
#     cancel_practice, this_and_future (practices/cancel_service.py):
#       the primary and its series in one statement, the time boundary
#       applied after the lock (_lock_cancel_set);
#     delete_curator_group (curator_groups/service.py): the school's
#       practices, before its UPDATE of them;
#     block_student (masters/groups_service.py): the student's future
#       practices of the master (BE-99, already in this form).
#     block_curator_group_member (curator_groups/service.py,
#       _close_school_practices_to, BE-79): the school's practices where the
#       blocked person has a future booking or a queue entry, and his own
#       practices of the school (K3), in one statement, before their
#       bookings.
#     update_practice changing a series root's audience: the root and its
#       non-terminal children, before the school (_lock_practice_and_
#       children); whether to take the children is decided on the
#       unlocked read and re-decided on the locked root, and a
#       non-terminal child the lock does not hold -- the read went stale,
#       or the child was born while the lock waited -- refuses the edit
#       with 409 series_audience_changed rather than taking a practice
#       outside the statement (_refuse_unheld_children_or_409).
#   Second cycle of the same pair, not through practices: block_student's
#   master_student upsert holds KEY SHARE on the student's users row, and a
#   cancellation refunding that student locks the row for the balance --
#   payments/service.py::record_user_ledger takes it FOR NO KEY UPDATE, which
#   does not conflict with KEY SHARE (BE-64 follow-up, O2).
#
#   What comes after the practice rows stays as recorded elsewhere:
#   practice -> group (curator_groups/service.py, header) and
#   practice -> booking (masters/groups_service.py, header).
#
# DELETE vs CANCEL:
#   DELETE sets status=deleted (only from draft).
#   CANCEL sets status=cancelled + refunds all bookings (Phase 6.5).
#
# SESSION RULES:
#   No session.commit() here (P-01). Router handles flush + refresh.
# =============================================================================

import copy
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import structlog
from sqlalchemy import and_, delete, func, or_, select
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import (
    BadRequestError,
    ConflictError,
    ForbiddenError,
    NotFoundError,
)
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupMember,
    CuratorMemberKind,
)
from app.modules.masters.groups_models import MasterGroup
from app.modules.masters.models import MasterProfile
from app.modules.practices.audience_service import (
    count_stranded_active_bookings,
    curator_group_audience_is_dark,
)
from app.modules.practices.enrichment_service import (
    attendance_counts_for_practices,
    attendance_counts_kwargs,
    series_meta_for_practices,
    series_meta_kwargs,
)
from app.modules.practices.models import (
    AudienceKind,
    Practice,
    PracticeAudienceGroup,
    PracticeStatus,
    PracticeType,
)
from app.modules.practices.schemas import (
    CreatePracticeRequest,
    PracticeResponse,
    UpdatePracticeRequest,
    check_school_audience,
)
from app.modules.practices.series_service import (
    _TERMINAL_CHILD_STATUSES,
    generate_series_occurrences,
)
from app.modules.practices.taxonomy_models import TaxonomyDirection, TaxonomyStyle
from app.modules.users.models import User

logger = structlog.get_logger()

# Statuses visible to any authenticated user.
_PUBLIC_STATUSES = {
    PracticeStatus.SCHEDULED.value,
    PracticeStatus.LIVE.value,
    PracticeStatus.COMPLETED.value,
    PracticeStatus.CANCELLED.value,
}

# Valid state transitions via PATCH. Terminal states (and states whose only
# remaining transitions are automated) have no outgoing edges here.
# Phase 6.5: cancelled is removed -- the ONLY way to reach cancelled is via
# cancel_practice() which handles refunds, preventing an accidental PATCH
# status=cancelled that would skip refund logic.
# Batch 1: scheduled -> live and live -> completed are removed too -- both are
# driven by the clock by the lifecycle worker (bookings/autofinalize.py:
# auto_start_practice / auto_finalize_practice) as the system, not by PATCH.
# So the ONLY PATCH-driven transitions left are draft -> scheduled (publish)
# and draft -> deleted.
_VALID_TRANSITIONS: dict[str, set[str]] = {
    PracticeStatus.DRAFT.value: {
        PracticeStatus.SCHEDULED.value,
        PracticeStatus.DELETED.value,
    },
}

# NOT NULL columns that cannot be set to None via PATCH (P-02).
_NOT_NULL_FIELDS = {
    "title",
    "scheduled_at",
    "duration_minutes",
    "timezone",
    "is_free",
    "price_cents",
    "currency",
}

# Booking statuses that count as "active" for the price-change guard.
_ACTIVE_BOOKING_STATUSES = {
    BookingStatus.PENDING.value,
    BookingStatus.CONFIRMED.value,
}

# Booking statuses that mark a practice as "booked" for the requesting user
# in feed/detail responses (is_booked). Includes ATTENDED so a practice the
# user already attended still shows as theirs. Cancelled/no_show excluded.
_BOOKED_STATUSES = {
    BookingStatus.PENDING.value,
    BookingStatus.CONFIRMED.value,
    BookingStatus.ATTENDED.value,
}

# Booking statuses that grant a user access to this practice's PERSONAL Zoom
# link (M-3 access gate). STRICTER than _BOOKED_STATUSES above: a PENDING
# booking does NOT unlock the link -- only CONFIRMED or ATTENDED does. Read by
# GET /bookings/me for zoom_registrant_join_url and by zoom/service.py's
# resolve_zoom_entry (T-35) for the 'personal' rung. NOTE for that resolver:
# the set that decides "guest or not" is deliberately WIDER than this one --
# see _LIVE_BOOKING_STATUSES there.
ZOOM_VISIBLE_BOOKING_STATUSES = {
    BookingStatus.CONFIRMED.value,
    BookingStatus.ATTENDED.value,
}

# S-c: statuses that let a NON-audience viewer through the detail read gate
# (get_practice_detail). Same composition as the zoom set and deliberately
# an ALIAS of it rather than a copy -- two literal sets drift, and the day
# they do, one of them silently widens an access gate. The name exists
# because "zoom_visible" says nothing about reading a restricted practice.
#
# Why not _BOOKED_STATUSES (which the is_booked BADGE uses): that set
# includes PENDING, and a pending booking is an intent, not an entitlement
# -- anyone able to create one would otherwise read practices their
# audience excludes them from. The badge keeps PENDING; the gate does not.
_ACCESS_GRANTING_STATUSES = ZOOM_VISIBLE_BOOKING_STATUSES

# Calendar taxonomy facets -- stored in Practice.data.taxonomy (JSONB),
# NOT as columns. Handled separately from setattr-based column updates.
_TAXONOMY_FIELDS = ("direction", "style", "difficulty")


# ===================================================================
# Helpers
# ===================================================================


async def _owned_root_parent_or_400(
    master_id: UUID, parent_id: UUID | None, session: AsyncSession,
) -> Practice | None:
    """H-R2 (3.4): a series occurrence may only attach to (a) an EXISTING
    practice, (b) owned by THIS master, (c) that is itself a ROOT (no
    grandchildren -- occurrences of occurrences are not a thing).

    One 400 for all three refusals, deliberately not distinguishing
    "someone else's" from "does not exist" -- same anti-enumeration
    reflex as _owned_group_ids_or_400 below (a 400/404 split would leak
    which foreign practice ids exist). Also converts what would be a raw
    FK IntegrityError (-> 500) on a nonexistent id into a clean 400.

    Returns the validated parent (None when parent_id is None) so the
    caller can inherit from it without a second fetch -- T-23 (owner-ruled
    2026-08-17) needs the parent's audience_kind and group rows.

    The parent is LOCKED, FOR SHARE, and held to the commit (BE-103 W-a):
    the child inherits the parent's audience from this row and the
    parent's group rows after its INSERT, and both must be one state of
    the parent. A plain read let an audience edit of the root commit in
    between -- the child came out with the old kind and the new rows
    (public -> groups: a public child without groups; groups -> public: a
    'groups' child with none). Under the lock the edit (update_practice,
    FOR UPDATE on the root) waits for this transaction, or this lock waits
    for the edit and reads it whole.

    WHY FOR SHARE, not KEY SHARE (the strength the child's FK takes
    anyway): KEY SHARE conflicts only with FOR UPDATE. Every writer of the
    root's audience takes FOR UPDATE today -- but the first writer that
    updates it with a plain UPDATE (FOR NO KEY UPDATE) would pass a KEY
    SHARE and bring W-a back silently. FOR SHARE conflicts with both; the
    reason for the strength is that conflict, not today's list of writers.
    No upgrade follows: the FK check's KEY SHARE is weaker than what is
    held.

    The other half of the window is update_practice's: a child born while
    its lock statement waits on the root is not in that statement's set,
    and the edit is refused with 409 (_refuse_unheld_children_or_409).

    WHERE it is called is part of the order (PRACTICE ROW ORDER, and the
    curator_groups module header: member -> master profile -> practice ->
    group): before any group lock. On the path for another master that is
    inside _effective_master_id_or_4xx, between the target's rows and the
    school; on the caller's own path, in create_practice, which locks no
    group at all.

    populate_existing: no read on today's create path loads the parent
    before this lock, but the session is the caller's, and a lock does not
    refresh an object already in it (BE-85) -- the inherited audience must
    come from the locked row, whoever loaded it first.
    """
    if parent_id is None:
        return None
    parent = (
        await session.execute(
            select(Practice)
            .where(Practice.id == parent_id)
            .with_for_update(read=True)
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    if (
        parent is None
        or parent.master_id != master_id
        or parent.parent_practice_id is not None
    ):
        raise BadRequestError(
            "parent_practice_id must be your own root practice"
        )
    return parent


async def _owned_group_ids_or_400(
    master_id: UUID, group_ids: list[UUID], session: AsyncSession,
) -> None:
    """Validate every group_id in a create/update audience payload belongs
    to a CUSTOM group owned by master_id (Master GROUPS P5, PROMPT №594).

    Rejects another master's group, an unknown id, or a system slug (which
    never resolves to a real MasterGroup row in the first place) with a
    single 400 -- P-08 does not apply here (the master is choosing among
    THEIR OWN resources, not probing another's).
    """
    if not group_ids:
        return
    owned = (
        await session.execute(
            select(MasterGroup.id).where(
                MasterGroup.id.in_(group_ids), MasterGroup.master_id == master_id,
            )
        )
    ).scalars().all()
    if set(owned) != set(group_ids):
        raise BadRequestError(
            "group_ids must be your own custom groups"
        )


_SCHOOL_NOT_USABLE = "curator_group_id must be an active school you belong to"
# FE-92 follow-up: the refusal's own code, so the front can say «the school
# is unavailable» instead of a generic «bad request». ONE code for every
# cause (schools switched off, no such / inactive school, not a member of it,
# the school deleted mid-create) -- the same reason the message is one.
_SCHOOL_NOT_USABLE_CODE = "curator_group_not_usable"


async def _usable_curator_group_or_400(
    master_id: UUID, group_id: UUID, session: AsyncSession,
) -> None:
    """Refuse a school this master may not create a practice in (BE-74).

    THREE conditions, all required: schools are switched on; the school is
    ACTIVE (its curator is verified right now); this master belongs to it
    -- as its curator, or as a kind='master' member. The last two are
    exactly the set audience_service.py's predicate accepts later;
    validating against a narrower or wider rule here would let a master
    save a practice the school cannot see, or refuse one it would.

    THE KILLSWITCH IS READ HERE (BE-74, new). Setting the owning school is
    a new write path outside the school routers, and a path that does not
    listen to curator_groups_enabled is the hole BE-43 closed twice. With
    schools off, "this school" is not a school you can use.

    Single 400 with one message, no split by cause -- P-08 does not apply
    (the master is choosing among their OWN schools, not probing somebody
    else's). The same message as a school deleted between this check and
    the INSERT (create_practice), because it is the same fact.
    """
    if not settings.curator_groups_enabled:
        raise BadRequestError(_SCHOOL_NOT_USABLE, code=_SCHOOL_NOT_USABLE_CODE)
    verified = (
        select(MasterProfile.user_id)
        .where(
            MasterProfile.user_id == CuratorGroup.curator_user_id,
            MasterProfile.data["account"]["status"].as_string() == "verified",
        )
        .exists()
    )
    master_belongs = or_(
        CuratorGroup.curator_user_id == master_id,
        select(CuratorGroupMember.id)
        .where(
            CuratorGroupMember.group_id == CuratorGroup.id,
            CuratorGroupMember.user_id == master_id,
            CuratorGroupMember.kind == CuratorMemberKind.MASTER.value,
        )
        .exists(),
    )
    usable = (
        await session.execute(
            select(CuratorGroup.id).where(
                CuratorGroup.id == group_id, verified, master_belongs,
            )
        )
    ).scalar_one_or_none()
    if usable is None:
        raise BadRequestError(_SCHOOL_NOT_USABLE, code=_SCHOOL_NOT_USABLE_CODE)


_MASTER_NOT_IN_SCHOOL = "master_id must be a verified master of this school"


async def _effective_master_id_or_4xx(
    user: User, body: CreatePracticeRequest, session: AsyncSession,
) -> tuple[UUID, Practice | None]:
    """Return who leads the practice being created (BE-102) -- and, on the
    path for another master, the locked series parent (BE-103 N1; None
    without parent_practice_id, and always None on the caller's own path,
    where create_practice locks the parent itself).

    The caller, unless body.master_id names somebody else. Somebody else is
    a school curator creating a practice for a master of that school, and
    is accepted only when ALL of these hold (owner ruling, 2026-10-01):

      1. the request names the school (curator_group_id, explicitly --
         a child's school inherited from its parent does not count: the
         rule is "created IN a school", said by the request itself);
      2. the school is usable by the caller at all -- schools switched on,
         the school active, the caller in it (_usable_curator_group_or_400,
         unchanged: the caller is the "author" it was written for);
      3. the caller is THIS school's curator. A curator of several schools
         is checked against the school of the practice, not against "any
         school of theirs";
      4. the target is a kind='master' member of THIS school, and their
         master profile is verified right now.

    Refusals, in this order, and why each code is what it is:
      - 1 -> 400 master_id_requires_school: nothing was read, nothing
        about anybody is revealed;
      - 2 -> the existing 400 of _usable_curator_group_or_400: an outsider
        cannot tell "this school exists, it is not yours" from "no such
        school", the same as on the caller's own path;
      - 3 -> 403 curator_only: only a member of the school gets this far,
        and a member already knows the school and its curator;
      - 4 -> ONE 400 master_not_in_school for every cause -- no such user,
        not a member, a student, a master of another school, not verified.
        Split by cause, the code would tell a curator whether an arbitrary
        user id is a verified master.

    The target is checked by the master profile, NOT by users.role. role
    is the mode a verified master is currently browsing in (they switch it
    themselves, users/service.py), so a verified master in the student
    zone is still a master; the profile is the capability, the same test
    _usable_curator_group_or_400 and the school's audience apply.

    THE TARGET'S ROWS ARE TAKEN, NOT READ (BE-102, owner ruling Q5): the
    member row, then the master profile, both FOR SHARE, in the order of
    the curator_groups module header (member -> master profile -> ... ->
    practice -> group); the practice INSERT comes after both. A demotion
    or removal of the target (an UPDATE / DELETE of the member row) and an
    admin taking verification away (an UPDATE of the profile) conflict
    with FOR SHARE, so either they commit first -- and READ COMMITTED
    re-evaluates the predicates below against what they committed, which
    refuses -- or they wait for this request's commit and find the
    practice already there. Without the locks, a practice could be born
    for somebody who had stopped being a master of the school between the
    check and the INSERT.

    Runs BEFORE the windowed dedup in create_practice: the dedup returns
    the target's existing practice, and returning it to a caller who has
    not passed the checks above would hand out another master's practice.
    """
    if body.master_id is None or body.master_id == user.id:
        return user.id, None
    target_id = body.master_id
    school_id = body.curator_group_id
    if school_id is None:
        raise BadRequestError(
            "master_id of another master requires curator_group_id",
            code="master_id_requires_school",
        )
    await _usable_curator_group_or_400(user.id, school_id, session)
    curator_id = (
        await session.execute(
            select(CuratorGroup.curator_user_id).where(
                CuratorGroup.id == school_id,
            )
        )
    ).scalar_one_or_none()
    if curator_id != user.id:
        raise ForbiddenError(_CURATOR_ONLY, code="curator_only")
    await _lock_school_master_or_400(school_id, target_id, session)
    # BE-103 N1: the series parent, in its place in the order -- after the
    # target's rows, BEFORE the group. A child's INSERT takes KEY SHARE on
    # its parent (FK), so a new practice row does wait for its parent's
    # holder: taken after the group, that is group -> practice, against
    # update_practice and the series cancellation, which hold the series
    # and then want the group (40P01). It cannot go below the dedup either:
    # the group re-check below must run first (see above), and the parent
    # comes before it. Validated against the TARGET master: the child is
    # theirs.
    parent = await _owned_root_parent_or_400(
        target_id, body.parent_practice_id, session,
    )
    # BE-63: the curator's right, re-checked UNDER THE GROUP LOCK, after the
    # target's rows and the parent (module order: member -> master profile
    # -> practice -> group) and before the INSERT. The INSERT's FK checks
    # are covered by locks already held: the parent's above, this group's
    # here. The read above is the fast path; the school can change hands
    # between it and here (accept of a transfer), and a former curator must
    # not create in the new owner's school. Same 403 as the read: one fact,
    # one code.
    if not await _lock_group_as_owner(user.id, school_id, session):
        raise ForbiddenError(_CURATOR_ONLY, code="curator_only")
    return target_id, parent


async def _lock_school_master_or_400(
    school_id: UUID, master_id: UUID, session: AsyncSession,
) -> None:
    """Take this master's place in this school, or refuse (BE-102, BE-63).

    kind='master' member row of THIS school, then the master profile
    verified NOW -- both FOR SHARE, in the curator_groups module order
    (member -> master profile), and before the caller locks the practice
    or the group. A demotion / removal (UPDATE / DELETE of the member row)
    or a verification taken away (UPDATE of the profile) either commits
    first -- READ COMMITTED re-evaluates the predicates against it, and
    this refuses -- or waits for the caller's commit.

    ONE 400 master_not_in_school for every cause: split by cause, the code
    would tell whether an arbitrary user id is a verified master.

    Used by create_practice for another master (BE-102) and by a curator's
    publication of a master's draft (BE-63, owner Q5): a practice published
    for somebody who is no longer a master of the school is a practice the
    school does not show, and it would slip past the hand-over of a demoted
    master's future practices (B2).
    """
    member = (
        await session.execute(
            select(CuratorGroupMember.id)
            .where(
                CuratorGroupMember.group_id == school_id,
                CuratorGroupMember.user_id == master_id,
                CuratorGroupMember.kind == CuratorMemberKind.MASTER.value,
            )
            .with_for_update(read=True)
        )
    ).scalar_one_or_none()
    if member is None:
        raise BadRequestError(
            _MASTER_NOT_IN_SCHOOL, code="master_not_in_school",
        )
    verified = (
        await session.execute(
            select(MasterProfile.user_id)
            .where(
                MasterProfile.user_id == master_id,
                MasterProfile.data["account"]["status"].as_string()
                == "verified",
            )
            .with_for_update(read=True)
        )
    ).scalar_one_or_none()
    if verified is None:
        raise BadRequestError(
            _MASTER_NOT_IN_SCHOOL, code="master_not_in_school",
        )


_CURATOR_ONLY = (
    "Only the school's curator may create a practice for another master"
)
_NOT_FOUND = "Practice not found"


async def _lock_group_as_owner(
    curator_user_id: UUID, school_id: UUID, session: AsyncSession,
) -> bool:
    """curator_groups' _lock_group_as_owner, imported lazily (import cycle:
    curator_groups/service.py imports practices/models.py)."""
    from app.modules.curator_groups.service import (
        _lock_group_as_owner as lock,
    )
    return await lock(curator_user_id, school_id, session)


async def _curated_school_of(
    practice: Practice, user: User, session: AsyncSession,
) -> UUID | None:
    """The practice's school if the caller curates it right now, else None.

    THE BODY OF THE RULE is curated_group_id_for_practice (BE-21): the
    killswitch, the practice's own school, the caller its curator, the
    school active. A READ -- the fast path; writers re-check it under the
    group lock (_relock_school_or_404).
    """
    from app.modules.curator_groups.service import (
        curated_group_id_for_practice,
    )
    return await curated_group_id_for_practice(practice, user.id, session)


async def _refuse_blocked_in_school(
    school_id: UUID | None, user_id: UUID, session: AsyncSession,
) -> None:
    """403 blocked_in_group if `user_id` is blocked in `school_id` (BE-79,
    gate ruling 3, 3 October): a master blocked in a school neither edits
    nor publishes the school's practices -- his own included -- and does
    not add a session to his series there. Cancelling his own practice and
    deleting his own draft (DELETE /practices/{id}) stay open (B2), which
    is why this is NOT in _manager_of_practice_or_404, the one rule every
    action shares.

    Callers: update_practice (on the locked practice), preview_audience_
    change (a read, no lock), create_practice on the series-child path (on
    the parent it holds FOR SHARE). The two writers read the block AFTER
    their practice lock: the block takes the blocked master's practices in
    the school FOR UPDATE (block_curator_group_member, K3), so the read
    either precedes the block entirely or sees it.

    No school -> nothing to be blocked in. Lazy import: the same shape as
    _lock_group_as_owner's above.
    """
    if school_id is None:
        return
    from app.modules.curator_groups.service import (
        _blocked_in_group,
        _blocked_in_group_error,
    )
    if await _blocked_in_group(school_id, user_id, session):
        raise _blocked_in_group_error()


async def _manager_of_practice_or_404(
    practice: Practice, user: User, session: AsyncSession,
) -> UUID | None:
    """THE ONE RULE for acting on a practice (BE-63): its master OR the
    curator of the school it belongs to.

    None -> the caller is the practice's master (no query at all);
    a school id -> the caller curates the practice's school;
    anybody else -> 404, the identical answer to "no such practice" (P-08:
    "not your school", "not a school practice" and "no such practice" must
    be one answer). A practice without a school -- the general section, or
    one whose school was deleted -- is its master's only.

    Readers use the answer as it is; every WRITER that got a school id
    re-checks it under the group lock before it writes (_relock_school_or_404).
    """
    if practice.master_id == user.id:
        return None
    school_id = await _curated_school_of(practice, user, session)
    if school_id is None:
        raise NotFoundError(_NOT_FOUND)
    return school_id


async def _relock_school_or_404(
    user: User, school_id: UUID, session: AsyncSession,
) -> None:
    """The curator's right, re-checked under the group lock (BE-63).

    Called by a writer that holds the practice FOR UPDATE, before it writes
    anything that takes the group (a journal row: KEY SHARE) -- the module
    order practice -> group, the group taken once at the strength it ends
    up needing. A school that changed hands since the read answers 404;
    writes already made are undone by get_db_session's rollback (P-01).
    """
    if not await _lock_group_as_owner(user.id, school_id, session):
        raise NotFoundError(_NOT_FOUND)


async def _root_audience_change(
    practice: Practice, update_data: dict, session: AsyncSession,
) -> bool:
    """THE ONE decision of whether a PATCH changes a series ROOT's audience
    -- the change update_practice pushes down to the children
    (propagate_audience_to_children). Called twice by update_practice: on
    the unlocked read, to choose what to lock, and on the locked row, to
    decide (PRACTICE ROW ORDER: decide on a read, re-check on the lock).

    A change is (a) a sent audience_kind other than the stored one, or (b)
    a sent group_ids set other than the stored set -- compared as SETS,
    presence in the payload is not change (EditPracticeView resends both
    fields on every save). A child is never a root, and its audience
    fields are refused before anything is applied (S-a), so a child
    answers False.

    Must run BEFORE update_practice applies anything: it reads the stored
    kind off the object and the stored set from practice_audience_group.
    """
    if practice.parent_practice_id is not None:
        return False
    if (
        "audience_kind" in update_data
        and update_data["audience_kind"] != practice.audience_kind
    ):
        return True
    if "group_ids" not in update_data:
        return False
    stored = set(
        (
            await session.execute(
                select(PracticeAudienceGroup.group_id).where(
                    PracticeAudienceGroup.practice_id == practice.id,
                )
            )
        ).scalars().all()
    )
    return stored != set(update_data["group_ids"] or [])


async def _lock_practice_and_children(
    practice_id: UUID, with_children: bool, session: AsyncSession,
) -> tuple[Practice | None, list[Practice]]:
    """Lock the practice -- and, with_children, its non-terminal children
    -- in ONE statement, ORDER BY id (PRACTICE ROW ORDER, module header).

    Returns (the practice or None, the locked children). The children's
    status filter is IN the statement on purpose: FOR UPDATE re-checks the
    predicate on every row it had to wait for, so a child cancelled or
    deleted by a writer that held it is dropped from the set instead of
    having its audience rewritten (S-d: history is not rewritten). The
    parent id is a parameter that cannot go stale: parent_practice_id is
    set at birth and never written again (C2-b).

    A child born after this statement's snapshot is NOT in the set even if
    the statement waited for its birth (its INSERT holds KEY SHARE on the
    root): FOR UPDATE re-checks rows it found, it does not look for new
    ones. update_practice therefore looks for such children after the
    lock (_refuse_unheld_children_or_409).

    populate_existing: update_practice's read put the practice into the
    session, and a lock does not refresh an object already there (BE-85).
    """
    wanted = Practice.id == practice_id
    if with_children:
        wanted = or_(
            wanted,
            and_(
                Practice.parent_practice_id == practice_id,
                Practice.status.notin_(_TERMINAL_CHILD_STATUSES),
            ),
        )
    rows = list(
        (
            await session.execute(
                select(Practice)
                .where(wanted)
                .order_by(Practice.id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        ).scalars().all()
    )
    practice = next((p for p in rows if p.id == practice_id), None)
    return practice, [p for p in rows if p.id != practice_id]


async def _refuse_unheld_children_or_409(
    root: Practice, children: list[Practice], session: AsyncSession,
) -> None:
    """409 series_audience_changed if the root has a non-terminal child
    this transaction does not hold.

    Two ways to get here, one fact -- the set update_practice locked is
    not the set the propagation must write:
      - the unlocked read said "no audience change", so no children were
        taken, and the locked root says otherwise: another audience edit
        of this root committed in between;
      - a child was born after the lock statement's snapshot, while that
        statement waited on the root (_lock_practice_and_children).
    A plain read: the transaction holds the root FOR UPDATE, so no child
    can be born from here on (its INSERT needs KEY SHARE on the root), and
    the answer cannot go stale before the commit. Taking the missing
    children now would lock practices outside the one statement (PRACTICE
    ROW ORDER); the request is refused whole instead, before anything is
    written, and a retry locks the right set.
    """
    held = [c.id for c in children]
    query = select(Practice.id).where(
        Practice.parent_practice_id == root.id,
        Practice.status.notin_(_TERMINAL_CHILD_STATUSES),
    )
    if held:
        query = query.where(Practice.id.notin_(held))
    if (await session.execute(query.limit(1))).first() is not None:
        raise ConflictError(
            "The series changed while this edit was being applied; "
            "reload and try again",
            code="series_audience_changed",
        )


@dataclass(frozen=True)
class _CuratorAct:
    """One kind of thing a curator does to a master's practice (BE-102,
    BE-63): its audit event, its notification type, how its notification
    is keyed, and how it reads."""

    event: str
    type: str
    key: str
    per_act: bool
    title: str
    verb: str
    tail: str


# The idempotency key is the identity of the FACT. Creation, publication
# and deletion happen to a practice once (each is a one-way transition),
# so the practice is the whole key. An edit can happen many times, each a
# new fact: it is keyed on a fresh act id minted when the edit WROTE
# something -- a resent request that changes nothing never reaches here.
_CURATOR_CREATED = _CuratorAct(
    event="practice_created_by_curator",
    type="curator_group.practice_created_for_master",
    key="practice-created-by-curator",
    per_act=False,
    title="Куратор создал практику от вашего имени",
    verb="создал от вашего имени черновик практики",
    tail="Проверьте его и опубликуйте.",
)
_CURATOR_PUBLISHED = _CuratorAct(
    event="practice_published_by_curator",
    type="curator_group.master_practice_published",
    key="practice-published-by-curator",
    per_act=False,
    title="Куратор опубликовал вашу практику",
    verb="опубликовал вашу практику",
    tail="Она видна в школе.",
)
_CURATOR_EDITED = _CuratorAct(
    event="practice_updated_by_curator",
    type="curator_group.master_practice_edited",
    key="practice-edited-by-curator",
    per_act=True,
    title="Куратор изменил вашу практику",
    verb="изменил вашу практику",
    tail="Проверьте, всё ли верно.",
)
_CURATOR_DELETED = _CuratorAct(
    event="practice_deleted_by_curator",
    type="curator_group.master_practice_deleted",
    key="practice-deleted-by-curator",
    per_act=False,
    title="Куратор удалил ваш черновик",
    verb="удалил ваш черновик",
    tail="Черновик больше недоступен.",
)


def _practice_snapshot(practice: Practice) -> dict:
    """Every mapped column of the practice except updated_at, deep-copied:
    "did this request write anything" is "does the snapshot differ". The
    audience-group rows are not in it -- a school practice has none
    (check_school_audience), and only a school practice has a curator."""
    return {
        attr.key: copy.deepcopy(getattr(practice, attr.key))
        for attr in sa_inspect(Practice).column_attrs
        if attr.key != "updated_at"
    }


async def _tell_master_of_curator_act(
    curator: User, practice: Practice, act: _CuratorAct, session: AsyncSession,
) -> None:
    """Audit a curator's act on a master's practice and tell the master.

    Called only when the act really happened to somebody else's practice
    -- never on a dedup return, never when the curator is the practice's
    own master. Both writes are in the request's transaction: an audit row
    or a notification about something a rollback undid would record and
    announce what did not happen.

    The audit is a distinct EVENT per act, like
    practice_cancelled_by_curator (cancel_service.py): actor_id is the
    curator, master_id the practice's master, group_id the school the
    right came from. The notification has ONE addressee, the master -- a
    party to the fact -- and opens the practice (the deleted draft is
    gone, so that one opens nothing and carries no practice id).
    """
    from app.core.audit import record_audit
    from app.core.events.notify import emit_notification
    from app.core.events.reminders import format_event_time
    from app.modules.users.helpers import display_name

    await record_audit(
        event=act.event,
        actor_id=curator.id,
        actor_type="user",
        target_type="practice",
        target_id=practice.id,
        data={
            "group_id": str(practice.curator_group_id),
            "master_id": str(practice.master_id),
        },
        session=session,
    )
    group_name = (
        await session.execute(
            select(CuratorGroup.name).where(
                CuratorGroup.id == practice.curator_group_id,
            )
        )
    ).scalar_one()
    actor_name = display_name(curator.first_name, curator.last_name)
    when_text = format_event_time(practice.scheduled_at)
    key = f"{act.key}:{practice.id}"
    if act.per_act:
        key = f"{key}:{uuid4()}"
    action: dict = (
        {"action": "open_practice", "params": {"practice_id": str(practice.id)}}
        if act is not _CURATOR_DELETED
        else {"action": "open_master_practices", "params": {}}
    )
    await emit_notification(
        session,
        idempotency_key=key,
        type=act.type,
        target_type="user",
        target_value=str(practice.master_id),
        title=act.title,
        body=(
            f"{actor_name} {act.verb} «{practice.title}» ({when_text}) "
            f"в школе «{group_name}». {act.tail}"
        ),
        action_data={
            **action,
            "practice_title": practice.title,
            "scheduled_at": when_text,
            "group_name": group_name,
            "actor_name": actor_name,
        },
    )


async def _set_practice_audience_groups(
    practice_id: UUID, group_ids: list[UUID], session: AsyncSession,
) -> None:
    """REPLACE the practice's full target-group set with group_ids
    (delete-then-insert -- these are small sets, no need for a diff)."""
    await session.execute(
        delete(PracticeAudienceGroup).where(
            PracticeAudienceGroup.practice_id == practice_id,
        )
    )
    for group_id in group_ids:
        session.add(
            PracticeAudienceGroup(practice_id=practice_id, group_id=group_id)
        )
    await session.flush()


async def group_names_for_practice(
    practice: Practice, session: AsyncSession,
) -> list[str]:
    """PracticeResponse.audience_group_names -- the practice's target
    CUSTOM groups' names, alphabetical. Empty for anything but
    audience_kind='groups' (nothing to look up). Public (like
    user_flags_for_practices / series_meta_for_practices) -- called from
    both this module (get_practice_detail) and router.py (create/update
    endpoints' owner-facing responses)."""
    if practice.audience_kind != AudienceKind.GROUPS.value:
        return []
    stmt = (
        select(MasterGroup.name)
        .join(
            PracticeAudienceGroup,
            PracticeAudienceGroup.group_id == MasterGroup.id,
        )
        .where(PracticeAudienceGroup.practice_id == practice.id)
        .order_by(MasterGroup.name)
    )
    return list((await session.execute(stmt)).scalars().all())


async def curator_group_name_for_practice(
    practice: Practice, session: AsyncSession,
) -> str | None:
    """PracticeResponse.curator_group_name -- the OWNING school's name, or
    None for a practice without one (BE-74).

    For EVERY audience, not only 'curator_groups': a public practice of a
    school is still that school's, and the name is what the frontend shows
    next to it. Seen by everyone who can read the practice (owner ruling,
    2026-10-01) -- for a public one that is anybody; for a 'curator_groups'
    one it is the school's own people, plus a booked non-owner who reaches
    the detail by the H-R2-8 grandfather and needs the name to read
    "Вы не состоите в школе «...»". A stranger never gets that far: the
    detail's audience gate answers 404 first.

    NAME SURVIVES WHAT THE FLAG REPORTS. audience_unavailable can be true
    while this is set -- a frozen school still has a name. The pair is
    deliberate and must not be "harmonised": the flag says nobody can see
    the practice, the name says which school it belongs to, and a master
    given the first without the second cannot tell what to fix.
    """
    if practice.curator_group_id is None:
        return None
    return (
        await session.execute(
            select(CuratorGroup.name).where(
                CuratorGroup.id == practice.curator_group_id,
            )
        )
    ).scalar_one_or_none()


def _enforce_pricing(
    is_free: bool,
    price_cents: int,
) -> int:
    """Enforce pricing invariant.

    is_free=True  -> return 0 (override any client value).
    is_free=False -> price_cents must be > 0, else raise 400.
    """
    if is_free:
        return 0
    if price_cents <= 0:
        raise BadRequestError(
            "price_cents must be > 0 for paid practices"
        )
    return price_cents


def _build_taxonomy(
    direction: str,
    difficulty: str,
    style: str | None,
) -> dict:
    """Build the data.taxonomy dict for a practice.

    Calendar facets: direction + difficulty are required on create;
    style is optional (None when not provided).
    """
    return {
        "direction": direction,
        "difficulty": difficulty,
        "style": style,
    }


# ===================================================================
# Taxonomy union validation (T2, 2026-07-15)
# ===================================================================
#
# direction / style are valid if they're in config OR the active DB catalog
# (practice_directions / practice_styles) -- UNION, never replace (operator
# decision): the catalog was seeded 1:1 from this same config, so today both
# give identical results, but union can never reject a config-valid value
# while a replace could. Each VALUE is checked against config FIRST,
# unconditionally -- a config hit returns valid without touching the DB at
# all, so a broken/empty catalog can never affect a config-valid create/
# update. Only on a config MISS is the catalog queried, and that query is
# wrapped so ANY read error degrades to "not found" rather than propagating
# -- the only thing an outage can cost is a catalog-only value. Only ACTIVE
# catalog rows count, matching GET /api/v1/taxonomy's own contract.
# difficulty has no catalog table and is validated in schemas.py, unchanged.


async def _direction_in_catalog(
    direction: str,
    session: AsyncSession,
) -> bool:
    """Active-catalog fallback for direction membership (config already missed)."""
    try:
        stmt = select(TaxonomyDirection.id).where(
            TaxonomyDirection.value == direction,
            TaxonomyDirection.is_active.is_(True),
        )
        result = await session.execute(stmt)
        return result.scalar_one_or_none() is not None
    except Exception:
        logger.warning(
            "taxonomy_catalog_direction_read_failed", direction=direction,
        )
        return False


async def _catalog_styles_for_direction(
    direction: str,
    session: AsyncSession,
) -> set[str]:
    """Active catalog style values under one active direction."""
    try:
        stmt = (
            select(TaxonomyStyle.value)
            .join(
                TaxonomyDirection,
                TaxonomyStyle.direction_id == TaxonomyDirection.id,
            )
            .where(
                TaxonomyDirection.value == direction,
                TaxonomyDirection.is_active.is_(True),
                TaxonomyStyle.is_active.is_(True),
            )
        )
        result = await session.execute(stmt)
        return set(result.scalars().all())
    except Exception:
        logger.warning(
            "taxonomy_catalog_style_read_failed", direction=direction,
        )
        return set()


async def _validate_style_choice(
    direction: str | None,
    style: str | None,
    session: AsyncSession,
) -> None:
    """Validate style membership for an ALREADY-valid direction (union).

    Does not re-check direction membership -- callers use this either for a
    direction just validated by _validate_taxonomy(), or for a practice's
    STORED direction (accepted back when the practice was created/last set).
    """
    if style is None:
        return
    config_styles = settings.practice_allowed_styles_by_direction.get(
        direction, (),
    )
    if style in config_styles:
        return
    catalog_styles = await _catalog_styles_for_direction(direction, session)
    if style in catalog_styles:
        return
    allowed = sorted(set(config_styles) | catalog_styles)
    if allowed:
        raise BadRequestError(
            f"style for direction '{direction}' must be one of {allowed}, "
            f"got '{style}'"
        )
    raise BadRequestError(
        f"direction '{direction}' does not admit a style; got '{style}'"
    )


async def _validate_taxonomy(
    direction: str,
    style: str | None,
    session: AsyncSession,
) -> None:
    """Validate a direction + optional style pair against the GLOBAL union
    (config + active catalog). Deliberately does NOT check whether the
    CALLING MASTER is confirmed for this direction/style -- that is a
    separate, narrower question (see _assert_master_confirmed_taxonomy
    below), checked explicitly at each call site that has a `user` to check
    against. Kept separate rather than folded in here so this function keeps
    its existing, reusable "is this a real taxonomy value at all" meaning
    (master onboarding's own picker legitimately needs the unfiltered
    catalog, and must never route through the master-confirmation check --
    T21-6, PROMPT №546)."""
    if direction not in settings.practice_allowed_directions:
        if not await _direction_in_catalog(direction, session):
            raise BadRequestError(
                f"direction must be one of "
                f"{settings.practice_allowed_directions}, got '{direction}'"
            )
    await _validate_style_choice(direction, style, session)


# T21-6 (PROMPT №546): flat "Направление — Вид" join, byte-for-byte identical
# to the frontend's methodTaxonomy.ts SEP -- MasterProfile.data.profile.
# methods is a list of these frozen strings (see admin/masters/service.py's
# approve_method_change, which copies proposed_methods verbatim with no
# server-side value<->label resolution at all until now).
_METHOD_LABEL_SEP = " — "


async def _label_for_direction_value(
    direction: str,
    session: AsyncSession,
    master_id: UUID,
) -> str | None:
    """Active-catalog label for a direction value AS THIS MASTER SEES IT,
    or None if there is no such row in their own view of the catalog.

    SCOPED SINCE BE-38, and it used to be deliberately master-agnostic.
    The old reasoning -- written on TaxonomyDirection and corrected there --
    was that the per-master boundary is held twice elsewhere: by the
    catalog READ, and by this gate only ever matching against the
    REQUESTING master's own methods. The second half does not hold,
    because the match is BY LABEL and labels are not unique across
    masters: _scope_custom_methods_to_master deduplicates a new private
    row against global rows and this master's own, and deliberately NOT
    against other masters' private rows, "which are none of this master's
    business". Two masters who both write "Сказкотерапия" therefore own
    two different rows with one label -- and the label match let each of
    them name the other's value.

    master_id is REQUIRED rather than defaulted to None. There is one
    caller, and a default would leave a version of this function that
    silently answers for the wrong person.
    """
    stmt = select(TaxonomyDirection.label).where(
        TaxonomyDirection.value == direction,
        TaxonomyDirection.is_active.is_(True),
        or_(
            TaxonomyDirection.master_id.is_(None),
            TaxonomyDirection.master_id == master_id,
        ),
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def _label_for_style_value(
    direction: str,
    style: str,
    session: AsyncSession,
) -> str | None:
    """Current active-catalog label for a style value under a direction, or
    None if it isn't (or is no longer) an active catalog row."""
    stmt = (
        select(TaxonomyStyle.label)
        .join(TaxonomyDirection, TaxonomyStyle.direction_id == TaxonomyDirection.id)
        .where(
            TaxonomyDirection.value == direction,
            TaxonomyDirection.is_active.is_(True),
            TaxonomyStyle.value == style,
            TaxonomyStyle.is_active.is_(True),
        )
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def _assert_master_confirmed_taxonomy(
    master_id: UUID,
    direction: str,
    style: str | None,
    session: AsyncSession,
    *,
    own: bool = True,
) -> None:
    """Reject a direction/style the practice's master has not been CONFIRMED
    for (T21-6). master_id is the practice's master -- the caller, or the
    master a school curator creates the practice for (BE-102).
    own=False when the caller is not that master (a curator): the refusal
    then speaks of "this master's" methods, not "your" -- the codes are
    the same either way (BE-63).
    Confirmed = MasterProfile.data.profile.methods -- the live field,
    overwritten only on admin approval (approve_method_change).
    Deliberately does NOT read method_change_request.proposed_methods: a
    pending, unapproved request must never unlock a practice in that
    direction, or the "up to 3 working days" review the UI advertises would
    mean nothing.

    FAILS OPEN (does not restrict) when the master's confirmed methods list
    is EMPTY -- not a loophole, a reflection of reality: a real verified
    master always has at least one confirmed method (masters/schemas.py's
    MasterApplicationRequest requires min_length=1 at application time), so
    an empty list here means either a test fixture that never set up
    profile.methods at all, or a data state that should not be reachable in
    production. Restricting THAT case would be enforcing a rule against
    data that predates the rule, not the rule itself.

    STORED FORMAT IS MIXED (T21-7, PROMPT №547, MEASURED on prod): a method
    entry is a frozen catalog LABEL ("Йога — Кундалини-йога") when it was
    written by the wizard (flattenMethods/approve_method_change), but a raw
    catalog VALUE ("yoga") when it was written directly against the API --
    every seed-based master, ~30 backend test fixtures, and at least one live
    prod master (no wizard round-trip ever touched their profile) all store
    values, not labels. The original label-only check treated every entry as
    a label, so it rejected every real, correctly-confirmed direction a
    value-stored master holds.

    Canonical form = VALUE, not label: `direction`/`style` here are ALREADY
    values (the wire format for practice taxonomy), labels are just a
    renamable display string with no version pin, and a value-stored entry
    (the common case: raw seed/API data) needs zero catalog round-trip to
    compare -- only a label-stored entry needs one reverse lookup (label ->
    is this the CURRENT label for the direction/style being requested?).
    So each stored entry is compared against BOTH representations of the
    SAME requested (direction, style): the raw value, and -- if the
    requested direction/style currently has an active catalog row -- its
    current label. Mirrors the frontend's parseMethods split (same SEP,
    same "both halves must resolve" rule for a composite entry) but compares
    toward values instead of building a label to search for, which also
    sidesteps parseMethods' label-drift limitation on this comparison (we
    never resolve a STORED label into a value; we only ever check whether it
    still equals the CURRENT label of the specific direction/style being
    requested).

    A composite entry ("Направление — Вид") is confirmation for that EXACT
    style only -- it does NOT also confirm the bare parent direction (no
    style), and a bare-direction entry does NOT confirm any specific style
    under it. Deliberate, unchanged from before this fix, and matches
    CreatePracticeView.vue's confirmedMethods filter (directionOptions/
    styleOptionsForForm), which already documents and relies on this same
    strict split.

    A STORED entry that resolves to nothing recognizable (neither half
    matches the requested value or label representation -- a stale/custom
    entry, or one written against a since-deactivated/renamed catalog row)
    simply confirms nothing: it is skipped, not an error, and does not by
    itself cause a reject -- the request is rejected only if NO entry in the
    whole list confirms it. If the REQUESTED direction itself has no active
    catalog row at all (dir_label is None below), this still fails OPEN
    exactly as before this fix -- unrelated to the mixed-format bug and
    deliberately not touched here (out of scope for T21-7; see the fail-open
    branch below for the original rationale).
    """
    profile = (
        await session.execute(
            select(MasterProfile).where(MasterProfile.user_id == master_id)
        )
    ).scalar_one_or_none()
    whose = "your" if own else "this master's"
    methods: list[str] = (
        (profile.data or {}).get("profile", {}).get("methods", [])
        if profile
        else []
    )
    if not methods:
        return

    dir_label = await _label_for_direction_value(
        direction, session, master_id=master_id,
    )
    if dir_label is None:
        # BE-38: "no row THIS MASTER can see" now has TWO causes, and only
        # one of them is the one the branch below was written for.
        #
        # Cause A -- the row exists, is active, and belongs to somebody
        # else. _validate_taxonomy let the value through because it asks
        # the catalog globally and must keep doing so (T21-6 above). Before
        # the scoping above, this case resolved a label and was refused by
        # the comparison below; scoped, it would fall into the fail-open
        # and be ALLOWED, which is the hole this delivery closes. Refused
        # here, under the same code as any other unconfirmed direction:
        # from the master's side it IS simply not one of their methods.
        if await _direction_in_catalog(direction, session):
            raise BadRequestError(
                f"direction '{direction}' is not in {whose} catalog",
                code="direction_not_confirmed",
            )
        # Cause B, the original one, and its reasoning is untouched:
        # not an active catalog row at all -- _validate_taxonomy already
        # accepted it via the config-only allow-list (a seed direction with
        # no catalog row). Every direction in today's config is in fact
        # mirrored into the catalog as an active row (R5 seed migration), so
        # this only fires if a direction is later deactivated -- a separate,
        # pre-existing gap (not introduced or widened by T21-7). Nothing to
        # resolve a label-side match against; let the config-level
        # validation's own verdict stand rather than raising a second,
        # redundant error here.
        return
    style_label = (
        await _label_for_style_value(direction, style, session)
        if style is not None
        else None
    )

    for raw in methods:
        sep_idx = raw.find(_METHOD_LABEL_SEP)
        entry_dir = raw if sep_idx == -1 else raw[:sep_idx]
        entry_style = None if sep_idx == -1 else raw[sep_idx + len(_METHOD_LABEL_SEP):]

        if (entry_style is None) != (style is None):
            continue  # bare vs composite -- never cross-confirm (see above).
        if entry_dir != direction and entry_dir != dir_label:
            continue
        if style is None or entry_style == style or (
            style_label is not None and entry_style == style_label
        ):
            return

    if style is None:
        raise BadRequestError(
            f"direction '{direction}' is not among {whose} confirmed methods",
            code="direction_not_confirmed",
        )
    raise BadRequestError(
        f"style '{style}' for direction '{direction}' is not among {whose} "
        f"confirmed methods",
        code="style_not_confirmed",
    )


async def _has_active_bookings(
    practice_id: UUID,
    session: AsyncSession,
) -> bool:
    """Check if a practice has any active (pending/confirmed) bookings.

    CQ-05: used to prevent price changes on practices that already
    have participants who paid the original price.
    """
    stmt = (
        select(func.count(Booking.id))
        .where(
            Booking.practice_id == practice_id,
            Booking.status.in_(_ACTIVE_BOOKING_STATUSES),
        )
    )
    result = await session.execute(stmt)
    return result.scalar_one() > 0


async def _active_booking_count(
    practice_id: UUID,
    session: AsyncSession,
) -> int:
    """Count active (pending/confirmed) bookings on a practice.

    Used to forbid lowering max_participants below the number of people
    already holding a slot -- otherwise current > max makes every
    capacity check read "full" forever (new bookings and every waitlist
    confirmation silently rejected).
    """
    stmt = select(func.count(Booking.id)).where(
        Booking.practice_id == practice_id,
        Booking.status.in_(_ACTIVE_BOOKING_STATUSES),
    )
    result = await session.execute(stmt)
    return result.scalar_one()


def master_full_name(
    first_name: str | None,
    last_name: str | None,
) -> str:
    """Build the master's display name as "First Last".

    MVP rule (mirrors the frontend masterDisplayName helper): always use the
    Telegram first_name + last_name, ignoring MasterProfile.display_name.
    Telegram guarantees first_name but last_name is optional, so the surname
    is appended only when present; if both are empty we fall back to "Мастер".
    Empty parts are filtered out so there is no trailing space or "None".
    """
    parts = [p for p in (first_name, last_name) if p]
    return " ".join(parts) if parts else "Мастер"


def practice_to_response(
    practice: Practice,
    master_name: str | None = None,
    master_methods: list[str] | None = None,
    *,
    master_avatar_url: str | None = None,
    is_booked: bool = False,
    is_paid: bool = False,
    recurrence_days: list[int] | None = None,
    total_sessions: int | None = None,
    completed_sessions: int | None = None,
    checkin_count: int | None = None,
    attended: int | None = None,
    no_show: int | None = None,
    zoom_host_join_url: str | None = None,
    zoom_public_link_visible: bool = False,
    zoom_meeting_status: str | None = None,
    deduplicated: bool = False,
    audience_group_names: list[str] | None = None,
    curator_group_name: str | None = None,
    audience_unavailable: bool | None = None,
) -> PracticeResponse:
    """Build PracticeResponse from ORM object with master_name and master_methods.

    master_name:       full "First Last" built via master_full_name() from the
                       User row in the JOIN (or the mutation's User object).
    master_methods:    MasterProfile.data.profile.methods from outer join in
                       get_practice(). List endpoints pass [] (not shown on cards).
    master_avatar_url: User.avatar_url from JOIN in get_practice() (detail only).
                       List endpoints leave it None -- avatars are not shown on
                       feed cards (V3: feed is untouched).

    Calendar taxonomy (direction / style / difficulty) is extracted from
    practice.data.taxonomy. Missing keys (e.g. practices created before the
    Calendar iteration, whose data sandbox is empty) resolve to None.
    """
    resp = PracticeResponse.model_validate(practice)
    resp.master_name = master_name
    resp.master_avatar_url = master_avatar_url
    resp.master_methods = master_methods or []

    taxonomy = (practice.data or {}).get("taxonomy", {})
    resp.direction = taxonomy.get("direction")
    resp.style = taxonomy.get("style")
    resp.difficulty = taxonomy.get("difficulty")

    # Per-user state for the requesting user (default False -- see schema).
    resp.is_booked = is_booked
    resp.is_paid = is_paid

    # Series card meta (E3 batch 2). None unless the caller resolved it for a
    # series-with-spec; the public feed leaves all three None.
    resp.recurrence_days = recurrence_days
    resp.total_sessions = total_sessions
    resp.completed_sessions = completed_sessions

    # Attendance / check-in counts (E12 + aggregate). None unless the caller
    # resolved them for an owner-facing view (master list / owner detail); the
    # public feed and a non-owner's detail leave all three None.
    resp.checkin_count = checkin_count
    resp.attended = attended
    resp.no_show = no_show

    # T21-1: host join_url -- caller decides whether to fetch/pass it (owner-
    # facing responses only); everyone else gets the schema default (None).
    resp.zoom_host_join_url = zoom_host_join_url

    # T-35: OUR public link, replacing the raw shared Zoom URL that used to be
    # returned here. Built, not stored -- the code is a pure function of
    # practice.id, so there is nothing to look up and nothing to keep in step
    # after a reschedule. Same owner-only posture as zoom_host_join_url above;
    # see the schema field for why that gate is NOT a security boundary.
    if zoom_public_link_visible:
        # Lazy, like every other zoom/service call in this module (that module
        # reaches back into this one).
        from app.modules.zoom.service import build_public_practice_link
        resp.zoom_public_link = build_public_practice_link(practice.id)
    else:
        resp.zoom_public_link = None

    # A4 V2 (PROMPT №572): NOT owner-gated, unlike zoom_host_join_url above --
    # see the schema field's own docstring for why.
    resp.zoom_meeting_status = zoom_meeting_status

    # A4 V6 (PROMPT №572): True only on create_practice's two dedup-return
    # paths (see that function's own docstring). Every other caller of this
    # builder (update/delete/cancel/list/detail) leaves the schema default
    # (False) -- deduplication is a CREATE-time concept only.
    resp.deduplicated = deduplicated

    # audience_kind is picked up automatically via from_attributes (matches
    # the ORM column name 1:1). audience_group_names has no ORM attribute --
    # the caller resolves it (async, via _group_names_for_practice) and
    # passes it through; every caller that doesn't leaves the schema
    # default ([]).
    if audience_group_names is not None:
        resp.audience_group_names = audience_group_names
    # P5/GT-12, BE-74: same "no ORM attribute, set after model_validate"
    # shape as the line above (curator_group_id itself IS a column and comes
    # through from_attributes). None means "the caller did not compute it",
    # which is not the same as false -- a caller that skips the lookup
    # leaves the schema default in place rather than asserting the practice
    # is fine.
    if curator_group_name is not None:
        resp.curator_group_name = curator_group_name
    if audience_unavailable is not None:
        resp.audience_unavailable = audience_unavailable

    return resp


async def user_flags_for_practices(
    user_id: UUID,
    practice_ids: list[UUID],
    session: AsyncSession,
) -> dict[UUID, tuple[bool, bool]]:
    """Map practice_id -> (is_booked, is_paid) for the given user.

    One query over the user's bookings restricted to practice_ids on the
    current page (uses ix_bookings_user_id), joined to Practice for the price.

    is_booked -- the user has a booking in _BOOKED_STATUSES for the practice.
    is_paid   -- is_booked AND the practice is paid (price_cents > 0).
                 Definition note: a Booking always carries a purchase_id (even
                 free practices create a zero-amount Purchase), so purchase
                 presence is NOT a paid signal. "Paid" here means the user
                 holds a booking on a priced practice -- this drives the
                 "Оплачено" vs "Бесплатно" badge in the Calendar.

    Practices with no booking for this user are simply absent from the
    map -> caller treats them as (False, False).
    """
    if not practice_ids:
        return {}

    stmt = select(
        Booking.practice_id,
        Practice.price_cents,
    ).join(
        Practice, Booking.practice_id == Practice.id,
    ).where(
        Booking.user_id == user_id,
        Booking.practice_id.in_(practice_ids),
        Booking.status.in_(_BOOKED_STATUSES),
    )
    result = await session.execute(stmt)

    flags: dict[UUID, tuple[bool, bool]] = {}
    for practice_id, price_cents in result.all():
        flags[practice_id] = (True, price_cents > 0)
    return flags


# ===================================================================
# CRUD
# ===================================================================


async def _find_duplicate_practice(
    user_id: UUID,
    body: CreatePracticeRequest,
    session: AsyncSession,
    *,
    since: datetime | None,
) -> Practice | None:
    """Shared match logic behind _find_recent_duplicate_practice (the
    pre-insert, WINDOWED check below) and create_practice's post-race
    lookup (A4 V7, since=None -- called only after losing the INSERT race
    to uq_practice_master_title_scheduled_recurrence, where a matching row
    is now guaranteed to exist regardless of when it was created, so no
    window applies).

    Match key: (master_id, title, scheduled_at, recurrence). Compared in
    Python (not a JSONB query) since recurrence needs a value-equality
    check against a Pydantic model, not a string match.
    """
    stmt = select(Practice).where(
        Practice.master_id == user_id,
        Practice.title == body.title,
        Practice.scheduled_at == body.scheduled_at,
        Practice.status != PracticeStatus.DELETED.value,
    )
    if since is not None:
        stmt = stmt.where(Practice.created_at >= since)
    candidates = (
        await session.execute(stmt.order_by(Practice.created_at.desc()))
    ).scalars().all()

    incoming_recurrence = (
        body.recurrence.model_dump(mode="json") if body.recurrence is not None else None
    )
    for candidate in candidates:
        stored_recurrence = (candidate.data or {}).get("recurrence")
        if stored_recurrence == incoming_recurrence:
            return candidate
    return None


async def _same_school_or_409(
    candidate: Practice, body: CreatePracticeRequest, session: AsyncSession,
) -> None:
    """Refuse a "duplicate" that belongs to a different school (BE-74).

    The dedup key (master, title, scheduled_at, recurrence) is the unique
    index's, and the index does not know schools -- a master cannot hold
    the same slot twice, wherever it was created. So a request from a
    school's section can match a practice the same master already made in
    the general section (or in another school), and returning that one
    with 200 would tell the school "here is your practice" about a practice
    that is not its own. That is a conflict, not a repeat: 409.

    The school the request MEANS is the one create_practice would store:
    the body's, or -- for a child that sent none -- its parent's (the T-23
    inheritance below). Read here because the windowed check runs before
    the parent is resolved. Same school (both none included) -> it IS the
    repeat, and the caller returns it as before.
    """
    expected = body.curator_group_id
    if (
        "curator_group_id" not in body.model_fields_set
        and body.parent_practice_id is not None
    ):
        parent = await session.get(Practice, body.parent_practice_id)
        expected = parent.curator_group_id if parent is not None else None
    if candidate.curator_group_id != expected:
        raise ConflictError(
            "A practice with the same title and time already exists "
            "outside this school",
            code="practice_exists_in_other_school",
        )


async def _find_recent_duplicate_practice(
    user_id: UUID,
    body: CreatePracticeRequest,
    session: AsyncSession,
) -> Practice | None:
    """PROMPT №559 idempotency check: a non-deleted practice this SAME master
    created within the last practice_duplicate_submit_window_minutes, with
    the identical title, scheduled_at, AND recurrence spec, is treated as
    the master's earlier submission having already gone through -- not a
    fresh, different practice.

    MEASURED root cause (PROMPT №559): a series publish makes one Zoom API
    call per occurrence, sequentially, inside one request; the frontend's
    own 15s AbortController gives up well before a ~29-occurrence series
    finishes, the master sees a timeout, and presses the button again --
    creating a full duplicate series, not a cosmetic double-click. Since
    (child creation is now deferred to the poller and) the ROOT publish is
    the only synchronous Zoom call left, THIS check, at create_practice
    time, is early enough to prevent the duplicate before any of that work
    starts.

    A4 V7: this SELECT-then-INSERT shape is TOCTOU-safe only up to the
    point of the actual insert -- two genuinely CONCURRENT requests (double-
    tap, two tabs) both run this SELECT before either commits, so both see
    nothing and both proceed to insert. create_practice below closes that
    gap at the DB level (uq_practice_master_title_scheduled_recurrence),
    same pattern as ensure_host_registrant (zoom/service.py, PROMPT №525).
    This windowed check remains the fast, common-case path (a retry inside
    the window returns immediately, no INSERT attempted at all); the DB
    constraint is the backstop for the race this check cannot see.

    Match key is (master_id, title, scheduled_at, recurrence) -- exactly
    what the owner specified.

    DOES NOT COVER:
      - Two GENUINELY separate series/practices with an identical title,
        an identical scheduled_at (to the second), and identical recurrence,
        submitted deliberately within the window -- silently merged into
        one. Considered acceptable: two real submissions matching on all
        three fields to the SECOND is a scenario indistinguishable from a
        retry by any server-side signal available here.
      - A retry more than window-minutes after the original -- intentional;
        a stale window would block a master who genuinely re-creates the
        same series hours or days later.
      - Any resource other than Practice (bookings, purchases, etc.).
      - A client whose retry recomputes scheduled_at slightly differently
        between attempts (e.g. from a fresh "now + offset" instead of a
        fixed picked date/time) -- the match is exact, not fuzzy.
    """
    window_start = datetime.now(UTC) - timedelta(
        minutes=settings.practice_duplicate_submit_window_minutes,
    )
    return await _find_duplicate_practice(user_id, body, session, since=window_start)


async def create_practice(
    user: User,
    body: CreatePracticeRequest,
    session: AsyncSession,
) -> tuple[Practice, bool]:
    """Create a new practice in draft status.

    Returns (practice, deduplicated) -- A4 V6 (PROMPT №572): deduplicated is
    True on EITHER return-the-existing-practice path below (the window
    check or the post-race lookup), False on a genuine new insert. Before
    this, both paths returned a bare Practice indistinguishable from a
    freshly created one -- the caller (create_practice_endpoint) had no way
    to tell the master "this is your EARLIER submission, not a new one",
    so a second click after a timeout, or the losing side of a genuine
    concurrent double-submit (A4 V7), silently looked like success with no
    signal that nothing new was actually created.

    Calendar taxonomy (direction / difficulty / style) is written into the
    data.taxonomy JSONB sandbox via set_jsonb() -- direction and difficulty
    are required by the schema, style is optional. direction/style membership
    (T2, 2026-07-15) is validated here against the config+catalog union --
    difficulty stays schema-validated (config only, no catalog table).

    T21-6 (PROMPT №546): ALSO validated against the practice's master's own
    CONFIRMED methods (_assert_master_confirmed_taxonomy; the master is the
    caller unless a curator names another one, BE-102) -- a master may
    only create a practice in a direction/style their profile has been
    approved for. This is separate from the global catalog check above and
    does not apply anywhere master onboarding picks methods (a different
    endpoint entirely, which correctly shows the unfiltered catalogue).

    PROMPT №559: returns the EXISTING practice, unchanged, instead of
    creating a new one, if _find_recent_duplicate_practice finds a match --
    see that function's docstring for exactly what this does and does not
    cover. No new validation runs in that case; there is nothing new to
    validate.

    A4 V7: the window check above is a fast-path optimization, not the
    actual guarantee -- uq_practice_master_title_scheduled_recurrence (see
    the practices table migration) is what excludes two concurrent
    requests for the same (master, title, scheduled_at, recurrence) at the
    DB level. The insert below runs inside session.begin_nested() (a
    SAVEPOINT) for the same reason as ensure_host_registrant (zoom/
    service.py, PROMPT №525): a plain try/except around the flush is not
    enough by itself to keep the CALLER's own transaction usable after a
    database-level abort (PendingRollbackError) -- something has to roll
    back TO. On IntegrityError, the race was LOST: look up the winning row
    (unwindowed -- it is guaranteed to exist and match exactly) and return
    it, exactly like the window check's own duplicate-return path.

    BE-102: THE PRACTICE'S MASTER IS master_id, NOT ALWAYS THE CALLER. A
    school curator may create a practice for a master of their school
    (body.master_id; _effective_master_id_or_4xx says exactly when). From
    there on, every place that asks "whose practice" asks it of that
    master: the dedup window and the race lookup (the slot is the
    master's), the confirmed-methods check (the master teaches it), the
    master's own groups and root parent, Practice.master_id and the logs'
    master_id. The CALLER stays the one who acted: the logs' actor_id, the
    school check of _usable_curator_group_or_400, and the audit row plus
    the master's notification written when a practice was really created
    for somebody else (_tell_master_of_curator_act).
    """
    # BE-102: before the dedup, which would otherwise hand the target's
    # existing practice to a caller who has not passed the checks.
    master_id, parent = await _effective_master_id_or_4xx(user, body, session)
    for_another_master = master_id != user.id
    duplicate = await _find_recent_duplicate_practice(master_id, body, session)
    if duplicate is not None:
        await _same_school_or_409(duplicate, body, session)
        logger.info(
            "practice_create_deduplicated",
            master_id=str(master_id),
            actor_id=str(user.id),
            existing_practice_id=str(duplicate.id),
            title=body.title,
        )
        return duplicate, True

    await _validate_taxonomy(body.direction, body.style, session)
    await _assert_master_confirmed_taxonomy(
        master_id, body.direction, body.style, session,
        own=not for_another_master,
    )
    price_cents = _enforce_pricing(body.is_free, body.price_cents)
    # P5 (PROMPT №594): reject a group_id that isn't one of THIS master's own
    # custom groups (another master's group, an unknown id, or a system
    # slug) before anything is inserted.
    await _owned_group_ids_or_400(master_id, body.group_ids, session)
    # BE-74: same placement, same reflex -- reject a school this master
    # cannot create a practice in before anything is inserted. BE-102: on
    # the path for another master the same check already ran, for the
    # caller, inside _effective_master_id_or_4xx.
    if body.curator_group_id is not None and not for_another_master:
        await _usable_curator_group_or_400(
            user.id, body.curator_group_id, session,
        )
    # H-R2 (3.4): validate parent_practice_id BEFORE anything is inserted
    # -- same placement discipline as the group check above. BE-103: the
    # parent is locked here on the caller's own path; for another master
    # it already is, in its place before the school's group
    # (_effective_master_id_or_4xx) -- one lock, not two.
    if not for_another_master:
        parent = await _owned_root_parent_or_400(
            master_id, body.parent_practice_id, session,
        )
        # BE-79: a new session of a school series is a publication in that
        # school, and the series inherits the school without naming it --
        # so _usable_curator_group_or_400 below never sees it. Read on the
        # parent held FOR SHARE: the block takes it FOR UPDATE (K3). For
        # another master this path is closed earlier: a blocked master has
        # no member row, and _effective_master_id_or_4xx refuses him.
        if parent is not None:
            await _refuse_blocked_in_school(
                parent.curator_group_id, user.id, session,
            )

    # T-23 (owner-ruled 2026-08-17): a manually-attached child (this path;
    # the auto-generated recurrence path already does this in
    # series_service.py's _build_child_occurrence) must not silently default
    # PUBLIC under a restricted root. The hole was made by SILENCE, not by
    # disagreement -- so the rule is symmetric: no audience_kind in the
    # request INHERITS the parent's (audience_kind + its
    # PracticeAudienceGroup rows, copied after flush below); an EXPLICIT
    # audience_kind that DIFFERS from the parent's is REFUSED rather than
    # silently overwriting the master's stated intent. No parent -> the
    # request's own audience_kind (default PUBLIC) is unaffected.
    inherited_group_source_id: UUID | None = None
    effective_audience_kind = body.audience_kind
    if parent is not None:
        if "audience_kind" in body.model_fields_set:
            if body.audience_kind != parent.audience_kind:
                raise BadRequestError(
                    "audience_kind conflicts with the parent practice's "
                    f"audience_kind ({parent.audience_kind!r}) -- omit "
                    "audience_kind to inherit it, or match it explicitly"
                )
        else:
            effective_audience_kind = parent.audience_kind
            inherited_group_source_id = parent.id

    # BE-74: the owning school follows the same T-23 rule, and for a
    # stronger reason -- it is inherited by every session of the series and
    # never changes afterwards. Silence inherits the parent's school; an
    # explicit one that differs, null included, is refused: a child of
    # another school's series, or a school child of a general series, is
    # the cross-school mix the one-school rule forbids. No parent -> the
    # request's own school (or none).
    effective_curator_group_id = body.curator_group_id
    if parent is not None:
        if "curator_group_id" in body.model_fields_set:
            if body.curator_group_id != parent.curator_group_id:
                raise BadRequestError(
                    "curator_group_id conflicts with the parent practice's "
                    "school -- omit curator_group_id to inherit it, or "
                    "match it explicitly",
                    code="practice_school_immutable",
                )
        else:
            effective_curator_group_id = parent.curator_group_id

    practice = Practice(
        master_id=master_id,
        practice_type=body.practice_type,
        title=body.title,
        description=body.description,
        what_to_prepare=body.what_to_prepare,
        contraindications=body.contraindications,
        scheduled_at=body.scheduled_at,
        duration_minutes=body.duration_minutes,
        timezone=body.timezone,
        max_participants=body.max_participants,
        parent_practice_id=body.parent_practice_id,
        is_free=body.is_free,
        price_cents=price_cents,
        currency=body.currency,
        audience_kind=effective_audience_kind,
        curator_group_id=effective_curator_group_id,
    )

    # Calendar taxonomy -> data.taxonomy (JSONB sandbox).
    # set_jsonb() flags the column modified so SQLAlchemy emits the write;
    # a fresh dict is safe to assign on a not-yet-persisted object.
    data: dict = {
        "taxonomy": _build_taxonomy(
            body.direction, body.difficulty, body.style,
        ),
    }
    # E3: persist the recurrence spec on the series root (schema-on-read, the
    # same JSONB sandbox as taxonomy). Stored as plain JSON (dates -> ISO
    # strings via mode="json") so it round-trips through JSONB; generation
    # parses it back on publication. A series practice without a spec omits the
    # key entirely, and generation no-ops for it.
    if body.recurrence is not None:
        data["recurrence"] = body.recurrence.model_dump(mode="json")
    practice.set_jsonb("data", data)

    try:
        async with session.begin_nested():
            session.add(practice)
            await session.flush()
    except IntegrityError:
        winner = await _find_duplicate_practice(
            master_id, body, session, since=None,
        )
        if winner is not None:
            await _same_school_or_409(winner, body, session)
            logger.info(
                "practice_create_race_lost",
                master_id=str(master_id),
                actor_id=str(user.id),
                existing_practice_id=str(winner.id),
                title=body.title,
            )
            return winner, True
        # BE-74: the OTHER constraint this INSERT can fail. The school was
        # validated above, and delete_curator_group may have deleted it
        # since: the INSERT waited on the school row's lock (the FK check
        # takes KEY SHARE) and then failed the FK. That used to fall
        # through to the bare `raise` below -- a 500 because somebody
        # deleted a school. It is the very fact the validation refuses, so
        # it gets the validation's 400. Told apart by READING the school
        # again rather than by parsing the error: no winner was found, so
        # the unique index did not fire; a school that is gone is the FK.
        # The other order of the same race does not land here: an INSERT
        # that commits before the school's DELETE succeeds, and the DELETE's
        # FK action then turns the practice public and schoolless (trigger
        # of migration be74a1b2c3d4).
        # A SELECT, not session.get: get answers from the identity map,
        # and a school object loaded earlier in this session would still
        # be there after the row was deleted.
        if effective_curator_group_id is not None and (
            await session.execute(
                select(CuratorGroup.id).where(
                    CuratorGroup.id == effective_curator_group_id,
                )
            )
        ).scalar_one_or_none() is None:
            raise BadRequestError(
                _SCHOOL_NOT_USABLE, code=_SCHOOL_NOT_USABLE_CODE,
            ) from None
        # Practically unreachable: uq_practice_master_title_scheduled_
        # recurrence only fires on an exact (master_id, title,
        # scheduled_at, recurrence) collision, so the winner must exist.
        # Re-raise rather than silently returning nothing a caller isn't
        # prepared to handle.
        raise

    if inherited_group_source_id is not None and effective_audience_kind == AudienceKind.GROUPS.value:
        # Copy the PARENT's target groups, not body.group_ids -- silence
        # inherits the whole restriction, and body.group_ids is empty here
        # by construction (the caller sent neither field). Same shape as
        # series_service.py's root_group_ids copy for Path A.
        #
        # Read AFTER the flush, a statement later than the audience_kind
        # taken off the parent -- and still the same state of the parent
        # (BE-103 W-a): the parent is held FOR SHARE since
        # _owned_root_parent_or_400, the root's group rows are written by
        # update_practice, and update_practice holds the root FOR UPDATE,
        # so it waits for this transaction. The one writer of these rows
        # that does NOT pass the practice's lock is the FK cascade of
        # masters/groups_service.py::delete_group (master_group ->
        # practice_audience_group, ON DELETE CASCADE): a group deleted in
        # between drops its row here as everywhere (BE-103 N2, open).
        parent_group_ids = list(
            (
                await session.execute(
                    select(PracticeAudienceGroup.group_id).where(
                        PracticeAudienceGroup.practice_id == inherited_group_source_id,
                    )
                )
            ).scalars().all()
        )
        await _set_practice_audience_groups(practice.id, parent_group_ids, session)
    elif body.group_ids:
        await _set_practice_audience_groups(practice.id, body.group_ids, session)

    if for_another_master:
        await _tell_master_of_curator_act(
            user, practice, _CURATOR_CREATED, session,
        )

    logger.info(
        "practice_created",
        master_id=str(master_id),
        actor_id=str(user.id),
        practice_type=body.practice_type,
        title=body.title,
        is_free=body.is_free,
        price_cents=price_cents,
        direction=body.direction,
        difficulty=body.difficulty,
    )

    return practice, False


async def get_practice(
    practice_id: UUID,
    user: User,
    session: AsyncSession,
) -> tuple[Practice, str | None, str | None, list[str]]:
    """Get a practice by id with visibility rules.

    Returns (Practice, master_name, master_avatar_url, master_methods) tuple.

    Uses OUTER JOIN to MasterProfile so that a practice is never hidden
    just because its master profile was deleted (review #3 finding).
    master_methods extracted from MasterProfile.data.profile.methods;
    defaults to [] when profile row is missing.
    master_avatar_url is User.avatar_url (synced from Telegram on login);
    None when the master has no Telegram photo.

    Draft/deleted practices are visible only to the owner master.
    All other statuses are visible to any authenticated user.
    """
    stmt = (
        select(
            Practice,
            User.first_name,
            User.last_name,
            User.avatar_url,
            MasterProfile.data,
        )
        .join(User, Practice.master_id == User.id)
        .outerjoin(MasterProfile, Practice.master_id == MasterProfile.user_id)
        .where(Practice.id == practice_id)
    )
    result = await session.execute(stmt)
    row = result.one_or_none()

    if not row:
        raise NotFoundError("Practice not found")

    practice, first_name, last_name, master_avatar_url, profile_data = row
    master_name = master_full_name(first_name, last_name)

    # Draft/deleted visible only to owner (P-08: 404 not 403). BE-63: the
    # owner is the master or the curator of the practice's school -- the
    # curator reads the school's drafts to publish or fix them. A deleted
    # practice stays nobody's to read but its master's, as before.
    if practice.status not in _PUBLIC_STATUSES and practice.master_id != user.id:
        if practice.status == PracticeStatus.DELETED.value:
            raise NotFoundError("Practice not found")
        await _manager_of_practice_or_404(practice, user, session)

    master_methods: list[str] = (
        profile_data.get("profile", {}).get("methods", [])
        if profile_data
        else []
    )

    return practice, master_name, master_avatar_url, master_methods


async def get_practice_detail(
    practice_id: UUID,
    user: User,
    session: AsyncSession,
) -> PracticeResponse:
    """Get a single practice as a ready PracticeResponse for the detail screen.

    Public service entry point for GET /practices/{id}. Encapsulates the
    visibility rules (get_practice), the per-user is_booked/is_paid flags,
    and response assembly so the router stays thin and does not reach into
    private helpers (C-1: no cross-layer import of user_flags_for_practices).
    """
    practice, master_name, master_avatar_url, master_methods = (
        await get_practice(practice_id, user, session)
    )
    # Per-user booking flags -- computed BEFORE the audience gate below
    # because an existing booking is exactly what exempts a non-owner
    # from it (see the gate).
    flags = await user_flags_for_practices(user.id, [practice.id], session)
    is_booked, is_paid = flags.get(practice.id, (False, False))

    # Audience gate on the DETAIL view (C-audience): a scheduled
    # groups/students practice must not be readable by an arbitrary
    # authenticated stranger via a forwarded link (it leaks
    # audience_group_names). 404 not 403, mirroring get_practice's P-08
    # so the response is not an "exists but private" oracle.
    #
    # BUT a viewer who ALREADY holds a booking is exempt: this endpoint
    # is also what PracticeLiveView / CheckinView read for a booked
    # non-owner (zoom_meeting_status and the
    # audience_group_names that compose the "you are not in group X"
    # message are all served BELOW for exactly this person). A master
    # narrowing the audience or blocking a user must not retroactively
    # 404 a practice they paid for -- their access already exists; the
    # gate only guards access a stranger does NOT yet have. The owner
    # always sees their own practice.
    # Retroactive policy (B) (H-R2-8): this READ grandfather covers BOTH
    # cases (the record stays visible); the check-in ACTION is
    # grandfathered only through audience narrowing -- a blocked viewer
    # still reads here but is refused at upsert_checkin
    # (diary/checkins_service.py).
    # S-c: the EXEMPTION uses the strict set, not is_booked. is_booked is a
    # display flag and counts PENDING -- an intent, not an entitlement.
    # Taking it as proof of access let anyone who can create a pending
    # booking read a practice their audience excludes them from; the badge
    # is unaffected and still shows PENDING as "yours".
    holds_access_booking = (
        await session.execute(
            select(func.count(Booking.id)).where(
                Booking.user_id == user.id,
                Booking.practice_id == practice.id,
                Booking.status.in_(_ACCESS_GRANTING_STATUSES),
            )
        )
    ).scalar_one() > 0

    # BE-63: the curator of the practice's school passes too -- they
    # manage it, whatever its audience (a draft has no audience yet).
    if (
        practice.master_id != user.id
        and not holds_access_booking
        and await _curated_school_of(practice, user, session) is None
    ):
        from app.core.exceptions import ForbiddenError
        from app.modules.practices.audience_service import (
            assert_viewer_can_access_practice,
        )
        try:
            await assert_viewer_can_access_practice(
                user.id, practice, session,
            )
        except ForbiddenError:
            raise NotFoundError("Practice not found") from None
    series_meta = await series_meta_for_practices([practice], session)
    # E12 + aggregate: OWNER-ONLY on this shared detail endpoint. no_show is
    # sensitive, so a non-owner viewer never sees these -- skip the query and
    # leave all three None. (Series-meta above is innocuous and shown to all.)
    is_owner = practice.master_id == user.id
    attendance = (
        await attendance_counts_for_practices([practice], session)
        if is_owner
        else {}
    )
    # T21-1: host join_url, owner-only -- same is_owner gate as the
    # attendance counts above (a non-owner must never see the master's
    # personal link either).
    #
    # T-35: the per-viewer zoom_link gate that used to stand here is gone with
    # the column. A booked non-owner no longer receives ANY link from this
    # endpoint -- they ask resolve_zoom_entry_endpoint, which answers for them
    # specifically. The narrowing query this replaced only existed to decide
    # whether to echo a hand-typed URL back.
    host_join_url = None
    if is_owner:
        from app.modules.zoom.service import get_host_join_url
        host_join_url = await get_host_join_url(practice.id, session)
    # A4 V2 (PROMPT №572): NOT owner-gated -- this is the call site behind
    # GET /practices/{id}, which is also what PracticeLiveView reads for a
    # booked (non-owner) participant. Both need to distinguish pending_
    # creation from create_failed, not just the owner.
    from app.modules.zoom.service import get_zoom_meeting_status
    zoom_meeting_status = await get_zoom_meeting_status(practice.id, session)
    # P5 (PROMPT №594): needed by CheckinView.vue to compose "Вы не состоите
    # в группе «...»" client-side without a second round-trip -- see this
    # endpoint's own callers for the full message-mapping story.
    audience_group_names = await group_names_for_practice(practice, session)
    # P5/GT-12: a second, independent lookup rather than one query fused
    # with the line above -- the two answer different questions against
    # different tables, and saving one round trip on an owner-facing
    # response is not worth a join nobody can read.
    curator_group_name = await curator_group_name_for_practice(
        practice, session,
    )
    audience_unavailable = await curator_group_audience_is_dark(
        practice, session,
    )
    return practice_to_response(
        practice,
        master_name,
        master_methods,
        master_avatar_url=master_avatar_url,
        is_booked=is_booked,
        is_paid=is_paid,
        zoom_host_join_url=host_join_url,
        zoom_public_link_visible=is_owner,
        zoom_meeting_status=zoom_meeting_status,
        audience_group_names=audience_group_names,
        curator_group_name=curator_group_name,
        audience_unavailable=audience_unavailable,
        **series_meta_kwargs(series_meta.get(practice.id)),
        **attendance_counts_kwargs(attendance.get(practice.id)),
    )


async def update_practice(
    practice_id: UUID,
    user: User,
    body: UpdatePracticeRequest,
    session: AsyncSession,
) -> Practice:
    """Update a practice. Only the owner master can edit.

    Uses FOR UPDATE to prevent lost updates on concurrent
    status transitions (P-12).

    Raises NotFoundError if not found or not owner (P-08).
    Raises BadRequestError if practice is deleted/terminal,
        if NOT NULL field set to null (P-02),
        if status transition is invalid,
        if pricing invariant is violated,
        or if price is changed with active bookings (CQ-05).

    Calendar taxonomy (direction / difficulty / style) is handled in a
    separate JSONB branch (data.taxonomy) -- see _TAXONOMY_FIELDS. These keys
    are pulled out of update_data BEFORE the column setattr loop so that
    setattr() never targets a non-existent column.

    BE-63: "the owner" is the practice's master OR the curator of its
    school (_manager_of_practice_or_404, the one rule). For a curator:
      - publishing a master's draft needs that master to be a master of
        the school NOW (owner Q5): their member row and profile are taken
        FOR SHARE first (_lock_school_master_or_400), BEFORE the practice
        -- the module order is member -> master profile -> practice ->
        group, and delete_curator_group takes members and then practices;
      - the practice is then taken FOR UPDATE, and the curator's right is
        re-checked under the group lock before anything is written;
      - "whose" stays the MASTER's everywhere it meant the owner: the
        confirmed methods, the master's own groups, the school fan-out's
        author (owner ruling: the master, and the fan-out skips them);
      - the act is audited and the master is told (_tell_master_of_
        curator_act) -- once per publication, once per edit that wrote
        something; a repeated request that changes nothing tells nobody.
    """
    # BE-63: a plain read first, to learn whose practice and which school
    # before any lock -- the curator's publication must take the master's
    # rows ahead of the practice. practices.master_id has no writer after
    # creation, so what this read says about the master is the row's.
    pre = await session.get(Practice, practice_id)
    if pre is None:
        raise NotFoundError(_NOT_FOUND)
    managing_school = await _manager_of_practice_or_404(pre, user, session)
    publishes = (
        body.model_dump(exclude_unset=True).get("status")
        == PracticeStatus.SCHEDULED.value
    )
    if managing_school is not None and publishes:
        await _lock_school_master_or_400(
            managing_school, pre.master_id, session,
        )

    # PRACTICE ROW ORDER (module header): an audience change of a series
    # root writes the root AND its children, so all of them are taken in
    # one statement, by id, before the school. WHETHER to take the
    # children is decided here, on the unlocked read, and decided again on
    # the locked root below -- the read can go stale, the lock cannot.
    # Children are taken only when the read says the audience changes:
    # EditPracticeView sends the audience on every save, and taking them on
    # mere presence would queue every booking of the series behind each
    # title edit of its root.
    take_children = await _root_audience_change(
        pre, body.model_dump(exclude_unset=True), session,
    )
    practice, children = await _lock_practice_and_children(
        practice_id, take_children, session,
    )

    if not practice:
        raise NotFoundError("Practice not found")

    # BE-79 (K3): the practice's own master, blocked in its school, may not
    # edit or publish it -- any PATCH, the move to 'deleted' included
    # (gate ruling R5: the draft is deleted by DELETE /practices/{id}).
    # Read on the locked row, see _refuse_blocked_in_school. A curator
    # acting here is never the blocked one: the curator cannot be blocked
    # in his own school (block_curator_group_member).
    if managing_school is None:
        await _refuse_blocked_in_school(
            practice.curator_group_id, user.id, session,
        )

    if managing_school is not None:
        await _relock_school_or_404(user, managing_school, session)
    acting_for_master = managing_school is not None
    before = _practice_snapshot(practice)

    if practice.status == PracticeStatus.DELETED.value:
        raise BadRequestError("Cannot edit a deleted practice")

    update_data = body.model_dump(exclude_unset=True)

    # S-a: a CHILD occurrence has no audience of its own to edit.
    #
    # The audience of a series lives on the root and is pushed down to the
    # children (propagate_audience_to_children). Editing a child's audience
    # per-occurrence therefore produces a state that looks applied and is
    # not: the very next root edit overwrites it without a word. That is
    # worse than a refusal -- the master believes one session is restricted
    # while it is one root save away from being public again.
    #
    # Refused WHOLE, before anything is applied: a PATCH mixing an audience
    # field with innocent ones would otherwise land half of itself and stay
    # silent about the rest -- the exact class of quiet partial state this
    # gate exists to kill.
    if practice.parent_practice_id is not None and (
        "audience_kind" in update_data or "group_ids" in update_data
    ):
        raise BadRequestError(
            "Audience belongs to the series: edit it on the series root, "
            "not on a single occurrence",
        )

    # The decision again, on the locked root: it is the one the
    # propagation below acts on. The locked set must be the set it writes;
    # a non-terminal child outside it refuses the request whole, before
    # anything is applied (_refuse_unheld_children_or_409).
    audience_changed = await _root_audience_change(
        practice, update_data, session,
    )
    if audience_changed:
        await _refuse_unheld_children_or_409(practice, children, session)

    # Separate Calendar taxonomy (JSONB) from plain column fields.
    # These are NOT columns: applying them via setattr would create dead
    # Python attributes that never persist (same trap as onboarding_completed
    # in users/service.py). They are merged into data.taxonomy below.
    taxonomy_updates = {
        field: update_data.pop(field)
        for field in _TAXONOMY_FIELDS
        if field in update_data
    }

    # P5 (PROMPT №594): group_ids is NOT a column either (practice_audience_
    # group is a separate table) -- pull it out before the setattr loop for
    # the same reason as taxonomy above. audience_kind IS a real column and
    # flows through the loop unchanged.
    group_ids_sent = "group_ids" in update_data
    group_ids_value: list[UUID] = update_data.pop("group_ids", None) or []
    # BE-74: curator_group_id IS a column, and that is exactly why it must
    # be pulled out here: left in update_data it would reach the setattr
    # loop and move the practice to another school. The owning school is
    # set at creation and never changes (owner ruling, 2026-10-01): the
    # stored value resent is a no-op, anything else is refused whole,
    # before any field of this request lands.
    if (
        "curator_group_id" in update_data
        and update_data.pop("curator_group_id") != practice.curator_group_id
    ):
        raise BadRequestError(
            "The practice's school is set when it is created and "
            "cannot be changed",
            code="practice_school_immutable",
        )
    final_audience_kind = update_data.get("audience_kind", practice.audience_kind)

    # BE-74: the audience must stay one a practice with THIS school (or
    # with none) may carry -- the same rule CreatePracticeRequest applies,
    # checked here against the STORED school because the school is not
    # editable and therefore never in the request. Only when the kind is
    # actually sent: an unsent kind is the stored one, which passed this
    # rule when it was written.
    if "audience_kind" in update_data:
        try:
            check_school_audience(
                final_audience_kind, practice.curator_group_id,
            )
        except ValueError as exc:
            raise BadRequestError(str(exc)) from exc

    if group_ids_sent:
        if final_audience_kind == AudienceKind.GROUPS.value and not group_ids_value:
            raise BadRequestError(
                "group_ids must be non-empty when audience_kind='groups'"
            )
        if final_audience_kind != AudienceKind.GROUPS.value and group_ids_value:
            raise BadRequestError(
                "group_ids is only allowed when audience_kind='groups'"
            )
        await _owned_group_ids_or_400(
            practice.master_id, group_ids_value, session,
        )
    elif final_audience_kind == AudienceKind.GROUPS.value:
        # Switching TO (or staying on) 'groups' without sending new
        # group_ids in THIS request -- only valid if the practice already
        # has target groups from before; otherwise it would end up
        # audience_kind='groups' with nobody able to ever see it.
        existing_count = (
            await session.execute(
                select(func.count(PracticeAudienceGroup.id)).where(
                    PracticeAudienceGroup.practice_id == practice.id,
                )
            )
        ).scalar_one()
        if existing_count == 0:
            raise BadRequestError(
                "group_ids must be non-empty when audience_kind='groups'"
            )

    # S-b: does this request actually CHANGE the target-group set?
    #
    # EditPracticeView resends group_ids on every save (an empty list on a
    # public practice), so without this the delete-then-insert below ran on
    # every title edit -- and, worse, marked the audience as changed, which
    # fanned the C1 propagation out over every child of the series. Same
    # reasoning as the taxonomy comparison further down: presence in the
    # payload is not change.
    #
    # Compared as SETS: order and duplicates carry no meaning here.
    groups_unchanged = False
    if group_ids_sent:
        stored_group_ids = set(
            (
                await session.execute(
                    select(PracticeAudienceGroup.group_id).where(
                        PracticeAudienceGroup.practice_id == practice.id,
                    )
                )
            ).scalars().all()
        )
        groups_unchanged = stored_group_ids == set(group_ids_value)

    # Guard NOT NULL fields against explicit null (P-02).
    for field in _NOT_NULL_FIELDS:
        if field in update_data and update_data[field] is None:
            raise BadRequestError(f"{field} cannot be null")

    # Validate status transition if status is being changed.
    if "status" in update_data:
        new_status = update_data["status"]
        allowed = _VALID_TRANSITIONS.get(practice.status, set())
        if new_status not in allowed:
            raise BadRequestError(
                f"Cannot transition from "
                f"{practice.status} to {new_status}"
            )

    # CQ-05: prevent price/is_free changes when active bookings exist.
    # Participants paid the original price; changing it mid-flight
    # creates a mismatch between Purchase.paid_cents and Practice.price_cents.
    pricing_changed = (
        "is_free" in update_data
        and update_data["is_free"] != practice.is_free
    ) or (
        "price_cents" in update_data
        and update_data["price_cents"] != practice.price_cents
    )
    if pricing_changed and await _has_active_bookings(
        practice.id, session,
    ):
        raise BadRequestError(
            "Cannot change price with active bookings"
        )

    # Forbid lowering capacity below the people already holding a slot.
    # max_participants has a ge=1 bound in the schema but no floor at the
    # current headcount -- dropping 20 bookings to max=1 leaves
    # current > max, and every capacity check ("< max_participants")
    # then reads "full" forever: new bookings AND every waitlist
    # confirmation are silently rejected (confirm_waitlist even quietly
    # returns each holder to WAITING). Reject the shrink instead.
    if "max_participants" in update_data:
        new_cap = update_data["max_participants"]
        # None means "no capacity limit" -- a RELAXATION, never a shrink,
        # so it is always allowed (and `None < active` would be a
        # TypeError -> 500). The frontend sends null on every save with
        # an empty capacity field, so this path is hit routinely.
        if new_cap is not None:
            active = await _active_booking_count(practice.id, session)
            if new_cap < active:
                raise BadRequestError(
                    f"Cannot set max_participants to {new_cap}: "
                    f"{active} participant(s) already booked"
                )

    # Enforce pricing invariant after applying updates.
    # Resolve final is_free and price_cents from mix of
    # existing values and incoming updates.
    final_is_free = update_data.get("is_free", practice.is_free)
    final_price = update_data.get(
        "price_cents", practice.price_cents,
    )
    if "is_free" in update_data or "price_cents" in update_data:
        final_price = _enforce_pricing(final_is_free, final_price)
        update_data["price_cents"] = final_price

    # Capture the pre-update scheduled_at so we can detect a reschedule and
    # record old -> new in the diary feed projection below. Read BEFORE the
    # setattr loop overwrites practice.scheduled_at.
    old_scheduled_at = practice.scheduled_at
    # E3: capture status before the loop applies the new one, so we can detect a
    # draft -> scheduled publication and materialize series occurrences below.
    old_status = practice.status

    # P5 (PROMPT №594): capture the PRE-update audience_kind before the
    # setattr loop overwrites it, so the "transitioning away from groups"
    # branch below can tell.
    old_audience_kind = practice.audience_kind

    # H-R2 (3.3): capture the PRE-update capacity before the setattr loop
    # overwrites it -- the "was capacity relaxed?" comparison at the end
    # of this function must read the OLD value (mirror of old_scheduled_at
    # / old_status above).
    old_cap = practice.max_participants

    # Apply only provided column fields.
    for field, value in update_data.items():
        setattr(practice, field, value)

    if group_ids_sent and not groups_unchanged:
        await _set_practice_audience_groups(practice.id, group_ids_value, session)
    elif (
        "audience_kind" in update_data
        and old_audience_kind == AudienceKind.GROUPS.value
        and final_audience_kind != AudienceKind.GROUPS.value
    ):
        # Switched AWAY from 'groups' without sending group_ids -- the old
        # target-group rows are now meaningless; clear them so they don't
        # linger as stale state a later switch BACK to 'groups' would
        # silently resurrect.
        #
        # P5/GT-11: "away from groups" now INCLUDES away to
        # 'curator_groups'. No code change was needed for that -- the
        # condition was always written as "not GROUPS" rather than
        # "== PUBLIC" -- but it is worth saying out loud, because the
        # branch below is its new mirror and the pair only works if both
        # halves read the same way.
        await _set_practice_audience_groups(practice.id, [], session)

    # C1-propagation: if this is a SERIES ROOT and the audience changed,
    # push the new audience onto the already-generated children -- a root
    # published public and later switched to 'groups' would otherwise
    # leave N public, bookable children exposing the restricted sessions
    # (the original C1 hole, reachable via the ordinary edit path rather
    # than at generation). Root-only: children are edited via their own
    # root, not individually, and a per-occurrence audience change is not
    # a supported operation, so a non-root update never fans out.
    # An unchanged set is not a change -- otherwise every save propagated to
    # every child. A KIND change still propagates even when the set is
    # identical (public -> groups with the same rows already stored is a
    # real audience change).
    # audience_changed was decided on the locked root before anything was
    # applied (_root_audience_change); it is False for a child.
    if audience_changed:
        from app.modules.practices.series_service import (
            propagate_audience_to_children,
        )
        await propagate_audience_to_children(practice, children, session)

    # Apply Calendar taxonomy updates into data.taxonomy (JSONB).
    # deepcopy + set_jsonb so SQLAlchemy detects the change. Only the keys
    # actually sent are overwritten; the rest of data.taxonomy is preserved.
    if taxonomy_updates:
        # T2 (2026-07-15): direction/style membership is no longer checked by
        # Pydantic (it can't reach the async catalog), so both are validated
        # here, against the config+catalog union.
        #
        # T21-8 (PROMPT №547): EditPracticeView resends BOTH direction and
        # style on EVERY save (not only when the master actually changes
        # them), and exclude_unset only tells us they were PRESENT, not that
        # they changed -- so gating re-validation on presence alone re-ran
        # _assert_master_confirmed_taxonomy on every title-only save too,
        # blocking a master from editing ANY field of a practice the instant
        # their confirmed methods no longer covered its (unchanged) taxonomy.
        # Compare against the practice's currently-stored taxonomy instead:
        # object only when a value ACTUALLY CHANGES to something unconfirmed.
        stored_taxonomy = (practice.data or {}).get("taxonomy", {})
        stored_direction = stored_taxonomy.get("direction")
        stored_style = stored_taxonomy.get("style")

        if "direction" in taxonomy_updates:
            new_direction = taxonomy_updates["direction"]
            # Style paired with this same request validates against the NEW
            # direction (None if style isn't part of this update -- a no-op,
            # unchanged from before T21-8: a direction-only change does not
            # re-check the existing stored style against the new direction).
            new_style = taxonomy_updates.get("style")
            direction_changed = new_direction != stored_direction
            style_changed = (
                "style" in taxonomy_updates and new_style != stored_style
            )
            if direction_changed or style_changed:
                await _validate_taxonomy(new_direction, new_style, session)
                # T21-6 (PROMPT №546): same master-confirmation check as
                # create_practice -- an update can equally smuggle in a
                # direction/style the master was never confirmed for.
                await _assert_master_confirmed_taxonomy(
                    practice.master_id, new_direction, new_style, session,
                    own=not acting_for_master,
                )
        elif "style" in taxonomy_updates:
            # W-1: style changed WITHOUT direction in the same request --
            # validate against the direction actually STORED on the practice
            # (a style valid for a DIFFERENT direction, e.g. "silence" -- a
            # meditation style -- on a stored yoga practice, must still be
            # rejected).
            new_style = taxonomy_updates["style"]
            if new_style != stored_style:
                await _validate_style_choice(stored_direction, new_style, session)
                await _assert_master_confirmed_taxonomy(
                    practice.master_id, stored_direction, new_style, session,
                    own=not acting_for_master,
                )

        data = copy.deepcopy(practice.data) if practice.data else {}
        taxonomy = data.get("taxonomy", {})
        taxonomy.update(taxonomy_updates)
        data["taxonomy"] = taxonomy
        practice.set_jsonb("data", data)

    logger.info(
        "practice_updated",
        practice_id=str(practice_id),
        master_id=str(practice.master_id),
        actor_id=str(user.id),
        fields=list(update_data.keys()),
        taxonomy_fields=list(taxonomy_updates.keys()),
    )

    # Diary feed: if the master moved the time, fan out a reschedule event to
    # every booked user. Only when scheduled_at actually changed (a PATCH that
    # touches other fields must not spam reschedule cards). Lazy import keeps
    # the dependency one-way (practices -> diary).
    new_scheduled_at = practice.scheduled_at
    if (
        "scheduled_at" in update_data
        and new_scheduled_at != old_scheduled_at
    ):
        from app.modules.diary.projections import (
            project_practice_rescheduled,
        )
        # Master name for the diary card: full "First Last" (MVP rule), same
        # as practice cards. Load the User directly -- get_master_display_name
        # is for notifications and would return the profile display_name.
        master_user = await session.get(User, practice.master_id)
        master_name = master_full_name(
            master_user.first_name if master_user else None,
            master_user.last_name if master_user else None,
        )
        await project_practice_rescheduled(
            session,
            practice=practice,
            master_name=master_name,
            old_scheduled_at=old_scheduled_at,
            new_scheduled_at=new_scheduled_at,
            occurred_at=datetime.now(UTC),
        )

        # Comms (T1, dictionary §2): practice.rescheduled (ONLY a time
        # move -- this branch already gates on scheduled_at actually
        # changing) fanned out to every booked user (velo expands the
        # domain audience, ID-4), and every reminder is moved to the new
        # anchor: cancel (one per booking by its "booking:<id>"
        # correlation, plus the master's by "practice:<id>") + re-schedule
        # (donor rule: reschedule = cancel + schedule by the caller). Same
        # transaction as the update (ID-2).
        #
        # ONE ACT, ONE IDENTITY: `act` names this move in every key it
        # emits (core/events/reminders.py header). A key without it would
        # collide with the cancelled series of the previous anchor -- comms
        # holds a key forever -- and the moved practice would have no
        # reminders. Minting is safe because this branch runs only when
        # scheduled_at actually changed, on the row locked FOR UPDATE
        # above: a repeated request to the same time never reaches here.
        from app.core.events.notify import emit_notification
        from app.core.events.reminders import (
            BookingRef,
            cancel_practice_reminders,
            format_event_time,
            new_reschedule_act,
            schedule_booking_reminders,
            schedule_master_practice_reminder,
        )
        act = new_reschedule_act()
        from app.modules.bookings.models import Booking, BookingStatus
        booked_stmt = (
            select(Booking)
            .where(
                Booking.practice_id == practice.id,
                Booking.status == BookingStatus.CONFIRMED.value,
            )
        )
        booked = (
            await session.execute(booked_stmt)
        ).scalars().all()
        when_text = format_event_time(new_scheduled_at)
        for booking in booked:
            await emit_notification(
                session,
                idempotency_key=(
                    f"practice-rescheduled:{act}:{booking.user_id}"
                ),
                type="practice.rescheduled",
                target_type="user",
                target_value=str(booking.user_id),
                title="Практика перенесена",
                body=(
                    f"Практика «{practice.title}» перенесена. "
                    f"Новое время: {when_text}. Мастер: {master_name}."
                ),
                action_data={
                    "action": "open_practice",
                    "params": {"practice_id": str(practice.id)},
                    "practice_title": practice.title,
                    "master_name": master_name,
                    "scheduled_at": when_text,
                },
            )
        await cancel_practice_reminders(
            session,
            practice_id=str(practice.id),
            bookings=[
                BookingRef(
                    booking_id=str(booking.id), user_id=str(booking.user_id),
                )
                for booking in booked
            ],
        )
        for booking in booked:
            await schedule_booking_reminders(
                session,
                booking_id=str(booking.id),
                user_id=str(booking.user_id),
                practice_id=str(practice.id),
                practice_title=practice.title,
                master_name=master_name,
                scheduled_at=new_scheduled_at,
                act=act,
            )
        # BE-33: the master's own reminder rides the same cancel above
        # ("practice:<id>" correlation, MASTER_REMINDER_TYPES) and has to be
        # re-anchored here for the same reason the series is -- it is not
        # per-booking, so it sits outside the loop and happens even for a
        # practice nobody has booked.
        await schedule_master_practice_reminder(
            session,
            practice_id=str(practice.id),
            master_user_id=str(practice.master_id),
            practice_title=practice.title,
            scheduled_at=new_scheduled_at,
            act=act,
        )

        # E21: keep the Zoom meeting's start time in sync, then re-fetch and
        # overwrite stored registrant join links -- self-healing regardless
        # of whether Zoom actually invalidates them on reschedule (unresolved
        # question, see zoom/service.py docstring). Best-effort: never raises.
        from app.modules.zoom.service import sync_meeting_reschedule
        await sync_meeting_reschedule(practice, session)

    # E3: materialize series occurrences when a series ROOT is published
    # (draft -> scheduled). Gated inside the helper on the recurrence spec's
    # presence, so a series practice without a spec (seed demo) is a no-op. Only
    # roots generate (parent_practice_id is None); generated children are
    # created already-scheduled and never re-enter this path.
    if (
        old_status == PracticeStatus.DRAFT.value
        and practice.status == PracticeStatus.SCHEDULED.value
        and practice.practice_type == PracticeType.SERIES.value
        and practice.parent_practice_id is None
    ):
        await generate_series_occurrences(practice, session)

    # E21: create the practice's Zoom meeting on publish (draft -> scheduled),
    # for ANY practice type -- not gated on series, unlike the block above.
    # Best-effort: create_meeting_for_practice never raises, so publish
    # always succeeds regardless of Zoom's outcome (PROMPT №519 amendment 2 --
    # confirmed as the intended reading). KNOWN GAP: series CHILDREN are
    # created directly inside generate_series_occurrences() with
    # status=scheduled and never pass through this branch, so they do not
    # get a Zoom meeting from this step -- out of scope for this prompt
    # (would touch series_service.py), flagged rather than silently patched.
    if (
        old_status == PracticeStatus.DRAFT.value
        and practice.status == PracticeStatus.SCHEDULED.value
    ):
        from app.modules.zoom.service import create_meeting_for_practice
        await create_meeting_for_practice(practice, session)

    # BE-33: the master's own one-hour reminder, scheduled at publication.
    # Gated on the SAME transition as the Zoom block above and it inherits
    # that block's KNOWN GAP by construction -- series children never reach
    # here -- so generate_series_occurrences schedules its own, per child.
    # A practice published less than an hour before it starts gets none:
    # schedule_master_practice_reminder returns False rather than emitting
    # into the past.
    if (
        old_status == PracticeStatus.DRAFT.value
        and practice.status == PracticeStatus.SCHEDULED.value
        and practice.scheduled_at is not None
    ):
        from app.core.events.reminders import PUBLISHED_ACT
        from app.core.events.reminders import (
            schedule_master_practice_reminder as _schedule_master_reminder,
        )
        await _schedule_master_reminder(
            session,
            practice_id=str(practice.id),
            master_user_id=str(practice.master_id),
            practice_title=practice.title,
            scheduled_at=practice.scheduled_at,
            act=PUBLISHED_ACT,
        )

    # BE-30: tell the school its teacher opened something.
    #
    # BE-74: EVERY practice of a school, public ones included -- the
    # trigger is ownership, not audience. A public practice made in a
    # school is shown on its page, and its students hear about it like
    # about any other.
    #
    # HOOKED HERE AND NOWHERE ELSE, and that is the opposite of the block
    # above on purpose. The master reminder is also scheduled inside
    # generate_series_occurrences, because forty occurrences are forty
    # sessions to be reminded of; this is one decision to open a course,
    # and a second hook there would turn two hundred members times forty
    # occurrences into eight thousand messages from one press of publish.
    # Series children never pass this branch (born scheduled), so the
    # single hook gives exactly one announcement per publication.
    #
    # Lazy import: curator_groups/service.py imports practices/models.py,
    # so a module-level import here closes a cycle -- the same reason
    # cancel_service.py imports _record_group_event lazily.
    if (
        old_status == PracticeStatus.DRAFT.value
        and practice.status == PracticeStatus.SCHEDULED.value
        and practice.curator_group_id is not None
    ):
        from app.modules.curator_groups.service import (
            announce_published_practice,
        )
        # BE-63 (owner ruling): the fan-out's author is the MASTER, also
        # when the curator pressed publish -- the school hears its teacher
        # opened something, and the master is the one it skips.
        author = (
            user if not acting_for_master
            else await session.get(User, practice.master_id)
        )
        await announce_published_practice(practice, author, session)

    # H-R2 (3.3): a capacity RELAXATION frees seats -- hand them to the
    # waitlist NOW instead of leaving the queue to wait for someone
    # else's cancellation. Relaxation = max_participants was updated AND
    # (a numeric cap was lifted to None, or raised to a larger number);
    # None -> number is a TIGHTENING and number -> smaller is refused by
    # the shrink guard above, so neither reaches the loop. All decisions
    # read the FINAL post-update state (status / scheduled_at / new cap)
    # except the OLD cap, pre-captured above: a single PATCH may raise
    # the cap AND cancel the practice, and the final picture decides.
    # Gated on a confirmable practice -- mirror of the H-R1 handoff gate
    # in confirm_waitlist's expiry branch (waitlist/service.py): offering
    # seats on a dead practice would only walk the queue through
    # pointless notify -> expire cycles.
    if "max_participants" in update_data:
        new_cap = practice.max_participants
        relaxed = (new_cap is None and old_cap is not None) or (
            new_cap is not None
            and old_cap is not None
            and new_cap > old_cap
        )
        now_utc = datetime.now(UTC)
        confirmable = (
            practice.status == PracticeStatus.SCHEDULED.value
            and practice.scheduled_at > now_utc
        )
        if relaxed and confirmable:
            # process_waitlist notifies EXACTLY ONE waiter per call
            # (.limit(1)) and does NOT check capacity itself -- the
            # boundary is the caller's job (verified fact, H-R2).
            from app.modules.bookings.models import Booking, BookingStatus
            from app.modules.waitlist.models import Waitlist, WaitlistStatus
            from app.modules.waitlist.service import process_waitlist

            if new_cap is None:
                # No limit anymore: every WAITING entry gets its offer.
                while await process_waitlist(practice.id, session):
                    pass
            else:
                active = (
                    await session.execute(
                        select(func.count())
                        .select_from(Booking)
                        .where(
                            Booking.practice_id == practice.id,
                            Booking.status
                            == BookingStatus.CONFIRMED.value,
                        )
                    )
                ).scalar_one()
                # Live holds keep their seat reserved: NOTIFIED with a
                # window still open, or (defensively) with no window at
                # all -- under-offering beats re-offering (re-offering
                # existing holders is explicitly forbidden).
                live_holds = (
                    await session.execute(
                        select(func.count())
                        .select_from(Waitlist)
                        .where(
                            Waitlist.practice_id == practice.id,
                            Waitlist.status
                            == WaitlistStatus.NOTIFIED.value,
                            or_(
                                Waitlist.expires_at.is_(None),
                                Waitlist.expires_at > now_utc,
                            ),
                        )
                    )
                ).scalar_one()
                free_seats = new_cap - active - live_holds
                for _ in range(max(free_seats, 0)):
                    if await process_waitlist(
                        practice.id, session,
                    ) is None:
                        break  # queue drained before the seats did

    # BE-63: a curator's act on a master's practice is audited and told to
    # the master -- ONE message: a publication that also edited fields is
    # "published", and an edit that wrote nothing (a resent PATCH, values
    # equal to the stored ones) is no act at all.
    if acting_for_master:
        if (
            old_status == PracticeStatus.DRAFT.value
            and practice.status == PracticeStatus.SCHEDULED.value
        ):
            await _tell_master_of_curator_act(
                user, practice, _CURATOR_PUBLISHED, session,
            )
        elif _practice_snapshot(practice) != before:
            await _tell_master_of_curator_act(
                user, practice, _CURATOR_EDITED, session,
            )

    return practice


async def preview_audience_change(
    practice_id: UUID,
    user: User,
    audience_kind: str,
    group_ids: list[UUID],
    session: AsyncSession,
) -> int:
    """Owner Q15 (PROMPT №613): how many of this practice's ACTIVE (pending/
    confirmed) bookers would fall OUTSIDE a PROPOSED audience -- called by
    EditPracticeView before saving an audience change, so the master sees
    the real number instead of finding out from upset students at check-in
    time. Read-only: never writes audience_kind or group_ids anywhere.

    Same ownership check as update_practice (404 not 403 for non-owner,
    P-08) and the same group_ids ownership validation the real PATCH
    applies (_owned_group_ids_or_400) -- a master can't use this to probe
    another master's group membership by feeding in group_ids they don't
    own.

    BE-74: no school in the proposal. 'curator_groups' means the
    practice's OWN school, which neither this preview nor the PATCH can
    change; count_stranded_active_bookings reads it off the practice. The
    proposed kind is held to the same rule the PATCH applies
    (check_school_audience), so the preview never prices an audience the
    save would refuse. That also leaves nothing to probe: there is no
    school id to feed in.
    """
    practice = await session.get(Practice, practice_id)
    if practice is None:
        raise NotFoundError("Practice not found")
    # BE-63: the same rule as the PATCH it previews.
    managing_school = await _manager_of_practice_or_404(practice, user, session)
    # BE-79: and the same refusal -- a blocked master gets no number for an
    # edit he may not save. A read: no lock to take.
    if managing_school is None:
        await _refuse_blocked_in_school(
            practice.curator_group_id, user.id, session,
        )

    if group_ids:
        await _owned_group_ids_or_400(practice.master_id, group_ids, session)
    try:
        check_school_audience(audience_kind, practice.curator_group_id)
    except ValueError as exc:
        raise BadRequestError(str(exc)) from exc

    booker_ids = (
        await session.execute(
            select(Booking.user_id).where(
                Booking.practice_id == practice_id,
                Booking.status.in_(_ACTIVE_BOOKING_STATUSES),
            )
        )
    ).scalars().all()

    return await count_stranded_active_bookings(
        practice,
        list(booker_ids),
        audience_kind,
        group_ids,
        session,
    )


async def delete_practice(
    practice_id: UUID,
    user: User,
    session: AsyncSession,
) -> Practice:
    """Soft-delete a draft practice (set status=deleted).

    Only drafts can be deleted. Published practices must be cancelled
    through cancel_practice() (Phase 6.5) which handles refunds.

    Uses FOR UPDATE to prevent concurrent state changes (P-12).

    Raises NotFoundError if not found or not owner (P-08).
    Raises BadRequestError if not a draft.

    BE-63/BE-64: the owner is the master or the curator of the practice's
    school (_manager_of_practice_or_404). A curator's right is re-checked
    under the group lock after the practice row (order practice -> group),
    and the deletion is audited and told to the master. Only a draft is
    deleted, so there is no series cascade here: a series root's sessions
    are born at its publication, and a draft has none.
    """
    stmt = (
        select(Practice)
        .where(Practice.id == practice_id)
        .with_for_update()
    )
    result = await session.execute(stmt)
    practice = result.scalar_one_or_none()

    if not practice:
        raise NotFoundError("Practice not found")

    # R-01 fix: 404 not 403 for non-owner (P-08).
    managing_school = await _manager_of_practice_or_404(practice, user, session)

    if practice.status != PracticeStatus.DRAFT.value:
        raise BadRequestError(
            "Only draft practices can be deleted. "
            "Use cancel for published practices."
        )

    if managing_school is not None:
        await _relock_school_or_404(user, managing_school, session)

    practice.status = PracticeStatus.DELETED.value

    if managing_school is not None:
        await _tell_master_of_curator_act(
            user, practice, _CURATOR_DELETED, session,
        )

    logger.info(
        "practice_deleted",
        practice_id=str(practice_id),
        master_id=str(practice.master_id),
        actor_id=str(user.id),
    )

    return practice
