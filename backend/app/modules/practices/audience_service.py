# =============================================================================
# VELO Backend -- Practice Audience Service (Master GROUPS P5, PROMPT №594)
# =============================================================================
#
# ONE shared predicate for "can this viewer see/book/check into this
# practice" -- reused (not duplicated) by:
#   - practices/listing_service.py list_public_practices (SQL filter, via
#     viewer_audience_clause)
#   - bookings/service.py create_booking (the P1->P5 carried seam)
#   - waitlist/service.py confirm_waitlist (the OTHER booking-creation path
#     -- also closes the carried seam; a blocked/out-of-audience user must
#     not be able to convert a held waitlist notification into a booking
#     either)
#   - diary/checkins_service.py upsert_checkin -- via
#     assert_viewer_not_blocked ONLY (retroactive policy (B), H-R2-8):
#     a CONFIRMED booking grandfathers the holder through audience
#     narrowing; a personal block still refuses the check-in action
# via assert_viewer_can_access_practice below.
#
# RULE: viewer is NOT blocked by the practice's master (master_student.
# blocked_at) AND (audience=public) OR (audience=students AND viewer holds
# >=1 booking in STUDENT_ENTITLEMENT_STATUSES on that master's practices)
# OR (audience=groups AND viewer is a member of >=1 of the practice's
# target groups).
#
# T-20 (owner ruling 2026-08-13): "student" names TWO things and they are
# SPLIT here, not reconciled. DISPLAY (what a master sees in their students
# list -- groups_service._derived_students_base) is a CONTACT LIST and is
# deliberately WIDE: any non-cancelled booking. The RIGHT to enter an
# audience_kind=students practice is NARROW and lives in this module, in
# STUDENT_ENTITLEMENT_STATUSES below. This module used to borrow the
# display rule verbatim (`status != CANCELLED`); it no longer does. Widening
# the DISPLAY sources is T-37 and is NOT part of this file's job.
#
# The three _*_clause() functions are the single source of truth for each
# condition -- both viewer_audience_clause (composes all three into one SQL
# WHERE-clause boolean, correlated to the module-level Practice table) and
# assert_viewer_can_access_practice (evaluates them one at a time against an
# already-loaded practice, to raise the RIGHT specific error code) call the
# SAME functions. Nothing here is reimplemented twice.
# =============================================================================

from uuid import UUID

from sqlalchemy import ColumnElement, and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.exceptions import ForbiddenError
from app.modules.bookings.models import Booking, BookingStatus

# Model imports only. curator_groups/ is NOT imported here for its
# helpers -- see _curator_profile_verified below for why the predicate is
# written locally instead.
from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupMember,
    CuratorMemberKind,
)
from app.modules.masters.groups_models import MasterGroupMembership, MasterStudent
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import (
    AudienceKind,
    Practice,
    PracticeAudienceCuratorGroup,
    PracticeAudienceGroup,
)

# T-20: THE GATE's own booking-status set -- the single source for "does
# this booking make its holder a student of that booking's master, for the
# purpose of ENTERING an audience_kind=students practice".
#
#   CONFIRMED -- holds a seat. The entitlement itself.
#   ATTENDED  -- was there.
#   NO_SHOW   -- KEPT DELIBERATELY (owner ruling 2026-08-13): the person WAS
#                a student; entitlement is not revoked for missing one
#                session. Narrowing here would silently evict people whose
#                only sin is an absence the master themselves recorded.
#   PENDING   -- EXCLUDED. An intent, not an entitlement. Today nothing
#                creates PENDING (both booking-creation paths write
#                CONFIRMED explicitly: bookings/service.py create_booking
#                and waitlist/service.py confirm_waitlist), but Booking.
#                status carries BOTH default=PENDING and
#                server_default=PENDING (bookings/models.py), so ANY future
#                insert that omits status would otherwise mint a student
#                with access to every students-only practice by that master.
#                This set closes that latent hole by construction rather
#                than by relying on both creators continuing to be explicit.
#   CANCELLED -- EXCLUDED, unchanged.
#
# NOT an alias of practices/service.py's ZOOM_VISIBLE_BOOKING_STATUSES /
# _ACCESS_GRANTING_STATUSES, and the difference is the point: those two ARE
# each other (one is literally an alias of the other) because they answer
# the same PER-PRACTICE question -- "may this viewer see THIS practice's
# zoom link / read THIS restricted practice" -- where a NO_SHOW must not
# hand out a live meeting link. This set answers a PER-MASTER question:
# "is this person one of that master's students at all". Same reasoning
# about PENDING, different membership, different question; aliasing them
# would let a change to either silently move the other.
#
# NOT groups_service._derived_students_base's rule either -- see this
# module's header: that is the DISPLAY predicate, and display is wide on
# purpose.
STUDENT_ENTITLEMENT_STATUSES = {
    BookingStatus.CONFIRMED.value,
    BookingStatus.ATTENDED.value,
    BookingStatus.NO_SHOW.value,
}


