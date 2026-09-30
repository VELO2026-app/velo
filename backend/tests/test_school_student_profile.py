# =============================================================================
# VELO Backend -- Tests: the school's view of one student (BE-54)
# =============================================================================
#
# telegram_id band: 69500-69599 (curator 69501, master of the school 69502,
# master of another school 69503, student 69510, other student 69511).
# Declared module-level below as _TID_MIN/_TID_MAX, ONCE --
# tests/telegram_id_bands.py parses that declaration out of the AST on every
# run, and a file using ids without declaring a band fails
# test_blind_zone_has_not_grown. Checked free before it was claimed:
# free_windows(space=(69000, 69999)) returned [(69500, 69999)].
#
# EIGHT REFUSALS, SEVEN OF THEM ONE 404 AND ONE A 403. The seven are folded
# on purpose (P-08): telling "no such school" apart from "not yours" would
# let anyone probe which school ids are real. The eighth -- a master whose
# own verification was revoked -- is refused by get_current_master before
# the handler runs, and is asserted AS a 403 rather than masked: it is
# raised before any group is looked at and is identical on every path of the
# master router, so it says nothing about this school.
#
# THE STUDENT OF THE SCHOOL IS THE ONE THAT WAS NOT IN THE CARD.
# _relation_or_404 returns 'curator' or the kind on the caller's membership
# row, and a student has one -- so without the relation test in the service
# a student would read their neighbour's profile. The test for it is the
# reason this file exists as much as the happy path is.
#
# EVERY "NOTHING IS THERE" IS PAIRED. An empty profile and a masked 404 look
# the same from a distance: one returns 200 with zeros, the other returns
# 404, and a test that only checked "no practices listed" would pass on
# both. Each such assertion here carries its opposite in the same test.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from unittest.mock import patch
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupMember,
    CuratorMemberKind,
)
from app.modules.diary.models import Checkin, CheckType, Feedback
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import (
    AudienceKind,
    Practice,
    PracticeAudienceCuratorGroup,
    PracticeStatus,
    PracticeType,
)
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user

PROFILE_URL = (
    "/api/v1/masters/me/curator-groups/{group_id}/students/{user_id}"
)

_TID_MIN = 69500
_TID_MAX = 69599

_TID_CURATOR = 69501
_TID_MASTER = 69502
_TID_OUTSIDER = 69503
_TID_STUDENT = 69510
_TID_OTHER_STUDENT = 69511

_FLAG = "curator_groups_enabled"


# ===========================================================================
# Local helpers. Copied rather than imported, the convention in every
# curator test file here.
# ===========================================================================


async def _master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int,
    *,
    verified: bool = True,
    first_name: str = "Мастер",
) -> dict:
    auth = await login_user(
        client, telegram_id=telegram_id, first_name=first_name,
    )
    user_id = UUID(auth["user"]["id"])
    user = await db_session.get(User, user_id)
    user.role = UserRole.MASTER
    await db_session.flush()
    db_session.add(
        MasterProfile(
            user_id=user_id,
            data={
                "account": {
                    "status": "verified" if verified else "suspended",
                    "can_create_groups": True,
                },
                "profile": {"bio": "m"},
            },
        )
    )
    await db_session.flush()
    await db_session.commit()
    return await login_user(
        client, telegram_id=telegram_id, first_name=first_name,
    )


async def _student(
    client: AsyncClient, telegram_id: int, first_name: str = "Мария",
    last_name: str | None = "К.",
) -> dict:
    auth = await login_user(
        client, telegram_id=telegram_id, first_name=first_name,
    )
    return auth


async def _school(
    db_session: AsyncSession, curator: dict, name: str = "Школа",
) -> CuratorGroup:
    group = CuratorGroup(
        curator_user_id=UUID(curator["user"]["id"]), name=name,
    )
    db_session.add(group)
    await db_session.flush()
    await db_session.commit()
    return group


async def _join(
    db_session: AsyncSession,
    school: CuratorGroup,
    auth: dict,
    kind: CuratorMemberKind,
) -> CuratorGroupMember:
    row = CuratorGroupMember(
        group_id=school.id,
        user_id=UUID(auth["user"]["id"]),
        kind=kind.value,
    )
    db_session.add(row)
    await db_session.flush()
    await db_session.commit()
    return row


