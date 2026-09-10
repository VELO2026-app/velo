# =============================================================================
# VELO Backend -- Tests: the school's feedback, seen by its curator (BE-24)
# =============================================================================
#
# telegram_id band: 65800-65899 (curator 65801, school masters 65802-65803,
# a second curator 65804, students 65810-65813, outsider 65830). Declared
# module-level below as _TID_MIN/_TID_MAX, ONCE -- tests/telegram_id_bands.py
# parses that declaration out of the AST on every run, and a file using ids
# without declaring a band fails test_blind_zone_has_not_grown. Checked free
# before it was claimed: free_windows(space=(65000, 65999)) returned
# [(65800, 65999)].
#
# WHAT THIS FILE IS ABOUT. A curator now reads the check-ins and the reviews
# left on their school's practices, including practices they did not run.
# The feature is a WIDENING OF REACH AND NOT OF DEPTH, so two thirds of the
# tests here are about what the curator does NOT get.
#
# EVERY "IS NOT THERE" IS PAIRED WITH AN "IS THERE" IN THE SAME TEST. An
# assertion that a field is absent passes just as happily on an empty page,
# a broken join or a 404 -- which is exactly how a privacy check quietly
# stops checking anything. The pair is the test; the absence alone is not.
#
# TWO PREDICATES THAT DISAGREE ON PURPOSE. A practice belongs to a school
# for as long as its audience row exists (history), while it reaches the
# school's feed only while its master is still a member (state). Owner
# ruling, 2026-09-10. The pair of tests around
# _teacher_leaves is the one that pins the disagreement; if somebody ever
# "fixes" the two predicates into one, exactly one of the two fails.
#
# ROWS ARE SEEDED, NOT DRIVEN THROUGH THE API. Check-ins and feedbacks are
# window-bound and immutable by design (diary/models.py), so building an
# eight-row history through the endpoints would mean moving the clock in
# every test. The seeds carry the same shapes the writing paths produce:
# one PRE check-in per booking, one feedback per (practice, user).
#
# CLEANUP is full_cleanup_range(..., delete_users=True). The helper knows
# nothing about curator tables and does not need to: curator_group cascades
# from its curator, practice_audience_curator_group cascades from both
# sides, and checkins/feedbacks/bookings hang off users in the band.
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

CHECKINS_URL = "/api/v1/masters/me/curator-groups/{group_id}/checkins"
REVIEWS_URL = "/api/v1/masters/me/curator-groups/{group_id}/reviews"
PRACTICES_URL = "/api/v1/practices"
DETAIL_URL = "/api/v1/practices/{practice_id}"
STUDENT_DOSSIER_URL = "/api/v1/masters/me/students/{student_id}"

_TID_MIN = 65800
_TID_MAX = 65899

_TID_CURATOR = 65801
_TID_TEACHER = 65802
_TID_TEACHER_B = 65803
_TID_CURATOR_B = 65804
_TID_STUDENT = 65810
_TID_STUDENT_B = 65811
_TID_STUDENT_C = 65812
_TID_OUTSIDER = 65830

_FLAG = "curator_groups_enabled"


# ===========================================================================
# Local helpers. Copied rather than imported, which is the convention in
# every curator test file. No default telegram_id on any of them: a default
# would have to sit inside 65800-65899 too.
# ===========================================================================


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int,
    first_name: str = "Master",
    last_name: str | None = None,
) -> dict:
    """A verified master -- the only person get_current_master admits."""
    auth = await login_user(
        client, telegram_id=telegram_id, first_name=first_name,
    )
    user_id = UUID(auth["user"]["id"])

    user = await db_session.get(User, user_id)
    user.role = UserRole.MASTER
    if last_name is not None:
        user.last_name = last_name
    await db_session.flush()

    db_session.add(
        MasterProfile(
            user_id=user_id,
            data={
                "account": {"status": "verified", "can_create_groups": True},
                "profile": {"bio": "m"},
            },
        )
    )
    await db_session.flush()
    await db_session.commit()
    return auth


