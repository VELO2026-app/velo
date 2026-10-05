# =============================================================================
# VELO Backend -- Tests: what a school block closes (BE-79, 1b)
# =============================================================================
#
# telegram_id band: 71200-71249 (curators 71201-71202, masters 71203-71205,
# students 71210-71212). Declared module-level below as _TID_MIN/_TID_MAX,
# ONCE -- tests/telegram_id_bands.py parses it. Checked free on eb9eb89:
# free_windows(space=(70000, 72999)) returned (71200, 72769) among others.
#
# WHAT (1b) ADDS to the swap of (1a):
#   (a) the school's practices close to the blocked person -- the feed, the
#       card, booking, the waitlist (entry and confirm), check-in -- public
#       ones included; code blocked_in_group, after blocked_by_master and
#       before the audience;
#   (b) the block cancels and refunds the person's FUTURE live bookings in
#       the school and removes their queue places; the past stays history;
#   (c) a blocked master neither edits, previews nor publishes the school's
#       practices, nor adds a session to his school series; cancelling and
#       deleting his own stay open;
#   (d) K2 and K3 -- the races of the block with a booking, a queue entry, a
#       confirmation and the blocked master's edit -- and the measurement of
#       the master profile taken AFTER the practice by the block's refunds.
#
# Every "X is gone" here is paired with "Y is still there": a bookings test
# that only checked cancellation would pass on a block that cancelled
# everything.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ForbiddenError
from app.modules.bookings import service as bookings_service
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.curator_groups import service as curator_service
from app.modules.curator_groups.models import CuratorGroupMember, CuratorMemberKind
from app.modules.diary.checkins_service import upsert_checkin
from app.modules.masters.groups_models import MasterStudent
from app.modules.masters.models import MasterProfile
from app.modules.payments.models import MasterLedger
from app.modules.practices import service as practices_service
from app.modules.practices.audience_service import assert_viewer_not_blocked
from app.modules.practices.models import (
    AudienceKind,
    Practice,
    PracticeStatus,
    PracticeType,
)
from app.modules.practices.schemas import UpdatePracticeRequest
from app.modules.users.models import User, UserRole
from app.modules.waitlist import service as waitlist_service
from app.modules.waitlist.models import Waitlist, WaitlistStatus
from tests.curator_race_harness import race
from tests.helpers import auth_headers, fresh_execute, full_cleanup_range, login_user

GROUPS_URL = "/api/v1/masters/me/curator-groups"
BLOCK_URL = "/api/v1/masters/me/curator-groups/{group_id}/members/{user_id}/block"
UNBLOCK_URL = "/api/v1/masters/me/curator-groups/{group_id}/blocks/{user_id}"
PRACTICES_URL = "/api/v1/practices"
PRACTICE_URL = "/api/v1/practices/{practice_id}"
CANCEL_URL = "/api/v1/practices/{practice_id}/cancel"
PREVIEW_URL = "/api/v1/practices/{practice_id}/audience-preview"
WAITLIST_JOIN_URL = "/api/v1/practices/{practice_id}/waitlist"
BOOKINGS_URL = "/api/v1/bookings"

_TID_MIN = 71200
_TID_MAX = 71249

_TID_CURATOR = 71201
_TID_CURATOR_B = 71202
_TID_MASTER = 71203
_TID_MASTER_B = 71204
_TID_BLOCKED_MASTER = 71205
_TID_STUDENT = 71210
_TID_STUDENT_B = 71211
_TID_STRANGER = 71212


# ===========================================================================
# Helpers -- the convention of the curator test files
# ===========================================================================


async def _verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int,
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


async def _student(client: AsyncClient, telegram_id: int) -> dict:
    return await login_user(client, telegram_id=telegram_id, first_name="Аня")


def _h(auth: dict) -> dict:
    return auth_headers(auth["session_token"])


def _uid(auth: dict) -> UUID:
    return UUID(auth["user"]["id"])


async def _school(client: AsyncClient, curator: dict, name: str = "Школа") -> str:
    resp = await client.post(GROUPS_URL, json={"name": name}, headers=_h(curator))
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _member(
    db_session: AsyncSession,
    group_id: str | None,
    auth: dict,
    kind: CuratorMemberKind = CuratorMemberKind.STUDENT,
) -> None:
    db_session.add(
        CuratorGroupMember(
            group_id=UUID(group_id),
            user_id=_uid(auth),
            kind=kind.value,
        )
    )
    await db_session.flush()
    await db_session.commit()


