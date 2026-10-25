# =============================================================================
# VELO -- a new state revokes the undelivered old one (BE-171)
# =============================================================================
# Band 55080-55119.
#
# What is under test, and why each one exists:
#
#   1. THE LISTS: what each transition revokes, written in one place
#      (core/events/reminders.py) -- and no list names a reminder type:
#      the reminders are moved by their own functions, a revocation naming
#      them would take the re-scheduled ones too.
#   2. THE LABELS: every state the transitions revoke carries the
#      correlation the revocation names -- the booking's or the practice's
#      -- so comms' equality match can find it.
#   3. THE ORDER: in the outbox the revocation comes BEFORE the new state
#      (lower id), which is the order the relay and comms keep.
#   4. THE TRANSITIONS: a move revokes an earlier move and nothing of the
#      booking; a cancellation revokes the move, the spot offer, the
#      announcement, the curator's word, and each booking's state; a
#      student's cancellation revokes their booking's state; a curator's
#      act revokes the earlier act.
#   5. THE WAITLIST SHEETS name the deadline by a variable.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import pytest
import yaml
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.events.models import OutboxEvent
from app.core.events.reminders import (
    BOOKING_REMINDER_TYPES,
    BOOKING_STATE_TYPES,
    CANCELLATION_REVOKES,
    CURATOR_ACT_TYPES,
    MASTER_REMINDER_TYPES,
    PRACTICE_STATE_TYPES,
    RESCHEDULE_REVOKES,
    booking_correlation,
    practice_correlation,
)
from app.modules.curator_groups.models import CuratorGroup
from app.modules.diary.models import Checkin
from app.modules.diary.notify_master import notify_master_of_checkin
from app.modules.masters.models import MasterProfile
from app.modules.practices import service as practices_service
from app.modules.practices.models import Practice
from app.modules.users.models import User, UserRole
from app.modules.waitlist.models import Waitlist
from app.modules.waitlist.service import process_waitlist
from tests.helpers import auth_headers, fresh_execute, full_cleanup_range, login_user

BAND_MIN, BAND_MAX = 55080, 55119

PRACTICES_URL = "/api/v1/practices"
BOOKINGS_URL = "/api/v1/bookings"
_PROFILE = Path(__file__).resolve().parents[2] / "comms-profile"


