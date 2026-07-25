# =============================================================================
# VELO Backend -- Practice Audience Service (Master GROUPS P5, ПРОМТ №594)
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
#   - diary/checkins_service.py upsert_checkin (covers the retroactive case:
#     a booking made while the practice was public/open, before the master
#     narrowed the audience or blocked this viewer)
# via assert_viewer_can_access_practice below.
#
# RULE: viewer is NOT blocked by the practice's master (master_student.
# blocked_at) AND (audience=public) OR (audience=students AND viewer has
# >=1 non-cancelled booking on that master's practices -- the same derived
# "Ученики" rule groups_service.py uses) OR (audience=groups AND viewer is
# a member of >=1 of the practice's target groups).
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
from app.modules.masters.groups_models import MasterGroupMembership, MasterStudent
from app.modules.practices.models import AudienceKind, Practice, PracticeAudienceGroup


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


def _is_student_clause(user_id: UUID) -> ColumnElement[bool]:
    """True iff `user_id` has >= 1 non-cancelled booking on ANY practice by
    the (correlated) Practice's master. Aliased self-join: the outer query
    already selects FROM Practice, so the "does this master have OTHER
    practices this user booked" lookup needs its own reference to avoid
    colliding with the outer one."""
    master_practice = aliased(Practice)
    return (
        select(Booking.id)
        .join(master_practice, Booking.practice_id == master_practice.id)
        .where(
            master_practice.master_id == Practice.master_id,
            Booking.user_id == user_id,
            Booking.status != BookingStatus.CANCELLED.value,
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
            _is_student_clause(user_id),
        ),
        and_(
            Practice.audience_kind == AudienceKind.GROUPS.value,
            _is_group_member_clause(user_id),
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

    OWNER BYPASS (P5 hardening, ПРОМТ №596): matches list_public_practices's
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
      - upsert_checkin: unreachable transitively -- requires an existing
        CONFIRMED Booking (diary/checkins_service.py), and a booking can only
        be created via the two gated paths above
    So this bypass changes no live behavior; it removes the shared
    function's dependence on that caller discipline continuing to hold.
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
            practice.id, _is_student_clause(user_id), session,
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

    # FAIL-CLOSED (P5 hardening, ПРОМТ №596): an unrecognized audience_kind
    # is DENIED, not silently allowed -- matches viewer_audience_clause's SQL
    # `or_`, which likewise matches none of its three explicit branches and
    # so evaluates false for anything else. AudienceKind has exactly three
    # members today (models.py), so this is unreachable in practice; it
    # exists so a future 4th value fails closed here too, instead of
    # silently falling through to the GROUPS rule (the previous implicit-
    # else shape) or, worse, being allowed.
    raise ForbiddenError(
        "Unrecognized audience_kind", code="not_in_audience",
    )