async def _practice(
    db_session: AsyncSession,
    master: dict,
    group_id: str | None,
    *,
    hours: float = 48,
    status: str = PracticeStatus.SCHEDULED.value,
    audience: str = AudienceKind.PUBLIC.value,
    max_participants: int | None = 20,
    title: str = "Практика",
) -> UUID:
    practice = Practice(
        master_id=_uid(master),
        title=title,
        description="x",
        practice_type=PracticeType.LIVE.value,
        status=status,
        scheduled_at=datetime.now(UTC) + timedelta(hours=hours),
        duration_minutes=60,
        timezone="UTC",
        max_participants=max_participants,
        current_participants=0,
        is_free=True,
        price_cents=0,
        currency="eur",
        audience_kind=audience,
        curator_group_id=UUID(group_id) if group_id is not None else None,
    )
    db_session.add(practice)
    await db_session.flush()
    await db_session.commit()
    return practice.id


async def _book(client: AsyncClient, auth: dict, practice_id: UUID):
    return await client.post(
        BOOKINGS_URL,
        json={"practice_id": str(practice_id)},
        headers=_h(auth),
    )


async def _booked(client: AsyncClient, auth: dict, practice_id: UUID) -> UUID:
    resp = await _book(client, auth, practice_id)
    assert resp.status_code in (200, 201), resp.text
    return UUID(resp.json()["id"])


async def _seed_booking(
    db_session: AsyncSession,
    practice_id: UUID,
    auth: dict,
    status: str,
) -> UUID:
    """A booking in a state the booking path does not create by itself --
    on a practice already past its start. Reachable: a practice keeps its
    CONFIRMED bookings past the start until it is finalized, and ATTENDED
    is what the finalizer leaves."""
    booking = Booking(practice_id=practice_id, user_id=_uid(auth), status=status)
    db_session.add(booking)
    await db_session.flush()
    await db_session.commit()
    return booking.id


async def _seed_queue(
    db_session: AsyncSession,
    practice_id: UUID,
    auth: dict,
    status: str,
    position: int,
) -> UUID:
    now = datetime.now(UTC)
    entry = Waitlist(
        practice_id=practice_id,
        user_id=_uid(auth),
        position=position,
        status=status,
        joined_at=now,
        notified_at=now if status == WaitlistStatus.NOTIFIED.value else None,
        expires_at=(
            now + timedelta(minutes=30)
            if status == WaitlistStatus.NOTIFIED.value
            else None
        ),
    )
    db_session.add(entry)
    await db_session.flush()
    await db_session.commit()
    return entry.id


async def _block(client, curator, group_id, person):
    return await client.post(
        BLOCK_URL.format(group_id=group_id, user_id=person["user"]["id"]),
        headers=_h(curator),
    )


async def _unblock(client, curator, group_id, person):
    return await client.delete(
        UNBLOCK_URL.format(group_id=group_id, user_id=person["user"]["id"]),
        headers=_h(curator),
    )


async def _booking(booking_id: UUID) -> Booking:
    return (
        await fresh_execute(select(Booking).where(Booking.id == booking_id))
    ).scalar_one()


async def _queue_status(entry_id: UUID) -> str:
    return (
        await fresh_execute(select(Waitlist.status).where(Waitlist.id == entry_id))
    ).scalar_one()


async def _refunds(practice_id: UUID) -> int:
    """Refund rows of the master ledger for this practice -- one per
    refunded booking (refund_booking, step 1)."""
    return (
        await fresh_execute(
            select(func.count(MasterLedger.id)).where(
                MasterLedger.practice_id == practice_id,
                MasterLedger.reason == f"refund:practice={practice_id}",
            )
        )
    ).scalar_one()


async def _feed_ids(client: AsyncClient, auth: dict) -> set[str]:
    resp = await client.get(
        PRACTICES_URL,
        headers=_h(auth),
        params={"limit": 100},
    )
    assert resp.status_code == 200, resp.text
    return {item["id"] for item in resp.json()["items"]}


def _code(resp) -> str | None:
    """The machine code of an error response: the "error" key."""
    return resp.json().get("error")


def _practice_body(**overrides) -> dict:
    base: dict = {
        "practice_type": "live",
        "direction": "meditation",
        "difficulty": "beginner",
        "title": "Занятие серии",
        "description": "x",
        "scheduled_at": (datetime.now(UTC) + timedelta(hours=72)).isoformat(),
        "duration_minutes": 60,
        "timezone": "UTC",
        "max_participants": 20,
        "is_free": True,
        "price_cents": 0,
        "currency": "eur",
    }
    base.update(overrides)
    return base


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


