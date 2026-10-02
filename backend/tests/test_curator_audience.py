# =============================================================================
# VELO Backend -- Tests: the fourth audience, curator groups (P5/GT-11)
# =============================================================================
#
# telegram_id band: 68000-68199 (masters 68001-68005, students 68010-68019,
# stranger 68030, admin 68090). Declared module-level below as
# _TID_MIN/_TID_MAX, ONCE -- tests/telegram_id_bands.py parses that
# declaration out of the AST on every run, and a file that uses ids without
# declaring a band fails test_blind_zone_has_not_grown.
# 68200-68399 is reserved for GT-12 and deliberately untouched.
#
# ⚠ BACKEND-ONLY, UNPROVEN LOCALLY -- no Postgres in the authoring
# environment. Written to be read and to run on the server.
#
# EVERY "cannot see" HERE IS PAIRED WITH A "can see and can book" ON THE
# SAME PRACTICE. A test that only asserts a refusal passes just as happily
# when the practice is broken, missing, or invisible to everyone -- which is
# the failure mode an audience change is most likely to cause.
#
# AND EVERY REFUSAL IS CHECKED AT EVERY GATE. There are five call sites of
# the audience predicate in the tree (feed, booking, waitlist join, waitlist
# confirm, detail stranger-gate); a branch added to the shared predicate
# reaches all five by construction, and _assert_all_gates_refuse is how that
# claim is tested instead of assumed.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.bookings.models import Booking, BookingStatus
from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupMember,
    CuratorMemberKind,
)
from app.modules.masters.groups_models import MasterStudent
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import (
    AudienceKind,
    Practice,
    PracticeStatus,
    PracticeType,
)
from app.modules.users.models import User, UserRole
from app.modules.waitlist.models import Waitlist, WaitlistStatus
from tests.helpers import (
    auth_headers,
    fresh_execute,
    full_cleanup_range,
    login_user,
)

PRACTICES_URL = "/api/v1/practices"
BOOKINGS_URL = "/api/v1/bookings"
DETAIL_URL = "/api/v1/practices/{practice_id}"
WAITLIST_JOIN_URL = "/api/v1/practices/{practice_id}/waitlist"
PREVIEW_URL = "/api/v1/practices/{practice_id}/audience-preview"
REVOKE_URL = "/api/v1/admin/masters/{user_id}/revoke"
MAKE_MASTER_URL = "/api/v1/admin/users/{user_id}/make-master"

_TID_MIN = 68000
_TID_MAX = 68199

_TID_MASTER = 68001
_TID_CURATOR = 68002
_TID_MASTER_B = 68003
_TID_STUDENT_A = 68010
_TID_STUDENT_B = 68011
_TID_STUDENT_C = 68012
_TID_STRANGER = 68030
_TID_ADMIN = 68090


# ===========================================================================
# Local helpers -- copied, not imported, as every test file in this tree does
# ===========================================================================


async def _make_verified_master(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int,
    first_name: str = "Master",
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
            data={"account": {"status": "verified"}, "profile": {"bio": "m"}},
        )
    )
    await db_session.flush()
    await db_session.commit()
    return auth


async def _make_admin(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int,
) -> str:
    auth = await login_user(client, telegram_id=telegram_id, first_name="Admin")
    user = await db_session.get(User, UUID(auth["user"]["id"]))
    user.role = UserRole.ADMIN
    await db_session.flush()
    await db_session.commit()
    return auth["session_token"]


async def _school(
    db_session: AsyncSession, curator_id: str, name: str = "Тихое утро",
) -> CuratorGroup:
    group = CuratorGroup(curator_user_id=UUID(curator_id), name=name)
    db_session.add(group)
    await db_session.flush()
    await db_session.commit()
    return group


async def _join_school(
    db_session: AsyncSession, group_id, user_id: str, kind: CuratorMemberKind,
) -> CuratorGroupMember:
    row = CuratorGroupMember(
        group_id=group_id, user_id=UUID(user_id), kind=kind.value,
    )
    db_session.add(row)
    await db_session.flush()
    await db_session.commit()
    return row


async def _create_practice(
    db_session: AsyncSession,
    master_id: str,
    *,
    audience_kind: str = AudienceKind.CURATOR_GROUPS.value,
    school: CuratorGroup | None = None,
    status: str = PracticeStatus.SCHEDULED.value,
    hours_from_now: float = 48,
    max_participants: int | None = 20,
    title: str = "School Practice",
) -> Practice:
    practice = Practice(
        master_id=UUID(master_id),
        title=title,
        description="x",
        practice_type=PracticeType.LIVE.value,
        status=status,
        scheduled_at=datetime.now(UTC) + timedelta(hours=hours_from_now),
        duration_minutes=60,
        timezone="UTC",
        max_participants=max_participants,
        current_participants=0,
        is_free=True,
        price_cents=0,
        currency="eur",
        audience_kind=audience_kind,
        curator_group_id=school.id if school is not None else None,
    )
    db_session.add(practice)
    await db_session.flush()
    await db_session.commit()
    return practice


def _practice_body(**overrides) -> dict:
    """A body POST /practices actually accepts.

    direction and difficulty are REQUIRED by CreatePracticeRequest -- the
    first version of these tests omitted both and got a 422 that looked like
    an audience rejection. Kept in one helper so a future required field is
    added once rather than in four payloads.

    The taxonomy gate (_assert_master_confirmed_taxonomy) fails OPEN for a
    master whose profile.methods is empty, which is what _make_verified_master
    above creates -- so "meditation" needs no confirmed method here. That is
    the documented behaviour of the gate, not an accident this test relies
    on quietly.
    """
    base: dict = {
        "practice_type": "live",
        "direction": "meditation",
        "difficulty": "beginner",
        "title": "Практика школы",
        "description": "x",
        "scheduled_at": (datetime.now(UTC) + timedelta(hours=48)).isoformat(),
        "duration_minutes": 60,
        "timezone": "UTC",
        "max_participants": 20,
        "is_free": True,
        "price_cents": 0,
        "currency": "eur",
    }
    base.update(overrides)
    return base


