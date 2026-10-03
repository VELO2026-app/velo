# =============================================================================
# VELO Backend -- Tests: a departed master's unconducted practices leave the
# school's feedback (BE-75)
# =============================================================================
#
# telegram_id band: 70600-70699 (curator 70601, teachers 70602-70604, a
# second curator 70605, student 70610). Declared module-level below as
# _TID_MIN/_TID_MAX, ONCE -- tests/telegram_id_bands.py parses it. Checked
# free at packing, on 93032e3: free_windows(space=(70000, 72999)) returned
# (70600, 70849) among others (70500-70599 went to BE-76's roster tests).
#
# THE RULE (owner ruling, 2026-10-03): in the school's feedback a practice
# of a master who has LEFT the school, or was REMOVED from it, counts only
# if it was conducted (COMPLETED). Everybody else's practices count in any
# status. One clause (practice_in_school_feedback_clause) feeds every
# consumer, so every test reads ALL of them at once:
#   - the curator's check-in feed and review feed;
#   - the school analytics' all-time feedback aggregate;
#   - a school student's dossier (attended count, hours, check-ins,
#     reviews).
#
# THE GRID. Master state {left, removed} x {active, demoted, curator,
# previous curator, revoked by the platform, left-and-back, still in a
# second school} against the practice statuses that can carry feedback.
# Which statuses can carry WHAT is read from the writing paths, not chosen:
#   - a PRE check-in needs a booking, a booking needs a scheduled or live
#     practice (bookings/service.py create_booking); cancelling a practice
#     does not cancel its bookings (cancel_service.py), so SCHEDULED, LIVE
#     and CANCELLED all carry check-ins -- these are the cells the rule
#     moves;
#   - DRAFT and DELETED never had a booking, so they carry nothing. They
#     are seeded anyway, to show they add nothing either side;
#   - a review and an ATTENDED booking exist only on COMPLETED
#     (diary/service.py upsert_feedback; the finalization that completes
#     the practice), and COMPLETED is terminal. A review on an unconducted
#     practice is not built here: it is a state the product cannot reach.
#
# EVERY "GONE" IS PAIRED WITH A "STILL THERE": the departed master's own
# conducted practice, and an active teacher's identical trail in the same
# school, are asserted in the same breath.
#
# DEPARTURES GO THROUGH THE API (leave, remove, demote), so the test proves
# what those endpoints leave behind rather than what a seed claims they do.
# Three shapes are seeded instead, each named where it is built: the
# platform's revocation, a rejoin, and a transfer's previous curator.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

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
    PracticeStatus,
    PracticeType,
)
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user

CHECKINS_URL = "/api/v1/masters/me/curator-groups/{group_id}/checkins"
REVIEWS_URL = "/api/v1/masters/me/curator-groups/{group_id}/reviews"
ANALYTICS_URL = "/api/v1/masters/me/curator-groups/{group_id}/analytics"
PROFILE_URL = "/api/v1/masters/me/curator-groups/{group_id}/students/{user_id}"
LEAVE_URL = "/api/v1/curator-groups/{group_id}/membership"
MEMBER_URL = "/api/v1/masters/me/curator-groups/{group_id}/members/{user_id}"
DEMOTE_URL = MEMBER_URL + "/demote"

_TID_MIN = 70600
_TID_MAX = 70699

_TID_CURATOR = 70601
_TID_TEACHER = 70602
_TID_PEER = 70603
_TID_OTHER = 70604
_TID_CURATOR_B = 70605
_TID_STUDENT = 70610

# The statuses that carry a check-in (see the header) and the ones that
# carry nothing. COMPLETED is seeded separately: it carries everything.
_UNCONDUCTED_WITH_CHECKINS = (
    PracticeStatus.SCHEDULED.value,
    PracticeStatus.LIVE.value,
    PracticeStatus.CANCELLED.value,
)
_UNCONDUCTED_EMPTY = (
    PracticeStatus.DRAFT.value,
    PracticeStatus.DELETED.value,
)
_HOURS_FROM_NOW = {
    PracticeStatus.COMPLETED.value: -48,
    PracticeStatus.SCHEDULED.value: 48,
    PracticeStatus.LIVE.value: -0.2,
    PracticeStatus.CANCELLED.value: 24,
    PracticeStatus.DRAFT.value: 72,
    PracticeStatus.DELETED.value: 96,
}