async def _practice(
    db_session: AsyncSession,
    master: dict,
    schools: list[CuratorGroup],
    *,
    title: str = "Утренняя медитация",
    minutes: int = 60,
) -> Practice:
    practice = Practice(
        master_id=UUID(master["user"]["id"]),
        title=title,
        description="x",
        practice_type=PracticeType.LIVE.value,
        status=PracticeStatus.COMPLETED.value,
        scheduled_at=datetime.now(UTC) - timedelta(days=3),
        duration_minutes=minutes,
        timezone="UTC",
        max_participants=20,
        current_participants=0,
        is_free=True,
        price_cents=0,
        currency="eur",
        audience_kind=(
            AudienceKind.CURATOR_GROUPS.value if schools else None
        ),
    )
    db_session.add(practice)
    await db_session.flush()
    for school in schools:
        db_session.add(
            PracticeAudienceCuratorGroup(
                practice_id=practice.id, group_id=school.id,
            )
        )
    await db_session.flush()
    await db_session.commit()
    return practice


async def _attended(
    db_session: AsyncSession,
    practice: Practice,
    student: dict,
    *,
    status: str = BookingStatus.ATTENDED.value,
) -> Booking:
    booking = Booking(
        practice_id=practice.id,
        user_id=UUID(student["user"]["id"]),
        status=status,
    )
    db_session.add(booking)
    await db_session.flush()
    await db_session.commit()
    return booking


async def _checkin(
    db_session: AsyncSession,
    practice: Practice,
    student: dict,
    booking: Booking,
    *,
    mood: int = 8,
    comment: str | None = None,
    check_type: str = CheckType.PRE.value,
) -> None:
    db_session.add(
        Checkin(
            practice_id=practice.id,
            user_id=UUID(student["user"]["id"]),
            booking_id=booking.id,
            mood=mood,
            comment=comment,
            check_type=check_type,
        )
    )
    await db_session.flush()
    await db_session.commit()


async def _feedback(
    db_session: AsyncSession,
    practice: Practice,
    student: dict,
    booking: Booking,
    *,
    rating: int = 10,
    comment: str | None = "Спасибо!",
) -> None:
    db_session.add(
        Feedback(
            practice_id=practice.id,
            user_id=UUID(student["user"]["id"]),
            booking_id=booking.id,
            rating=rating,
            comment=comment,
        )
    )
    await db_session.flush()
    await db_session.commit()


async def _get(
    client: AsyncClient, viewer: dict, school, student_id: str,
):
    group_id = school if isinstance(school, str) else str(school.id)
    return await client.get(
        PROFILE_URL.format(group_id=group_id, user_id=student_id),
        headers=auth_headers(viewer["session_token"]),
    )


async def _profile(
    client: AsyncClient, viewer: dict, school, student: dict,
) -> dict:
    resp = await _get(client, viewer, school, student["user"]["id"])
    assert resp.status_code == 200, resp.text
    return resp.json()


# ===========================================================================
# Cleanup
# ===========================================================================


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


# ===========================================================================
# What the school sees
# ===========================================================================