async def _make_student(
    client: AsyncClient,
    telegram_id: int,
    first_name: str = "Student",
) -> dict:
    return await login_user(
        client, telegram_id=telegram_id, first_name=first_name,
    )


async def _school(
    db_session: AsyncSession, curator: dict, name: str = "Тихое утро",
) -> CuratorGroup:
    group = CuratorGroup(
        curator_user_id=UUID(curator["user"]["id"]), name=name,
    )
    db_session.add(group)
    await db_session.flush()
    await db_session.commit()
    return group


async def _join_school(
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


async def _leave_school(
    db_session: AsyncSession, membership: CuratorGroupMember,
) -> None:
    """The teacher walks out -- the membership row goes, nothing else."""
    await db_session.delete(
        await db_session.get(CuratorGroupMember, membership.id)
    )
    await db_session.commit()


async def _practice(
    db_session: AsyncSession,
    master: dict,
    schools: list[CuratorGroup] | None = None,
    *,
    title: str = "Утренняя практика",
    status: str = PracticeStatus.SCHEDULED.value,
    hours_from_now: float = 48,
) -> Practice:
    practice = Practice(
        master_id=UUID(master["user"]["id"]),
        title=title,
        description="x",
        practice_type=PracticeType.LIVE.value,
        status=status,
        scheduled_at=datetime.now(UTC) + timedelta(hours=hours_from_now),
        duration_minutes=60,
        timezone="UTC",
        max_participants=20,
        current_participants=0,
        is_free=True,
        price_cents=0,
        currency="eur",
        audience_kind=AudienceKind.CURATOR_GROUPS.value,
    )
    db_session.add(practice)
    await db_session.flush()
    for school in schools or []:
        db_session.add(
            PracticeAudienceCuratorGroup(
                practice_id=practice.id, group_id=school.id,
            )
        )
    await db_session.flush()
    await db_session.commit()
    return practice


async def _booking(
    db_session: AsyncSession,
    practice: Practice,
    student: dict,
    status: str = BookingStatus.CONFIRMED.value,
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
    mood: int = 9,
    comment: str | None = "Спалось хорошо",
    check_type: str = CheckType.PRE.value,
) -> Checkin:
    row = Checkin(
        practice_id=practice.id,
        user_id=UUID(student["user"]["id"]),
        booking_id=booking.id,
        mood=mood,
        comment=comment,
        check_type=check_type,
    )
    db_session.add(row)
    await db_session.flush()
    await db_session.commit()
    return row


async def _feedback(
    db_session: AsyncSession,
    practice: Practice,
    student: dict,
    booking: Booking,
    *,
    rating: int = 9,
    comment: str | None = "Спасибо",
) -> Feedback:
    row = Feedback(
        practice_id=practice.id,
        user_id=UUID(student["user"]["id"]),
        booking_id=booking.id,
        rating=rating,
        comment=comment,
    )
    db_session.add(row)
    await db_session.flush()
    await db_session.commit()
    return row


async def _attended(
    db_session: AsyncSession,
    practice: Practice,
    student: dict,
    *,
    mood: int = 9,
    rating: int = 9,
) -> Booking:
    """The whole trail one participant leaves: booking, check-in, review."""
    booking = await _booking(db_session, practice, student)
    await _checkin(db_session, practice, student, booking, mood=mood)
    await _feedback(db_session, practice, student, booking, rating=rating)
    return booking


async def _get(
    client: AsyncClient,
    url: str,
    auth: dict,
    school: CuratorGroup | str,
    **params,
):
    group_id = school if isinstance(school, str) else str(school.id)
    return await client.get(
        url.format(group_id=group_id),
        params=params or None,
        headers=auth_headers(auth["session_token"]),
    )


async def _checkins(
    client: AsyncClient, auth: dict, school: CuratorGroup, **params,
) -> list[dict]:
    resp = await _get(client, CHECKINS_URL, auth, school, **params)
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]


async def _reviews(
    client: AsyncClient, auth: dict, school: CuratorGroup, **params,
) -> list[dict]:
    resp = await _get(client, REVIEWS_URL, auth, school, **params)
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]