def _blocked_clause(user_id: UUID) -> ColumnElement[bool]:
    """True iff `user_id` is blocked by the (correlated) Practice's master."""
    return (
        select(MasterStudent.id)
        .where(
            MasterStudent.master_id == Practice.master_id,
            MasterStudent.student_user_id == user_id,
            MasterStudent.blocked_at.is_not(None),
        )
        .exists()
    )


def _has_student_entitlement_clause(user_id: UUID) -> ColumnElement[bool]:
    """True iff `user_id` holds >= 1 booking in STUDENT_ENTITLEMENT_STATUSES
    on ANY practice by the (correlated) Practice's master.

    T-20 rename (was `_is_student_clause`): the old name claimed to answer
    "is this person a student", which is ALSO what the master's students
    LIST answers -- with a different, wider rule. This one answers only
    "does this person hold the RIGHT to enter this master's students-only
    practices". Two questions, two names, so no future reader reconciles
    them back into one by accident.

    Aliased self-join: the outer query already selects FROM Practice, so the
    "does this master have OTHER practices this user booked" lookup needs
    its own reference to avoid colliding with the outer one.
    """
    master_practice = aliased(Practice)
    return (
        select(Booking.id)
        .join(master_practice, Booking.practice_id == master_practice.id)
        .where(
            master_practice.master_id == Practice.master_id,
            Booking.user_id == user_id,
            Booking.status.in_(STUDENT_ENTITLEMENT_STATUSES),
        )
        .exists()
    )


def _is_group_member_clause(user_id: UUID) -> ColumnElement[bool]:
    """True iff `user_id` is a member of at least one of the (correlated)
    Practice's target groups (practice_audience_group)."""
    return (
        select(PracticeAudienceGroup.id)
        .join(
            MasterGroupMembership,
            MasterGroupMembership.group_id == PracticeAudienceGroup.group_id,
        )
        .where(
            PracticeAudienceGroup.practice_id == Practice.id,
            MasterGroupMembership.student_user_id == user_id,
        )
        .exists()
    )


def _curator_profile_verified(user_id_col: ColumnElement) -> ColumnElement[bool]:
    """Correlated EXISTS: this user holds a verified MasterProfile right now.

    THIRD COPY OF THIS PREDICATE IN THE TREE, deliberately. The twins are
    curator_groups/service.py::_verified_profile_exists (the schools module's
    own) and admin/curator_groups/service.py::_profile_verified (ruled a
    considered duplicate in GT-9). Both are private to their modules, and
    importing a private helper across a module boundary would tie the
    audience gate -- the single predicate guarding every practice on the
    platform -- to the internals of two other modules. A copy is the cheaper
    trade; all three are named here so the next reader finds them together.

    Projects user_id, not id: MasterProfile's PRIMARY KEY *is* user_id
    (masters/models.py), and MasterProfile.id raises AttributeError while
    the query is being built.
    """
    return (
        select(MasterProfile.user_id)
        .where(
            MasterProfile.user_id == user_id_col,
            MasterProfile.data["account"]["status"].as_string() == "verified",
        )
        .exists()
    )


