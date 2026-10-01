# =============================================================================
# VELO Backend -- School student profile (BE-54)
# =============================================================================
#
# One read: what a school knows about one of its students. The curator and
# EVERY MASTER OF THE SCHOOL see it, and they see the same thing -- owner
# ruling, 24 September.
#
# THE ACCESS RULE IS NOT feedback_service.py's, and the difference is the
# first thing to know about this file. BE-24's two feeds resolve ownership
# through _get_group_or_404, which admits the CURATOR AND NOBODY ELSE. Here
# the door is wider by decision, so the check is _relation_or_404 plus one
# more test. Their DATA rules are this file's canon -- PRE check-ins only,
# cancelled bookings dropped, the practice belongs to the school by audience
# row -- their ACCESS rule is not, and folding the two into one helper would
# narrow this handle back to the curator without anyone noticing.
#
# _relation_or_404 ADMITS STUDENTS TOO. It returns 'curator' or the kind on
# the caller's membership row, and a student of the school has one. Without
# the relation test below, a student would read their neighbour's profile.
#
# WHAT IS COUNTED, and why it cannot double-count:
#   - a practice belongs to the school by practice_in_curator_group_clause,
#     an equality on the practice's own owner column (BE-74) -- one practice
#     is one row, and it belongs to one school at most, public ones
#     included;
#   - a person holds at most one non-cancelled booking per practice
#     (uq_booking_practice_user_active, a partial unique index WHERE status
#     != 'cancelled'), and 'attended' is not cancelled -- so at most one
#     ATTENDED booking per practice.
#
# THERE IS THEREFORE NO DISTINCT, AND THAT IS DELIBERATE. A DISTINCT on the
# count would have covered half the arithmetic and left the SUM doubling,
# which is worse than none: it reads as "this case was handled".
#
# SESSION RULES: read-only, caller passes get_db_reader. No commit (P-01).
# =============================================================================

from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.curator_groups.models import (
    CuratorGroupMember,
    CuratorMemberKind,
)
from app.modules.curator_groups.service import (
    CURATOR_RELATION,
    _master_offer_state_expr,
    _relation_or_404,
)
from app.modules.diary.models import Checkin, CheckType, Feedback
from app.modules.practices.audience_service import (
    practice_in_curator_group_clause,
)
from app.modules.practices.models import Practice
from app.modules.users.helpers import display_name
from app.modules.users.models import User

# Cap on the two recent lists. TEN, matching _RECENT_LIMIT in
# masters/students_service.py: that is the other per-student dossier a
# master can open, and two screens of the same kind showing different
# depths of the same kind of list read as a bug rather than as a decision.
_RECENT_LIMIT = 10