@pytest.fixture
async def world(client: AsyncClient, db_session: AsyncSession) -> dict:
    """School G with master M and student S (the one to be blocked); a
    second school G2 of another curator, where S is a member too."""
    curator = await _verified_master(client, db_session, _TID_CURATOR)
    curator_b = await _verified_master(client, db_session, _TID_CURATOR_B)
    master = await _verified_master(client, db_session, _TID_MASTER)
    student = await _student(client, _TID_STUDENT)
    group_id = await _school(client, curator)
    other_group_id = await _school(client, curator_b, name="Другая школа")
    await _member(db_session, group_id, master, CuratorMemberKind.MASTER)
    await _member(db_session, group_id, student)
    await _member(db_session, other_group_id, master, CuratorMemberKind.MASTER)
    await _member(db_session, other_group_id, student)
    return {
        "curator": curator,
        "curator_b": curator_b,
        "master": master,
        "student": student,
        "group_id": group_id,
        "other_group_id": other_group_id,
    }


# ===========================================================================
# (a) Access -- every door, and the doors that stay open
# ===========================================================================


@pytest.mark.asyncio
async def test_the_feed_loses_every_school_practice_public_ones_included(
    client: AsyncClient,
    db_session: AsyncSession,
    world: dict,
) -> None:
    """The block closes the school's PUBLIC practices too (gate ruling 1).
    Pair: the same person keeps another school's and a schoolless practice,
    and a stranger still sees the blocked school's public one -- the filter
    is about this person, not about the practice."""
    w = world
    stranger = await _student(client, _TID_STRANGER)
    in_school = await _practice(db_session, w["master"], w["group_id"])
    in_other = await _practice(db_session, w["master"], w["other_group_id"])
    no_school = await _practice(db_session, w["master"], None)

    assert str(in_school) in await _feed_ids(client, w["student"])
    assert (
        await _block(client, w["curator"], w["group_id"], w["student"])
    ).status_code == 204

    seen = await _feed_ids(client, w["student"])
    assert str(in_school) not in seen
    assert {str(in_other), str(no_school)} <= seen
    assert str(in_school) in await _feed_ids(client, stranger)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "audience",
    [AudienceKind.PUBLIC.value, AudienceKind.CURATOR_GROUPS.value],
)
async def test_booking_and_the_queue_refuse_with_blocked_in_group(
    client: AsyncClient,
    db_session: AsyncSession,
    world: dict,
    audience: str,
) -> None:
    """Booking and joining the queue answer blocked_in_group -- for a
    'curator_groups' practice too, where the missing member row would
    otherwise say not_in_audience (the check stands before the audience,
    R3). Pair: the same calls on the other school's practice go through."""
    w = world
    other_student = await _student(client, _TID_STUDENT_B)
    practice = await _practice(
        db_session, w["master"], w["group_id"], audience=audience
    )
    full = await _practice(
        db_session,
        w["master"],
        w["group_id"],
        audience=audience,
        max_participants=1,
    )
    await _member(db_session, w["group_id"], other_student)
    await _booked(client, other_student, full)
    open_practice = await _practice(db_session, w["master"], w["other_group_id"])

    assert (
        await _block(client, w["curator"], w["group_id"], w["student"])
    ).status_code == 204

    resp = await _book(client, w["student"], practice)
    assert resp.status_code == 403 and _code(resp) == "blocked_in_group", resp.text
    resp = await client.post(
        WAITLIST_JOIN_URL.format(practice_id=full),
        headers=_h(w["student"]),
    )
    assert resp.status_code == 403 and _code(resp) == "blocked_in_group", resp.text
    assert (await _book(client, w["student"], open_practice)).status_code in (200, 201)


@pytest.mark.asyncio
async def test_the_masters_own_block_is_named_first(
    client: AsyncClient,
    db_session: AsyncSession,
    world: dict,
) -> None:
    """Blocked by the practice's master AND in its school: the master's
    code, the older one the frontend maps (R3)."""
    w = world
    practice = await _practice(db_session, w["master"], w["group_id"])
    db_session.add(
        MasterStudent(
            master_id=_uid(w["master"]),
            student_user_id=_uid(w["student"]),
            blocked_at=datetime.now(UTC),
        )
    )
    await db_session.commit()
    assert (
        await _block(client, w["curator"], w["group_id"], w["student"])
    ).status_code == 204

    resp = await _book(client, w["student"], practice)
    assert resp.status_code == 403 and _code(resp) == "blocked_by_master", resp.text


