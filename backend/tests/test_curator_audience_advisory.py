# =============================================================================
# VELO Backend -- Tests: a dark practice, school names, and the advisory
# previews (P5/GT-12)
# =============================================================================
#
# telegram_id band: 68200-68399 (masters 68201-68205, students 68210-68219,
# stranger 68230, admin 68290). Declared module-level below as
# _TID_MIN/_TID_MAX, ONCE -- tests/telegram_id_bands.py parses that
# declaration out of the AST on every run, and a file that uses ids without
# declaring a band fails test_blind_zone_has_not_grown.
# The neighbour 68000-68199 belongs to test_curator_audience.py (GT-11).
#
# ⚠ BACKEND-ONLY, UNPROVEN LOCALLY -- no Postgres in the authoring
# environment. Written to be read and to run on the server.
#
# FIXTURES OBEY OTHER PEOPLE'S RULES, read from their bodies rather than
# remembered -- the GT-11 lesson, where five of twenty-six tests were built
# wrong and none of the five was about curator groups:
#   * POST /practices REQUIRES direction and difficulty
#     (CreatePracticeRequest) -- _practice_body below carries them;
#   * a target school must be active AND the master must belong to it
#     (_member_curator_group_ids_or_400), or creation is a 400;
#   * "upcoming" is {scheduled, live} + scheduled_at STRICTLY in the future
#     (listing_service.py) -- a draft and a past practice are not upcoming;
#   * the taxonomy gate fails OPEN on an empty profile.methods, which is
#     what _make_verified_master creates.
#
# EVERY "dark" ASSERTION IS PAIRED. audience_unavailable=true is checked
# together with what it claims: the stranger's 404 and the booked viewer's
# surviving access on the SAME practice. A flag asserted alone would pass
# just as well if it were hardcoded.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.bookings.models import Booking, BookingStatus
from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupMember,
    CuratorMemberKind,
)
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

PRACTICES_URL = "/api/v1/practices"
DETAIL_URL = "/api/v1/practices/{practice_id}"
BOOKINGS_URL = "/api/v1/bookings"
CHECKIN_URL = "/api/v1/practices/{practice_id}/checkin"
LEAVE_PREVIEW_URL = "/api/v1/curator-groups/{group_id}/leave-preview"
MEMBERSHIP_URL = "/api/v1/curator-groups/{group_id}/membership"
CURATOR_GROUPS_URL = "/api/v1/masters/me/curator-groups"
REMOVE_PREVIEW_URL = (
    "/api/v1/masters/me/curator-groups/{group_id}"
    "/members/{user_id}/remove-preview"
)
DELETE_PREVIEW_URL = (
    "/api/v1/masters/me/curator-groups/{group_id}/delete-preview"
)
MEMBER_URL = "/api/v1/masters/me/curator-groups/{group_id}/members/{user_id}"
REVOKE_URL = "/api/v1/admin/masters/{user_id}/revoke"

_TID_MIN = 68200
_TID_MAX = 68399

_TID_CURATOR = 68201
_TID_MASTER = 68202
_TID_MASTER_B = 68203
_TID_STUDENT_A = 68210
_TID_STUDENT_B = 68211
_TID_STRANGER = 68230
_TID_ADMIN = 68290


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
    await db_session.execute(
        update(User)
        .where(User.id == UUID(auth["user"]["id"]))
        .values(role=UserRole.ADMIN.value)
    )
    await db_session.commit()
    return auth["session_token"]