async def get_school_student_profile(
    viewer_id: UUID,
    group_id: UUID,
    student_id: UUID,
    session: AsyncSession,
) -> dict:
    """What this school knows about one of its students.

    EIGHT REFUSALS, SEVEN OF THEM ONE 404. A stranger, a master of another
    school, a viewer who left, a frozen or deleted school -- all four are
    _relation_or_404, which folds "no such group", "its curator is not
    verified now" and "you have no tie to it" into one answer so that
    nobody can probe which school ids are real (P-08). A student of the
    school, a target who is not a student, a target who was removed or
    promoted -- the three tests below, raising the same NotFoundError with
    the same body.

    THE EIGHTH IS A 403 AND IS NOT MASKED. A master whose own verification
    was revoked never reaches this function: get_current_master refuses on
    the way in. Masking that into a 404 would mean either hanging the
    handle off the member router (losing the master check) or repeating the
    verification test here (a second place to keep it true). The 403 says
    nothing about this school: it is raised before any group is looked at
    and is identical on every path of the master router.

    ATTENDED ONLY, for both numbers. CONFIRMED, NO_SHOW, CANCELLED, drafts
    and deleted practices do not count as attendance and so do not count
    here. Hours are rounded on the server to one decimal -- the client does
    not compute them (TZ 1.13.3).

    THE TWO LISTS FOLLOW BE-24 AND THEY DIFFER FROM EACH OTHER. Check-ins
    are PRE only and skip cancelled bookings, because that is what the
    practice's own master sees on his roster. Reviews carry NO booking
    filter, and that is not an oversight either: BE-24 says a review the
    master reads is a review the school may read, and the master's own
    review feeds carry no such filter.

    THE SCORES ARE RAW 1..10 HERE, unlike BE-24's feeds, which bucket them.
    Turning a number into a face is the frontend's single responsibility on
    this screen (BE-54), and the fields are named as the forms that write
    them name them: `mood` on a check-in, `rating` on a review.

    Args:
        viewer_id: The authenticated master -- curator or member.
        group_id: The school.
        student_id: The person whose profile is asked for.
        session: Read session.

    Returns:
        A dict ready for SchoolStudentProfileResponse.

    Raises:
        NotFoundError: Any of the seven refusals above.
    """
    group, relation = await _relation_or_404(group_id, viewer_id, session)

    # A student of the school is a member, so _relation_or_404 let them
    # through. This screen is the school's view OF students, not a view
    # FOR them.
    if relation not in (CURATOR_RELATION, CuratorMemberKind.MASTER.value):
        raise NotFoundError("Student not found")

    # The target must be a student of THIS school right now. Removed,
    # never a member, or promoted to master -- all three land here, and all
    # three answer exactly as a missing school does.
    is_student = (
        await session.execute(
            select(CuratorGroupMember.id).where(
                CuratorGroupMember.group_id == group.id,
                CuratorGroupMember.user_id == student_id,
                CuratorGroupMember.kind == CuratorMemberKind.STUDENT.value,
            )
        )
    ).scalar_one_or_none()
    if is_student is None:
        raise NotFoundError("Student not found")

    # Both aggregates in one pass. COUNT and COALESCE(SUM) over zero
    # matching rows still return one row of zeros, so a student who has
    # attended nothing gets 0/0 and a 200 -- never an empty result set and
    # never a 404.
    practices_count, total_minutes = (
        await session.execute(
            select(
                func.count(Booking.id),
                func.coalesce(func.sum(Practice.duration_minutes), 0),
            )
            .join(Practice, Booking.practice_id == Practice.id)
            .where(
                Booking.user_id == student_id,
                Booking.status == BookingStatus.ATTENDED.value,
                practice_in_curator_group_clause(group.id),
            )
        )
    ).one()

    checkins = (
        await session.execute(
            select(Checkin, Practice.title)
            .join(Practice, Checkin.practice_id == Practice.id)
            .join(Booking, Checkin.booking_id == Booking.id)
            .where(
                Checkin.user_id == student_id,
                Checkin.check_type == CheckType.PRE.value,
                Booking.status != BookingStatus.CANCELLED.value,
                practice_in_curator_group_clause(group.id),
            )
            .order_by(Checkin.created_at.desc(), Checkin.id.desc())
            .limit(_RECENT_LIMIT)
        )
    ).all()

    feedbacks = (
        await session.execute(
            select(Feedback, Practice.title)
            .join(Practice, Feedback.practice_id == Practice.id)
            .where(
                Feedback.user_id == student_id,
                practice_in_curator_group_clause(group.id),
            )
            .order_by(Feedback.created_at.desc(), Feedback.id.desc())
            .limit(_RECENT_LIMIT)
        )
    ).all()

    # BE-59: the state of a pending appointment of this student, for the
    # CURATOR ONLY -- the one who made it. A master of the school reads
    # null, as a member outside a transfer reads null for it (TZ 5.2): an
    # appointment under way is the curator's business, and a fellow master
    # learns nothing of it, not even that one exists.
    master_offer = None
    if relation == CURATOR_RELATION:
        master_offer = (
            await session.execute(
                select(_master_offer_state_expr(group.id, student_id))
            )
        ).scalar_one()

    student = await session.get(User, student_id)

    return {
        "user_id": student_id,
        # The student is NAMED. display_name falls back to the neutral
        # "Участник" when both parts are empty, which is the participant
        # rule and the one that applies here.
        "display_name": display_name(
            student.first_name if student else None,
            student.last_name if student else None,
        ),
        "avatar_url": student.avatar_url if student else None,
        "practices_count": practices_count,
        "hours": round(total_minutes / 60, 1),
        "master_offer": master_offer,
        "recent_checkins": [
            {
                "mood": checkin.mood,
                "comment": checkin.comment,
                "practice_id": checkin.practice_id,
                "practice_title": title,
                "created_at": checkin.created_at,
            }
            for checkin, title in checkins
        ],
        "recent_feedbacks": [
            {
                "rating": feedback.rating,
                "comment": feedback.comment,
                "practice_id": feedback.practice_id,
                "practice_title": title,
                "created_at": feedback.created_at,
            }
            for feedback, title in feedbacks
        ],
    }
