# =============================================================================
# VELO Backend -- Tests: «Аналитика по практике» (BE-78)
# =============================================================================
#
# GET /practices/{id}/analytics, /analytics/pairs, /analytics/reviews.
#
# telegram_id band: 71100-71199 (declared once below; checked free with
# free_windows(space=(55000, 99999)) -> (71100, 72769) before it was claimed).
#
# WHAT IS PINNED:
#   - WHO: the leading master; for a school's practice its curator and its
#     masters verified right now. Everyone else -- admin included -- the
#     masked 404, rights before status (an entitled reader of a practice that
#     is not completed gets 400). Every 404 is paired with a 200 for the
#     same practice, so a broken endpoint cannot pass as "refused".
#   - ONE POPULATION: ATTENDED bookings. A no-show's or a cancelled
#     booking's PRE check-in is not «до».
#   - PAIRS BY BOOKING: a PRE check-in on a cancelled booking does not pair
#     with the same person's review of a later attended booking.
#   - ZONES ONLY (BE-24): no stored 1..10 leaves the server.
#
# Local helpers are copied, not imported -- the convention of every curator
# test file (no default telegram_id on any of them).
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
from app.modules.diary.insights_service import score_zone
from app.modules.diary.models import Checkin, CheckType, Feedback
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import (
    AudienceKind,
    Practice,
    PracticeStatus,
    PracticeType,
)
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user

_TID_MIN = 71100
_TID_MAX = 71199

_TID_LEADER = 71101
_TID_CURATOR = 71102
_TID_SCHOOL_MASTER = 71103
_TID_OTHER_CURATOR = 71104
_TID_OUTSIDE_MASTER = 71105
_TID_ADMIN = 71106
_TID_STUDENTS = range(71120, 71160)

SUMMARY_URL = "/api/v1/practices/{pid}/analytics"
PAIRS_URL = "/api/v1/practices/{pid}/analytics/pairs"
REVIEWS_URL = "/api/v1/practices/{pid}/analytics/reviews"
ZONES = {"bad", "low", "neutral", "good", "fire"}


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _user(client: AsyncClient, tid: int, first: str = "User", last=None) -> dict:
    auth = await login_user(client, telegram_id=tid, first_name=first)
    if last is not None:
        auth["_last"] = last
    return auth


async def _verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    tid: int,
    first: str = "Master",
) -> dict:
    auth = await login_user(client, telegram_id=tid, first_name=first)
    uid = UUID(auth["user"]["id"])
    await db_session.execute(
        update(User).where(User.id == uid).values(role=UserRole.MASTER.value)
    )
    db_session.add(
        MasterProfile(
            user_id=uid,
            data={"account": {"status": "verified"}, "profile": {"bio": "m"}},
        )
    )
    await db_session.commit()
    return auth


async def _school(db_session: AsyncSession, curator: dict) -> CuratorGroup:
    group = CuratorGroup(curator_user_id=UUID(curator["user"]["id"]), name="Школа")
    db_session.add(group)
    await db_session.commit()
    return group


async def _member(
    db_session: AsyncSession,
    school: CuratorGroup,
    auth: dict,
    kind: CuratorMemberKind,
) -> None:
    db_session.add(
        CuratorGroupMember(
            group_id=school.id,
            user_id=UUID(auth["user"]["id"]),
            kind=kind.value,
        )
    )
    await db_session.commit()


async def _practice(
    db_session: AsyncSession,
    master: dict,
    school: CuratorGroup | None,
    *,
    status: str = PracticeStatus.COMPLETED.value,
) -> Practice:
    practice = Practice(
        master_id=UUID(master["user"]["id"]),
        title="Вечерняя практика",
        description="x",
        practice_type=PracticeType.LIVE.value,
        status=status,
        scheduled_at=datetime.now(UTC) - timedelta(hours=3),
        duration_minutes=60,
        timezone="UTC",
        max_participants=20,
        current_participants=0,
        is_free=True,
        price_cents=0,
        currency="eur",
        audience_kind=(
            AudienceKind.CURATOR_GROUPS.value
            if school is not None
            else AudienceKind.PUBLIC.value
        ),
        curator_group_id=school.id if school is not None else None,
    )
    db_session.add(practice)
    await db_session.commit()
    return practice