def _practice_body(**overrides) -> dict:
    """A body POST /practices actually accepts.

    direction and difficulty are REQUIRED -- taken from
    CreatePracticeRequest, not from memory. Kept in one helper so the next
    required field is added once.
    """
    base: dict = {
        "practice_type": "live",
        "direction": "meditation",
        "difficulty": "beginner",
        "title": "Практика",
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
    schools: list | None = None,
    audience_kind: str = AudienceKind.CURATOR_GROUPS.value,
    status: str = PracticeStatus.SCHEDULED.value,
    hours_from_now: float = 48,
    title: str = "Практика школы",
) -> Practice:
    """Built via ORM, not the API, wherever API validation is not the
    subject -- the audience rows are the point here, and going through
    create_practice would only add its own 400s to the picture."""
    practice = Practice(
        master_id=UUID(master_id),
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


async def _detail(client: AsyncClient, auth: dict, practice: Practice):
    return await client.get(
        DETAIL_URL.format(practice_id=practice.id),
        headers=auth_headers(auth["session_token"]),
    )


async def _revoke(client: AsyncClient, admin_token: str, user_id: str) -> None:
    resp = await client.post(
        REVOKE_URL.format(user_id=user_id), headers=auth_headers(admin_token),
    )
    assert resp.status_code == 200, resp.text


async def _leave_preview(client: AsyncClient, auth: dict, group_id):
    return await client.get(
        LEAVE_PREVIEW_URL.format(group_id=group_id),
        headers=auth_headers(auth["session_token"]),
    )


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
# audience_unavailable
# ===========================================================================


@pytest.mark.asyncio
async def test_a_live_school_practice_is_not_flagged_and_names_its_school(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The baseline every "dark" test below is measured against."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER, first_name="Teacher",
    )
    school = await _school(db_session, curator["user"]["id"], name="Тихое утро")
    await _join_school(
        db_session, school.id, teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    practice = await _create_practice(
        db_session, teacher["user"]["id"], schools=[school],
    )

    body = (await _detail(client, teacher, practice)).json()
    assert body["audience_unavailable"] is False
    assert body["audience_curator_group_names"] == ["Тихое утро"]


@pytest.mark.asyncio
async def test_leaving_the_only_school_darkens_the_practice(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """THE POINT OF THE FLAG, with both halves of what it claims.

    Before: the student sees the practice, the master is not flagged. After
    the master walks out: the flag is true for the master, a stranger gets
    404 on the same practice, and the holder of a CONFIRMED booking still
    reads it (H-R2-8). The flag alone would pass if it were hardcoded; the
    404 and the surviving booking are what make it mean something.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER, first_name="Teacher",
    )
    holder = await login_user(client, telegram_id=_TID_STUDENT_A)
    stranger = await login_user(client, telegram_id=_TID_STRANGER)
    school = await _school(db_session, curator["user"]["id"])
    membership = await _join_school(
        db_session, school.id, teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    await _join_school(
        db_session, school.id, holder["user"]["id"],
        CuratorMemberKind.STUDENT,
    )
    practice = await _create_practice(
        db_session, teacher["user"]["id"], schools=[school],
    )
    booked = await client.post(
        BOOKINGS_URL,
        json={"practice_id": str(practice.id)},
        headers=auth_headers(holder["session_token"]),
    )
    assert booked.status_code == 201, booked.text
    assert (await _detail(client, teacher, practice)).json()[
        "audience_unavailable"
    ] is False

    await db_session.delete(
        await db_session.get(CuratorGroupMember, membership.id)
    )
    await db_session.commit()

    body = (await _detail(client, teacher, practice)).json()
    assert body["audience_unavailable"] is True
    # The names survive: the master must learn WHICH school went dark.
    assert body["audience_curator_group_names"] == ["Тихое утро"]

    assert (await _detail(client, stranger, practice)).status_code == 404
    assert (await _detail(client, holder, practice)).status_code == 200


@pytest.mark.asyncio
async def test_two_schools_and_the_master_leaves_only_one(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """False while ANY target school still works -- and the pair is that it
    flips to true once the second one goes too."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER, first_name="Teacher",
    )
    first = await _school(db_session, curator["user"]["id"], name="Первая")
    second = await _school(db_session, curator["user"]["id"], name="Вторая")
    m1 = await _join_school(
        db_session, first.id, teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    m2 = await _join_school(
        db_session, second.id, teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    practice = await _create_practice(
        db_session, teacher["user"]["id"], schools=[first, second],
    )

    await db_session.delete(await db_session.get(CuratorGroupMember, m1.id))
    await db_session.commit()
    body = (await _detail(client, teacher, practice)).json()
    assert body["audience_unavailable"] is False
    assert body["audience_curator_group_names"] == ["Вторая", "Первая"]

    await db_session.delete(await db_session.get(CuratorGroupMember, m2.id))
    await db_session.commit()
    assert (await _detail(client, teacher, practice)).json()[
        "audience_unavailable"
    ] is True


@pytest.mark.asyncio
async def test_a_frozen_school_darkens_the_practice_but_keeps_its_name(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A DECISION, not a side effect: the flag and the names disagree here
    on purpose.

    Freezing the school (revoking its curator) makes the practice
    unreachable, but the rows and the name are untouched. A master told
    "nobody can see this" without being told which school would have nothing
    to act on.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER, first_name="Teacher",
    )
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    school = await _school(db_session, curator["user"]["id"], name="Тихое утро")
    await _join_school(
        db_session, school.id, teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    practice = await _create_practice(
        db_session, teacher["user"]["id"], schools=[school],
    )

    await _revoke(client, admin_token, curator["user"]["id"])

    body = (await _detail(client, teacher, practice)).json()
    assert body["audience_unavailable"] is True
    assert body["audience_curator_group_names"] == ["Тихое утро"]


@pytest.mark.asyncio
async def test_a_suspended_master_darkens_their_own_school_practice(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The master-side condition is checked NOW: a revoked teacher no longer
    belongs to the school for audience purposes, even with the row intact.

    The row check is the pair -- otherwise "true" could equally mean the
    membership had been deleted.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER, first_name="Teacher",
    )
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    school = await _school(db_session, curator["user"]["id"])
    membership = await _join_school(
        db_session, school.id, teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    practice = await _create_practice(
        db_session, teacher["user"]["id"], schools=[school],
    )
    assert (await _detail(client, teacher, practice)).json()[
        "audience_unavailable"
    ] is False

    await _revoke(client, admin_token, teacher["user"]["id"])

    assert (await _detail(client, teacher, practice)).json()[
        "audience_unavailable"
    ] is True
    assert await db_session.get(CuratorGroupMember, membership.id) is not None


@pytest.mark.asyncio
async def test_deleting_every_target_school_darkens_and_empties_the_names(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The one case where the names DO empty: the rows are gone by cascade,
    so there is no name left to report. Contrast with the frozen school
    above, where both the row and the name survive."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER, first_name="Teacher",
    )
    school = await _school(db_session, curator["user"]["id"])
    await _join_school(
        db_session, school.id, teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    practice = await _create_practice(
        db_session, teacher["user"]["id"], schools=[school],
    )

    await db_session.delete(await db_session.get(CuratorGroup, school.id))
    await db_session.commit()

    body = (await _detail(client, teacher, practice)).json()
    assert body["audience_unavailable"] is True
    assert body["audience_curator_group_names"] == []


@pytest.mark.asyncio
async def test_the_other_three_audiences_are_never_flagged(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """False and [], never null -- a public practice's audience cannot
    become unavailable, and a tri-state would make every consumer handle a
    case that does not exist."""
    teacher = await _make_verified_master(client, db_session, _TID_MASTER)

    for kind in (
        AudienceKind.PUBLIC.value,
        AudienceKind.STUDENTS.value,
        AudienceKind.GROUPS.value,
    ):
        practice = await _create_practice(
            db_session, teacher["user"]["id"], schools=[],
            audience_kind=kind, title=f"Практика {kind}",
        )
        body = (await _detail(client, teacher, practice)).json()
        assert body["audience_unavailable"] is False, kind
        assert body["audience_curator_group_names"] == [], kind


@pytest.mark.asyncio
async def test_create_and_update_carry_both_fields(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """All THREE fill points, not just the detail: create and update are
    owner-facing and answer with the same two fields."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _school(db_session, curator["user"]["id"], name="Тихое утро")
    headers = auth_headers(curator["session_token"])

    created = await client.post(
        PRACTICES_URL,
        json=_practice_body(
            audience_kind="curator_groups",
            curator_group_ids=[str(school.id)],
        ),
        headers=headers,
    )
    assert created.status_code == 201, created.text
    assert created.json()["audience_curator_group_names"] == ["Тихое утро"]
    assert created.json()["audience_unavailable"] is False

    updated = await client.patch(
        f"{PRACTICES_URL}/{created.json()['id']}",
        json={"title": "Другое название"},
        headers=headers,
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["audience_curator_group_names"] == ["Тихое утро"]
    assert updated.json()["audience_unavailable"] is False


@pytest.mark.asyncio
async def test_a_school_member_reads_the_school_name_and_a_stranger_gets_404(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The circle that reads the names is the older field's circle.

    A member of the target school reaches the detail and sees the name --
    which they already know, being in the school. A stranger never reaches
    the field: the audience gate answers 404 first. The pair is the point:
    without the 404 half, "a member can read it" would say nothing about
    whether anyone else can.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER, first_name="Teacher",
    )
    colleague = await _make_verified_master(
        client, db_session, _TID_MASTER_B, first_name="Colleague",
    )
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    stranger = await login_user(client, telegram_id=_TID_STRANGER)
    school = await _school(db_session, curator["user"]["id"], name="Тихое утро")
    for who in (teacher, colleague):
        await _join_school(
            db_session, school.id, who["user"]["id"],
            CuratorMemberKind.MASTER,
        )
    await _join_school(
        db_session, school.id, student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )
    practice = await _create_practice(
        db_session, teacher["user"]["id"], schools=[school],
    )

    # A colleague master of the school -- the circle is wider here than for
    # 'groups', and deliberately so.
    for who in (student, colleague, curator):
        resp = await _detail(client, who, practice)
        assert resp.status_code == 200, who["user"]["id"]
        assert resp.json()["audience_curator_group_names"] == ["Тихое утро"]

    assert (await _detail(client, stranger, practice)).status_code == 404


@pytest.mark.asyncio
async def test_a_booked_viewer_keeps_reading_the_name_after_the_practice_darkens(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Why the detail fill point is not owner-gated.

    The person who booked reaches the detail by the H-R2-8 grandfather, and
    the school's name is exactly what lets the frontend tell them why they
    can no longer check in. Removing the name from them would leave the
    message with a hole in it.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER, first_name="Teacher",
    )
    holder = await login_user(client, telegram_id=_TID_STUDENT_A)
    school = await _school(db_session, curator["user"]["id"], name="Тихое утро")
    membership = await _join_school(
        db_session, school.id, teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    await _join_school(
        db_session, school.id, holder["user"]["id"],
        CuratorMemberKind.STUDENT,
    )
    practice = await _create_practice(
        db_session, teacher["user"]["id"], schools=[school], hours_from_now=1,
    )
    db_session.add(
        Booking(
            practice_id=practice.id,
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

    body = (await _detail(client, holder, practice)).json()
    assert body["audience_curator_group_names"] == ["Тихое утро"]
    assert body["audience_unavailable"] is True

    # And the access the name explains is genuinely still there.
    checked_in = await client.post(
        CHECKIN_URL.format(practice_id=practice.id),
        json={"type": "pre", "mood": 7},
        headers=auth_headers(holder["session_token"]),
    )
    assert checked_in.status_code in (200, 201), checked_in.text


# ===========================================================================
# leave-preview
# ===========================================================================


@pytest.mark.asyncio
async def test_leave_preview_counts_only_my_own_upcoming_practices(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Mine, upcoming, aimed at THIS school -- and nothing else.

    The colleague's practice on the same school, my own practice on another
    school, my draft and my past practice are all present precisely so the
    number cannot be right by accident.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER, first_name="Teacher",
    )
    colleague = await _make_verified_master(
        client, db_session, _TID_MASTER_B, first_name="Colleague",
    )
    school = await _school(db_session, curator["user"]["id"], name="Эта")
    other_school = await _school(
        db_session, curator["user"]["id"], name="Другая",
    )
    for who in (teacher, colleague):
        for g in (school, other_school):
            await _join_school(
                db_session, g.id, who["user"]["id"], CuratorMemberKind.MASTER,
            )

    await _create_practice(
        db_session, teacher["user"]["id"], schools=[school], title="Моя одна",
    )
    await _create_practice(
        db_session, teacher["user"]["id"], schools=[school], title="Моя две",
        hours_from_now=72,
    )
    await _create_practice(
        db_session, colleague["user"]["id"], schools=[school],
        title="Не моя",
    )
    await _create_practice(
        db_session, teacher["user"]["id"], schools=[other_school],
        title="Другая школа",
    )
    await _create_practice(
        db_session, teacher["user"]["id"], schools=[school],
        status=PracticeStatus.DRAFT.value, title="Черновик",
    )
    await _create_practice(
        db_session, teacher["user"]["id"], schools=[school],
        hours_from_now=-48, status=PracticeStatus.COMPLETED.value,
        title="Прошедшая",
    )

    resp = await _leave_preview(client, teacher, school.id)
    assert resp.status_code == 200, resp.text
    assert resp.json()["upcoming_practices_targeting_group"] == 2


@pytest.mark.asyncio
async def test_the_advisory_number_matches_what_actually_goes_dark(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """THE PAIR THAT MAKES THE DIALOG HONEST.

    The advisory says N; the master leaves; exactly those N practices report
    audience_unavailable=true. If the two ever disagreed, the confirm dialog
    would be lying about the price of the action it is confirming.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER, first_name="Teacher",
    )
    school = await _school(db_session, curator["user"]["id"])
    await _join_school(
        db_session, school.id, teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    first = await _create_practice(
        db_session, teacher["user"]["id"], schools=[school], title="Первая",
    )
    second = await _create_practice(
        db_session, teacher["user"]["id"], schools=[school], title="Вторая",
        hours_from_now=72,
    )

    advised = (await _leave_preview(client, teacher, school.id)).json()
    assert advised["upcoming_practices_targeting_group"] == 2

    left = await client.delete(
        MEMBERSHIP_URL.format(group_id=school.id),
        headers=auth_headers(teacher["session_token"]),
    )
    assert left.status_code == 204, left.text

    for practice in (first, second):
        assert (await _detail(client, teacher, practice)).json()[
            "audience_unavailable"
        ] is True


@pytest.mark.asyncio
async def test_leave_preview_is_zero_for_a_student_and_for_an_empty_school(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """0, not 404: "you switch nothing off" is a real answer."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    school = await _school(db_session, curator["user"]["id"])
    await _join_school(
        db_session, school.id, student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )

    resp = await _leave_preview(client, student, school.id)
    assert resp.status_code == 200
    assert resp.json()["upcoming_practices_targeting_group"] == 0

    curator_resp = await _leave_preview(client, curator, school.id)
    assert curator_resp.status_code == 200
    assert curator_resp.json()["upcoming_practices_targeting_group"] == 0


@pytest.mark.asyncio
async def test_the_curator_gets_a_number_even_though_they_cannot_leave(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """409 on the action, 200 on the advice -- the pair asserted together.

    The curator cannot walk out, but they are the one person who might hand
    the school over instead, and the price of walking away is the input to
    that decision.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _school(db_session, curator["user"]["id"])
    await _create_practice(
        db_session, curator["user"]["id"], schools=[school], title="Кураторская",
    )

    advised = await _leave_preview(client, curator, school.id)
    assert advised.status_code == 200
    assert advised.json()["upcoming_practices_targeting_group"] == 1

    refused = await client.delete(
        MEMBERSHIP_URL.format(group_id=school.id),
        headers=auth_headers(curator["session_token"]),
    )
    assert refused.status_code == 409
    assert refused.json()["error"] == "curator_cannot_leave"


@pytest.mark.asyncio
async def test_leave_preview_refuses_a_stranger_and_an_unknown_school(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """404 through the same resolver the group page uses -- a stranger must
    not learn the school exists, let alone how busy it is.

    Paired with a member's own 200 on the same school.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    stranger = await login_user(client, telegram_id=_TID_STRANGER)
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    school = await _school(db_session, curator["user"]["id"])
    await _join_school(
        db_session, school.id, student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )

    assert (await _leave_preview(client, stranger, school.id)).status_code == 404
    assert (await _leave_preview(client, student, uuid4())).status_code == 404
    assert (await _leave_preview(client, student, school.id)).status_code == 200


@pytest.mark.asyncio
async def test_leave_preview_is_404_on_a_frozen_school_though_leaving_works(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A DECISION with a visible consequence, asserted rather than assumed.

    The advisory resolves through _relation_or_404, which checks that the
    school is active; leave() deliberately does not (I-5). So on a frozen
    school the exit dialog shows no advice while the button still works.
    Both halves are here so the asymmetry is a recorded fact rather than a
    surprise for GT-13.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    school = await _school(db_session, curator["user"]["id"])
    await _join_school(
        db_session, school.id, student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )
    assert (await _leave_preview(client, student, school.id)).status_code == 200

    await _revoke(client, admin_token, curator["user"]["id"])

    assert (await _leave_preview(client, student, school.id)).status_code == 404
    left = await client.delete(
        MEMBERSHIP_URL.format(group_id=school.id),
        headers=auth_headers(student["session_token"]),
    )
    assert left.status_code == 204, left.text


# ===========================================================================
# remove-preview
# ===========================================================================


@pytest.mark.asyncio
async def test_remove_preview_counts_that_members_practices(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The curator asks about somebody else, and gets that person's number
    -- not their own. The curator's own practice on the same school is here
    to prove the query is scoped to the member."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER, first_name="Teacher",
    )
    school = await _school(db_session, curator["user"]["id"])
    await _join_school(
        db_session, school.id, teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    await _create_practice(
        db_session, teacher["user"]["id"], schools=[school], title="Его",
    )
    await _create_practice(
        db_session, curator["user"]["id"], schools=[school], title="Кураторская",
    )

    resp = await client.get(
        REMOVE_PREVIEW_URL.format(
            group_id=school.id, user_id=teacher["user"]["id"],
        ),
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["upcoming_practices_targeting_group"] == 1


@pytest.mark.asyncio
async def test_remove_preview_is_zero_for_a_student_and_a_non_member(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """0, not 404 -- the removal itself answers 204 on the same targets, and
    the advisory must not be stricter than the action it describes."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    school = await _school(db_session, curator["user"]["id"])
    await _join_school(
        db_session, school.id, student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )
    headers = auth_headers(curator["session_token"])

    for user_id in (student["user"]["id"], str(uuid4())):
        resp = await client.get(
            REMOVE_PREVIEW_URL.format(group_id=school.id, user_id=user_id),
            headers=headers,
        )
        assert resp.status_code == 200, user_id
        assert resp.json()["upcoming_practices_targeting_group"] == 0

    # The pair: removal answers 204 on the very same non-member.
    removed = await client.delete(
        MEMBER_URL.format(group_id=school.id, user_id=uuid4()),
        headers=headers,
    )
    assert removed.status_code == 204


@pytest.mark.asyncio
async def test_remove_preview_refuses_someone_elses_school(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    outsider = await _make_verified_master(
        client, db_session, _TID_MASTER, first_name="Outsider",
    )
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    school = await _school(db_session, curator["user"]["id"])
    await _join_school(
        db_session, school.id, student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )

    resp = await client.get(
        REMOVE_PREVIEW_URL.format(
            group_id=school.id, user_id=student["user"]["id"],
        ),
        headers=auth_headers(outsider["session_token"]),
    )
    assert resp.status_code == 404

    plain = await login_user(client, telegram_id=_TID_STUDENT_B)
    forbidden = await client.get(
        REMOVE_PREVIEW_URL.format(
            group_id=school.id, user_id=student["user"]["id"],
        ),
        headers=auth_headers(plain["session_token"]),
    )
    assert forbidden.status_code == 403


# ===========================================================================
# delete-preview
# ===========================================================================


@pytest.mark.asyncio
async def test_delete_preview_counts_everyone_including_the_curator(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Every master of the school, the curator included.

    The curator holds no membership row (I-2), so a literal read of the
    roster would miss their practices -- and those go dark with the school
    like anyone else's. Counters come from the same helper the group page
    uses, so the dialog and the page cannot disagree.
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
    await _create_practice(
        db_session, curator["user"]["id"], schools=[school], title="Кураторская",
    )
    await _create_practice(
        db_session, teacher["user"]["id"], schools=[school], title="Учительская",
    )

    resp = await client.get(
        DELETE_PREVIEW_URL.format(group_id=school.id),
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["masters_count"] == 1
    assert body["students_count"] == 1
    assert body["upcoming_practices_targeting_group"] == 2

    page = (
        await client.get(
            f"/api/v1/curator-groups/{school.id}",
            headers=auth_headers(curator["session_token"]),
        )
    ).json()
    assert body["masters_count"] == page["masters_count"]
    assert body["students_count"] == page["students_count"]


@pytest.mark.asyncio
async def test_delete_preview_on_an_empty_school_is_all_zeros(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Zeros, not a 404 -- an empty school is a normal thing to delete."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _school(db_session, curator["user"]["id"])

    resp = await client.get(
        DELETE_PREVIEW_URL.format(group_id=school.id),
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 200
    assert resp.json() == {
        "masters_count": 0,
        "students_count": 0,
        "upcoming_practices_targeting_group": 0,
    }


@pytest.mark.asyncio
async def test_delete_preview_refuses_someone_elses_school(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    outsider = await _make_verified_master(
        client, db_session, _TID_MASTER, first_name="Outsider",
    )
    school = await _school(db_session, curator["user"]["id"])

    theirs = await client.get(
        DELETE_PREVIEW_URL.format(group_id=school.id),
        headers=auth_headers(outsider["session_token"]),
    )
    assert theirs.status_code == 404
    mine = await client.get(
        DELETE_PREVIEW_URL.format(group_id=school.id),
        headers=auth_headers(curator["session_token"]),
    )
    assert mine.status_code == 200


@pytest.mark.asyncio
async def test_the_advisory_endpoints_block_nothing(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """ADVISORY, NOT A GATE -- asserted rather than stated.

    With a non-zero count on every one of the three, all three actions still
    succeed: the member leaves, the curator removes somebody, and the school
    is deleted.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER, first_name="Teacher",
    )
    leaver = await _make_verified_master(
        client, db_session, _TID_MASTER_B, first_name="Leaver",
    )
    school = await _school(db_session, curator["user"]["id"])
    for who in (teacher, leaver):
        await _join_school(
            db_session, school.id, who["user"]["id"],
            CuratorMemberKind.MASTER,
        )
        await _create_practice(
            db_session, who["user"]["id"], schools=[school],
            title=f"Практика {who['user']['id'][:8]}",
        )
    headers = auth_headers(curator["session_token"])

    assert (await _leave_preview(client, leaver, school.id)).json()[
        "upcoming_practices_targeting_group"
    ] == 1
    left = await client.delete(
        MEMBERSHIP_URL.format(group_id=school.id),
        headers=auth_headers(leaver["session_token"]),
    )
    assert left.status_code == 204

    assert (
        await client.get(
            REMOVE_PREVIEW_URL.format(
                group_id=school.id, user_id=teacher["user"]["id"],
            ),
            headers=headers,
        )
    ).json()["upcoming_practices_targeting_group"] == 1
    removed = await client.delete(
        MEMBER_URL.format(group_id=school.id, user_id=teacher["user"]["id"]),
        headers=headers,
    )
    assert removed.status_code == 204

    deleted = await client.delete(
        f"{CURATOR_GROUPS_URL}/{school.id}", headers=headers,
    )
    assert deleted.status_code == 204


@pytest.mark.asyncio
async def test_a_malformed_group_id_is_422_on_all_three_advisories(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """{group_id} is a UUID in the path, so a malformed one never reaches
    the service and 404 stays reserved for "not yours / not there"."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    headers = auth_headers(curator["session_token"])

    for url in (
        LEAVE_PREVIEW_URL.format(group_id="not-a-uuid"),
        DELETE_PREVIEW_URL.format(group_id="not-a-uuid"),
        REMOVE_PREVIEW_URL.format(group_id="not-a-uuid", user_id=uuid4()),
    ):
        resp = await client.get(url, headers=headers)
        assert resp.status_code == 422, url