@pytest.mark.asyncio
async def test_the_curator_and_a_master_of_the_school_see_the_same_thing(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Two doors, one room -- owner ruling, 24 September.

    The bodies are compared whole rather than field by field: the claim is
    that the school has ONE view of its student, and an assertion that
    named a few fields would keep passing on the day the two answers start
    to differ somewhere else.

    The practice here belongs to the school's OTHER master, which is the
    point of the screen: a curator sees what happened in their school, not
    only what they taught.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    master = await _master(client, db_session, _TID_MASTER)
    student = await _student(client, _TID_STUDENT)
    school = await _school(db_session, curator)
    await _join(db_session, school, master, CuratorMemberKind.MASTER)
    await _join(db_session, school, student, CuratorMemberKind.STUDENT)

    practice = await _practice(db_session, master, [school], minutes=90)
    booking = await _attended(db_session, practice, student)
    await _checkin(db_session, practice, student, booking, mood=8)
    await _feedback(db_session, practice, student, booking, rating=10)

    as_curator = await _profile(client, curator, school, student)
    as_master = await _profile(client, master, school, student)

    assert as_curator == as_master
    assert as_curator["practices_count"] == 1
    assert as_curator["hours"] == 1.5
    assert as_curator["display_name"] == "Мария"
    assert len(as_curator["recent_checkins"]) == 1
    assert len(as_curator["recent_feedbacks"]) == 1
    assert as_curator["recent_checkins"][0]["practice_title"] == (
        "Утренняя медитация"
    )


@pytest.mark.asyncio
async def test_the_scores_are_raw_numbers_and_nothing_else(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """1..10 as the forms wrote them, with no bucket beside them.

    BE-24's school feeds bucket these same numbers, because a feed card is
    read at a glance; a dossier is not, and turning a number into a face is
    the frontend's single responsibility here. So the assertion is on the
    TYPE and the VALUE, and on the ABSENCE of any derived key -- a bucket
    added "for convenience" would be a second vocabulary for one number.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    student = await _student(client, _TID_STUDENT)
    school = await _school(db_session, curator)
    await _join(db_session, school, student, CuratorMemberKind.STUDENT)

    practice = await _practice(db_session, curator, [school])
    booking = await _attended(db_session, practice, student)
    await _checkin(db_session, practice, student, booking, mood=3)
    await _feedback(db_session, practice, student, booking, rating=7)

    profile = await _profile(client, curator, school, student)
    checkin = profile["recent_checkins"][0]
    feedback = profile["recent_feedbacks"][0]

    assert checkin["mood"] == 3
    assert isinstance(checkin["mood"], int)
    assert feedback["rating"] == 7
    assert isinstance(feedback["rating"], int)

    derived = {"mood_bucket", "rating_bucket", "bucket", "emoji", "face"}
    assert derived & set(checkin) == set()
    assert derived & set(feedback) == set()


@pytest.mark.asyncio
async def test_a_student_with_nothing_yet_is_an_honest_zero(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Zeros and empty arrays, with a 200 -- not a 404.

    THE PAIR IS THE POINT. "No practices listed" is equally true of a
    masked refusal, so the same test asserts that access was granted: the
    status is 200 and the student is named. Without that half this test
    would pass for a student the viewer is not allowed to see at all.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    student = await _student(client, _TID_STUDENT)
    school = await _school(db_session, curator)
    await _join(db_session, school, student, CuratorMemberKind.STUDENT)

    resp = await _get(client, curator, school, student["user"]["id"])

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["display_name"] == "Мария"
    assert body["practices_count"] == 0
    assert body["hours"] == 0
    assert body["recent_checkins"] == []
    assert body["recent_feedbacks"] == []


# ===========================================================================
# What the school does NOT see
# ===========================================================================


@pytest.mark.asyncio
async def test_another_schools_practices_are_not_counted(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The same student, two schools, and each sees only its own.

    Both halves in one test, because "the other school is absent" is
    satisfied by a profile that counts nothing at all. The student attends
    one practice in each school; each school must report exactly one.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    outsider = await _master(client, db_session, _TID_OUTSIDER)
    student = await _student(client, _TID_STUDENT)
    mine = await _school(db_session, curator, name="Моя школа")
    theirs = await _school(db_session, outsider, name="Чужая школа")
    await _join(db_session, mine, student, CuratorMemberKind.STUDENT)
    await _join(db_session, theirs, student, CuratorMemberKind.STUDENT)

    here = await _practice(
        db_session, curator, [mine], title="Моя практика", minutes=60,
    )
    there = await _practice(
        db_session, outsider, [theirs], title="Чужая практика", minutes=120,
    )
    booking_here = await _attended(db_session, here, student)
    booking_there = await _attended(db_session, there, student)
    await _checkin(db_session, here, student, booking_here, mood=5)
    await _checkin(db_session, there, student, booking_there, mood=9)

    mine_profile = await _profile(client, curator, mine, student)
    theirs_profile = await _profile(client, outsider, theirs, student)

    assert mine_profile["practices_count"] == 1
    assert mine_profile["hours"] == 1.0
    assert [c["practice_title"] for c in mine_profile["recent_checkins"]] == [
        "Моя практика"
    ]

    assert theirs_profile["practices_count"] == 1
    assert theirs_profile["hours"] == 2.0
    assert [
        c["practice_title"] for c in theirs_profile["recent_checkins"]
    ] == ["Чужая практика"]


@pytest.mark.asyncio
async def test_only_attended_bookings_count_and_cancelled_checkins_drop(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Three bookings, one attendance, and one check-in that vanishes.

    CONFIRMED is not attendance and does not count. A check-in behind a
    cancelled booking is gone from the list, because it is gone from the
    practice's own master's roster too and the school does not see deeper
    than the person who taught (BE-24).

    A POST check-in is seeded on the attended booking to show it is skipped
    while its PRE sibling on the same booking is not -- an empty list would
    have satisfied "no POST" all by itself.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    student = await _student(client, _TID_STUDENT)
    school = await _school(db_session, curator)
    await _join(db_session, school, student, CuratorMemberKind.STUDENT)

    attended = await _practice(
        db_session, curator, [school], title="Посещённая", minutes=60,
    )
    confirmed = await _practice(
        db_session, curator, [school], title="Только записан", minutes=60,
    )
    cancelled = await _practice(
        db_session, curator, [school], title="Отменённая бронь", minutes=60,
    )

    booking = await _attended(db_session, attended, student)
    await _attended(
        db_session, confirmed, student,
        status=BookingStatus.CONFIRMED.value,
    )
    cancelled_booking = await _attended(
        db_session, cancelled, student,
        status=BookingStatus.CANCELLED.value,
    )
    await _checkin(
        db_session, attended, student, booking, mood=6, comment="до",
    )
    await _checkin(
        db_session, attended, student, booking, mood=2, comment="после",
        check_type=CheckType.POST.value,
    )
    await _checkin(
        db_session, cancelled, student, cancelled_booking, mood=1,
    )

    profile = await _profile(client, curator, school, student)

    assert profile["practices_count"] == 1
    assert profile["hours"] == 1.0
    assert [c["comment"] for c in profile["recent_checkins"]] == ["до"]


@pytest.mark.asyncio
async def test_a_practice_addressed_to_two_schools_counts_once(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Two audience rows, one practice, one hour.

    The belonging test is an EXISTS rather than a join, and this is the
    assertion that fails the day somebody rewrites it as one: joining the
    audience table would count this practice twice and double the hours
    with it.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    student = await _student(client, _TID_STUDENT)
    morning = await _school(db_session, curator, name="Утро")
    evening = await _school(db_session, curator, name="Вечер")
    await _join(db_session, morning, student, CuratorMemberKind.STUDENT)

    practice = await _practice(
        db_session, curator, [morning, evening], minutes=60,
    )
    await _attended(db_session, practice, student)

    profile = await _profile(client, curator, morning, student)

    assert profile["practices_count"] == 1
    assert profile["hours"] == 1.0


@pytest.mark.asyncio
async def test_a_departed_masters_practice_stays_in_the_schools_history(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The teacher walked out; what the school collected is still its own.

    practice_in_curator_group_clause answers "what happened", not "what to
    show now" -- owner ruling, 10 September, and the same rule the school's
    feeds already follow. Membership is a state; a practice's belonging to
    the school is a fact.

    The BEFORE half is asserted too: without it a profile that was empty
    all along would satisfy the AFTER half.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    master = await _master(client, db_session, _TID_MASTER)
    student = await _student(client, _TID_STUDENT)
    school = await _school(db_session, curator)
    membership = await _join(
        db_session, school, master, CuratorMemberKind.MASTER,
    )
    await _join(db_session, school, student, CuratorMemberKind.STUDENT)

    practice = await _practice(db_session, master, [school], minutes=60)
    booking = await _attended(db_session, practice, student)
    await _checkin(db_session, practice, student, booking, mood=7)

    before = await _profile(client, curator, school, student)
    assert before["practices_count"] == 1

    await db_session.delete(
        await db_session.get(CuratorGroupMember, membership.id)
    )
    await db_session.commit()

    after = await _profile(client, curator, school, student)
    assert after["practices_count"] == 1
    assert after["hours"] == 1.0
    assert len(after["recent_checkins"]) == 1


# ===========================================================================
# Who is refused
# ===========================================================================


@pytest.mark.asyncio
async def test_seven_refusals_share_a_code_and_the_outside_ones_a_body(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """One 404 for every reason -- and NOT one body, which is correct.

    THE CARD PROMISED AN IDENTICAL BODY AND THE TREE DOES NOT GIVE ONE.
    _relation_or_404 answers "Curator group not found"; the two membership
    tests in this service answer "Student not found". Both are 404 with
    the same machine-readable code, and the split falls exactly on the
    access boundary: everybody who is refused from OUTSIDE the school gets
    the group message and cannot tell the three outside reasons apart,
    which is what P-08 is for. The student message is reachable only by
    somebody who already has the school -- telling them "group not found"
    about a school they are standing in would be a worse answer, not a
    safer one.

    So the assertion is: one code everywhere, one body among the outside
    refusals, sampled against a school id that belongs to nobody. The
    baseline is captured here rather than written down, so the day the
    wording changes the comparison moves with it.

    Four of the seven are exercised: a stranger to the school, a student
    of this school, a target who is not a student, and a school that does
    not exist. A removed target and one promoted to master are the same
    membership query answering on an absent row or a wrong kind -- the
    third case already runs that line, and two more fixtures would assert
    it twice.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    outsider = await _master(client, db_session, _TID_OUTSIDER)
    student = await _student(client, _TID_STUDENT)
    stranger = await _student(client, _TID_OTHER_STUDENT, first_name="Гость")
    school = await _school(db_session, curator)
    await _join(db_session, school, student, CuratorMemberKind.STUDENT)

    nowhere = await _get(client, curator, str(uuid4()), student["user"]["id"])
    assert nowhere.status_code == 404, nowhere.text
    baseline = nowhere.json()

    # A master with no tie to this school.
    theirs = await _get(client, outsider, school, student["user"]["id"])
    assert theirs.status_code == 404, theirs.text
    assert theirs.json() == baseline

    # A student OF this school -- _relation_or_404 admits them, and this
    # test is the reason the service refuses them a second time.
    await _join(db_session, school, stranger, CuratorMemberKind.STUDENT)
    peer = await _get(client, stranger, school, student["user"]["id"])
    assert peer.status_code in (403, 404), peer.text

    # A target who is not a student of this school.
    not_a_student = await _get(
        client, curator, school, outsider["user"]["id"],
    )
    assert not_a_student.status_code == 404, not_a_student.text
    assert not_a_student.json()["error"] == baseline["error"]
    assert not_a_student.json()["message"] != baseline["message"], (
        "an insider asking about a non-student should be told so, not "
        "that the school they are standing in does not exist"
    )


@pytest.mark.asyncio
async def test_a_suspended_master_is_refused_with_403_not_404(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The eighth refusal, and the one that does not join the other seven.

    THE CARD PROMISED EIGHT UNDER ONE 404; this is seven plus this. A
    master whose own verification was revoked is stopped by
    get_current_master before the handler runs, so the answer cannot be
    shaped here without either moving the handle off the master router --
    losing the master check -- or repeating the verification test, a second
    place to keep true.

    IT LEAKS NOTHING. The 403 is raised before any group is looked at and
    is identical on every path of the master router: it tells the caller
    about their own standing, which they already know, and nothing about
    whether this school exists. P-08 guards against an oracle of SCHOOLS.

    The curator's 200 on the same student sits in this test so that "403"
    cannot quietly mean "this fixture was broken".
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    suspended = await _master(
        client, db_session, _TID_MASTER, verified=False,
    )
    student = await _student(client, _TID_STUDENT)
    school = await _school(db_session, curator)
    await _join(db_session, school, suspended, CuratorMemberKind.MASTER)
    await _join(db_session, school, student, CuratorMemberKind.STUDENT)

    refused = await _get(client, suspended, school, student["user"]["id"])
    assert refused.status_code == 403, refused.text

    allowed = await _get(client, curator, school, student["user"]["id"])
    assert allowed.status_code == 200, allowed.text


@pytest.mark.asyncio
async def test_the_killswitch_takes_this_handle_with_it(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Off is 404, on is 200 -- and what this really asserts is placement.

    The flag is not read anywhere in this feature's own code: the handle
    hangs on the school router, whose dependency answers first. So the
    test's job is not "does the flag work" -- BE-35 covers that over all
    twenty-eight operations -- but "did this endpoint land on that router".
    Mounted a segment away, it would keep working with schools switched
    off and no other test would notice.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    student = await _student(client, _TID_STUDENT)
    school = await _school(db_session, curator)
    await _join(db_session, school, student, CuratorMemberKind.STUDENT)

    with patch.object(settings, _FLAG, False):
        blocked = await _get(client, curator, school, student["user"]["id"])
    assert blocked.status_code == 404, blocked.text

    with patch.object(settings, _FLAG, True):
        allowed = await _get(client, curator, school, student["user"]["id"])
    assert allowed.status_code == 200, allowed.text