async def _booking(
    db_session: AsyncSession,
    practice: Practice,
    person: dict,
    status: str,
) -> Booking:
    booking = Booking(
        practice_id=practice.id,
        user_id=UUID(person["user"]["id"]),
        status=status,
    )
    db_session.add(booking)
    await db_session.commit()
    return booking


async def _pre(
    db_session: AsyncSession,
    practice: Practice,
    person: dict,
    booking: Booking,
    mood: int,
) -> None:
    db_session.add(
        Checkin(
            practice_id=practice.id,
            user_id=UUID(person["user"]["id"]),
            booking_id=booking.id,
            mood=mood,
            comment="pre",
            check_type=CheckType.PRE.value,
        )
    )
    await db_session.commit()


async def _review(
    db_session: AsyncSession,
    practice: Practice,
    person: dict,
    booking: Booking,
    rating: int,
    comment: str | None,
    created_at: datetime | None = None,
) -> None:
    row = Feedback(
        practice_id=practice.id,
        user_id=UUID(person["user"]["id"]),
        booking_id=booking.id,
        rating=rating,
        comment=comment,
    )
    if created_at is not None:
        row.created_at = created_at
    db_session.add(row)
    await db_session.commit()


async def _get(client: AsyncClient, url: str, auth: dict | None, pid, **params):
    headers = auth_headers(auth["session_token"]) if auth else {}
    return await client.get(url.format(pid=pid), params=params or None, headers=headers)


async def _school_world(client: AsyncClient, db_session: AsyncSession) -> dict:
    """Leader + curator + a verified school master, one school, one attendee."""
    curator = await _user(client, _TID_CURATOR, "Curator")
    school = await _school(db_session, curator)
    leader = await _verified_master(client, db_session, _TID_LEADER, "Leader")
    await _member(db_session, school, leader, CuratorMemberKind.MASTER)
    peer = await _verified_master(client, db_session, _TID_SCHOOL_MASTER, "Peer")
    await _member(db_session, school, peer, CuratorMemberKind.MASTER)
    practice = await _practice(db_session, leader, school)
    student = await _user(client, _TID_STUDENTS[0], "Анна")
    b = await _booking(db_session, practice, student, BookingStatus.ATTENDED.value)
    await _pre(db_session, practice, student, b, 3)
    await _review(db_session, practice, student, b, 9, "Спасибо")
    return {
        "curator": curator,
        "school": school,
        "leader": leader,
        "peer": peer,
        "practice": practice,
        "student": student,
    }