def _master_in_curator_group_clause(
    master_id_col: ColumnElement,
) -> ColumnElement[bool]:
    """True iff this master still belongs to the (correlated) CuratorGroup.

    THE HEART OF THIS AUDIENCE (owner ruling, 2026-08-22). The other three
    audience kinds ask only about the VIEWER; this one also asks about the
    master, because a school's audience is lent to a teacher rather than
    given. A master who leaves the school, or is removed by its curator,
    stops broadcasting into a room that is no longer theirs -- and stops
    the moment the membership row goes, with nobody editing the practice.

    Belongs = curator of the school, OR a kind='master' member whose own
    profile is verified right now. The verification check is not
    decoration: a suspended master is already hidden from the school's
    roster (I-4), and a hidden teacher whose practices still reached the
    school would contradict the page one screen away.

    Correlated to CuratorGroup: the calling query must have curator_group in
    its FROM.
    """
    return or_(
        CuratorGroup.curator_user_id == master_id_col,
        select(CuratorGroupMember.id)
        .where(
            CuratorGroupMember.group_id == CuratorGroup.id,
            CuratorGroupMember.user_id == master_id_col,
            CuratorGroupMember.kind == CuratorMemberKind.MASTER.value,
            _curator_profile_verified(master_id_col),
        )
        .exists(),
    )


def _viewer_in_curator_group_clause(user_id: UUID) -> ColumnElement[bool]:
    """True iff this viewer belongs to the (correlated) CuratorGroup at all.

    ANY kind of membership counts, and so does being the curator -- the
    school sees its own practices whether you teach there or study there.
    Deliberately NOT symmetrical with the master clause above: the master
    side asks "is this person still entitled to use this room", the viewer
    side asks "is this person in the room". Two different questions that
    happen to touch the same table.

    No verification check here either: a student has no MasterProfile to
    verify, and a suspended master-member is still a member of the school
    (GT-1 kept their row and only hid them from the roster). Losing sight of
    the school's practices is not part of what suspension means.
    """
    return or_(
        CuratorGroup.curator_user_id == user_id,
        select(CuratorGroupMember.id)
        .where(
            CuratorGroupMember.group_id == CuratorGroup.id,
            CuratorGroupMember.user_id == user_id,
        )
        .exists(),
    )


def _is_curator_group_audience_clause(user_id: UUID) -> ColumnElement[bool]:
    """True iff `user_id` may see the (correlated) Practice through one of
    its target SCHOOLS.

    Three conditions on the SAME school row, all required:
      1. the school is ACTIVE -- its curator is verified right now (I-6),
         the same rule that makes an inactive school a 404 for its own
         members;
      2. the viewer belongs to that school;
      3. the practice's master still belongs to that school.

    EXISTS rather than a join, so a viewer who is in two of the practice's
    target schools yields ONE row in the feed, not two. Same shape as
    _is_group_member_clause next door, for the same reason.
    """
    return (
        select(PracticeAudienceCuratorGroup.id)
        .join(
            CuratorGroup,
            CuratorGroup.id == PracticeAudienceCuratorGroup.group_id,
        )
        .where(
            PracticeAudienceCuratorGroup.practice_id == Practice.id,
            _curator_profile_verified(CuratorGroup.curator_user_id),
            _viewer_in_curator_group_clause(user_id),
            _master_in_curator_group_clause(Practice.master_id),
        )
        .exists()
    )


def viewer_audience_clause(user_id: UUID) -> ColumnElement[bool]:
    """SQL boolean expression correlated to the module-level Practice table
    -- the caller's query MUST select FROM Practice (directly, or via a
    JOIN that includes it). Used as a plain filters.append() entry, same
    shape as every other list_public_practices filter.
    """
    audience_ok = or_(
        Practice.audience_kind == AudienceKind.PUBLIC.value,
        and_(
            Practice.audience_kind == AudienceKind.STUDENTS.value,
            _has_student_entitlement_clause(user_id),
        ),
        and_(
            Practice.audience_kind == AudienceKind.GROUPS.value,
            _is_group_member_clause(user_id),
        ),
        and_(
            Practice.audience_kind == AudienceKind.CURATOR_GROUPS.value,
            _is_curator_group_audience_clause(user_id),
        ),
    )
    return and_(~_blocked_clause(user_id), audience_ok)


async def _clause_true_for(
    practice_id: UUID, clause: ColumnElement[bool], session: AsyncSession,
) -> bool:
    """Evaluate one of the _*_clause() expressions against a single,
    already-known practice_id (correlation target for the clause)."""
    row = (
        await session.execute(
            select(Practice.id).where(Practice.id == practice_id, clause).limit(1)
        )
    ).first()
    return row is not None