async def _revoke(client: AsyncClient, admin_token: str, user_id: str) -> None:
    resp = await client.post(
        REVOKE_URL.format(user_id=user_id), headers=auth_headers(admin_token),
    )
    assert resp.status_code == 200, resp.text


async def _re_verify(
    client: AsyncClient, admin_token: str, user_id: str,
) -> None:
    """make-master, NOT /verify -- verify_master 409s on anything but a
    `pending` profile, and a revoked one is `suspended`."""
    resp = await client.post(
        MAKE_MASTER_URL.format(user_id=user_id),
        headers=auth_headers(admin_token),
    )
    assert resp.status_code == 200, resp.text


async def _feed_titles(client: AsyncClient, auth: dict) -> list[str]:
    resp = await client.get(
        f"{PRACTICES_URL}?limit=100",
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 200, resp.text
    return [i["title"] for i in resp.json()["items"]]


async def _book(client: AsyncClient, auth: dict, practice: Practice):
    return await client.post(
        BOOKINGS_URL,
        json={"practice_id": str(practice.id)},
        headers=auth_headers(auth["session_token"]),
    )


async def _assert_can_see_and_book(
    client: AsyncClient, auth: dict, practice: Practice,
) -> None:
    """The POSITIVE half every refusal below is paired against.

    Covers three of the five gates on the way: the feed clause, the detail
    stranger-gate, and the booking gate. If this passes while a sibling
    refusal also passes, the refusal means something.
    """
    assert practice.title in await _feed_titles(client, auth)
    detail = await client.get(
        DETAIL_URL.format(practice_id=practice.id),
        headers=auth_headers(auth["session_token"]),
    )
    assert detail.status_code == 200, detail.text
    booked = await _book(client, auth, practice)
    assert booked.status_code == 201, booked.text


async def _assert_all_gates_refuse(
    client: AsyncClient, auth: dict, practice: Practice,
) -> None:
    """Every one of the five audience gates refuses this viewer.

    The list is not from a document -- it is every call site of
    viewer_audience_clause / assert_viewer_can_access_practice found by
    grepping the tree:
      1. feed          -- listing_service.py
      2. detail        -- practices/service.py stranger gate (403 -> 404)
      3. booking       -- bookings/service.py
      4. waitlist join -- waitlist/service.py
      5. waitlist confirm -- waitlist/service.py, unreachable without (4),
         so it is covered by its own dedicated test rather than here.
    """
    assert practice.title not in await _feed_titles(client, auth)

    detail = await client.get(
        DETAIL_URL.format(practice_id=practice.id),
        headers=auth_headers(auth["session_token"]),
    )
    # This gate translates ForbiddenError to NotFoundError on purpose --
    # a stranger must not learn the practice exists.
    assert detail.status_code == 404, detail.text

    booked = await _book(client, auth, practice)
    assert booked.status_code == 403, booked.text
    assert booked.json()["error"] == "not_in_audience"

    queued = await client.post(
        WAITLIST_JOIN_URL.format(practice_id=practice.id),
        headers=auth_headers(auth["session_token"]),
    )
    assert queued.status_code == 403, queued.text
    assert queued.json()["error"] == "not_in_audience"


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
# TZ 8.5 row 1 -- the master belongs to the school
# ===========================================================================


@pytest.mark.asyncio
async def test_the_school_sees_the_practice_and_a_stranger_does_not(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The whole feature in one test: same practice, four viewers.

    Curator, master-member and student-member all get in; a person outside
    the school is refused at every gate. The refusal only means something
    because the three admissions sit beside it.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER, first_name="Teacher",
    )
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    stranger = await login_user(client, telegram_id=_TID_STRANGER)
    school = await _school(db_session, curator["user"]["id"])
    await _join_school(
        db_session, school.id, teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    await _join_school(
        db_session, school.id, student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )
    practice = await _create_practice(
        db_session, teacher["user"]["id"], school=school,
    )

    for who in (curator, student):
        await _assert_can_see_and_book(client, who, practice)
    await _assert_all_gates_refuse(client, stranger, practice)


@pytest.mark.asyncio
async def test_a_master_member_of_the_school_sees_another_masters_practice(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The viewer clause does not look at `kind`: a teacher of the school is
    in the room like anyone else."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER, first_name="Teacher",
    )
    colleague = await _make_verified_master(
        client, db_session, _TID_MASTER_B, first_name="Colleague",
    )
    school = await _school(db_session, curator["user"]["id"])
    for who in (teacher, colleague):
        await _join_school(
            db_session, school.id, who["user"]["id"],
            CuratorMemberKind.MASTER,
        )
    practice = await _create_practice(
        db_session, teacher["user"]["id"], school=school,
    )

    await _assert_can_see_and_book(client, colleague, practice)


@pytest.mark.asyncio
async def test_a_practice_by_the_curator_themselves_is_visible_to_the_school(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The master clause's FIRST branch: the curator belongs to their own
    school without holding a membership row (I-2)."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    school = await _school(db_session, curator["user"]["id"])
    await _join_school(
        db_session, school.id, student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )
    practice = await _create_practice(
        db_session, curator["user"]["id"], school=school,
    )

    await _assert_can_see_and_book(client, student, practice)


# ===========================================================================
# TZ 8.5 row 2 -- the master no longer belongs
# ===========================================================================


@pytest.mark.asyncio
async def test_a_master_who_leaves_the_school_stops_broadcasting_to_it(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """THE RULING THIS AUDIENCE EXISTS FOR (owner, 2026-08-22).

    Before/after on the SAME practice and the SAME viewer, with nobody
    editing the practice: the student can see and book while the teacher is
    in the school, and every gate refuses once the membership row is gone.
    The master keeps seeing their own practice throughout -- otherwise the
    "after" half would pass just as well if the practice had been deleted.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER, first_name="Teacher",
    )
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    other = await login_user(client, telegram_id=_TID_STUDENT_B)
    school = await _school(db_session, curator["user"]["id"])
    membership = await _join_school(
        db_session, school.id, teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    for who in (student, other):
        await _join_school(
            db_session, school.id, who["user"]["id"],
            CuratorMemberKind.STUDENT,
        )
    practice = await _create_practice(
        db_session, teacher["user"]["id"], school=school,
    )

    await _assert_can_see_and_book(client, student, practice)

    await db_session.delete(
        await db_session.get(CuratorGroupMember, membership.id)
    )
    await db_session.commit()

    await _assert_all_gates_refuse(client, other, practice)
    assert practice.title in await _feed_titles(client, teacher)


@pytest.mark.asyncio
async def test_a_suspended_master_member_stops_broadcasting_too(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Verification is checked NOW, not at the time the row was written.

    A suspended teacher is already hidden from the school's roster (I-4);
    a hidden teacher whose practices still reached the school would
    contradict the page one screen away. Re-verification brings both back,
    with no row rewritten -- which is what the third phase proves.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER, first_name="Teacher",
    )
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    other = await login_user(client, telegram_id=_TID_STUDENT_B)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    school = await _school(db_session, curator["user"]["id"])
    await _join_school(
        db_session, school.id, teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    for who in (student, other):
        await _join_school(
            db_session, school.id, who["user"]["id"],
            CuratorMemberKind.STUDENT,
        )
    practice = await _create_practice(
        db_session, teacher["user"]["id"], school=school,
    )
    await _assert_can_see_and_book(client, student, practice)

    await _revoke(client, admin_token, teacher["user"]["id"])
    await _assert_all_gates_refuse(client, other, practice)

    await _re_verify(client, admin_token, teacher["user"]["id"])
    await _assert_can_see_and_book(client, other, practice)


@pytest.mark.asyncio
async def test_a_frozen_school_takes_the_practice_dark(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """I-6 reaches the audience: an inactive school targets nobody.

    Same shape as above but the CURATOR is the one revoked -- a different
    condition of the same clause, and one the master cannot fix.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER, first_name="Teacher",
    )
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    other = await login_user(client, telegram_id=_TID_STUDENT_B)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    school = await _school(db_session, curator["user"]["id"])
    await _join_school(
        db_session, school.id, teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    for who in (student, other):
        await _join_school(
            db_session, school.id, who["user"]["id"],
            CuratorMemberKind.STUDENT,
        )
    practice = await _create_practice(
        db_session, teacher["user"]["id"], school=school,
    )
    await _assert_can_see_and_book(client, student, practice)

    await _revoke(client, admin_token, curator["user"]["id"])
    await _assert_all_gates_refuse(client, other, practice)

    await _re_verify(client, admin_token, curator["user"]["id"])
    await _assert_can_see_and_book(client, other, practice)


@pytest.mark.asyncio
async def test_deleting_the_school_makes_its_practice_public_and_ownerless(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Checked on LIVE DATA, not read off the DDL (the GT-4 lesson).

    Before BE-74 the audience rows went with the school and the practice
    went dark -- right while the school was a set of rows beside the
    practice. BE-74 (owner ruling Q3, 2026-10-01): the school is the
    practice's own column, and losing it makes a 'curator_groups' practice
    public in the same statement. The deletion here is a plain DELETE of
    the school row, so what clears the column is the FK's ON DELETE SET
    NULL and what changes the audience is the BEFORE UPDATE trigger
    (trg_practices_school_lost_goes_public) -- without the trigger the
    CHECK refuses the cascade and this DELETE fails.

    THE PAIR: the row is asserted (public, no school, still scheduled), and
    a student of the deleted school -- who never booked -- now sees and
    books it as anybody would.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER, first_name="Teacher",
    )
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    other = await login_user(client, telegram_id=_TID_STUDENT_B)
    school = await _school(db_session, curator["user"]["id"])
    await _join_school(
        db_session, school.id, teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    for who in (student, other):
        await _join_school(
            db_session, school.id, who["user"]["id"],
            CuratorMemberKind.STUDENT,
        )
    practice = await _create_practice(
        db_session, teacher["user"]["id"], school=school,
    )
    await _assert_can_see_and_book(client, student, practice)

    await db_session.execute(
        delete(CuratorGroup).where(CuratorGroup.id == school.id),
    )
    await db_session.commit()

    row = (
        await fresh_execute(select(Practice).where(Practice.id == practice.id))
    ).scalar_one()
    assert row.audience_kind == AudienceKind.PUBLIC.value
    assert row.curator_group_id is None
    assert row.status == PracticeStatus.SCHEDULED.value
    await _assert_can_see_and_book(client, other, practice)


# ===========================================================================
# TZ 8.5 row 3 -- blocking beats audience
# ===========================================================================


@pytest.mark.asyncio
async def test_a_blocked_member_is_refused_with_the_block_code(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The block branch runs BEFORE any audience branch and keeps its own
    code -- a member of the school still gets blocked_by_master, not
    not_in_audience. The order was not touched by this delivery, and this
    test is what says so."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER, first_name="Teacher",
    )
    blocked = await login_user(client, telegram_id=_TID_STUDENT_A)
    welcome = await login_user(client, telegram_id=_TID_STUDENT_B)
    school = await _school(db_session, curator["user"]["id"])
    await _join_school(
        db_session, school.id, teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    for who in (blocked, welcome):
        await _join_school(
            db_session, school.id, who["user"]["id"],
            CuratorMemberKind.STUDENT,
        )
    practice = await _create_practice(
        db_session, teacher["user"]["id"], school=school,
    )
    db_session.add(
        MasterStudent(
            master_id=UUID(teacher["user"]["id"]),
            student_user_id=UUID(blocked["user"]["id"]),
            blocked_at=datetime.now(UTC),
        )
    )
    await db_session.flush()
    await db_session.commit()

    refused = await _book(client, blocked, practice)
    assert refused.status_code == 403
    assert refused.json()["error"] == "blocked_by_master"
    assert practice.title not in await _feed_titles(client, blocked)

    await _assert_can_see_and_book(client, welcome, practice)


# ===========================================================================
# TZ 8.5 row 4 -- the grandfather rule
# ===========================================================================


@pytest.mark.asyncio
async def test_a_confirmed_booking_survives_leaving_the_school(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """H-R2-8 policy (B) reaches the new audience without any code for it.

    Check-in calls assert_viewer_not_blocked, which has no audience branches
    at all -- so a holder of a CONFIRMED booking keeps their check-in when
    the audience narrows under them. What they lose is the ability to make a
    NEW booking, and both halves are asserted here on the same person.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER, first_name="Teacher",
    )
    holder = await login_user(client, telegram_id=_TID_STUDENT_A)
    school = await _school(db_session, curator["user"]["id"])
    await _join_school(
        db_session, school.id, teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    membership = await _join_school(
        db_session, school.id, holder["user"]["id"],
        CuratorMemberKind.STUDENT,
    )
    # Check-in is open on the interval [scheduled_at - checkin_window_hours,
    # scheduled_at) -- diary/checkins_service.py. The first version of this
    # test put the practice half an hour in the PAST, which is on the closed
    # side of that interval, and the 400 it produced said nothing about
    # audience at all. +1h is inside the window (24h wide by default) and
    # still in the future.
    started = await _create_practice(
        db_session, teacher["user"]["id"], school=school,
        status=PracticeStatus.SCHEDULED.value, hours_from_now=1,
        title="Soon School Practice",
    )
    db_session.add(
        Booking(
            practice_id=started.id,
            user_id=UUID(holder["user"]["id"]),
            status=BookingStatus.CONFIRMED.value,
        )
    )
    await db_session.flush()
    await db_session.commit()

    await db_session.delete(
        await db_session.get(CuratorGroupMember, membership.id)
    )
    await db_session.commit()

    checked_in = await client.post(
        f"{PRACTICES_URL}/{started.id}/checkin",
        json={"type": "pre", "mood": 7},
        headers=auth_headers(holder["session_token"]),
    )
    assert checked_in.status_code in (200, 201), checked_in.text

    fresh = await _create_practice(
        db_session, teacher["user"]["id"], school=school,
        title="Another School Practice",
    )
    refused = await _book(client, holder, fresh)
    assert refused.status_code == 403
    assert refused.json()["error"] == "not_in_audience"


@pytest.mark.asyncio
async def test_waitlist_confirm_refuses_someone_who_left_while_queued(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The fifth gate, reachable only through the fourth.

    Join the queue while inside the school, leave, then try to convert the
    hold into a booking -- confirm_waitlist exists precisely to close this
    door, and the new branch has to reach it like the other three.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER, first_name="Teacher",
    )
    taker = await login_user(client, telegram_id=_TID_STUDENT_A)
    queued_user = await login_user(client, telegram_id=_TID_STUDENT_B)
    school = await _school(db_session, curator["user"]["id"])
    await _join_school(
        db_session, school.id, teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    await _join_school(
        db_session, school.id, taker["user"]["id"],
        CuratorMemberKind.STUDENT,
    )
    membership = await _join_school(
        db_session, school.id, queued_user["user"]["id"],
        CuratorMemberKind.STUDENT,
    )
    practice = await _create_practice(
        db_session, teacher["user"]["id"], school=school,
        max_participants=1,
    )

    filled = await _book(client, taker, practice)
    assert filled.status_code == 201, filled.text

    joined = await client.post(
        WAITLIST_JOIN_URL.format(practice_id=practice.id),
        headers=auth_headers(queued_user["session_token"]),
    )
    assert joined.status_code == 201, joined.text
    entry_id = joined.json()["id"]

    # confirm_waitlist refuses anything but a NOTIFIED entry, and it does so
    # BEFORE the audience gate -- so a WAITING entry never reaches the
    # branch under test and answers 400 instead. The notification normally
    # arrives from process_waitlist when a spot frees up; here the entry is
    # promoted directly, because what is being tested is the gate after it,
    # not the promotion. expires_at is set in the future so the lazy-expiry
    # step (which runs before the gate too) leaves it alone.
    entry = await db_session.get(Waitlist, UUID(entry_id))
    entry.status = WaitlistStatus.NOTIFIED.value
    entry.notified_at = datetime.now(UTC)
    entry.expires_at = datetime.now(UTC) + timedelta(minutes=30)
    await db_session.flush()
    await db_session.commit()

    await db_session.delete(
        await db_session.get(CuratorGroupMember, membership.id)
    )
    await db_session.commit()

    confirmed = await client.post(
        f"/api/v1/waitlist/{entry_id}/confirm",
        headers=auth_headers(queued_user["session_token"]),
    )
    assert confirmed.status_code == 403, confirmed.text
    assert confirmed.json()["error"] == "not_in_audience"


# ===========================================================================
# One school per practice (BE-74): the second is refused
# ===========================================================================


@pytest.mark.asyncio
async def test_a_second_school_is_refused_and_a_viewer_in_both_sees_it_once(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """One practice, ONE school: two are refused at the door, and a viewer
    who is in the owning school and in another sees the practice once.

    Before BE-74 this test guarded the EXISTS shape against two matching
    target rows duplicating the practice in the feed -- right while a
    practice could target several schools. The owner ruling of 2026-10-01
    (a practice belongs to exactly one school, a scalar column) made the
    two-row practice impossible to build. The precise statement now: the
    two-school create is a 422, and the one-school practice is in the feed
    of a viewer of both schools exactly once -- counted, so absence fails.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER, first_name="Teacher",
    )
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    first = await _school(db_session, curator["user"]["id"], name="Первая")
    second = await _school(db_session, curator["user"]["id"], name="Вторая")
    for school in (first, second):
        await _join_school(
            db_session, school.id, teacher["user"]["id"],
            CuratorMemberKind.MASTER,
        )
        await _join_school(
            db_session, school.id, student["user"]["id"],
            CuratorMemberKind.STUDENT,
        )

    refused = await client.post(
        PRACTICES_URL,
        json=_practice_body(
            audience_kind="curator_groups",
            curator_group_id=[str(first.id), str(second.id)],
        ),
        headers=auth_headers(teacher["session_token"]),
    )
    assert refused.status_code == 422, refused.text

    practice = await _create_practice(
        db_session, teacher["user"]["id"], school=first,
    )

    titles = await _feed_titles(client, student)
    assert titles.count(practice.title) == 1


@pytest.mark.asyncio
async def test_membership_in_another_school_is_not_enough(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The audience is the OWNING school's students -- not any school's.

    Before BE-74 this test asserted that membership in one of two target
    schools was enough (multiplicity meant OR) -- right while a practice
    could target several. The owner ruling of 2026-10-01 (exactly one
    school) made that practice impossible to build. The precise statement
    now: a student of the curator's OTHER school, where the teacher also
    teaches, is refused at every gate; the same student joining the owning
    school sees and books -- the pair that keeps the refusal honest.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER, first_name="Teacher",
    )
    inside = await login_user(client, telegram_id=_TID_STUDENT_A)
    first = await _school(db_session, curator["user"]["id"], name="Первая")
    second = await _school(db_session, curator["user"]["id"], name="Вторая")
    for school in (first, second):
        await _join_school(
            db_session, school.id, teacher["user"]["id"],
            CuratorMemberKind.MASTER,
        )
    await _join_school(
        db_session, second.id, inside["user"]["id"],
        CuratorMemberKind.STUDENT,
    )
    practice = await _create_practice(
        db_session, teacher["user"]["id"], school=first,
    )

    await _assert_all_gates_refuse(client, inside, practice)

    await _join_school(
        db_session, first.id, inside["user"]["id"], CuratorMemberKind.STUDENT,
    )
    await _assert_can_see_and_book(client, inside, practice)


# ===========================================================================
# Create / PATCH validation
# ===========================================================================


@pytest.mark.asyncio
async def test_creating_a_school_practice_through_the_api(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The happy path end to end, and the column it writes (BE-74)."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _school(db_session, curator["user"]["id"])

    resp = await client.post(
        PRACTICES_URL,
        json=_practice_body(
            title="Утро в школе",
            audience_kind="curator_groups",
            curator_group_id=str(school.id),
        ),
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["audience_kind"] == "curator_groups"
    assert resp.json()["curator_group_id"] == str(school.id)

    owner = (
        await fresh_execute(
            select(Practice.curator_group_id).where(
                Practice.id == UUID(resp.json()["id"])
            )
        )
    ).scalar_one()
    assert owner == school.id


@pytest.mark.asyncio
async def test_a_missing_null_or_list_school_is_rejected(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """422 at the schema, before anything is written -- and the pair is the
    same request with one school succeeding.

    BE-74: the school is a scalar curator_group_id. Absent and null mean
    "the school's students of no school" (check_school_audience); an empty
    list -- the old way to say "no schools" -- is now refused by type.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _school(db_session, curator["user"]["id"])
    headers = auth_headers(curator["session_token"])

    for payload in (
        _practice_body(audience_kind="curator_groups"),
        _practice_body(audience_kind="curator_groups", curator_group_id=None),
        _practice_body(audience_kind="curator_groups", curator_group_id=[]),
    ):
        resp = await client.post(PRACTICES_URL, json=payload, headers=headers)
        assert resp.status_code == 422, resp.text

    ok = await client.post(
        PRACTICES_URL,
        json=_practice_body(
            audience_kind="curator_groups",
            curator_group_id=str(school.id),
        ),
        headers=headers,
    )
    assert ok.status_code == 201, ok.text


@pytest.mark.asyncio
async def test_a_school_with_the_masters_own_audiences_is_rejected(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A school practice is for everyone or for the school's students.

    Before BE-74 'public' was refused here too -- right while the school
    was an audience and nothing else. BE-74 made the school the practice's
    OWNER, and a school practice may be public (owner ruling: the school
    promotes it). The precise statement now: 'students' and 'groups' with a
    school are a 422, and 'public' with a school is created and keeps the
    school -- the pair, so the refusals are not every school body failing.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _school(db_session, curator["user"]["id"])
    headers = auth_headers(curator["session_token"])

    for kind, extra in (("students", {}), ("groups", {"group_ids": [str(uuid4())]})):
        resp = await client.post(
            PRACTICES_URL,
            json=_practice_body(
                audience_kind=kind, curator_group_id=str(school.id), **extra,
            ),
            headers=headers,
        )
        assert resp.status_code == 422, kind

    ok = await client.post(
        PRACTICES_URL,
        json=_practice_body(
            audience_kind="public", curator_group_id=str(school.id),
        ),
        headers=headers,
    )
    assert ok.status_code == 201, ok.text
    assert ok.json()["audience_kind"] == "public"
    assert ok.json()["curator_group_id"] == str(school.id)


@pytest.mark.asyncio
async def test_group_ids_and_a_school_together_are_rejected(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Two target sets at once is not a narrower audience, it is an
    ambiguous one. BE-74: the school is the scalar curator_group_id."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _school(db_session, curator["user"]["id"])

    resp = await client.post(
        PRACTICES_URL,
        json=_practice_body(
            audience_kind="curator_groups",
            group_ids=[str(uuid4())],
            curator_group_id=str(school.id),
        ),
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 422, resp.text


@pytest.mark.asyncio
async def test_a_school_the_master_does_not_belong_to_is_rejected(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """400, one message, three causes: somebody else's school, an unknown
    id, and a frozen one. The master is choosing among their own resources,
    so P-08 does not apply -- but they still learn nothing about which of
    the three it was.

    The pair: a school this master DOES belong to is accepted.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    outsider = await _make_verified_master(
        client, db_session, _TID_MASTER, first_name="Outsider",
    )
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    theirs = await _school(db_session, curator["user"]["id"], name="Чужая")
    frozen_curator = await _make_verified_master(
        client, db_session, _TID_MASTER_B, first_name="Frozen",
    )
    frozen = await _school(
        db_session, frozen_curator["user"]["id"], name="Замороженная",
    )
    await _join_school(
        db_session, frozen.id, outsider["user"]["id"],
        CuratorMemberKind.MASTER,
    )
    await _revoke(client, admin_token, frozen_curator["user"]["id"])

    headers = auth_headers(outsider["session_token"])

    for school_id in (str(theirs.id), str(uuid4()), str(frozen.id)):
        resp = await client.post(
            PRACTICES_URL,
            json=_practice_body(
                audience_kind="curator_groups", curator_group_id=school_id,
            ),
            headers=headers,
        )
        assert resp.status_code == 400, school_id

    own = await _school(db_session, outsider["user"]["id"], name="Своя")
    ok = await client.post(
        PRACTICES_URL,
        json=_practice_body(
            audience_kind="curator_groups", curator_group_id=str(own.id),
        ),
        headers=headers,
    )
    assert ok.status_code == 201, ok.text


@pytest.mark.asyncio
async def test_patch_cannot_move_a_practice_to_another_school(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The school is set at creation and never moves (BE-74, owner Q1).

    Before BE-74 this test asserted that a PATCH replaced the whole set of
    target schools -- right while the schools were an editable audience.
    The owner ruling made the school the practice's owner: another id or
    null is a 400 practice_school_immutable, the stored id is a no-op. THE
    PAIR: after both refusals the column still names the first school, and
    the no-op answers 200 -- so the refusals are not a broken PATCH.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    first = await _school(db_session, curator["user"]["id"], name="Первая")
    second = await _school(db_session, curator["user"]["id"], name="Вторая")
    practice = await _create_practice(
        db_session, curator["user"]["id"], school=first,
        status=PracticeStatus.DRAFT.value,
    )
    url = f"{PRACTICES_URL}/{practice.id}"
    headers = auth_headers(curator["session_token"])

    for value in (str(second.id), None):
        resp = await client.patch(
            url, json={"curator_group_id": value}, headers=headers,
        )
        assert resp.status_code == 400, (value, resp.text)
        assert resp.json()["error"] == "practice_school_immutable", value

    same = await client.patch(
        url, json={"curator_group_id": str(first.id)}, headers=headers,
    )
    assert same.status_code == 200, same.text

    owner = (
        await fresh_execute(
            select(Practice.curator_group_id).where(Practice.id == practice.id)
        )
    ).scalar_one()
    assert owner == first.id


# ===========================================================================
# Audience changes and the school (BE-74: the school never moves)
# ===========================================================================


@pytest.mark.asyncio
async def test_switching_the_audience_keeps_the_school(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A school practice moves between 'curator_groups' and 'public' and
    stays the school's; the master's own audiences are refused.

    Before BE-74 this was the owner's "no litter" double: switching away
    from schools had to delete the target rows so they could not return --
    right while the schools were an audience beside the practice. BE-74
    made the school the practice's owner (Q1: never moves), so there is no
    row to litter: the precise statement now is that the school SURVIVES
    every audience change. 'students' and 'groups' are refused with a 400
    (check_school_audience against the stored school), and the practice
    comes back to 'curator_groups' with the same school.
    """
    from app.modules.masters.groups_models import MasterGroup

    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _school(db_session, curator["user"]["id"])
    custom = MasterGroup(master_id=UUID(curator["user"]["id"]), name="VIP")
    db_session.add(custom)
    await db_session.flush()
    await db_session.commit()
    practice = await _create_practice(
        db_session, curator["user"]["id"], school=school,
        status=PracticeStatus.DRAFT.value,
    )
    url = f"{PRACTICES_URL}/{practice.id}"
    headers = auth_headers(curator["session_token"])

    async def _stored() -> tuple[str, UUID | None]:
        row = (
            await fresh_execute(select(Practice).where(Practice.id == practice.id))
        ).scalar_one()
        return row.audience_kind, row.curator_group_id

    public = await client.patch(
        url, json={"audience_kind": "public"}, headers=headers,
    )
    assert public.status_code == 200, public.text
    assert await _stored() == (AudienceKind.PUBLIC.value, school.id)

    for body in (
        {"audience_kind": "students"},
        {"audience_kind": "groups", "group_ids": [str(custom.id)]},
    ):
        refused = await client.patch(url, json=body, headers=headers)
        assert refused.status_code == 400, (body, refused.text)
        assert await _stored() == (AudienceKind.PUBLIC.value, school.id)

    back = await client.patch(
        url, json={"audience_kind": "curator_groups"}, headers=headers,
    )
    assert back.status_code == 200, back.text
    assert await _stored() == (AudienceKind.CURATOR_GROUPS.value, school.id)


@pytest.mark.asyncio
async def test_a_practice_without_a_school_cannot_be_moved_into_one(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A practice of the general section stays out of every school.

    Before BE-74 this test switched a 'groups' practice to schools and
    asserted the old group rows were cleared -- right while a school was an
    audience any practice could be pointed at. BE-74 (owner Q1): the school
    is set at creation only, so the switch itself is refused -- 400
    practice_school_immutable -- and the refusal changes nothing. THE PAIR:
    the custom-group row is still there, the audience is still 'groups',
    and the practice still has no school.
    """
    from app.modules.masters.groups_models import (
        MasterGroup,
        MasterGroupMembership,
    )
    from app.modules.practices.models import PracticeAudienceGroup

    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    custom = MasterGroup(
        master_id=UUID(curator["user"]["id"]), name="VIP",
    )
    db_session.add(custom)
    await db_session.flush()
    db_session.add(
        MasterGroupMembership(
            group_id=custom.id, student_user_id=UUID(student["user"]["id"]),
        )
    )
    await db_session.flush()
    await db_session.commit()

    school = await _school(db_session, curator["user"]["id"])
    practice = await _create_practice(
        db_session, curator["user"]["id"],
        audience_kind=AudienceKind.GROUPS.value,
        status=PracticeStatus.DRAFT.value,
    )
    db_session.add(
        PracticeAudienceGroup(practice_id=practice.id, group_id=custom.id)
    )
    await db_session.flush()
    await db_session.commit()

    resp = await client.patch(
        f"{PRACTICES_URL}/{practice.id}",
        json={
            "audience_kind": "curator_groups",
            "curator_group_id": str(school.id),
        },
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"] == "practice_school_immutable"

    old_rows = (
        await fresh_execute(
            select(PracticeAudienceGroup.group_id).where(
                PracticeAudienceGroup.practice_id == practice.id
            )
        )
    ).scalars().all()
    assert old_rows == [custom.id]
    row = (
        await fresh_execute(select(Practice).where(Practice.id == practice.id))
    ).scalar_one()
    assert row.audience_kind == AudienceKind.GROUPS.value
    assert row.curator_group_id is None


# ===========================================================================
# Series
# ===========================================================================


@pytest.mark.asyncio
async def test_a_series_child_is_no_wider_than_its_root(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """C1 under BE-74: every generated child carries the root's school.

    Before BE-74 this test built a child with the school audience and no
    target rows -- reachable then, the C1 hole -- and asserted that
    propagation copied the rows. BE-74 made the school a column the child
    inherits at generation (_build_child_occurrence), and the CHECK forbids
    'curator_groups' without a school, so the hand-built child is a state
    that no longer exists. The reachable form drives the real generator: a
    school series is created and published through the API, and EVERY
    child names the root's school and audience. THE PAIR: a child is in a
    school student's feed -- so the column is not merely copied but read.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER, first_name="Teacher",
    )
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    school = await _school(db_session, curator["user"]["id"])
    await _join_school(
        db_session, school.id, teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    await _join_school(
        db_session, school.id, student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )
    headers = auth_headers(teacher["session_token"])

    created = await client.post(
        PRACTICES_URL,
        json=_practice_body(
            practice_type="series",
            title="Серия для школы",
            audience_kind="curator_groups",
            curator_group_id=str(school.id),
            recurrence={"period": "daily", "end": "after_count", "count": 3},
        ),
        headers=headers,
    )
    assert created.status_code == 201, created.text
    root_id = UUID(created.json()["id"])
    published = await client.patch(
        f"{PRACTICES_URL}/{root_id}", json={"status": "scheduled"},
        headers=headers,
    )
    assert published.status_code == 200, published.text

    children = (
        await fresh_execute(
            select(Practice).where(Practice.parent_practice_id == root_id)
        )
    ).scalars().all()
    assert len(children) == 2
    assert {(c.curator_group_id, c.audience_kind) for c in children} == {
        (school.id, AudienceKind.CURATOR_GROUPS.value),
    }
    titles = await _feed_titles(client, student)
    assert titles.count("Серия для школы") == 3


@pytest.mark.asyncio
async def test_propagation_moves_the_childrens_audience_and_keeps_their_school(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A root switched off 'curator_groups' takes its children with it --
    and neither the root nor a child loses its school.

    Before BE-74 this test pinned the unconditional delete of the
    children's school rows in the propagate path -- right while the school
    was an audience beside each practice. BE-74 made the school each
    practice's owner, set at creation and never moved (owner Q1), and the
    propagate path copies audience_kind only. The precise statement now:
    after propagation the child is public AND still names the school -- the
    pair, so "the child moved" is not "the child was emptied".

    Until BE-103 W4 the propagation was called alone here, and read the
    children itself -- right for that code. W4 made it write the set its
    caller locked (_lock_practice_and_children), so the test locks first,
    as update_practice does. The child is already in this session's
    identity map: the lock must refresh it (populate_existing, BE-85), and
    the asserted set is exactly that child.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _school(db_session, curator["user"]["id"])
    root = await _create_practice(
        db_session, curator["user"]["id"], school=school,
        status=PracticeStatus.DRAFT.value, title="Корень",
    )
    child = await _create_practice(
        db_session, curator["user"]["id"], school=school,
        status=PracticeStatus.SCHEDULED.value, hours_from_now=72,
        title="Ребёнок",
    )
    child.parent_practice_id = root.id
    await db_session.flush()

    fresh_root = await db_session.get(Practice, root.id)
    fresh_root.audience_kind = AudienceKind.PUBLIC.value
    await db_session.flush()

    from app.modules.practices.series_service import (
        propagate_audience_to_children,
    )
    from app.modules.practices.service import _lock_practice_and_children

    # Through the lock, as update_practice calls it (BE-103 W4: the
    # propagation writes the set its caller holds). The child is already
    # in this session's identity map -- the lock refreshes it
    # (populate_existing, BE-85) and the root keeps its flushed kind.
    locked_root, children = await _lock_practice_and_children(
        root.id, True, db_session,
    )
    assert locked_root is fresh_root
    assert [c.id for c in children] == [child.id]
    await propagate_audience_to_children(locked_root, children, db_session)
    await db_session.commit()

    row = (
        await fresh_execute(select(Practice).where(Practice.id == child.id))
    ).scalar_one()
    assert row.audience_kind == AudienceKind.PUBLIC.value
    assert row.curator_group_id == school.id


# ===========================================================================
# audience-preview
# ===========================================================================


@pytest.mark.asyncio
async def test_the_preview_counts_exactly_the_bookers_outside_the_school(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Counted by hand against mixed data: of three active bookers, one is
    a student of the school, one is its curator, and one is outside.

    The curator is the interesting one -- they hold no membership row (I-2),
    so a literal mirror of the groups query would report the school's own
    owner as stranded by their own school.

    BE-74: the preview names no school -- 'curator_groups' means the
    practice's OWN school, read off the practice. So the practice here is a
    public practice of the school, and the preview asks what narrowing it
    to the school's students would strand.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER, first_name="Teacher",
    )
    inside = await login_user(client, telegram_id=_TID_STUDENT_A)
    outside = await login_user(client, telegram_id=_TID_STUDENT_B)
    school = await _school(db_session, curator["user"]["id"])
    await _join_school(
        db_session, school.id, teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    await _join_school(
        db_session, school.id, inside["user"]["id"],
        CuratorMemberKind.STUDENT,
    )
    practice = await _create_practice(
        db_session, teacher["user"]["id"], school=school,
        audience_kind=AudienceKind.PUBLIC.value,
    )
    for who in (inside, outside, curator):
        db_session.add(
            Booking(
                practice_id=practice.id,
                user_id=UUID(who["user"]["id"]),
                status=BookingStatus.CONFIRMED.value,
            )
        )
    await db_session.flush()
    await db_session.commit()

    resp = await client.post(
        PREVIEW_URL.format(practice_id=practice.id),
        json={"audience_kind": "curator_groups"},
        headers=auth_headers(teacher["session_token"]),
    )
    assert resp.status_code == 200, resp.text
    # inside: in the school. curator: owns it. outside: neither.
    assert resp.json()["stranded_count"] == 1


@pytest.mark.asyncio
async def test_the_preview_reports_zero_when_nothing_narrows(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The pair for the count above: same practice, same bookers, an
    audience that excludes nobody."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    school = await _school(db_session, curator["user"]["id"])
    await _join_school(
        db_session, school.id, student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )
    practice = await _create_practice(
        db_session, curator["user"]["id"], school=school,
        audience_kind=AudienceKind.PUBLIC.value,
    )
    db_session.add(
        Booking(
            practice_id=practice.id,
            user_id=UUID(student["user"]["id"]),
            status=BookingStatus.CONFIRMED.value,
        )
    )
    await db_session.flush()
    await db_session.commit()

    resp = await client.post(
        PREVIEW_URL.format(practice_id=practice.id),
        json={"audience_kind": "curator_groups"},
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["stranded_count"] == 0


@pytest.mark.asyncio
async def test_the_preview_refuses_the_school_audience_without_a_school(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A practice of the general section has no school to narrow to.

    Before BE-74 this test refused a preview naming somebody else's school
    -- the anti-probing reflex of the PATCH, right while the preview took a
    list of schools. BE-74 took the school out of the preview: it reads the
    practice's own, which a master cannot choose. The reachable refusal is
    a practice with no school asked about 'curator_groups' (400, the same
    check_school_audience the PATCH uses). THE PAIR: the same practice and
    the same master previewing 'students' get an answer.
    """
    outsider = await _make_verified_master(
        client, db_session, _TID_MASTER, first_name="Outsider",
    )
    practice = await _create_practice(
        db_session, outsider["user"]["id"],
        audience_kind=AudienceKind.PUBLIC.value,
    )
    headers = auth_headers(outsider["session_token"])

    resp = await client.post(
        PREVIEW_URL.format(practice_id=practice.id),
        json={"audience_kind": "curator_groups"},
        headers=headers,
    )
    assert resp.status_code == 400, resp.text

    ok = await client.post(
        PREVIEW_URL.format(practice_id=practice.id),
        json={"audience_kind": "students"},
        headers=headers,
    )
    assert ok.status_code == 200, ok.text