# ---------------------------------------------------------------------------
# WHO
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_leader_the_curator_and_a_verified_school_master_read_it(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    w = await _school_world(client, db_session)
    pid = w["practice"].id
    for who in ("leader", "curator", "peer"):
        for url in (SUMMARY_URL, PAIRS_URL, REVIEWS_URL):
            resp = await _get(client, url, w[who], pid)
            assert resp.status_code == 200, (who, url, resp.text)
    body = (await _get(client, SUMMARY_URL, w["curator"], pid)).json()
    assert body["attended"] == 1 and body["pairs_total"] == 1
    # The curator sees names (owner ruling 24.09).
    pairs = (await _get(client, PAIRS_URL, w["curator"], pid)).json()["items"]
    assert pairs[0]["name"] == "Анна"


@pytest.mark.asyncio
async def test_everyone_else_gets_the_masked_404_on_all_three(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    w = await _school_world(client, db_session)
    pid = w["practice"].id
    other_curator = await _user(client, _TID_OTHER_CURATOR, "Other")
    await _school(db_session, other_curator)
    outsider_master = await _verified_master(client, db_session, _TID_OUTSIDE_MASTER)
    admin = await _user(client, _TID_ADMIN, "Admin")
    await db_session.execute(
        update(User)
        .where(User.id == admin["user"]["id"])
        .values(role=UserRole.ADMIN.value)
    )
    await db_session.commit()
    for who in (other_curator, outsider_master, admin, w["student"]):
        for url in (SUMMARY_URL, PAIRS_URL, REVIEWS_URL):
            resp = await _get(client, url, who, pid)
            assert resp.status_code == 404, (url, resp.text)
    # Pair: the same practice is readable -- the refusals are refusals.
    assert (await _get(client, SUMMARY_URL, w["leader"], pid)).status_code == 200
    # No such practice -> the same 404; no session -> 401.
    assert (await _get(client, SUMMARY_URL, w["leader"], uuid4())).status_code == 404
    assert (await _get(client, SUMMARY_URL, None, pid)).status_code == 401


@pytest.mark.asyncio
async def test_a_suspended_school_master_loses_it(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    w = await _school_world(client, db_session)
    pid = w["practice"].id
    assert (await _get(client, SUMMARY_URL, w["peer"], pid)).status_code == 200
    profile = await db_session.get(MasterProfile, UUID(w["peer"]["user"]["id"]))
    profile.set_jsonb("data", {**profile.data, "account": {"status": "suspended"}})
    await db_session.commit()
    assert (await _get(client, SUMMARY_URL, w["peer"], pid)).status_code == 404


@pytest.mark.asyncio
async def test_a_practice_outside_any_school_is_the_leaders_alone(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    w = await _school_world(client, db_session)
    own = await _practice(db_session, w["leader"], None)
    assert (await _get(client, SUMMARY_URL, w["leader"], own.id)).status_code == 200
    for who in ("curator", "peer"):
        resp = await _get(client, SUMMARY_URL, w[who], own.id)
        assert resp.status_code == 404, who


@pytest.mark.asyncio
async def test_rights_come_before_the_status(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Entitled + not completed -> 400; not entitled -> 404 whatever the status."""
    w = await _school_world(client, db_session)
    live = await _practice(
        db_session,
        w["leader"],
        w["school"],
        status=PracticeStatus.SCHEDULED.value,
    )
    for who in ("leader", "curator", "peer"):
        for url in (SUMMARY_URL, PAIRS_URL, REVIEWS_URL):
            resp = await _get(client, url, w[who], live.id)
            assert resp.status_code == 400, (who, url, resp.text)
    outsider = await _verified_master(client, db_session, _TID_OUTSIDE_MASTER)
    assert (await _get(client, SUMMARY_URL, outsider, live.id)).status_code == 404


# ---------------------------------------------------------------------------
# WHAT: one population, pairs by booking, zones only
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_every_block_counts_the_attended_only(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    leader = await _verified_master(client, db_session, _TID_LEADER, "Leader")
    practice = await _practice(db_session, leader, None)
    s = [await _user(client, tid, f"S{i}") for i, tid in enumerate(_TID_STUDENTS[:5])]
    att, ns, can = (
        BookingStatus.ATTENDED.value,
        BookingStatus.NO_SHOW.value,
        BookingStatus.CANCELLED.value,
    )
    a = await _booking(db_session, practice, s[0], att)  # PRE + review w/ text
    await _pre(db_session, practice, s[0], a, 2)
    await _review(db_session, practice, s[0], a, 9, "Глубоко")
    b = await _booking(db_session, practice, s[1], att)  # PRE only
    await _pre(db_session, practice, s[1], b, 9)
    c = await _booking(db_session, practice, s[2], att)  # review, blank text
    await _review(db_session, practice, s[2], c, 5, "   ")
    d = await _booking(db_session, practice, s[3], ns)  # no-show's PRE
    await _pre(db_session, practice, s[3], d, 8)
    e = await _booking(db_session, practice, s[4], can)  # cancelled's PRE
    await _pre(db_session, practice, s[4], e, 4)

    body = (await _get(client, SUMMARY_URL, leader, practice.id)).json()
    assert body["attended"] == 3
    expected_before = dict.fromkeys(ZONES, 0)
    for m in (2, 9):
        expected_before[score_zone(m)] += 1
    assert body["before"] == expected_before
    expected_after = dict.fromkeys(ZONES, 0)
    for r in (9, 5):
        expected_after[score_zone(r)] += 1
    assert body["after"] == expected_after
    assert body["pairs_total"] == 1
    assert body["reviews_total"] == 1

    pairs = (await _get(client, PAIRS_URL, leader, practice.id)).json()
    assert [p["user_id"] for p in pairs["items"]] == [s[0]["user"]["id"]]
    assert pairs["items"][0]["before_zone"] == score_zone(2)
    assert pairs["items"][0]["after_zone"] == score_zone(9)
    reviews = (await _get(client, REVIEWS_URL, leader, practice.id)).json()
    assert [r["comment"] for r in reviews["items"]] == ["Глубоко"]


@pytest.mark.asyncio
async def test_a_checkin_on_a_cancelled_booking_does_not_pair_with_a_later_review(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Pairs are glued by BOOKING, not by (practice, user)."""
    leader = await _verified_master(client, db_session, _TID_LEADER, "Leader")
    practice = await _practice(db_session, leader, None)
    person = await _user(client, _TID_STUDENTS[0], "Вера")
    first = await _booking(db_session, practice, person, BookingStatus.CANCELLED.value)
    await _pre(db_session, practice, person, first, 3)
    second = await _booking(db_session, practice, person, BookingStatus.ATTENDED.value)
    await _review(db_session, practice, person, second, 9, "Хорошо")

    body = (await _get(client, SUMMARY_URL, leader, practice.id)).json()
    assert body["attended"] == 1
    assert sum(body["after"].values()) == 1  # the review counts
    assert sum(body["before"].values()) == 0  # the cancelled PRE does not
    assert body["pairs_total"] == 0
    pairs = (await _get(client, PAIRS_URL, leader, practice.id)).json()
    assert pairs["items"] == [] and pairs["total"] == 0


@pytest.mark.asyncio
async def test_no_stored_score_leaves_the_server(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    w = await _school_world(client, db_session)
    pid = w["practice"].id
    summary = (await _get(client, SUMMARY_URL, w["curator"], pid)).json()
    assert set(summary["before"]) == ZONES and set(summary["after"]) == ZONES
    (pair,) = (await _get(client, PAIRS_URL, w["curator"], pid)).json()["items"]
    assert set(pair) == {
        "user_id",
        "name",
        "avatar_url",
        "before_zone",
        "after_zone",
        "is_school_student",
    }
    assert pair["before_zone"] in ZONES and pair["after_zone"] in ZONES
    (review,) = (await _get(client, REVIEWS_URL, w["curator"], pid)).json()["items"]
    assert set(review) == {
        "user_id",
        "name",
        "avatar_url",
        "comment",
        "created_at",
        "is_school_student",
    }


@pytest.mark.asyncio
async def test_pairs_go_by_name_and_reviews_newest_first_and_both_page(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    leader = await _verified_master(client, db_session, _TID_LEADER, "Leader")
    practice = await _practice(db_session, leader, None)
    names = ["Вера", "анна", "Борис"]
    now = datetime.now(UTC)
    for i, name in enumerate(names):
        person = await _user(client, _TID_STUDENTS[i], name)
        bk = await _booking(db_session, practice, person, BookingStatus.ATTENDED.value)
        await _pre(db_session, practice, person, bk, 5)
        await _review(
            db_session,
            practice,
            person,
            bk,
            7,
            f"от {name}",
            created_at=now - timedelta(minutes=10 * (3 - i)),
        )

    page1 = (await _get(client, PAIRS_URL, leader, practice.id, limit=2)).json()
    page2 = (
        await _get(client, PAIRS_URL, leader, practice.id, limit=2, offset=2)
    ).json()
    assert [p["name"] for p in page1["items"] + page2["items"]] == [
        "анна",
        "Борис",
        "Вера",
    ]
    assert page1["total"] == page2["total"] == 3
    reviews = (await _get(client, REVIEWS_URL, leader, practice.id)).json()
    assert [r["comment"] for r in reviews["items"]] == [
        "от Борис",
        "от анна",
        "от Вера",
    ]


@pytest.mark.asyncio
async def test_an_empty_practice_and_a_nameless_attendee(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    leader = await _verified_master(client, db_session, _TID_LEADER, "Leader")
    empty = await _practice(db_session, leader, None)
    body = (await _get(client, SUMMARY_URL, leader, empty.id)).json()
    assert body["attended"] == 0
    assert body["before"] == dict.fromkeys(ZONES, 0) == body["after"]
    assert body["pairs_total"] == 0 and body["reviews_total"] == 0
    assert body["title"] == "Вечерняя практика" and body["master_name"] == "Leader"

    practice = await _practice(db_session, leader, None)
    person = await _user(client, _TID_STUDENTS[0], "X")
    await db_session.execute(
        update(User)
        .where(User.id == person["user"]["id"])
        .values(first_name="", last_name=None)
    )
    await db_session.commit()
    bk = await _booking(db_session, practice, person, BookingStatus.ATTENDED.value)
    await _pre(db_session, practice, person, bk, 6)
    await _review(db_session, practice, person, bk, 6, "ok")
    (pair,) = (await _get(client, PAIRS_URL, leader, practice.id)).json()["items"]
    assert pair["name"] == "Участник"


# ---------------------------------------------------------------------------
# BE-78 (2): who is reading, and who each person is to the school
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_server_names_the_readers_role_and_the_curator_gets_the_school(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    w = await _school_world(client, db_session)
    pid = w["practice"].id
    seen = {
        who: (await _get(client, SUMMARY_URL, w[who], pid)).json()
        for who in ("leader", "curator", "peer")
    }
    assert seen["leader"]["viewer_role"] == "leader"
    assert seen["curator"]["viewer_role"] == "curator"
    assert seen["peer"]["viewer_role"] == "school_master"
    assert seen["curator"]["curator_group_id"] == str(w["school"].id)
    assert seen["leader"]["curator_group_id"] is None
    assert seen["peer"]["curator_group_id"] is None


@pytest.mark.asyncio
async def test_a_curator_who_led_the_practice_reads_it_as_its_leader(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """leader > curator: the dossier (own CRM), not the school profile."""
    curator = await _verified_master(client, db_session, _TID_CURATOR, "Curator")
    school = await _school(db_session, curator)
    practice = await _practice(db_session, curator, school)
    body = (await _get(client, SUMMARY_URL, curator, practice.id)).json()
    assert body["viewer_role"] == "leader"
    assert body["curator_group_id"] is None


@pytest.mark.asyncio
async def test_is_school_student_marks_members_only(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A STUDENT member -> true; a guest and a school master who came -> false.

    One value for every reader (owner, BE-78 (2)); asked on both lists.
    """
    w = await _school_world(client, db_session)  # Анна: attended, not a member yet
    practice, school = w["practice"], w["school"]
    await _member(db_session, school, w["student"], CuratorMemberKind.STUDENT)
    guest = await _user(client, _TID_STUDENTS[1], "Гость")
    bk = await _booking(db_session, practice, guest, BookingStatus.ATTENDED.value)
    await _pre(db_session, practice, guest, bk, 5)
    await _review(db_session, practice, guest, bk, 5, "был в гостях")
    bk = await _booking(db_session, practice, w["peer"], BookingStatus.ATTENDED.value)
    await _pre(db_session, practice, w["peer"], bk, 5)
    await _review(db_session, practice, w["peer"], bk, 5, "коллега")

    for url in (PAIRS_URL, REVIEWS_URL):
        for who in ("leader", "curator", "peer"):
            items = (await _get(client, url, w[who], practice.id)).json()["items"]
            flags = {i["name"]: i["is_school_student"] for i in items}
            assert flags == {"Анна": True, "Гость": False, "Peer": False}, (url, who)


@pytest.mark.asyncio
async def test_outside_any_school_nobody_is_a_school_student(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    w = await _school_world(client, db_session)
    await _member(db_session, w["school"], w["student"], CuratorMemberKind.STUDENT)
    own = await _practice(db_session, w["leader"], None)
    bk = await _booking(db_session, own, w["student"], BookingStatus.ATTENDED.value)
    await _pre(db_session, own, w["student"], bk, 5)
    await _review(db_session, own, w["student"], bk, 5, "вне школы")
    (pair,) = (await _get(client, PAIRS_URL, w["leader"], own.id)).json()["items"]
    assert pair["is_school_student"] is False
    # Pair: in the school's practice the same person IS one.
    (pair,) = (await _get(client, PAIRS_URL, w["leader"], w["practice"].id)).json()[
        "items"
    ]
    assert pair["is_school_student"] is True