async def assert_viewer_can_access_practice(
    user_id: UUID, practice: Practice, session: AsyncSession,
) -> None:
    """Raise ForbiddenError if `user_id` is blocked by the practice's master,
    or outside the practice's configured audience. Same rules as
    viewer_audience_clause, evaluated per-case here so the caller (and, via
    the machine code, the frontend) can tell WHICH reason applies.

    Codes: "blocked_by_master", "not_a_student", "not_in_audience" (the
    groups case, also the fail-closed default for an unrecognized
    audience_kind -- see below). Frontend maps each to its own Russian
    message -- see diary/checkins_service.py upsert_checkin's docstring for
    the exact strings and where they surface.

    OWNER BYPASS (P5 hardening, PROMPT №596): matches list_public_practices's
    own `or_(Practice.master_id == user.id, viewer_audience_clause(user.id))`
    filter (listing_service.py) -- so the gate and the feed filter agree by
    construction, not by caller discipline. VERIFIED INERT today: every call
    site already rejects a master acting on their OWN practice BEFORE ever
    reaching this function --
      - create_booking: `if practice.master_id == user.id: raise
        BadRequestError("Cannot book your own practice")`
        (bookings/service.py:240-241)
      - confirm_waitlist: unreachable transitively -- a Waitlist row can only
        exist via join_waitlist, which itself rejects `practice.master_id ==
        user.id` with "Cannot join waitlist for your own practice"
        (waitlist/service.py:136-137)
    So this bypass changes no live behavior; it removes the shared
    function's dependence on that caller discipline continuing to hold.

    RETROACTIVE POLICY (B) (H-R2-8): upsert_checkin is NO LONGER a caller
    of this FULL predicate. A CONFIRMED booking grandfathers the holder
    through audience NARROWING (an impersonal reconfiguration must not
    strip access already paid for -- the R2 symmetry), while a personal
    BLOCK (targeted moderation) still refuses the check-in ACTION.
    Check-in therefore calls assert_viewer_not_blocked below -- ONLY the
    blocked probe, with the audience branches structurally unreachable
    rather than flag-disabled. The four remaining callers of the full
    predicate (create_booking, join_waitlist, confirm_waitlist,
    get_practice_detail's stranger gate) are byte-for-byte unchanged:
    the audience gate stays fully alive for NEW acquisitions.
    """
    if practice.master_id == user_id:
        return

    if await _clause_true_for(practice.id, _blocked_clause(user_id), session):
        raise ForbiddenError(
            "You are blocked by this practice's master", code="blocked_by_master",
        )

    if practice.audience_kind == AudienceKind.PUBLIC.value:
        return

    if practice.audience_kind == AudienceKind.STUDENTS.value:
        if not await _clause_true_for(
            practice.id, _has_student_entitlement_clause(user_id), session,
        ):
            raise ForbiddenError(
                "This practice is only open to the master's students",
                code="not_a_student",
            )
        return

    if practice.audience_kind == AudienceKind.GROUPS.value:
        if not await _clause_true_for(
            practice.id, _is_group_member_clause(user_id), session,
        ):
            raise ForbiddenError(
                "You are not a member of this practice's target group(s)",
                code="not_in_audience",
            )
        return

    if practice.audience_kind == AudienceKind.CURATOR_GROUPS.value:
        # SAME machine code as the groups branch, on purpose: "you are not
        # in the audience" is one fact to the person refused, the frontend
        # already has a message for it, and a distinct code would tell a
        # stranger WHICH kind of restriction they hit -- i.e. which school
        # membership is worth probing for.
        #
        # ONE clause covers three failures indistinguishably: the school is
        # frozen, the viewer is not in it, or the MASTER has left it. The
        # third has no equivalent in any branch above, and it is the reason
        # this audience can go dark with nobody touching the practice.
        if not await _clause_true_for(
            practice.id, _is_curator_group_audience_clause(user_id), session,
        ):
            raise ForbiddenError(
                "You are not a member of this practice's target school(s)",
                code="not_in_audience",
            )
        return

    # FAIL-CLOSED (P5 hardening, PROMPT №596): an unrecognized audience_kind
    # is DENIED, not silently allowed -- matches viewer_audience_clause's SQL
    # `or_`, which likewise matches none of its three explicit branches and
    # so evaluates false for anything else. AudienceKind has exactly four
    # members today (models.py), so this is unreachable in practice; it
    # exists so a future 5th value fails closed here too, instead of
    # silently falling through to the last rule above (the previous
    # implicit-else shape) or, worse, being allowed.
    #
    # GT-11: the 4th value this guard was written for has now ARRIVED and
    # has its own branch above. The guard stays. It was never about that
    # particular missing value -- it is about there always being one.
    raise ForbiddenError(
        "Unrecognized audience_kind", code="not_in_audience",
    )