# ===========================================================================
# Local helpers -- copied, the convention of every curator test file. No
# default telegram_id anywhere: a default would have to sit in the band too.
# ===========================================================================


async def _make_verified_master(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int,
) -> dict:
    auth = await login_user(client, telegram_id=telegram_id, first_name="M")
    user_id = UUID(auth["user"]["id"])
    user = await db_session.get(User, user_id)
    user.role = UserRole.MASTER
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


def _uid(auth: dict) -> UUID:
    return UUID(auth["user"]["id"])


async def _school(
    db_session: AsyncSession, curator: dict, name: str = "Школа",
) -> CuratorGroup:
    group = CuratorGroup(curator_user_id=_uid(curator), name=name)
    db_session.add(group)
    await db_session.flush()
    await db_session.commit()
    return group


async def _join(
    db_session: AsyncSession,
    school: CuratorGroup,
    auth: dict,
    kind: CuratorMemberKind,
) -> None:
    db_session.add(
        CuratorGroupMember(group_id=school.id, user_id=_uid(auth), kind=kind.value)
    )
    await db_session.flush()
    await db_session.commit()


async def _practice(
    db_session: AsyncSession,
    master: dict,
    school: CuratorGroup,
    title: str,
    status: str,
) -> Practice:
    practice = Practice(
        master_id=_uid(master),
        title=title,
        description="x",
        practice_type=PracticeType.LIVE.value,
        status=status,
        scheduled_at=datetime.now(UTC) + timedelta(hours=_HOURS_FROM_NOW[status]),
        duration_minutes=60,
        timezone="UTC",
        max_participants=20,
        current_participants=0,
        is_free=True,
        price_cents=0,
        currency="eur",
        audience_kind=AudienceKind.CURATOR_GROUPS.value,
        curator_group_id=school.id,
    )
    db_session.add(practice)
    await db_session.flush()
    await db_session.commit()
    return practice


async def _checked_in(
    db_session: AsyncSession,
    practice: Practice,
    student: dict,
    booking_status: str,
) -> Booking:
    booking = Booking(
        practice_id=practice.id, user_id=_uid(student), status=booking_status,
    )
    db_session.add(booking)
    await db_session.flush()
    db_session.add(
        Checkin(
            practice_id=practice.id,
            user_id=_uid(student),
            booking_id=booking.id,
            mood=7,
            comment="Пришла",
            check_type=CheckType.PRE.value,
        )
    )
    await db_session.flush()
    await db_session.commit()
    return booking


async def _trail(
    db_session: AsyncSession,
    master: dict,
    school: CuratorGroup,
    student: dict,
    label: str,
) -> dict[str, Practice]:
    """One master's full trail in the school, titled '<label>:<status>'.

    COMPLETED: attended booking, check-in, review -- everything a conducted
    practice can carry. SCHEDULED / LIVE / CANCELLED: a confirmed booking
    and a PRE check-in. DRAFT / DELETED: the practice alone.
    """
    made: dict[str, Practice] = {}
    status = PracticeStatus.COMPLETED.value
    done = await _practice(db_session, master, school, f"{label}:{status}", status)
    booking = await _checked_in(
        db_session, done, student, BookingStatus.ATTENDED.value,
    )
    db_session.add(
        Feedback(
            practice_id=done.id,
            user_id=_uid(student),
            booking_id=booking.id,
            rating=9,
            comment="Спасибо",
        )
    )
    await db_session.flush()
    await db_session.commit()
    made[status] = done
    for status in _UNCONDUCTED_WITH_CHECKINS:
        practice = await _practice(
            db_session, master, school, f"{label}:{status}", status,
        )
        await _checked_in(
            db_session, practice, student, BookingStatus.CONFIRMED.value,
        )
        made[status] = practice
    for status in _UNCONDUCTED_EMPTY:
        made[status] = await _practice(
            db_session, master, school, f"{label}:{status}", status,
        )
    return made


def _titles(label: str, statuses) -> list[str]:
    return sorted(f"{label}:{status}" for status in statuses)