@pytest.mark.asyncio
async def test_the_card_closes_on_the_future_and_stays_open_on_history(
    client: AsyncClient,
    db_session: AsyncSession,
    world: dict,
) -> None:
    """The card answers 404 for a future practice of the school (R4: the
    detail gate turns a refusal into "no such practice"); a past one the
    person attended stays readable (B6). Then check-in of that past
    practice: refused, blocked_in_group (R7) -- the history is kept, the
    action is not. Pair: the same probe passes for a person not blocked."""
    w = world
    future = await _practice(db_session, w["master"], w["group_id"])
    past = await _practice(
        db_session,
        w["master"],
        w["group_id"],
        hours=-3,
        status=PracticeStatus.COMPLETED.value,
    )
    await _seed_booking(db_session, past, w["student"], BookingStatus.ATTENDED.value)
    other = await _student(client, _TID_STUDENT_B)
    assert (
        await _block(client, w["curator"], w["group_id"], w["student"])
    ).status_code == 204

    resp = await client.get(
        PRACTICE_URL.format(practice_id=future), headers=_h(w["student"])
    )
    assert resp.status_code == 404, resp.text
    resp = await client.get(
        PRACTICE_URL.format(practice_id=past), headers=_h(w["student"])
    )
    assert resp.status_code == 200, resp.text

    async with _fresh_session() as session:
        user = await session.get(User, _uid(w["student"]))
        with pytest.raises(ForbiddenError) as exc:
            await upsert_checkin(user, past, 3, session)
        assert exc.value.code == "blocked_in_group"
        practice = await session.get(Practice, past)
        await assert_viewer_not_blocked(_uid(other), practice, session)
        await session.rollback()


def _fresh_session():
    from app.core.database import get_session_factory

    return get_session_factory()()


# ===========================================================================
# (b) The block cancels the future, keeps the past, clears the queue
# ===========================================================================


@pytest.mark.asyncio
async def test_the_block_cancels_and_refunds_future_school_bookings_only(
    client: AsyncClient,
    db_session: AsyncSession,
    world: dict,
) -> None:
    """Two future bookings in the school: both cancelled, reason "Blocked in
    school", one refund each, the participant count recalculated. Kept: a
    booking in the other school, an ATTENDED one in this school's past, and
    a CONFIRMED one on a past practice nobody has finalized yet -- the pair
    that dies if "future" is dropped from the filter (B6). A repeated block
    (204) refunds nothing a second time."""
    w = world
    first = await _practice(db_session, w["master"], w["group_id"])
    second = await _practice(db_session, w["master"], w["group_id"], hours=96)
    elsewhere = await _practice(db_session, w["master"], w["other_group_id"])
    attended = await _practice(
        db_session,
        w["master"],
        w["group_id"],
        hours=-5,
        status=PracticeStatus.COMPLETED.value,
    )
    unfinalized = await _practice(db_session, w["master"], w["group_id"], hours=-2)
    b_first = await _booked(client, w["student"], first)
    b_second = await _booked(client, w["student"], second)
    b_elsewhere = await _booked(client, w["student"], elsewhere)
    b_attended = await _seed_booking(
        db_session,
        attended,
        w["student"],
        BookingStatus.ATTENDED.value,
    )
    b_unfinalized = await _seed_booking(
        db_session,
        unfinalized,
        w["student"],
        BookingStatus.CONFIRMED.value,
    )

    assert (
        await _block(client, w["curator"], w["group_id"], w["student"])
    ).status_code == 204

    for booking_id, practice_id in ((b_first, first), (b_second, second)):
        booking = await _booking(booking_id)
        assert booking.status == BookingStatus.CANCELLED.value
        assert booking.cancellation_reason == "Blocked in school"
        assert await _refunds(practice_id) == 1
    count = (
        await fresh_execute(
            select(Practice.current_participants).where(Practice.id == first)
        )
    ).scalar_one()
    assert count == 0
    assert (await _booking(b_elsewhere)).status == BookingStatus.CONFIRMED.value
    assert (await _booking(b_attended)).status == BookingStatus.ATTENDED.value
    assert (await _booking(b_unfinalized)).status == BookingStatus.CONFIRMED.value

    assert (
        await _block(client, w["curator"], w["group_id"], w["student"])
    ).status_code == 204
    assert await _refunds(first) == 1 and await _refunds(second) == 1