async def assert_viewer_not_blocked(
    user_id: UUID, practice: Practice, session: AsyncSession,
) -> None:
    """Raise ForbiddenError ONLY if `user_id` is personally blocked by the
    practice's master -- the blocked probe of the full predicate above,
    without the audience branches.

    RETROACTIVE POLICY (B) (H-R2-8): the dedicated entry point for
    diary/checkins_service.py upsert_checkin. Check-in runs only for
    holders of a CONFIRMED booking (booking-first, NotFound without one),
    and decision (B) grandfathers that paid access through audience
    NARROWING: narrowing is an impersonal reconfiguration and must not
    retroactively strip access already bought. A personal BLOCK is
    targeted moderation and still refuses the ACTION. A separate
    function -- not a bool flag on the full predicate -- so the audience
    branches are structurally unreachable on this path, not merely
    switched off, and no future caller can "make it work" by passing
    True.

    Message and code are byte-for-byte the full predicate's blocked
    branch (frontend mapping unchanged). Same _blocked_clause / same
    _clause_true_for -- nothing reimplemented.

    OWNER BYPASS mirrored from the parent (P5 hardening, ПРОМТ №596),
    and the parent's old inertness argument for check-in lives HERE now:
    unreachable transitively -- upsert_checkin requires an existing
    CONFIRMED Booking, and a booking can only be created via the gated
    paths (create_booking / confirm_waitlist), both of which reject a
    master acting on their own practice. Kept anyway so this function,
    like its parent, does not depend on that caller discipline
    continuing to hold.

    FLOW NOTE (defense in depth, verified H-R2-8): the live block flow
    (groups_service.block_student) cancels+refunds the student's FUTURE
    confirmed bookings, and the check-in window closes AT scheduled_at
    -- so any practice still check-in-able is "future" and its booking
    is cancelled by the block itself, landing on the booking-first
    NotFound. This 403 is therefore reachable only if blocked_at and a
    CONFIRMED booking coexist (flow changes, re-confirmation after an
    unblock..re-block, or direct state) -- kept as the belt to that
    flow's suspenders, not dead code.
    """
    if practice.master_id == user_id:
        return

    if await _clause_true_for(practice.id, _blocked_clause(user_id), session):
        raise ForbiddenError(
            "You are blocked by this practice's master", code="blocked_by_master",
        )


