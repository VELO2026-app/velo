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
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
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
    PracticeAudienceCuratorGroup,
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
    schools: list | None = None,
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
        db_session, teacher["user"]["id"], schools=[school],
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
        db_session, teacher["user"]["id"], schools=[school],
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
        db_session, curator["user"]["id"], schools=[school],
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
        db_session, teacher["user"]["id"], schools=[school],
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
        db_session, teacher["user"]["id"], schools=[school],
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
        db_session, teacher["user"]["id"], schools=[school],
    )
    await _assert_can_see_and_book(client, student, practice)

    await _revoke(client, admin_token, curator["user"]["id"])
    await _assert_all_gates_refuse(client, other, practice)

    await _re_verify(client, admin_token, curator["user"]["id"])
    await _assert_can_see_and_book(client, other, practice)


@pytest.mark.asyncio
async def test_deleting_the_target_school_takes_the_practice_dark(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """CASCADE checked on LIVE DATA, not read off the DDL (the GT-4 lesson).

    The rows go with the school, the predicate finds no targets, and the
    practice is fail-closed rather than fail-open -- which is the whole
    point of not defaulting an empty target set to "everyone".
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
        db_session, teacher["user"]["id"], schools=[school],
    )
    await _assert_can_see_and_book(client, student, practice)

    await db_session.delete(await db_session.get(CuratorGroup, school.id))
    await db_session.commit()

    rows = (
        await fresh_execute(
            select(PracticeAudienceCuratorGroup.id).where(
                PracticeAudienceCuratorGroup.practice_id == practice.id
            )
        )
    ).scalars().all()
    assert rows == []
    await _assert_all_gates_refuse(client, other, practice)


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
        db_session, teacher["user"]["id"], schools=[school],
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
        db_session, teacher["user"]["id"], schools=[school],
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
        db_session, teacher["user"]["id"], schools=[school],
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
        db_session, teacher["user"]["id"], schools=[school],
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
# Two schools, and the EXISTS shape
# ===========================================================================


@pytest.mark.asyncio
async def test_a_viewer_in_both_target_schools_appears_once_in_the_feed(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """EXISTS, not a join: two matching target rows must not duplicate the
    practice in the feed. A join would show it twice and nobody would
    notice until a school had two of the same people."""
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
    practice = await _create_practice(
        db_session, teacher["user"]["id"], schools=[first, second],
    )

    titles = await _feed_titles(client, student)
    assert titles.count(practice.title) == 1


@pytest.mark.asyncio
async def test_membership_in_one_of_two_target_schools_is_enough(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Multiplicity means OR, mirroring group_ids: in one school is in."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER, first_name="Teacher",
    )
    inside = await login_user(client, telegram_id=_TID_STUDENT_A)
    outside = await login_user(client, telegram_id=_TID_STUDENT_B)
    first = await _school(db_session, curator["user"]["id"], name="Первая")
    second = await _school(db_session, curator["user"]["id"], name="Вторая")
    await _join_school(
        db_session, first.id, teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    await _join_school(
        db_session, second.id, inside["user"]["id"],
        CuratorMemberKind.STUDENT,
    )
    # The teacher belongs only to the FIRST school, so the second target
    # cannot admit anyone -- the master clause is per-school, not global.
    practice = await _create_practice(
        db_session, teacher["user"]["id"], schools=[first, second],
    )

    await _assert_all_gates_refuse(client, inside, practice)
    await _assert_all_gates_refuse(client, outside, practice)

    await _join_school(
        db_session, second.id, teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    await _assert_can_see_and_book(client, inside, practice)


@pytest.mark.asyncio
async def test_the_same_school_cannot_be_targeted_twice(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """UNIQUE (practice_id, group_id) on live data."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _school(db_session, curator["user"]["id"])
    practice = await _create_practice(
        db_session, curator["user"]["id"], schools=[school],
    )

    db_session.add(
        PracticeAudienceCuratorGroup(
            practice_id=practice.id, group_id=school.id,
        )
    )
    with pytest.raises(IntegrityError):
        await db_session.flush()
    await db_session.rollback()


# ===========================================================================
# Create / PATCH validation
# ===========================================================================


@pytest.mark.asyncio
async def test_creating_a_school_practice_through_the_api(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The happy path end to end, and the rows it writes."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _school(db_session, curator["user"]["id"])

    resp = await client.post(
        PRACTICES_URL,
        json=_practice_body(
            title="Утро в школе",
            audience_kind="curator_groups",
            curator_group_ids=[str(school.id)],
        ),
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["audience_kind"] == "curator_groups"

    rows = (
        await fresh_execute(
            select(PracticeAudienceCuratorGroup.group_id).where(
                PracticeAudienceCuratorGroup.practice_id
                == UUID(resp.json()["id"])
            )
        )
    ).scalars().all()
    assert rows == [school.id]


@pytest.mark.asyncio
async def test_an_empty_or_absent_school_list_is_rejected(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """422 at the schema, before anything is written -- and the pair is the
    same request with one school succeeding."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _school(db_session, curator["user"]["id"])
    headers = auth_headers(curator["session_token"])

    for payload in (
        _practice_body(audience_kind="curator_groups"),
        _practice_body(audience_kind="curator_groups", curator_group_ids=[]),
    ):
        resp = await client.post(PRACTICES_URL, json=payload, headers=headers)
        assert resp.status_code == 422, resp.text

    ok = await client.post(
        PRACTICES_URL,
        json=_practice_body(
            audience_kind="curator_groups",
            curator_group_ids=[str(school.id)],
        ),
        headers=headers,
    )
    assert ok.status_code == 201, ok.text


@pytest.mark.asyncio
async def test_schools_sent_with_another_audience_kind_are_rejected(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _school(db_session, curator["user"]["id"])
    headers = auth_headers(curator["session_token"])

    for kind in ("public", "students", "groups"):
        resp = await client.post(
            PRACTICES_URL,
            json=_practice_body(
                audience_kind=kind, curator_group_ids=[str(school.id)],
            ),
            headers=headers,
        )
        assert resp.status_code == 422, kind


@pytest.mark.asyncio
async def test_group_ids_and_curator_group_ids_together_are_rejected(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The rule the previous validator had no case for: two target sets at
    once is not a narrower audience, it is an ambiguous one."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _school(db_session, curator["user"]["id"])

    resp = await client.post(
        PRACTICES_URL,
        json=_practice_body(
            audience_kind="curator_groups",
            group_ids=[str(uuid4())],
            curator_group_ids=[str(school.id)],
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

    for ids in ([str(theirs.id)], [str(uuid4())], [str(frozen.id)]):
        resp = await client.post(
            PRACTICES_URL,
            json=_practice_body(
                audience_kind="curator_groups", curator_group_ids=ids,
            ),
            headers=headers,
        )
        assert resp.status_code == 400, ids

    own = await _school(db_session, outsider["user"]["id"], name="Своя")
    ok = await client.post(
        PRACTICES_URL,
        json=_practice_body(
            audience_kind="curator_groups", curator_group_ids=[str(own.id)],
        ),
        headers=headers,
    )
    assert ok.status_code == 201, ok.text


@pytest.mark.asyncio
async def test_patch_replaces_the_whole_school_set(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """delete-then-insert: the set sent REPLACES, it does not merge."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    first = await _school(db_session, curator["user"]["id"], name="Первая")
    second = await _school(db_session, curator["user"]["id"], name="Вторая")
    practice = await _create_practice(
        db_session, curator["user"]["id"], schools=[first, second],
        status=PracticeStatus.DRAFT.value,
    )

    resp = await client.patch(
        f"{PRACTICES_URL}/{practice.id}",
        json={"curator_group_ids": [str(second.id)]},
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 200, resp.text

    rows = (
        await fresh_execute(
            select(PracticeAudienceCuratorGroup.group_id).where(
                PracticeAudienceCuratorGroup.practice_id == practice.id
            )
        )
    ).scalars().all()
    assert rows == [second.id]


# ===========================================================================
# The symmetry ruled by the owner: no litter in either direction
# ===========================================================================


@pytest.mark.asyncio
async def test_switching_away_from_schools_clears_the_rows_and_they_do_not_return(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The owner's obligatory double, forward direction.

    Target two schools -> PATCH audience_kind=public alone (no ids sent) ->
    the rows must be GONE, not merely ignored -> switch back naming only
    school A -> only A is targeted. If the clear branch were missing, B
    would resurrect an audience the master had abandoned.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    first = await _school(db_session, curator["user"]["id"], name="Первая")
    second = await _school(db_session, curator["user"]["id"], name="Вторая")
    practice = await _create_practice(
        db_session, curator["user"]["id"], schools=[first, second],
        status=PracticeStatus.DRAFT.value,
    )
    headers = auth_headers(curator["session_token"])

    gone = await client.patch(
        f"{PRACTICES_URL}/{practice.id}",
        json={"audience_kind": "public"},
        headers=headers,
    )
    assert gone.status_code == 200, gone.text
    rows = (
        await fresh_execute(
            select(PracticeAudienceCuratorGroup.id).where(
                PracticeAudienceCuratorGroup.practice_id == practice.id
            )
        )
    ).scalars().all()
    assert rows == []

    back = await client.patch(
        f"{PRACTICES_URL}/{practice.id}",
        json={
            "audience_kind": "curator_groups",
            "curator_group_ids": [str(first.id)],
        },
        headers=headers,
    )
    assert back.status_code == 200, back.text
    rows = (
        await fresh_execute(
            select(PracticeAudienceCuratorGroup.group_id).where(
                PracticeAudienceCuratorGroup.practice_id == practice.id
            )
        )
    ).scalars().all()
    assert rows == [first.id]


@pytest.mark.asyncio
async def test_switching_from_groups_to_schools_clears_the_old_group_rows(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The mirror direction, which is the half that already existed.

    'Away from groups' has always meant "to anything else"; this test says
    that 'curator_groups' is inside "anything else" and the pre-existing
    branch fires for it -- the claim I would otherwise be making by reading.
    """
    from app.modules.masters.groups_models import (
        MasterGroup,
        MasterGroupMembership,
    )

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
        db_session, curator["user"]["id"], schools=[],
        audience_kind=AudienceKind.GROUPS.value,
        status=PracticeStatus.DRAFT.value,
    )
    from app.modules.practices.models import PracticeAudienceGroup

    db_session.add(
        PracticeAudienceGroup(practice_id=practice.id, group_id=custom.id)
    )
    await db_session.flush()
    await db_session.commit()

    resp = await client.patch(
        f"{PRACTICES_URL}/{practice.id}",
        json={
            "audience_kind": "curator_groups",
            "curator_group_ids": [str(school.id)],
        },
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 200, resp.text

    old_rows = (
        await fresh_execute(
            select(PracticeAudienceGroup.id).where(
                PracticeAudienceGroup.practice_id == practice.id
            )
        )
    ).scalars().all()
    assert old_rows == []
    new_rows = (
        await fresh_execute(
            select(PracticeAudienceCuratorGroup.group_id).where(
                PracticeAudienceCuratorGroup.practice_id == practice.id
            )
        )
    ).scalars().all()
    assert new_rows == [school.id]


# ===========================================================================
# Series
# ===========================================================================


@pytest.mark.asyncio
async def test_a_series_child_is_no_wider_than_its_root(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """C1 on the new table -- THE test that fails without the series patch.

    A child generated without its own target-school rows matches no branch
    of the audience clause and is invisible to the school, while its parent
    is visible: the two rows of the same series disagree. Written to be run
    against the pre-patch tree first; see the delivery report.
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

    root = await _create_practice(
        db_session, teacher["user"]["id"], schools=[school],
        status=PracticeStatus.DRAFT.value, title="Серия для школы",
    )
    child = await _create_practice(
        db_session, teacher["user"]["id"], schools=[],
        status=PracticeStatus.SCHEDULED.value, hours_from_now=72,
        title="Занятие серии",
    )
    child.parent_practice_id = root.id
    child.audience_kind = AudienceKind.CURATOR_GROUPS.value
    await db_session.flush()
    await db_session.commit()

    # Before propagation the child carries no target rows: invisible to the
    # school, which is the fail-closed side of the C1 hole.
    assert child.title not in await _feed_titles(client, student)

    from app.modules.practices.series_service import (
        propagate_audience_to_children,
    )

    fresh_root = await db_session.get(Practice, root.id)
    await propagate_audience_to_children(fresh_root, db_session)
    await db_session.commit()

    copied = (
        await fresh_execute(
            select(PracticeAudienceCuratorGroup.group_id).where(
                PracticeAudienceCuratorGroup.practice_id == child.id
            )
        )
    ).scalars().all()
    assert copied == [school.id]
    assert child.title in await _feed_titles(client, student)


@pytest.mark.asyncio
async def test_propagation_clears_child_school_rows_when_the_root_moves_away(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The unconditional delete in the propagate path.

    A root switched off 'curator_groups' must not leave its children
    carrying school rows -- the same litter problem the single-practice path
    solves, one level down.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _school(db_session, curator["user"]["id"])
    root = await _create_practice(
        db_session, curator["user"]["id"], schools=[school],
        status=PracticeStatus.DRAFT.value, title="Корень",
    )
    child = await _create_practice(
        db_session, curator["user"]["id"], schools=[school],
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

    await propagate_audience_to_children(fresh_root, db_session)
    await db_session.commit()

    rows = (
        await fresh_execute(
            select(PracticeAudienceCuratorGroup.id).where(
                PracticeAudienceCuratorGroup.practice_id == child.id
            )
        )
    ).scalars().all()
    assert rows == []


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
        db_session, teacher["user"]["id"], schools=[],
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
        json={
            "audience_kind": "curator_groups",
            "curator_group_ids": [str(school.id)],
        },
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
        db_session, curator["user"]["id"], schools=[],
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
        json={
            "audience_kind": "curator_groups",
            "curator_group_ids": [str(school.id)],
        },
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["stranded_count"] == 0


@pytest.mark.asyncio
async def test_the_preview_refuses_a_school_the_master_does_not_belong_to(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Same anti-probing reflex the real PATCH has: without it a master
    could read another school's membership off the stranded count."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    outsider = await _make_verified_master(
        client, db_session, _TID_MASTER, first_name="Outsider",
    )
    theirs = await _school(db_session, curator["user"]["id"])
    practice = await _create_practice(
        db_session, outsider["user"]["id"], schools=[],
        audience_kind=AudienceKind.PUBLIC.value,
    )

    resp = await client.post(
        PREVIEW_URL.format(practice_id=practice.id),
        json={
            "audience_kind": "curator_groups",
            "curator_group_ids": [str(theirs.id)],
        },
        headers=auth_headers(outsider["session_token"]),
    )
    assert resp.status_code == 400, resp.text