async def _feed_titles(client: AsyncClient, auth: dict) -> list[str]:
    resp = await client.get(
        f"{PRACTICES_URL}?limit=100",
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 200, resp.text
    return [i["title"] for i in resp.json()["items"]]


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
# The feature itself
# ===========================================================================


@pytest.mark.asyncio
async def test_the_curator_reads_practices_they_did_not_run(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The whole point of BE-24, in one test.

    Two practices in the school: one the curator ran, one a school master
    ran. Both feeds carry both. The second half is the feature -- the first
    half is what makes a failure legible, because a curator who has lost
    sight of their OWN practice has a different bug.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_TEACHER, first_name="Ната",
    )
    student = await _make_student(client, _TID_STUDENT, first_name="Аня")
    school = await _school(db_session, curator)
    await _join_school(db_session, school, teacher, CuratorMemberKind.MASTER)

    mine = await _practice(
        db_session, curator, [school], title="Моя практика",
    )
    theirs = await _practice(
        db_session, teacher, [school], title="Чужая практика",
    )
    await _attended(db_session, mine, student)
    await _attended(db_session, theirs, student)

    titles = {i["practice_title"] for i in
              await _checkins(client, curator, school)}
    assert titles == {"Моя практика", "Чужая практика"}

    titles = {i["practice_title"] for i in
              await _reviews(client, curator, school)}
    assert titles == {"Моя практика", "Чужая практика"}


@pytest.mark.asyncio
async def test_the_student_is_named(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Names are shown -- owner decision, 27 August.

    Not obfuscated, not aggregated, not an initial. The assertion is on the
    literal name because "some non-empty string" would pass on a user id or
    a placeholder, which is precisely the shape a cautious rewrite reaches
    for.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await _make_student(client, _TID_STUDENT, first_name="Аня")
    school = await _school(db_session, curator)
    practice = await _practice(db_session, curator, [school])
    await _attended(db_session, practice, student)

    assert [i["student_name"] for i in
            await _checkins(client, curator, school)] == ["Аня"]
    assert [i["student_name"] for i in
            await _reviews(client, curator, school)] == ["Аня"]


# ===========================================================================
# Item 1 -- history is a fact, membership is a state
# ===========================================================================


@pytest.mark.asyncio
async def test_a_departed_masters_practice_stays_in_the_schools_feedback(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The school keeps what it collected when the teacher walks out.

    Owner ruling, 2026-09-10: masters can be invited for a season and
    collaboration between schools is normal, so a practice belongs to the
    school it was addressed to for good. Before this ruling the school's
    history would have been rewritten by somebody else's resignation.

    The BEFORE half is asserted too: without it, a feed that was empty all
    along would pass the AFTER half.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(client, db_session, _TID_TEACHER)
    student = await _make_student(client, _TID_STUDENT)
    school = await _school(db_session, curator)
    membership = await _join_school(
        db_session, school, teacher, CuratorMemberKind.MASTER,
    )
    practice = await _practice(
        db_session, teacher, [school], title="Практика ушедшего",
    )
    await _attended(db_session, practice, student)

    assert len(await _checkins(client, curator, school)) == 1
    assert len(await _reviews(client, curator, school)) == 1

    await _leave_school(db_session, membership)

    assert [i["practice_title"] for i in
            await _checkins(client, curator, school)] == ["Практика ушедшего"]
    assert [i["practice_title"] for i in
            await _reviews(client, curator, school)] == ["Практика ушедшего"]


@pytest.mark.asyncio
async def test_the_same_practice_leaves_the_school_feed_and_its_students(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """...and the OTHER predicate still says no. Existing behaviour, pinned.

    _master_in_curator_group_clause is untouched by BE-24, and this test is
    the proof rather than the claim: the practice that stayed in the
    curator's feedback above is, at the same moment, gone from a school
    student's feed and refused at the detail gate.

    THE STUDENT HERE HOLDS NO BOOKING, deliberately. A booking holder is
    grandfathered through audience narrowing (H-R2-8, the retroactive
    policy) and would still read the practice -- correctly -- which would
    make this test assert the opposite of what it means to.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(client, db_session, _TID_TEACHER)
    watcher = await _make_student(client, _TID_STUDENT_B)
    school = await _school(db_session, curator)
    membership = await _join_school(
        db_session, school, teacher, CuratorMemberKind.MASTER,
    )
    await _join_school(db_session, school, watcher, CuratorMemberKind.STUDENT)
    practice = await _practice(
        db_session, teacher, [school], title="Практика ушедшего",
    )

    assert "Практика ушедшего" in await _feed_titles(client, watcher)
    seen = await client.get(
        DETAIL_URL.format(practice_id=practice.id),
        headers=auth_headers(watcher["session_token"]),
    )
    assert seen.status_code == 200, seen.text

    await _leave_school(db_session, membership)

    assert "Практика ушедшего" not in await _feed_titles(client, watcher)
    gone = await client.get(
        DETAIL_URL.format(practice_id=practice.id),
        headers=auth_headers(watcher["session_token"]),
    )
    # The stranger gate turns the refusal into a 404 on purpose -- a
    # viewer must not learn the practice exists.
    assert gone.status_code == 404, gone.text


@pytest.mark.asyncio
async def test_a_practice_addressed_to_two_schools_reaches_both_curators(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """One practice, two schools, two curators -- and each sees it once.

    Nothing is split between them: the same check-in is the history of both
    schools, because the master pointed the practice at both.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    curator_b = await _make_verified_master(
        client, db_session, _TID_CURATOR_B,
    )
    teacher = await _make_verified_master(client, db_session, _TID_TEACHER)
    student = await _make_student(client, _TID_STUDENT)
    school = await _school(db_session, curator, name="Первая")
    school_b = await _school(db_session, curator_b, name="Вторая")
    await _join_school(db_session, school, teacher, CuratorMemberKind.MASTER)
    await _join_school(db_session, school_b, teacher, CuratorMemberKind.MASTER)

    practice = await _practice(
        db_session, teacher, [school, school_b], title="Коллаборация",
    )
    await _attended(db_session, practice, student)

    assert [i["practice_title"] for i in
            await _checkins(client, curator, school)] == ["Коллаборация"]
    assert [i["practice_title"] for i in
            await _checkins(client, curator_b, school_b)] == ["Коллаборация"]


@pytest.mark.asyncio
async def test_a_practice_in_two_schools_of_one_curator_arrives_once(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Two audience rows must not become two feed rows.

    The predicate is an EXISTS and not a join, and this is the test that
    fails the day somebody rewrites it as one. total is asserted alongside
    the page, because a duplicate that the page happens to hide would still
    inflate the count.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await _make_student(client, _TID_STUDENT)
    school = await _school(db_session, curator, name="Утро")
    school_b = await _school(db_session, curator, name="Вечер")
    practice = await _practice(
        db_session, curator, [school, school_b], title="Общая",
    )
    await _attended(db_session, practice, student)

    resp = await _get(client, CHECKINS_URL, curator, school)
    assert resp.status_code == 200, resp.text
    assert len(resp.json()["items"]) == 1
    assert resp.json()["total"] == 1

    resp = await _get(client, REVIEWS_URL, curator, school_b)
    assert resp.status_code == 200, resp.text
    assert len(resp.json()["items"]) == 1
    assert resp.json()["total"] == 1


@pytest.mark.asyncio
async def test_a_student_who_left_the_school_keeps_their_feedback_there(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Leaving does not retract what was left on the school's practices.

    Same ruling as the departed master: visibility is a property of the
    PRACTICE, not of anybody's current membership. Named here as its own
    test because it is the half that touches a person rather than a
    teacher, and because the answer was not in any document until 10
    September.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await _make_student(client, _TID_STUDENT, first_name="Аня")
    school = await _school(db_session, curator)
    membership = await _join_school(
        db_session, school, student, CuratorMemberKind.STUDENT,
    )
    practice = await _practice(db_session, curator, [school])
    await _attended(db_session, practice, student)

    assert len(await _reviews(client, curator, school)) == 1

    await _leave_school(db_session, membership)

    assert [i["student_name"] for i in
            await _reviews(client, curator, school)] == ["Аня"]


# ===========================================================================
# Item 2 -- who may ask
# ===========================================================================


@pytest.mark.asyncio
async def test_a_missing_school_and_somebody_elses_are_the_same_404(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The refusal must not tell a curator that the other school exists.

    THE BASELINE IS SAMPLED IN THIS TEST rather than written down: the
    response for a uuid that belongs to nobody is captured here and the
    response for a real school owned by somebody else is compared to it,
    status and body. A hard-coded expectation would keep passing on the day
    one of the two answers changes.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    curator_b = await _make_verified_master(
        client, db_session, _TID_CURATOR_B,
    )
    school_b = await _school(db_session, curator_b, name="Не твоя")

    for url in (CHECKINS_URL, REVIEWS_URL):
        nowhere = await _get(client, url, curator, str(uuid4()))
        theirs = await _get(client, url, curator, school_b)

        assert nowhere.status_code == 404, nowhere.text
        assert theirs.status_code == nowhere.status_code, theirs.text
        assert theirs.json() == nowhere.json()


@pytest.mark.asyncio
async def test_a_school_master_and_a_school_student_are_both_refused(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Inside the school is not the same as owning it.

    The master member gets the curator's own 404 -- the ownership check,
    not a role check. The student never reaches it: get_current_master
    turns them away first, and that is a 403 rather than a 404 because the
    school is not what they failed. Both are asserted so that a future
    unification of the two answers is a visible change.

    The curator's own 200 sits in the same test: two refusals over an
    endpoint that refuses everybody would prove nothing.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(client, db_session, _TID_TEACHER)
    student = await _make_student(client, _TID_STUDENT)
    school = await _school(db_session, curator)
    await _join_school(db_session, school, teacher, CuratorMemberKind.MASTER)
    await _join_school(db_session, school, student, CuratorMemberKind.STUDENT)

    assert (
        await _get(client, CHECKINS_URL, curator, school)
    ).status_code == 200

    assert (
        await _get(client, CHECKINS_URL, teacher, school)
    ).status_code == 404
    assert (
        await _get(client, REVIEWS_URL, teacher, school)
    ).status_code == 404

    assert (
        await _get(client, CHECKINS_URL, student, school)
    ).status_code == 403
    assert (
        await _get(client, REVIEWS_URL, student, school)
    ).status_code == 403


@pytest.mark.asyncio
async def test_an_outsider_gets_the_same_404_as_a_missing_school(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A verified master with no relation to the school learns nothing."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    outsider = await _make_verified_master(client, db_session, _TID_OUTSIDER)
    school = await _school(db_session, curator)

    theirs = await _get(client, CHECKINS_URL, outsider, school)
    nowhere = await _get(client, CHECKINS_URL, outsider, str(uuid4()))

    assert theirs.status_code == 404, theirs.text
    assert theirs.json() == nowhere.json()


@pytest.mark.asyncio
async def test_the_killswitch_takes_both_endpoints_with_it(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Both feeds are gone with the flag off, and back when it returns.

    The school and its rows exist throughout: the point is not that there
    is nothing to find. The "and back" half is in the same test because a
    dependency refusing unconditionally would satisfy the first half.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await _make_student(client, _TID_STUDENT)
    school = await _school(db_session, curator)
    practice = await _practice(db_session, curator, [school])
    await _attended(db_session, practice, student)

    with patch.object(settings, _FLAG, False):
        for url in (CHECKINS_URL, REVIEWS_URL):
            resp = await _get(client, url, curator, school)
            assert resp.status_code == 404, f"{url}: {resp.text}"

    with patch.object(settings, _FLAG, True):
        assert len(await _checkins(client, curator, school)) == 1
        assert len(await _reviews(client, curator, school)) == 1


# ===========================================================================
# Item 3 -- the depth ceiling. Every absence is paired with a presence.
# ===========================================================================


@pytest.mark.asyncio
async def test_post_checkins_never_appear_while_pre_ones_do(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """POST is invisible; PRE, on the same booking, is not.

    A master reads a POST check-in in exactly one place -- the per-student
    dossier at GET /masters/me/students/{id} -- and that path is the one
    thing a curator must not have. The pairing matters more here than
    anywhere: both rows hang off the SAME booking, so a feed that returned
    nothing would satisfy the "no POST" half perfectly.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await _make_student(client, _TID_STUDENT)
    school = await _school(db_session, curator)
    practice = await _practice(db_session, curator, [school])
    booking = await _booking(db_session, practice, student)
    await _checkin(
        db_session, practice, student, booking,
        mood=9, comment="до", check_type=CheckType.PRE.value,
    )
    await _checkin(
        db_session, practice, student, booking,
        mood=2, comment="после", check_type=CheckType.POST.value,
    )

    items = await _checkins(client, curator, school)

    assert [i["comment"] for i in items] == ["до"]


@pytest.mark.asyncio
async def test_a_cancelled_bookings_checkin_is_dropped_and_the_rest_stay(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The master's own roster drops these rows; so does this feed.

    get_attendance filters status != CANCELLED, so a check-in behind a
    cancelled booking is invisible to the practice's own master. Showing it
    to the curator would be the exact inversion of "wider reach, same
    depth".

    Two participants, one cancelled and one not, so the assertion cannot be
    satisfied by an empty page.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    stayed = await _make_student(client, _TID_STUDENT, first_name="Аня")
    left = await _make_student(client, _TID_STUDENT_B, first_name="Боря")
    school = await _school(db_session, curator)
    practice = await _practice(db_session, curator, [school])

    await _attended(db_session, practice, stayed)
    cancelled = await _booking(
        db_session, practice, left, status=BookingStatus.CANCELLED.value,
    )
    await _checkin(db_session, practice, left, cancelled, comment="ушёл")

    names = [i["student_name"] for i in
             await _checkins(client, curator, school)]

    assert names == ["Аня"]


@pytest.mark.asyncio
async def test_mood_is_a_bucket_and_never_the_stored_score(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The 1..10 mood does not leave the master's dossier.

    Three participants across the three ranges, so the mapping is asserted
    rather than a single value that a constant would satisfy. The type
    check is explicit: `9 == "high"` is False in Python, but a schema that
    quietly widened to `int | str` would pass a value-only assertion on a
    seeded 9 and fail nothing until production.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    low = await _make_student(client, _TID_STUDENT, first_name="Низ")
    mid = await _make_student(client, _TID_STUDENT_B, first_name="Серед")
    high = await _make_student(client, _TID_STUDENT_C, first_name="Верх")
    school = await _school(db_session, curator)
    practice = await _practice(db_session, curator, [school])

    for who, mood in ((low, 2), (mid, 5), (high, 10)):
        booking = await _booking(db_session, practice, who)
        await _checkin(db_session, practice, who, booking, mood=mood)

    items = await _checkins(client, curator, school)
    by_name = {i["student_name"]: i["mood"] for i in items}

    assert len(items) == 3
    assert all(isinstance(v, str) for v in by_name.values())
    assert by_name == {"Низ": "low", "Серед": "mid", "Верх": "high"}


@pytest.mark.asyncio
async def test_rating_is_a_bucket_and_never_the_stored_score(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The 1..10 rating does not leave the master's dossier either.

    The vocabulary is the feedback one (confused / good / fire), which is
    what both master-facing review feeds already publish -- so the curator
    reads a review in exactly the shape its own master reads it.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    low = await _make_student(client, _TID_STUDENT, first_name="Низ")
    mid = await _make_student(client, _TID_STUDENT_B, first_name="Серед")
    high = await _make_student(client, _TID_STUDENT_C, first_name="Верх")
    school = await _school(db_session, curator)
    practice = await _practice(db_session, curator, [school])

    for who, rating in ((low, 1), (mid, 7), (high, 8)):
        booking = await _booking(db_session, practice, who)
        await _feedback(db_session, practice, who, booking, rating=rating)

    items = await _reviews(client, curator, school)
    by_name = {i["student_name"]: i["rating"] for i in items}

    assert len(items) == 3
    assert all(isinstance(v, str) for v in by_name.values())
    assert by_name == {"Низ": "confused", "Серед": "good", "Верх": "fire"}


@pytest.mark.asyncio
async def test_no_contact_details_ride_along_with_the_identified_student(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """What the row does NOT carry, asserted against a row that exists.

    Email and phone are the curator's standing prohibition and are absent.
    The student is fully identified -- name, avatar and user_id -- and that
    is the decision, not an oversight: a school with two Александрs needs
    to tell them apart, which is most of why names are shown at all.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await _make_student(client, _TID_STUDENT, first_name="Аня")
    school = await _school(db_session, curator)
    practice = await _practice(db_session, curator, [school])
    await _attended(db_session, practice, student)

    forbidden = {"email", "phone", "telegram_id", "balance", "mood_score"}

    for items in (
        await _checkins(client, curator, school),
        await _reviews(client, curator, school),
    ):
        assert len(items) == 1
        assert items[0]["student_name"] == "Аня"
        assert items[0]["user_id"] == student["user"]["id"]
        assert forbidden & set(items[0]) == set()


@pytest.mark.asyncio
async def test_the_id_in_the_feed_does_not_open_the_students_dossier(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The barrier is the dossier endpoint, not a missing identifier.

    This is the test that makes carrying user_id safe to reason about: the
    curator takes the id straight out of their own feed and asks for the
    per-student profile with it, and gets the 404 that
    is_master_audience_member produces for somebody who is not this
    master's student. The practice's own master gets 200 on the same id in
    the same test -- without that half, a dossier broken for everybody
    would read as a passing privacy check.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(client, db_session, _TID_TEACHER)
    student = await _make_student(client, _TID_STUDENT, first_name="Аня")
    school = await _school(db_session, curator)
    await _join_school(db_session, school, teacher, CuratorMemberKind.MASTER)
    practice = await _practice(db_session, teacher, [school])
    await _attended(db_session, practice, student)

    items = await _reviews(client, curator, school)
    student_id = items[0]["user_id"]

    refused = await client.get(
        STUDENT_DOSSIER_URL.format(student_id=student_id),
        headers=auth_headers(curator["session_token"]),
    )
    assert refused.status_code == 404, refused.text

    allowed = await client.get(
        STUDENT_DOSSIER_URL.format(student_id=student_id),
        headers=auth_headers(teacher["session_token"]),
    )
    assert allowed.status_code == 200, allowed.text


@pytest.mark.asyncio
async def test_a_practice_outside_the_school_is_invisible_in_both_feeds(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Reach stops at the school's edge.

    The same master runs two practices -- one addressed to the school, one
    to nobody -- and only the first is the school's business. The included
    one is asserted alongside, so the exclusion is not the whole page being
    empty.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(client, db_session, _TID_TEACHER)
    student = await _make_student(client, _TID_STUDENT)
    school = await _school(db_session, curator)
    await _join_school(db_session, school, teacher, CuratorMemberKind.MASTER)

    inside = await _practice(db_session, teacher, [school], title="В школе")
    outside = await _practice(db_session, teacher, [], title="Вне школы")
    await _attended(db_session, inside, student)
    await _attended(db_session, outside, student)

    assert [i["practice_title"] for i in
            await _checkins(client, curator, school)] == ["В школе"]
    assert [i["practice_title"] for i in
            await _reviews(client, curator, school)] == ["В школе"]


# ===========================================================================
# Item 4 -- the page
# ===========================================================================


@pytest.mark.asyncio
async def test_the_page_is_bounded_while_total_counts_the_whole_school(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """limit bounds the rows; total does not.

    A school is tens of practices and, on a real practice, thousands of
    participants -- the number the curator is shown must come from the
    database rather than from len(items), or the first page would report
    itself as the whole history.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _school(db_session, curator)
    practice = await _practice(db_session, curator, [school])

    for tid in (_TID_STUDENT, _TID_STUDENT_B, _TID_STUDENT_C):
        who = await _make_student(client, tid, first_name=f"S{tid}")
        await _attended(db_session, practice, who)

    resp = await _get(client, CHECKINS_URL, curator, school, limit=2)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["items"]) == 2
    assert body["total"] == 3
    assert body["limit"] == 2
    assert body["offset"] == 0

    second = await _get(
        client, CHECKINS_URL, curator, school, limit=2, offset=2,
    )
    assert len(second.json()["items"]) == 1
    assert second.json()["total"] == 3


@pytest.mark.asyncio
async def test_an_empty_school_is_an_empty_page_not_an_error(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A school with no practices at all answers 200 with total 0.

    The school exists and the curator owns it; there is simply nothing in
    it yet. A 404 here would be indistinguishable from "not your school".
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _school(db_session, curator)

    for url in (CHECKINS_URL, REVIEWS_URL):
        resp = await _get(client, url, curator, school)
        assert resp.status_code == 200, resp.text
        assert resp.json()["items"] == []
        assert resp.json()["total"] == 0


@pytest.mark.asyncio
async def test_a_practice_with_no_feedback_yet_contributes_nothing(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Zero check-ins and zero reviews on a real practice is not an error.

    The practice is in the school and reachable; nobody has written
    anything on it. The second practice carries a row, so the empty one is
    shown to be absent rather than the whole feed being broken.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await _make_student(client, _TID_STUDENT)
    school = await _school(db_session, curator)
    silent = await _practice(db_session, curator, [school], title="Тишина")
    loud = await _practice(db_session, curator, [school], title="Голос")
    await _booking(db_session, silent, student)
    await _attended(db_session, loud, student)

    assert [i["practice_title"] for i in
            await _checkins(client, curator, school)] == ["Голос"]
    assert "Тишина" not in [
        i["practice_title"] for i in await _reviews(client, curator, school)
    ]


@pytest.mark.asyncio
async def test_practice_id_narrows_the_page_and_grants_nothing(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The filter is a narrowing, not a second way in.

    Passing the id of a practice outside the school returns an empty page
    rather than its rows: the school predicate is still applied and simply
    matches nothing. The in-school filter is asserted in the same test so
    that "empty" is not the answer to every value.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    stranger = await _make_verified_master(client, db_session, _TID_TEACHER_B)
    student = await _make_student(client, _TID_STUDENT)
    school = await _school(db_session, curator)
    first = await _practice(db_session, curator, [school], title="Первая")
    second = await _practice(db_session, curator, [school], title="Вторая")
    elsewhere = await _practice(db_session, stranger, [], title="Чужая")
    await _attended(db_session, first, student)
    await _attended(db_session, second, student)
    await _attended(db_session, elsewhere, student)

    narrowed = await _checkins(
        client, curator, school, practice_id=str(first.id),
    )
    assert [i["practice_title"] for i in narrowed] == ["Первая"]

    resp = await _get(
        client, CHECKINS_URL, curator, school, practice_id=str(elsewhere.id),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["items"] == []
    assert resp.json()["total"] == 0


@pytest.mark.asyncio
async def test_the_feed_is_newest_first_across_practices(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The sort key is the ROW's time, not the practice's date.

    A curator reads the school's feedback as it arrives, and it arrives
    across practices. The practices here are deliberately scheduled in the
    opposite order to the check-ins, so a query that sorted by
    Practice.scheduled_at would produce exactly the reverse of this.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await _make_student(client, _TID_STUDENT)
    school = await _school(db_session, curator)
    later = await _practice(
        db_session, curator, [school], title="Поздняя", hours_from_now=200,
    )
    sooner = await _practice(
        db_session, curator, [school], title="Ранняя", hours_from_now=10,
    )

    first_booking = await _booking(db_session, later, student)
    await _checkin(db_session, later, student, first_booking, comment="1")
    second_booking = await _booking(db_session, sooner, student)
    await _checkin(db_session, sooner, student, second_booking, comment="2")

    titles = [i["practice_title"] for i in
              await _checkins(client, curator, school)]

    assert titles == ["Ранняя", "Поздняя"]