@pytest.fixture(autouse=True)
async def _band(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    # full_cleanup_range deletes and leaves the commit to its caller (its
    # docstring); uncommitted, the next call's defensive rollback undid it,
    # and this file's data outlived it (BE-171 fix).
    await full_cleanup_range(db_session, BAND_MIN, BAND_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, BAND_MIN, BAND_MAX, delete_users=True)
    await db_session.commit()


async def _master(client: AsyncClient, db_session: AsyncSession, offset: int) -> dict:
    tid = BAND_MIN + offset
    auth = await login_user(client, telegram_id=tid, first_name="Master")
    user = await db_session.get(User, UUID(auth["user"]["id"]))
    user.role = UserRole.MASTER
    await db_session.flush()
    db_session.add(
        MasterProfile(
            user_id=user.id,
            data={"account": {"status": "verified"}, "profile": {"bio": "m"}},
        )
    )
    await db_session.commit()
    return await login_user(client, telegram_id=tid, first_name="Master")


async def _publish(client: AsyncClient, master: dict) -> str:
    headers = auth_headers(master["session_token"])
    created = await client.post(
        PRACTICES_URL,
        json={
            "practice_type": "live",
            "direction": "meditation",
            "difficulty": "beginner",
            "title": "BE-171",
            "description": "Guided session",
            "scheduled_at": (datetime.now(UTC) + timedelta(days=3)).isoformat(),
            "duration_minutes": 60,
            "timezone": "UTC",
            "max_participants": 20,
            "is_free": True,
            "price_cents": 0,
            "currency": "eur",
        },
        headers=headers,
    )
    assert created.status_code == 201, created.text
    practice_id = created.json()["id"]
    published = await client.patch(
        f"{PRACTICES_URL}/{practice_id}",
        json={"status": "scheduled"},
        headers=headers,
    )
    assert published.status_code == 200, published.text
    return practice_id


async def _book(client: AsyncClient, student: dict, practice_id: str) -> str:
    resp = await client.post(
        BOOKINGS_URL,
        json={"practice_id": practice_id},
        headers=auth_headers(student["session_token"]),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _move(client: AsyncClient, master: dict, practice_id: str, days: int) -> None:
    resp = await client.patch(
        f"{PRACTICES_URL}/{practice_id}",
        json={"scheduled_at": (datetime.now(UTC) + timedelta(days=days)).isoformat()},
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 200, resp.text


async def _cancel(client: AsyncClient, master: dict, practice_id: str) -> None:
    resp = await client.post(
        f"{PRACTICES_URL}/{practice_id}/cancel",
        json={},
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code in (200, 204), resp.text


async def _outbox(correlations: set[str]) -> list[OutboxEvent]:
    """Every outbox row -- notifications and cancels -- under these
    correlations, in id order (the order comms receives them)."""
    return list(
        (
            await fresh_execute(
                select(OutboxEvent)
                .where(OutboxEvent.payload["correlation"].astext.in_(correlations))
                .order_by(OutboxEvent.id)
            )
        ).scalars()
    )


def _notices(rows: list[OutboxEvent], type_: str) -> list[OutboxEvent]:
    return [
        r
        for r in rows
        if r.event_type != "reminder_cancel" and r.payload["type"] == type_
    ]


def _revokes(rows: list[OutboxEvent], types: list[str]) -> list[OutboxEvent]:
    return [
        r
        for r in rows
        if r.event_type == "reminder_cancel" and r.payload["types"] == types
    ]


# ---------------------------------------------------------------------------
# 1. The lists
# ---------------------------------------------------------------------------


def test_no_revocation_list_names_a_reminder() -> None:
    """booking.reminder_* and practice.master_reminder_1h are moved and
    cancelled by their own functions -- a reschedule re-schedules them right
    after its revocation; a list naming them would take the new ones."""
    reminders = set(BOOKING_REMINDER_TYPES) | set(MASTER_REMINDER_TYPES)
    for name, types in (
        ("BOOKING_STATE_TYPES", BOOKING_STATE_TYPES),
        ("RESCHEDULE_REVOKES", RESCHEDULE_REVOKES),
        ("CANCELLATION_REVOKES", CANCELLATION_REVOKES),
        ("CURATOR_ACT_TYPES", CURATOR_ACT_TYPES),
        ("PRACTICE_STATE_TYPES", PRACTICE_STATE_TYPES),
    ):
        assert types, name
        assert not reminders & set(types), name


def test_every_listed_type_is_declared_and_the_acts_are_the_curators() -> None:
    declared = set(yaml.safe_load((_PROFILE / "types.yaml").read_text())["types"])
    for types in (BOOKING_STATE_TYPES, CANCELLATION_REVOKES, PRACTICE_STATE_TYPES):
        assert set(types) <= declared
    acts = {
        practices_service._CURATOR_CREATED.type,
        practices_service._CURATOR_PUBLISHED.type,
        practices_service._CURATOR_EDITED.type,
        practices_service._CURATOR_DELETED.type,
    }
    assert set(CURATOR_ACT_TYPES) == acts
    # The lists, written out -- the transitions' tests compare events with
    # these very constants, so what is IN them is held here.
    # A move does not revoke what a booking or an announcement says.
    assert set(RESCHEDULE_REVOKES) == {"practice.rescheduled"}
    assert set(BOOKING_STATE_TYPES) == {
        "booking.confirmed",
        "practice.checkin_received",
    }
    assert set(CANCELLATION_REVOKES) == {
        "practice.rescheduled",
        "waitlist.spot_available",
        "curator_group.practice_published",
        *acts,
    }


# ---------------------------------------------------------------------------
# 2-4. Labels, order, transitions
# ---------------------------------------------------------------------------


async def test_a_move_revokes_an_earlier_move_and_nothing_of_the_booking(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    master = await _master(client, db_session, 0)
    student = await login_user(client, telegram_id=BAND_MIN + 1, first_name="S")
    practice_id = await _publish(client, master)
    booking_id = await _book(client, student, practice_id)
    p_corr, b_corr = practice_correlation(practice_id), booking_correlation(booking_id)

    rows = await _outbox({b_corr})
    (confirmed,) = _notices(rows, "booking.confirmed")
    assert confirmed.payload["correlation"] == b_corr

    await _move(client, master, practice_id, days=4)
    rows = await _outbox({p_corr, b_corr})
    (revoke,) = _revokes(rows, RESCHEDULE_REVOKES)
    assert revoke.payload["correlation"] == p_corr
    assert "target_type" not in revoke.payload
    (moved,) = _notices(rows, "practice.rescheduled")
    assert moved.payload["correlation"] == p_corr
    assert revoke.id < moved.id
    # The booking lives on: its "you're booked" is not revoked by a move.
    assert _revokes(rows, BOOKING_STATE_TYPES) == []


async def test_a_cancellation_revokes_the_move_and_each_booking_state_first(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Moved, then cancelled while the move may still wait for the window:
    the cancellation's revocation names practice.rescheduled under the
    move's own correlation, and comes after the move and before the
    cancellation notice -- comms closes the move as `cancelled`."""
    master = await _master(client, db_session, 2)
    students = [
        await login_user(client, telegram_id=BAND_MIN + 3 + i, first_name="S")
        for i in range(2)
    ]
    practice_id = await _publish(client, master)
    bookings = [await _book(client, s, practice_id) for s in students]
    await _move(client, master, practice_id, days=4)
    await _cancel(client, master, practice_id)

    p_corr = practice_correlation(practice_id)
    b_corrs = {booking_correlation(b) for b in bookings}
    rows = await _outbox({p_corr, *b_corrs})
    moves = _notices(rows, "practice.rescheduled")
    assert len(moves) == 2  # one per booked student
    moved = moves[-1]
    (cancel_revoke,) = _revokes(rows, CANCELLATION_REVOKES)
    assert "practice.rescheduled" in cancel_revoke.payload["types"]
    assert "waitlist.spot_available" in cancel_revoke.payload["types"]
    assert (
        cancel_revoke.payload["correlation"] == moved.payload["correlation"] == p_corr
    )
    booking_revokes = _revokes(rows, BOOKING_STATE_TYPES)
    assert {r.payload["correlation"] for r in booking_revokes} == b_corrs
    assert all("target_type" not in r.payload for r in booking_revokes)
    notices = _notices(rows, "practice.cancelled")
    assert len(notices) == 2
    assert all(n.payload["correlation"] == p_corr for n in notices)
    first_notice = min(n.id for n in notices)
    assert moved.id < cancel_revoke.id < first_notice
    assert max(r.id for r in booking_revokes) < first_notice


async def test_a_student_cancelling_revokes_the_booking_state_first(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    master = await _master(client, db_session, 5)
    student = await login_user(client, telegram_id=BAND_MIN + 6, first_name="S")
    practice_id = await _publish(client, master)
    booking_id = await _book(client, student, practice_id)
    resp = await client.delete(
        f"{BOOKINGS_URL}/{booking_id}",
        headers=auth_headers(student["session_token"]),
    )
    assert resp.status_code == 200, resp.text

    b_corr = booking_correlation(booking_id)
    (revoke,) = _revokes(await _outbox({b_corr}), BOOKING_STATE_TYPES)
    (told,) = (
        (
            await fresh_execute(
                select(OutboxEvent).where(
                    OutboxEvent.payload["idempotency_key"].astext
                    == f"booking-cancelled:{booking_id}"
                )
            )
        )
        .scalars()
        .all()
    )
    assert told.payload["type"] == "booking.cancelled_by_user"
    assert revoke.id < told.id
    assert "target_type" not in revoke.payload


async def test_a_check_in_carries_its_booking(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """practice.checkin_received is revoked by its booking's correlation
    when the booking ends -- so it carries that correlation."""
    master = await _master(client, db_session, 7)
    student = await login_user(client, telegram_id=BAND_MIN + 8, first_name="S")
    practice_id = await _publish(client, master)
    booking_id = await _book(client, student, practice_id)
    practice = await db_session.get(Practice, UUID(practice_id))
    author = await db_session.get(User, UUID(student["user"]["id"]))
    checkin = Checkin(id=uuid4(), booking_id=UUID(booking_id), mood=5, comment=None)
    assert await notify_master_of_checkin(
        db_session,
        checkin=checkin,
        practice=practice,
        author=author,
    )
    await db_session.commit()
    (notice,) = _notices(
        await _outbox({booking_correlation(booking_id)}), "practice.checkin_received"
    )
    assert notice.payload["target_value"] == master["user"]["id"]


async def test_a_spot_offer_carries_its_practice(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    master = await _master(client, db_session, 9)
    waiter = await login_user(client, telegram_id=BAND_MIN + 10, first_name="W")
    practice_id = await _publish(client, master)
    db_session.add(
        Waitlist(
            practice_id=UUID(practice_id),
            user_id=UUID(waiter["user"]["id"]),
            position=1,
            joined_at=datetime.now(UTC),
        )
    )
    await db_session.commit()
    assert await process_waitlist(UUID(practice_id), db_session) is not None
    await db_session.commit()
    (offer,) = _notices(
        await _outbox({practice_correlation(practice_id)}),
        "waitlist.spot_available",
    )
    assert offer.payload["target_value"] == waiter["user"]["id"]


async def test_a_curator_act_revokes_the_earlier_act_first(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    master = await _master(client, db_session, 11)
    curator_auth = await login_user(client, telegram_id=BAND_MIN + 12, first_name="C")
    practice_id = await _publish(client, master)
    curator = await db_session.get(User, UUID(curator_auth["user"]["id"]))
    # A curator acts on a practice of their school.
    group = CuratorGroup(curator_user_id=curator.id, name="BE-171 school")
    db_session.add(group)
    await db_session.flush()
    practice = await db_session.get(Practice, UUID(practice_id))
    practice.curator_group_id = group.id
    await db_session.commit()
    await practices_service._tell_master_of_curator_act(
        curator,
        practice,
        practices_service._CURATOR_EDITED,
        db_session,
    )
    await db_session.commit()
    rows = await _outbox({practice_correlation(practice_id)})
    (revoke,) = _revokes(rows, CURATOR_ACT_TYPES)
    (edited,) = _notices(rows, "curator_group.master_practice_edited")
    assert revoke.id < edited.id
    assert edited.payload["target_value"] == master["user"]["id"]


async def test_a_school_block_revokes_the_booking_state(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A person blocked in a school loses their future bookings of its
    practices (BE-79): each booking's reminder series is cancelled and,
    since BE-171, its undelivered state revoked -- the school path, next to
    the master's (tests/test_master_groups.py)."""
    from app.modules.curator_groups.service import _close_school_practices_to

    master = await _master(client, db_session, 13)
    student = await login_user(client, telegram_id=BAND_MIN + 14, first_name="S")
    curator_auth = await login_user(client, telegram_id=BAND_MIN + 15, first_name="C")
    practice_id = await _publish(client, master)
    booking_id = await _book(client, student, practice_id)
    group = CuratorGroup(
        curator_user_id=UUID(curator_auth["user"]["id"]), name="BE-171 b"
    )
    db_session.add(group)
    await db_session.flush()
    practice = await db_session.get(Practice, UUID(practice_id))
    practice.curator_group_id = group.id
    await db_session.commit()

    await _close_school_practices_to(group.id, UUID(student["user"]["id"]), db_session)
    await db_session.commit()

    rows = await _outbox({booking_correlation(booking_id)})
    (revoke,) = _revokes(rows, BOOKING_STATE_TYPES)
    assert "target_type" not in revoke.payload
    assert _revokes(rows, BOOKING_REMINDER_TYPES)  # the series, as before


# ---------------------------------------------------------------------------
# 5. The waitlist sheets
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("locale,literal", [("ru", "30 минут"), ("en", "30 minutes")])
def test_the_waitlist_sheet_names_the_deadline_by_a_variable(
    locale: str,
    literal: str,
) -> None:
    """The window is _CONFIRM_WINDOW in code; a literal in the sheet would
    turn false the day it changes. The sheet reads expires_at -- already in
    every spot_available's action_data, in the reader's zone."""
    sheets = yaml.safe_load((_PROFILE / "templates" / f"{locale}.yaml").read_text())
    body = sheets["waitlist.spot_available"]["telegram"]["body"]
    assert "{expires_at}" in body
    assert literal not in body