async def count_stranded_active_bookings(
    practice: Practice,
    booker_ids: list[UUID],
    proposed_audience_kind: str,
    proposed_group_ids: list[UUID],
    session: AsyncSession,
    proposed_curator_group_ids: list[UUID] | None = None,
) -> int:
    """Owner Q15 (PROMPT №613): how many of `booker_ids` (this practice's
    CURRENT active bookers -- the caller, practices/service.py, already owns
    that query and its own "active" definition, _ACTIVE_BOOKING_STATUSES)
    would fail assert_viewer_can_access_practice's own rule if the practice's
    audience were saved as (proposed_audience_kind, proposed_group_ids)
    instead of whatever it is stored as right now.

    Read-only, evaluates a HYPOTHETICAL audience -- nothing here writes to
    Practice or PracticeAudienceGroup.

    Reuses _blocked_clause/_has_student_entitlement_clause UNCHANGED:
    neither depends on audience_kind or target groups, so "is this user
    blocked" / "does this user hold student entitlement with this master"
    mean exactly the same whether the audience is saved or merely
    proposed.

    T-20 CONSEQUENCE, deliberate: "active booker" (the caller's
    _ACTIVE_BOOKING_STATUSES = {PENDING, CONFIRMED}) is no longer a SUBSET
    of "student" -- PENDING is active-for-capacity but no longer an
    entitlement. A PENDING-only booker would therefore now be COUNTED as
    stranded by a narrow-to-students preview. That is the honest answer,
    not a regression: under the new gate such a booker really would be
    refused. Unreachable today (nothing creates PENDING -- see
    STUDENT_ENTITLEMENT_STATUSES), so stranded_count is numerically
    unchanged for every booking this system can currently produce.

    CURATOR_GROUPS (P5/GT-11) is the GROUPS case again, with ONE deliberate
    difference: the membership lookup also accepts the school's CURATOR.
    A curator holds no curator_group_member row at all (I-2 -- ownership
    lives in curator_group.curator_user_id and nowhere else), so a literal
    mirror of the query below would report a curator who booked their own
    school's practice as stranded by an audience they are the centre of.
    Named here because the next reader's instinct will be to "align" this
    with its model.

    WHAT THIS FUNCTION DELIBERATELY DOES NOT CHECK for that kind: whether
    the practice's MASTER still belongs to the proposed schools. That
    condition can black out the audience entirely, but it is not a
    consequence of the change being previewed -- the master is not editing
    their own membership here. Folding it in would answer a question nobody
    asked ("would this practice be visible at all") with a number the master
    reads as "this is what your edit costs", and alarm them at a moment when
    they have done nothing.

    The GROUPS case can't reuse
    _is_group_member_clause as-is -- that function joins through THIS
    practice's ALREADY-SAVED PracticeAudienceGroup rows, and a proposal
    that hasn't been saved has nothing there to join against -- so it
    checks MasterGroupMembership against the proposed group_ids directly:
    same table, same join key (student_user_id + group_id), just fed an
    explicit set instead of this practice's persisted rows. This is the
    one piece that couldn't be a literal function call; every other
    condition is the exact, unmodified predicate the real gate uses.
    """
    if not booker_ids:
        return 0

    proposed_member_ids: set[UUID] = set()
    if proposed_audience_kind == AudienceKind.GROUPS.value and proposed_group_ids:
        proposed_member_ids = set(
            (
                await session.execute(
                    select(MasterGroupMembership.student_user_id).where(
                        MasterGroupMembership.group_id.in_(proposed_group_ids),
                        MasterGroupMembership.student_user_id.in_(booker_ids),
                    )
                )
            )
            .scalars()
            .all()
        )

    proposed_school_ids = proposed_curator_group_ids or []
    proposed_school_member_ids: set[UUID] = set()
    if (
        proposed_audience_kind == AudienceKind.CURATOR_GROUPS.value
        and proposed_school_ids
    ):
        proposed_school_member_ids = set(
            (
                await session.execute(
                    select(CuratorGroupMember.user_id).where(
                        CuratorGroupMember.group_id.in_(proposed_school_ids),
                        CuratorGroupMember.user_id.in_(booker_ids),
                    )
                )
            )
            .scalars()
            .all()
        )
        # The curators of the proposed schools, added separately -- see the
        # docstring: they have no membership row to find.
        proposed_school_member_ids |= set(
            (
                await session.execute(
                    select(CuratorGroup.curator_user_id).where(
                        CuratorGroup.id.in_(proposed_school_ids),
                        CuratorGroup.curator_user_id.in_(booker_ids),
                    )
                )
            )
            .scalars()
            .all()
        )

    stranded = 0
    for user_id in booker_ids:
        # Already outside every audience today -- not this change's doing.
        # (Provably can't occur in practice: block_student already cancels
        # a blocked student's active bookings on this master's practices --
        # kept anyway for exact fidelity with assert_viewer_can_access_
        # practice's own precedence, not as a load-bearing branch.)
        if await _clause_true_for(practice.id, _blocked_clause(user_id), session):
            continue
        if proposed_audience_kind == AudienceKind.PUBLIC.value:
            continue
        if proposed_audience_kind == AudienceKind.STUDENTS.value:
            if await _clause_true_for(
                practice.id, _has_student_entitlement_clause(user_id), session,
            ):
                continue
            stranded += 1
            continue
        if proposed_audience_kind == AudienceKind.GROUPS.value:
            if user_id in proposed_member_ids:
                continue
            stranded += 1
            continue
        if proposed_audience_kind == AudienceKind.CURATOR_GROUPS.value:
            if user_id in proposed_school_member_ids:
                continue
            stranded += 1
            continue
        # Unrecognized kind -- fail closed, matches
        # assert_viewer_can_access_practice's own fail-closed default.
        stranded += 1

    return stranded