@pytest.mark.asyncio
async def test_the_block_removes_queue_places_and_moves_a_held_spot_on(
    client: AsyncClient,
    db_session: AsyncSession,
    world: dict,
) -> None:
    """A WAITING place goes REMOVED; a NOTIFIED one goes REMOVED and the
    next person in that queue is notified at once. Pair: the person's place
    in the other school's queue is untouched."""
    w = world
    other = await _student(client, _TID_STUDENT_B)
    waiting_on = await _practice(
        db_session, w["master"], w["group_id"], max_participants=1
    )
    held_on = await _practice(
        db_session, w["master"], w["group_id"], max_participants=1
    )
    elsewhere = await _practice(
        db_session, w["master"], w["other_group_id"], max_participants=1
    )
    waiting = await _seed_queue(
        db_session, waiting_on, w["student"], WaitlistStatus.WAITING.value, 1
    )
    held = await _seed_queue(
        db_session, held_on, w["student"], WaitlistStatus.NOTIFIED.value, 1
    )
    next_in_line = await _seed_queue(
        db_session, held_on, other, WaitlistStatus.WAITING.value, 2
    )
    kept = await _seed_queue(
        db_session, elsewhere, w["student"], WaitlistStatus.WAITING.value, 1
    )

    assert (
        await _block(client, w["curator"], w["group_id"], w["student"])
    ).status_code == 204

    assert await _queue_status(waiting) == WaitlistStatus.REMOVED.value
    assert await _queue_status(held) == WaitlistStatus.REMOVED.value
    assert await _queue_status(next_in_line) == WaitlistStatus.NOTIFIED.value
    assert await _queue_status(kept) == WaitlistStatus.WAITING.value


@pytest.mark.asyncio
async def test_an_unblock_reopens_the_school_and_restores_nothing(
    client: AsyncClient,
    db_session: AsyncSession,
    world: dict,
) -> None:
    """After the unblock the school's practices are bookable again; the
    bookings the block cancelled stay cancelled (block_student's rule)."""
    w = world
    practice = await _practice(db_session, w["master"], w["group_id"])
    booking_id = await _booked(client, w["student"], practice)
    assert (
        await _block(client, w["curator"], w["group_id"], w["student"])
    ).status_code == 204
    assert (
        await _unblock(client, w["curator"], w["group_id"], w["student"])
    ).status_code == 204

    assert (await _booking(booking_id)).status == BookingStatus.CANCELLED.value
    fresh = await _practice(db_session, w["master"], w["group_id"], hours=120)
    assert (await _book(client, w["student"], fresh)).status_code in (200, 201)


# ===========================================================================
# (c) A blocked master
# ===========================================================================


@pytest.fixture
async def blocked_master(
    client: AsyncClient,
    db_session: AsyncSession,
    world: dict,
) -> dict:
    w = world
    master = await _verified_master(client, db_session, _TID_BLOCKED_MASTER)
    await _member(db_session, w["group_id"], master, CuratorMemberKind.MASTER)
    return master


@pytest.mark.asyncio
async def test_a_blocked_master_neither_edits_previews_nor_extends_his_series(
    client: AsyncClient,
    db_session: AsyncSession,
    world: dict,
    blocked_master: dict,
) -> None:
    """In the school: PATCH of his practice, PATCH of his draft to
    'deleted' (R5 -- the draft is deleted by DELETE), the audience preview
    and a new session of his series -- all 403 blocked_in_group. Pairs: the
    same PATCH of his schoolless practice passes, the curator edits his
    school practice, DELETE removes his draft and he cancels his practice
    (B2)."""
    w, x = world, blocked_master
    scheduled = await _practice(db_session, x, w["group_id"])
    draft = await _practice(
        db_session,
        x,
        w["group_id"],
        status=PracticeStatus.DRAFT.value,
    )
    to_cancel = await _practice(db_session, x, w["group_id"], hours=60)
    schoolless = await _practice(db_session, x, None)
    assert (await _block(client, w["curator"], w["group_id"], x)).status_code == 204

    for practice_id, body in (
        (scheduled, {"title": "Новое"}),
        (draft, {"status": "deleted"}),
    ):
        resp = await client.patch(
            PRACTICE_URL.format(practice_id=practice_id),
            json=body,
            headers=_h(x),
        )
        assert resp.status_code == 403 and _code(resp) == "blocked_in_group", resp.text
    resp = await client.post(
        PREVIEW_URL.format(practice_id=scheduled),
        json={"audience_kind": AudienceKind.PUBLIC.value, "group_ids": []},
        headers=_h(x),
    )
    assert resp.status_code == 403 and _code(resp) == "blocked_in_group", resp.text
    resp = await client.post(
        PRACTICES_URL,
        json=_practice_body(parent_practice_id=str(scheduled)),
        headers=_h(x),
    )
    assert resp.status_code == 403 and _code(resp) == "blocked_in_group", resp.text

    resp = await client.patch(
        PRACTICE_URL.format(practice_id=schoolless),
        json={"title": "Своё"},
        headers=_h(x),
    )
    assert resp.status_code == 200, resp.text
    resp = await client.patch(
        PRACTICE_URL.format(practice_id=scheduled),
        json={"title": "Куратор"},
        headers=_h(w["curator"]),
    )
    assert resp.status_code == 200, resp.text
    resp = await client.delete(PRACTICE_URL.format(practice_id=draft), headers=_h(x))
    assert resp.status_code in (200, 204), resp.text
    resp = await client.post(CANCEL_URL.format(practice_id=to_cancel), headers=_h(x))
    assert resp.status_code == 200, resp.text