_ALL_WITH_CHECKINS = (PracticeStatus.COMPLETED.value, *_UNCONDUCTED_WITH_CHECKINS)
_CONDUCTED = (PracticeStatus.COMPLETED.value,)


async def _get_ok(client: AsyncClient, url: str, auth: dict, **params) -> dict:
    resp = await client.get(
        url, params=params or None, headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _feedback_view(
    client: AsyncClient,
    curator: dict,
    school: CuratorGroup,
    student: dict,
    label: str,
) -> dict:
    """Everything the school's feedback says about ONE master's trail.

    Filtered to titles starting with '<label>:' -- each test seeds a second
    master next to the one it moves, and their numbers must not mix. The
    aggregate cannot be filtered by master, so it is returned whole and the
    callers assert it as a total over every trail in the school.
    """
    group_id = str(school.id)
    prefix = f"{label}:"
    checkins = await _get_ok(
        client, CHECKINS_URL.format(group_id=group_id), curator, limit=100,
    )
    reviews = await _get_ok(
        client, REVIEWS_URL.format(group_id=group_id), curator, limit=100,
    )
    profile = await _get_ok(
        client,
        PROFILE_URL.format(group_id=group_id, user_id=student["user"]["id"]),
        curator,
    )
    analytics = await _get_ok(
        client, ANALYTICS_URL.format(group_id=group_id), curator,
    )
    return {
        "checkins": sorted(
            i["practice_title"] for i in checkins["items"]
            if i["practice_title"].startswith(prefix)
        ),
        "reviews": sorted(
            i["practice_title"] for i in reviews["items"]
            if i["practice_title"].startswith(prefix)
        ),
        "dossier_checkins": sorted(
            i["practice_title"] for i in profile["recent_checkins"]
            if i["practice_title"].startswith(prefix)
        ),
        "dossier_reviews": sorted(
            i["practice_title"] for i in profile["recent_feedbacks"]
            if i["practice_title"].startswith(prefix)
        ),
        "dossier_attended": profile["practices_count"],
        "aggregate_checkins": analytics["feedback"]["checkins_count"],
        "aggregate_mood_total": sum(analytics["feedback"]["mood"].values()),
        "aggregate_reviews": analytics["feedback"]["reviews_count"],
    }


async def _scene(client: AsyncClient, db_session: AsyncSession):
    """A school with a curator, a student member, the master under test
    (kind='master') and an active peer master, both with full trails."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(client, db_session, _TID_TEACHER)
    peer = await _make_verified_master(client, db_session, _TID_PEER)
    student = await login_user(
        client, telegram_id=_TID_STUDENT, first_name="Аня",
    )
    school = await _school(db_session, curator)
    await _join(db_session, school, teacher, CuratorMemberKind.MASTER)
    await _join(db_session, school, peer, CuratorMemberKind.MASTER)
    await _join(db_session, school, student, CuratorMemberKind.STUDENT)
    teacher_trail = await _trail(db_session, teacher, school, student, "T")
    await _trail(db_session, peer, school, student, "P")
    return curator, teacher, peer, student, school, teacher_trail


async def _assert_peer_untouched(client, curator, school, student) -> None:
    """The pair to every "gone": an active master's identical trail."""
    peer = await _feedback_view(client, curator, school, student, "P")
    assert peer["checkins"] == _titles("P", _ALL_WITH_CHECKINS)
    assert peer["reviews"] == _titles("P", _CONDUCTED)
    assert peer["dossier_checkins"] == _titles("P", _ALL_WITH_CHECKINS)
    assert peer["dossier_reviews"] == _titles("P", _CONDUCTED)


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
# Departed: left, removed
# ===========================================================================


async def _leave(client, school, teacher, curator) -> None:
    resp = await client.delete(
        LEAVE_URL.format(group_id=school.id),
        headers=auth_headers(teacher["session_token"]),
    )
    assert resp.status_code == 204, resp.text


async def _remove(client, school, teacher, curator) -> None:
    resp = await client.delete(
        MEMBER_URL.format(group_id=school.id, user_id=teacher["user"]["id"]),
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 204, resp.text


@pytest.mark.asyncio
@pytest.mark.parametrize("depart", [_leave, _remove], ids=["left", "removed"])
async def test_a_departed_masters_unconducted_practices_leave_every_feedback_view(
    client: AsyncClient, db_session: AsyncSession, depart,
) -> None:
    """Left or removed: only the conducted practice stays, everywhere.

    BEFORE is asserted in full first -- every view sees the whole trail --
    so an AFTER that is empty for another reason cannot pass. The
    aggregate is a school total: two trails of four check-ins and one
    review each before, the peer's four plus the teacher's one after.
    """
    curator, teacher, _peer, student, school, _trail_rows = await _scene(
        client, db_session,
    )

    before = await _feedback_view(client, curator, school, student, "T")
    assert before["checkins"] == _titles("T", _ALL_WITH_CHECKINS)
    assert before["dossier_checkins"] == _titles("T", _ALL_WITH_CHECKINS)
    assert before["reviews"] == _titles("T", _CONDUCTED)
    assert before["dossier_reviews"] == _titles("T", _CONDUCTED)
    assert before["dossier_attended"] == 2
    assert before["aggregate_checkins"] == 8
    assert before["aggregate_mood_total"] == 8
    assert before["aggregate_reviews"] == 2

    await depart(client, school, teacher, curator)

    after = await _feedback_view(client, curator, school, student, "T")
    assert after["checkins"] == _titles("T", _CONDUCTED)
    assert after["dossier_checkins"] == _titles("T", _CONDUCTED)
    assert after["reviews"] == _titles("T", _CONDUCTED)
    assert after["dossier_reviews"] == _titles("T", _CONDUCTED)
    assert after["dossier_attended"] == 2
    assert after["aggregate_checkins"] == 5
    assert after["aggregate_mood_total"] == 5
    assert after["aggregate_reviews"] == 2
    await _assert_peer_untouched(client, curator, school, student)


@pytest.mark.asyncio
async def test_the_checkin_feeds_practice_filter_follows_the_same_rule(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """?practice_id= on a departed master's scheduled practice matches
    nothing; on their conducted one it still matches its check-in."""
    curator, teacher, _peer, _student, school, trail = await _scene(
        client, db_session,
    )
    await _leave(client, school, teacher, curator)
    url = CHECKINS_URL.format(group_id=school.id)

    planned = await _get_ok(
        client, url, curator,
        practice_id=str(trail[PracticeStatus.SCHEDULED.value].id),
    )
    conducted = await _get_ok(
        client, url, curator,
        practice_id=str(trail[PracticeStatus.COMPLETED.value].id),
    )

    assert planned["items"] == [] and planned["total"] == 0
    assert [i["practice_title"] for i in conducted["items"]] == [
        f"T:{PracticeStatus.COMPLETED.value}",
    ]


# ===========================================================================
# Not departed: every unconducted practice stays
# ===========================================================================


async def _demote(client, db_session, school, teacher, curator) -> None:
    resp = await client.post(
        DEMOTE_URL.format(group_id=school.id, user_id=teacher["user"]["id"]),
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code in (200, 204), resp.text


async def _stay(client, db_session, school, teacher, curator) -> None:
    """Nothing happens: an active kind='master' member."""


async def _revoked_by_platform(client, db_session, school, teacher, curator):
    """SEEDED: the profile shape revoke_master leaves (account.status ->
    suspended). Its body (admin/masters/service.py) does not touch the
    school's tables, and neither does this seed -- the row stays."""
    profile = await db_session.get(MasterProfile, _uid(teacher))
    data = dict(profile.data)
    data["account"] = {**data["account"], "status": "suspended"}
    profile.data = data
    await db_session.flush()
    await db_session.commit()


async def _left_and_back(client, db_session, school, teacher, curator) -> None:
    """Left through the API, then a new row -- the shape a rejoin writes.
    SEEDED as kind='student': the member link admits a student, and the
    rule takes any kind (the state now, not the history)."""
    await _leave(client, school, teacher, curator)
    await _join(db_session, school, teacher, CuratorMemberKind.STUDENT)


async def _previous_curator(client, db_session, school, teacher, curator):
    """SEEDED: the shape accept_curator_group_transfer leaves -- the school
    goes to another curator, the previous one keeps a kind='master' row.
    Here the TEACHER plays the previous curator: their row is already
    kind='master', and the school's curator_user_id moves to a third
    person. The same rows the transfer writes, minus the offer."""
    new_curator = await _make_verified_master(client, db_session, _TID_CURATOR_B)
    school.curator_user_id = _uid(new_curator)
    await db_session.merge(school)
    await db_session.flush()
    await db_session.commit()
    return new_curator


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change",
    [_stay, _demote, _revoked_by_platform, _left_and_back, _previous_curator],
    ids=["active", "demoted", "revoked", "left-and-back", "previous-curator"],
)
async def test_a_master_still_in_the_school_keeps_every_practice_in_its_feedback(
    client: AsyncClient, db_session: AsyncSession, change,
) -> None:
    """Demoted, revoked by the platform, back again, or a former curator:
    still in the school, so nothing moves.

    The demoted case is the one a narrower rule would get wrong:
    _master_in_curator_group_clause (kind='master' and verified) already
    says "no" for the demoted and the revoked, and borrowing it here would
    drop their unconducted practices from the curator's feedback.
    """
    curator, teacher, _peer, student, school, _rows = await _scene(
        client, db_session,
    )

    reader = await change(client, db_session, school, teacher, curator) or curator

    view = await _feedback_view(client, reader, school, student, "T")
    assert view["checkins"] == _titles("T", _ALL_WITH_CHECKINS)
    assert view["dossier_checkins"] == _titles("T", _ALL_WITH_CHECKINS)
    assert view["reviews"] == _titles("T", _CONDUCTED)
    assert view["dossier_reviews"] == _titles("T", _CONDUCTED)
    assert view["aggregate_checkins"] == 8
    assert view["aggregate_reviews"] == 2
    await _assert_peer_untouched(client, reader, school, student)


@pytest.mark.asyncio
async def test_the_curators_own_practices_need_no_membership_row(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The curator has no curator_group_member row (I-2); their scheduled,
    live and cancelled practices still count. The arm that says so is the
    curator test, not the member test."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await login_user(
        client, telegram_id=_TID_STUDENT, first_name="Аня",
    )
    school = await _school(db_session, curator)
    await _join(db_session, school, student, CuratorMemberKind.STUDENT)
    await _trail(db_session, curator, school, student, "C")

    view = await _feedback_view(client, curator, school, student, "C")

    assert view["checkins"] == _titles("C", _ALL_WITH_CHECKINS)
    assert view["dossier_checkins"] == _titles("C", _ALL_WITH_CHECKINS)
    assert view["reviews"] == _titles("C", _CONDUCTED)
    assert view["aggregate_checkins"] == 4


# ===========================================================================
# REPEAT axis: the membership that counts is the one in THIS school
# ===========================================================================


@pytest.mark.asyncio
async def test_a_master_who_left_one_school_is_departed_only_there(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Teacher in schools A and B leaves A. In A their unconducted
    practices go; in B, where the row is still there, they all stay.
    A membership test against "any school" would keep both."""
    curator_a = await _make_verified_master(client, db_session, _TID_CURATOR)
    curator_b = await _make_verified_master(client, db_session, _TID_CURATOR_B)
    teacher = await _make_verified_master(client, db_session, _TID_OTHER)
    student = await login_user(
        client, telegram_id=_TID_STUDENT, first_name="Аня",
    )
    school_a = await _school(db_session, curator_a, "А")
    school_b = await _school(db_session, curator_b, "Б")
    for school in (school_a, school_b):
        await _join(db_session, school, teacher, CuratorMemberKind.MASTER)
        await _join(db_session, school, student, CuratorMemberKind.STUDENT)
    await _trail(db_session, teacher, school_a, student, "A")
    await _trail(db_session, teacher, school_b, student, "B")

    await _leave(client, school_a, teacher, curator_a)

    in_a = await _feedback_view(client, curator_a, school_a, student, "A")
    in_b = await _feedback_view(client, curator_b, school_b, student, "B")
    assert in_a["checkins"] == _titles("A", _CONDUCTED)
    assert in_a["dossier_checkins"] == _titles("A", _CONDUCTED)
    assert in_a["aggregate_checkins"] == 1
    assert in_b["checkins"] == _titles("B", _ALL_WITH_CHECKINS)
    assert in_b["dossier_checkins"] == _titles("B", _ALL_WITH_CHECKINS)
    assert in_b["aggregate_checkins"] == 4