# ===========================================================================
# (d) Races -- K2, K3 and the measurement of the master profile
# ===========================================================================


def _actor_call(fn, *args, actor_id: UUID, **kwargs):
    async def _call(session: AsyncSession) -> None:
        actor = await session.get(User, actor_id)
        await fn(*args, session, actor=actor, **kwargs)

    return _call


def _block_call(w: dict, person: dict):
    return _actor_call(
        curator_service.block_curator_group_member,
        _uid(w["curator"]),
        UUID(w["group_id"]),
        _uid(person),
        actor_id=_uid(w["curator"]),
    )


def _as_user(fn, user_id: UUID, *args, **kwargs):
    async def _call(session: AsyncSession):
        user = await session.get(User, user_id)
        return await fn(user, *args, session, **kwargs)

    return _call


@pytest.mark.asyncio
async def test_k2_a_block_waits_for_a_booking_in_flight_and_then_cancels_it(
    client: AsyncClient,
    db_session: AsyncSession,
    world: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """K2, booking first. The booking is paused AFTER its gate said "not
    blocked", holding the member row FOR KEY SHARE; the block's DELETE of
    that row waits (rival_waited), then finds the booking under its
    practice lock and cancels it. Without the shared lock the block does
    not wait, its re-read under the lock cannot see the uncommitted
    booking, and the person keeps a live booking in a school that blocked
    them."""
    w = world
    practice = await _practice(db_session, w["master"], w["group_id"])
    result = await race(
        monkeypatch,
        holder=_as_user(bookings_service.create_booking, _uid(w["student"]), practice),
        pause_in=(bookings_service, "assert_viewer_can_access_practice"),
        pause="after",
        rival=_block_call(w, w["student"]),
    )
    assert not result.holder.deadlocked and not result.rival.deadlocked
    assert result.holder.committed and result.rival.committed, (
        result.holder.error,
        result.rival.error,
    )
    assert result.rival_waited
    live = (
        await fresh_execute(
            select(func.count(Booking.id)).where(
                Booking.practice_id == practice,
                Booking.user_id == _uid(w["student"]),
                Booking.status == BookingStatus.CONFIRMED.value,
            )
        )
    ).scalar_one()
    assert live == 0
    assert await _refunds(practice) == 1


@pytest.mark.asyncio
async def test_k2_a_booking_landing_inside_a_block_is_refused(
    client: AsyncClient,
    db_session: AsyncSession,
    world: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """K2, block first: paused after its DELETE of the member row; the
    booking waits on that row, and after the block commits it reads the
    block -> 403 blocked_in_group, no booking written."""
    w = world
    practice = await _practice(db_session, w["master"], w["group_id"])
    result = await race(
        monkeypatch,
        holder=_block_call(w, w["student"]),
        pause_in=(curator_service, "_close_school_practices_to"),
        pause="before",
        rival=_as_user(bookings_service.create_booking, _uid(w["student"]), practice),
    )
    assert not result.holder.deadlocked and not result.rival.deadlocked
    assert result.holder.committed, result.holder.error
    assert result.rival_waited
    assert getattr(result.rival.error, "code", None) == "blocked_in_group"


@pytest.mark.asyncio
async def test_k2_a_queue_entry_in_flight_is_removed_by_the_block(
    client: AsyncClient,
    db_session: AsyncSession,
    world: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """K2 for the queue entry: join_waitlist, paused after its gate,
    holds the member row; the block waits, then removes the entry."""
    w = world
    other = await _student(client, _TID_STUDENT_B)
    await _member(db_session, w["group_id"], other)
    full = await _practice(db_session, w["master"], w["group_id"], max_participants=1)
    await _booked(client, other, full)
    result = await race(
        monkeypatch,
        holder=_as_user(waitlist_service.join_waitlist, _uid(w["student"]), full),
        pause_in=(waitlist_service, "assert_viewer_can_access_practice"),
        pause="after",
        rival=_block_call(w, w["student"]),
    )
    assert not result.holder.deadlocked and not result.rival.deadlocked
    assert result.holder.committed and result.rival.committed
    assert result.rival_waited
    statuses = (
        (
            await fresh_execute(
                select(Waitlist.status).where(
                    Waitlist.practice_id == full,
                    Waitlist.user_id == _uid(w["student"]),
                )
            )
        )
        .scalars()
        .all()
    )
    assert statuses == [WaitlistStatus.REMOVED.value]


@pytest.mark.asyncio
async def test_k2_a_confirmation_in_flight_ends_cancelled(
    client: AsyncClient,
    db_session: AsyncSession,
    world: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """K2 for the other booking door: confirm_waitlist, paused after its
    gate, holds the member row; the block waits, then cancels the booking
    the confirmation made."""
    w = world
    practice = await _practice(
        db_session, w["master"], w["group_id"], max_participants=1
    )
    entry = await _seed_queue(
        db_session, practice, w["student"], WaitlistStatus.NOTIFIED.value, 1
    )

    async def _confirm(session: AsyncSession):
        user = await session.get(User, _uid(w["student"]))
        return await waitlist_service.confirm_waitlist(entry, user, session)

    result = await race(
        monkeypatch,
        holder=_confirm,
        pause_in=(waitlist_service, "assert_viewer_can_access_practice"),
        pause="after",
        rival=_block_call(w, w["student"]),
    )
    assert not result.holder.deadlocked and not result.rival.deadlocked
    assert result.holder.committed and result.rival.committed
    assert result.rival_waited
    bookings = (
        (
            await fresh_execute(
                select(Booking.status).where(
                    Booking.practice_id == practice,
                    Booking.user_id == _uid(w["student"]),
                )
            )
        )
        .scalars()
        .all()
    )
    assert bookings == [BookingStatus.CANCELLED.value]


def _patch_call(practice_id: UUID, user_id: UUID, body: dict):
    async def _call(session: AsyncSession):
        user = await session.get(User, user_id)
        return await practices_service.update_practice(
            practice_id,
            user,
            UpdatePracticeRequest(**body),
            session,
        )

    return _call


@pytest.mark.asyncio
async def test_k3_an_edit_in_flight_lands_before_the_block(
    client: AsyncClient,
    db_session: AsyncSession,
    world: dict,
    blocked_master: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """K3, edit first: the blocked-to-be master's PATCH holds his practice
    and has read "not blocked"; the block wants that practice (its K3 set)
    and waits, so the edit commits strictly before the block does."""
    w, x = world, blocked_master
    practice = await _practice(db_session, x, w["group_id"])
    result = await race(
        monkeypatch,
        holder=_patch_call(practice, _uid(x), {"title": "До блока"}),
        pause_in=(practices_service, "_refuse_blocked_in_school"),
        pause="after",
        rival=_block_call(w, x),
    )
    assert not result.holder.deadlocked and not result.rival.deadlocked
    assert result.holder.committed and result.rival.committed
    assert result.rival_waited


@pytest.mark.asyncio
async def test_k3_an_edit_landing_inside_a_block_is_refused(
    client: AsyncClient,
    db_session: AsyncSession,
    world: dict,
    blocked_master: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """K3, block first: paused after it took the master's practices; the
    PATCH waits on its practice and, once the block commits, reads it ->
    403 blocked_in_group, the title unchanged. Without the master's own
    practices in the block's lock set the PATCH does not wait, reads an
    uncommitted block as absent and lands its edit beside the block."""
    w, x = world, blocked_master
    practice = await _practice(db_session, x, w["group_id"], title="Было")
    result = await race(
        monkeypatch,
        holder=_block_call(w, x),
        pause_in=(curator_service, "_close_school_practices_to"),
        pause="after",
        rival=_patch_call(practice, _uid(x), {"title": "Стало"}),
    )
    assert not result.holder.deadlocked and not result.rival.deadlocked
    assert result.holder.committed, result.holder.error
    assert result.rival_waited
    assert getattr(result.rival.error, "code", None) == "blocked_in_group"
    title = (
        await fresh_execute(select(Practice.title).where(Practice.id == practice))
    ).scalar_one()
    assert title == "Было"


@pytest.mark.asyncio
@pytest.mark.parametrize("block_holds", [True, False])
async def test_master_profile_after_the_practice_closes_no_cycle(
    client: AsyncClient,
    db_session: AsyncSession,
    world: dict,
    monkeypatch: pytest.MonkeyPatch,
    block_holds: bool,
) -> None:
    """THE MEASUREMENT (gate ruling B4, reformulated at the gate: the same
    practice cannot meet -- a draft has no bookings). The block refunds the
    student's booking on master M's practice and so takes M's profile FOR
    UPDATE after that practice; the curator publishing ANOTHER practice of
    M -- a draft -- takes M's profile FOR SHARE before its practice. Both
    start orders: the two meet on the profile (rival_waited in each), and
    both commit -- no 40P01."""
    w = world
    booked = await _practice(db_session, w["master"], w["group_id"])
    await _booked(client, w["student"], booked)
    draft = await _practice(
        db_session,
        w["master"],
        w["group_id"],
        status=PracticeStatus.DRAFT.value,
    )
    publish = _patch_call(draft, _uid(w["curator"]), {"status": "scheduled"})
    if block_holds:
        result = await race(
            monkeypatch,
            holder=_block_call(w, w["student"]),
            pause_in=(curator_service, "_close_school_practices_to"),
            pause="after",
            rival=publish,
        )
    else:
        result = await race(
            monkeypatch,
            holder=publish,
            pause_in=(practices_service, "_lock_school_master_or_400"),
            pause="after",
            rival=_block_call(w, w["student"]),
        )
    assert not result.holder.deadlocked and not result.rival.deadlocked
    assert result.holder.committed and result.rival.committed, (
        result.holder.error,
        result.rival.error,
    )
    assert result.rival_waited
    assert await _refunds(booked) == 1
    status = (
        await fresh_execute(select(Practice.status).where(Practice.id == draft))
    ).scalar_one()
    assert status == PracticeStatus.SCHEDULED.value


@pytest.mark.asyncio
async def test_a_block_after_the_persons_own_cancellation_refunds_once(
    client: AsyncClient,
    db_session: AsyncSession,
    world: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The person cancels their own booking while the block runs into it:
    the cancellation holds the practice past its refund; the block waits
    on that practice and, re-reading under its lock, no longer finds a
    live booking -- one refund, and the reason stays the person's."""
    w = world
    practice = await _practice(db_session, w["master"], w["group_id"])
    booking_id = await _booked(client, w["student"], practice)

    async def _cancel(session: AsyncSession):
        user = await session.get(User, _uid(w["student"]))
        return await bookings_service.cancel_booking(
            booking_id,
            user,
            session,
            reason="Сам",
        )

    result = await race(
        monkeypatch,
        holder=_cancel,
        pause_in=(bookings_service, "refund_booking"),
        pause="after",
        rival=_block_call(w, w["student"]),
    )
    assert not result.holder.deadlocked and not result.rival.deadlocked
    assert result.holder.committed and result.rival.committed
    assert result.rival_waited
    assert await _refunds(practice) == 1
    assert (await _booking(booking_id)).cancellation_reason == "Сам"


@pytest.mark.asyncio
async def test_a_blocked_masters_own_cancellation_meets_the_block_without_a_deadlock(
    client: AsyncClient,
    db_session: AsyncSession,
    world: dict,
    blocked_master: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """B2 under a race: the block holds the master's practice (K3); his own
    cancellation of it waits and then goes through. Both commit."""
    w, x = world, blocked_master
    practice = await _practice(db_session, x, w["group_id"])
    other = await _student(client, _TID_STUDENT_B)
    await _member(db_session, w["group_id"], other)
    await _booked(client, other, practice)

    async def _cancel(session: AsyncSession):
        from app.modules.practices.cancel_service import cancel_practice

        user = await session.get(User, _uid(x))
        return await cancel_practice(practice, user, session)

    result = await race(
        monkeypatch,
        holder=_block_call(w, x),
        pause_in=(curator_service, "_close_school_practices_to"),
        pause="after",
        rival=_cancel,
    )
    assert not result.holder.deadlocked and not result.rival.deadlocked
    assert result.holder.committed and result.rival.committed, (
        result.holder.error,
        result.rival.error,
    )
    assert result.rival_waited
    status = (
        await fresh_execute(select(Practice.status).where(Practice.id == practice))
    ).scalar_one()
    assert status == PracticeStatus.CANCELLED.value
