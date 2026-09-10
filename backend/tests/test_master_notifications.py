# =============================================================================
# VELO Backend -- Tests: notifications behind the master's settings screen
# (BE-33)
# =============================================================================
#
# telegram_id band: 65900-65999 (master 65901-65902, participants 65910-65913,
# admin 65990). Declared module-level below as _TID_MIN/_TID_MAX, ONCE --
# tests/telegram_id_bands.py parses that declaration out of the AST on every
# run, and a file using ids without declaring a band fails
# test_blind_zone_has_not_grown. Checked free before it was claimed:
# free_windows(space=(65000, 65999)) returned [(65900, 65999)].
#
# WHAT THIS FILE CAN AND CANNOT PROVE, stated once so the gaps are not read
# as oversights.
#
# The MUTE GATE AND THE QUIET-HOURS DEFERRAL LIVE IN COMMS, not here:
# service.resolve_notification drops muted recipients, service.
# deliver_notification defers inside a window. Velo's suite observes
# OutboxEvent rows and starts no comms stack, so "the toggle actually
# silences it" is not a sentence this file can end. It is covered, type
# -agnostically, by comms tests/test_prefs_gating.py and tests/
# test_quiet_hours.py -- no hardcoded category list exists there, so a new
# category falls under them by construction.
#
# What IS provable here, and is what these tests assert:
#   1. the notification is emitted, to the right person, with the right
#      payload and timing;
#   2. the type -> category mapping in comms-profile/types.yaml is the one
#      the gate will read;
#   3. two rows of the settings screen resolve to two DIFFERENT categories
#      -- which is the whole content of "two switches, not one", and the
#      only part of it that can be wrong on our side.
#
# EVERY "IS NOT THERE" IS PAIRED WITH AN "IS THERE" IN THE SAME TEST. An
# assertion that no notification was emitted passes just as happily when the
# emit path is broken for everyone.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID

import pytest
import yaml
from httpx import AsyncClient
from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.events.models import OutboxEvent
from app.core.events.reminders import (
    BOOKING_REMINDER_TYPES,
    MASTER_REMINDER_TYPE,
)
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.diary.models import Checkin, CheckType, Feedback
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import (
    Practice,
    PracticeStatus,
    PracticeType,
)
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user

PRACTICES_URL = "/api/v1/practices"
CHECKIN_URL = "/api/v1/practices/{practice_id}/checkin"
FEEDBACK_URL = "/api/v1/practices/{practice_id}/feedback"
ATTENDANCE_URL = "/api/v1/practices/{practice_id}/attendance"

_TID_MIN = 65900
_TID_MAX = 65999

_TID_MASTER = 65901
_TID_MASTER_B = 65902
_TID_PARTICIPANT = 65910
_TID_PARTICIPANT_B = 65911

_PROFILE_DIR = Path(__file__).resolve().parents[2] / "comms-profile"

_CHECKIN_TYPE = "practice.checkin_received"
_FEEDBACK_TYPE = "practice.feedback_received"

# Scores that must never appear on the wire, as strings: the payload is
# JSON, so a leaked int would arrive as one of these.
_RAW_SCORES = {str(n) for n in range(1, 11)}


# ===========================================================================
# Local helpers. Copied rather than imported, the convention in every test
# file here. No default telegram_id on any of them.
# ===========================================================================


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int,
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
            data={
                "account": {"status": "verified"},
                "profile": {"bio": "m"},
            },
        )
    )
    await db_session.flush()
    await db_session.commit()
    return await login_user(
        client, telegram_id=telegram_id, first_name=first_name,
    )


async def _participant(
    client: AsyncClient, telegram_id: int, first_name: str = "Аня",
) -> dict:
    return await login_user(
        client, telegram_id=telegram_id, first_name=first_name,
    )


def _practice_body(**overrides: object) -> dict:
    base: dict = {
        "practice_type": "live",
        "direction": "meditation",
        "difficulty": "beginner",
        "title": "Утренняя практика",
        "description": "Guided session",
        "scheduled_at": (
            datetime.now(UTC) + timedelta(days=8)
        ).isoformat(),
        "duration_minutes": 60,
        "timezone": "UTC",
        "max_participants": 20,
        "is_free": True,
        "price_cents": 0,
        "currency": "eur",
    }
    base.update(overrides)
    return base


async def _create_and_publish(
    client: AsyncClient, master: dict, **overrides: object,
) -> str:
    """Create a draft and publish it -- the transition BE-33 hooks."""
    created = await client.post(
        PRACTICES_URL,
        json=_practice_body(**overrides),
        headers=auth_headers(master["session_token"]),
    )
    assert created.status_code == 201, created.text
    practice_id = created.json()["id"]
    published = await client.patch(
        f"{PRACTICES_URL}/{practice_id}",
        json={"status": "scheduled"},
        headers=auth_headers(master["session_token"]),
    )
    assert published.status_code == 200, published.text
    return practice_id


async def _events(
    session: AsyncSession, *, type_: str, to: dict,
) -> list[dict]:
    """Notification payloads of one type ADDRESSED TO ONE PERSON, oldest
    first.

    The addressee is mandatory, not a convenience. The outbox is one table
    for the whole suite and every other file that publishes a practice now
    emits a master reminder too; an unscoped query here counted forty of
    them and would have gone on passing for the wrong reason the day this
    file's own emit broke.
    """
    rows = (
        await session.execute(
            select(OutboxEvent)
            .where(
                OutboxEvent.payload["type"].astext == type_,
                OutboxEvent.payload["target_value"].astext
                == to["user"]["id"],
            )
            .order_by(OutboxEvent.id)
        )
    ).scalars().all()
    return [row.payload for row in rows]


async def _cancel_events(session: AsyncSession) -> list[dict]:
    """reminder_cancel payloads, oldest first."""
    rows = (
        await session.execute(
            select(OutboxEvent)
            .where(OutboxEvent.payload["correlation_key"].astext.isnot(None))
            .order_by(OutboxEvent.id)
        )
    ).scalars().all()
    return [row.payload for row in rows]


async def _seed_booking(
    db_session: AsyncSession,
    practice_id: str,
    who: dict,
    status: str = BookingStatus.CONFIRMED.value,
) -> Booking:
    booking = Booking(
        practice_id=UUID(practice_id),
        user_id=UUID(who["user"]["id"]),
        status=status,
    )
    db_session.add(booking)
    await db_session.flush()
    await db_session.commit()
    return booking


async def _pull_practice_into_checkin_window(
    db_session: AsyncSession, practice_id: str,
) -> Practice:
    """Move the practice close enough that the check-in window is open.

    The window is settings.checkin_window_hours before the start; the
    default draft above sits eight days out, which is outside it.
    """
    practice = await db_session.get(Practice, UUID(practice_id))
    practice.scheduled_at = datetime.now(UTC) + timedelta(minutes=30)
    await db_session.flush()
    await db_session.commit()
    return practice


def _load_profile() -> dict:
    return yaml.safe_load((_PROFILE_DIR / "types.yaml").read_text())


def _category_of(type_key: str) -> str | None:
    spec = _load_profile()[type_key]
    return None if spec is None else spec.get("category")


# ===========================================================================
# Cleanup. Users go, and so do the outbox rows addressed to them -- the
# helper knows nothing about the outbox, and a leftover notification_request
# from one test is a passing assertion in the next.
# ===========================================================================


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    async def _wipe() -> None:
        ids = (
            await db_session.execute(
                select(User.id).where(
                    User.telegram_id.between(_TID_MIN, _TID_MAX),
                )
            )
        ).scalars().all()
        if ids:
            target = OutboxEvent.payload["target_value"].astext
            await db_session.execute(
                delete(OutboxEvent).where(
                    or_(*[target == str(uid) for uid in ids])
                )
            )
        await full_cleanup_range(
            db_session, _TID_MIN, _TID_MAX, delete_users=True,
        )
        await db_session.commit()

    await _wipe()
    yield
    await _wipe()


# ===========================================================================
# Item 7 -- the profile, machine-checked. No database, no HTTP: these read
# the three YAML files that ARE the contract.
# ===========================================================================


class TestProfile:
    def test_every_template_sheet_names_a_declared_type(self) -> None:
        """A sheet for a type nobody declares renders for nothing.

        Templates are a SUBSET, not an equal set: support.thread_created is
        declared with no sheet on purpose (it goes to group:admins), so the
        assertion is containment and the known exception is named here
        rather than silently allowed by a weaker check.
        """
        types = set(_load_profile())
        for locale in ("ru", "en"):
            sheets = set(
                yaml.safe_load(
                    (_PROFILE_DIR / "templates" / f"{locale}.yaml").read_text()
                )
            )
            assert sheets <= types, f"{locale}: {sorted(sheets - types)}"

        ru = set(
            yaml.safe_load(
                (_PROFILE_DIR / "templates" / "ru.yaml").read_text()
            )
        )
        assert types - ru == {"support.thread_created"}

    def test_the_two_locales_carry_the_same_sheets(self) -> None:
        """A type translated into one locale and not the other is how a
        Russian user gets an English notification -- or none."""
        ru = yaml.safe_load(
            (_PROFILE_DIR / "templates" / "ru.yaml").read_text()
        )
        en = yaml.safe_load(
            (_PROFILE_DIR / "templates" / "en.yaml").read_text()
        )
        assert set(ru) == set(en)
        for key in ru:
            assert set(ru[key]["telegram"]) == set(en[key]["telegram"]), key

    def test_the_three_new_types_carry_the_intended_categories(self) -> None:
        """A new type that lost its category becomes non-mutable BY
        MECHANISM (decision A) -- silently, and in the direction nobody
        notices until a master cannot switch a feed off."""
        assert _category_of(MASTER_REMINDER_TYPE) == "master_reminders"
        assert _category_of(_CHECKIN_TYPE) == "practice_checkins"
        assert _category_of(_FEEDBACK_TYPE) == "practice_reviews"

    def test_the_masters_reminder_is_not_in_the_participant_family(
        self,
    ) -> None:
        """Item 2's whole reason: one switch would kill both.

        booking.reminder_1h reaches a master AS A PARTICIPANT of somebody
        else's practice. Sharing a category with his own teaching reminders
        would mean a single toggle for "remind me about the classes I take"
        and "remind me about the classes I teach".
        """
        assert _category_of("booking.reminder_1h") == "reminders"
        assert _category_of(MASTER_REMINDER_TYPE) != "reminders"

    def test_check_ins_and_reviews_are_two_categories(self) -> None:
        """Two rows on the screen, two categories -- items 5 and 6."""
        assert _category_of(_CHECKIN_TYPE) != _category_of(_FEEDBACK_TYPE)

    def test_participant_and_support_messages_are_two_categories(
        self,
    ) -> None:
        """Item 3, and it is a profile fact rather than a code path: velo
        never emits msg.* -- the messaging engine does. What velo owns is
        the mapping, and the mapping is what the gate reads.

        msg.thread_closed rides with participant messages deliberately:
        it is the same conversation ending.
        """
        assert _category_of("msg.participant_message") == "msg_participants"
        assert _category_of("msg.support_message") == "msg_support"
        assert _category_of("msg.thread_closed") == "msg_participants"

    def test_booking_cancellation_is_the_bookings_family(self) -> None:
        """Item 1's mapping half: the row labelled "Отмена бронирования" on
        the master's screen is the whole `bookings` category, which today
        holds exactly one master-facing type. The assertion pins today's
        truth; see the delivery report's observation for why the label is
        one added type away from lying."""
        assert _category_of("booking.cancelled_by_user") == "bookings"
        assert _category_of("booking.confirmed") == "bookings"


# ===========================================================================
# Item 2 -- the master's own reminder
# ===========================================================================


@pytest.mark.asyncio
async def test_publishing_schedules_the_masters_own_reminder(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """One reminder, to the master, an hour before his own session.

    Correlated by practice_id and NOT by booking_id: the reminder belongs
    to the practice, and the missing key is asserted because its presence
    would quietly opt this reminder into the per-booking cancel as well.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    practice_id = await _create_and_publish(client, master)

    events = await _events(
        db_session, type_=MASTER_REMINDER_TYPE, to=master,
    )
    assert len(events) == 1
    payload = events[0]
    assert payload["target_value"] == master["user"]["id"]
    assert payload["action_data"]["practice_id"] == practice_id
    assert "booking_id" not in payload["action_data"]


@pytest.mark.asyncio
async def test_a_practice_nobody_booked_still_reminds_its_master(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """His practice, not his booking -- so an empty room changes nothing.

    The paired assertion is the participant series: zero booking reminders
    exist (nobody booked), one master reminder does. Without the pair, a
    world where every reminder is emitted would pass this too.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    await _create_and_publish(client, master)

    assert len(
        await _events(db_session, type_=MASTER_REMINDER_TYPE, to=master)
    ) == 1
    for booking_type in BOOKING_REMINDER_TYPES:
        assert await _events(db_session, type_=booking_type, to=master) == []


@pytest.mark.asyncio
async def test_cancelling_the_practice_cancels_the_masters_reminder(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The cancel event must NAME the master's type.

    comms expires `Notification.type.in_(types)` AND the correlation, so a
    type absent from the list survives the cancellation of its own
    practice -- it would fire an hour before a session that no longer
    exists. The booking types are asserted alongside: this list is
    additive, not a replacement.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    practice_id = await _create_and_publish(client, master)

    # POST /cancel, not DELETE: DELETE is the draft-only soft delete and
    # answers 400 for a published practice ("use cancel"). The wrong verb
    # here would have made this test pass on an exception.
    cancelled = await client.post(
        f"{PRACTICES_URL}/{practice_id}/cancel",
        json={},
        headers=auth_headers(master["session_token"]),
    )
    assert cancelled.status_code in (200, 204), cancelled.text

    cancels = [
        c for c in await _cancel_events(db_session)
        if c.get("correlation_value") == practice_id
    ]
    assert cancels, "no reminder_cancel was emitted for the practice"
    named = cancels[-1]["types"]
    assert MASTER_REMINDER_TYPE in named
    assert set(BOOKING_REMINDER_TYPES) <= set(named)


@pytest.mark.asyncio
async def test_rescheduling_re_anchors_the_masters_reminder(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Move the practice, move the reminder: cancel, then a fresh one.

    Two emissions in total and the second is anchored on the NEW time --
    asserting only "a reminder exists" would pass on a stale one still
    pointing at the old hour.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    practice_id = await _create_and_publish(client, master)
    new_time = datetime.now(UTC) + timedelta(days=12)

    moved = await client.patch(
        f"{PRACTICES_URL}/{practice_id}",
        json={"scheduled_at": new_time.isoformat()},
        headers=auth_headers(master["session_token"]),
    )
    assert moved.status_code == 200, moved.text

    events = await _events(
        db_session, type_=MASTER_REMINDER_TYPE, to=master,
    )
    assert len(events) == 2
    assert events[0]["action_data"]["scheduled_at"] != (
        events[1]["action_data"]["scheduled_at"]
    )

    cancels = [
        c for c in await _cancel_events(db_session)
        if c.get("correlation_value") == practice_id
    ]
    assert cancels and MASTER_REMINDER_TYPE in cancels[-1]["types"]


@pytest.mark.asyncio
async def test_every_session_of_a_series_reminds_the_master(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Not just the root -- one per occurrence.

    Series children are born SCHEDULED inside generate_series_occurrences
    and never pass update_practice's draft->scheduled branch (the same
    KNOWN GAP the Zoom rows are created there to close). Hooking only
    publication would remind the master about the first class of a course
    and about none of the others, which is worse than not reminding at
    all.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    created = await client.post(
        PRACTICES_URL,
        json=_practice_body(
            practice_type="series",
            recurrence={"period": "daily", "end": "after_count", "count": 4},
        ),
        headers=auth_headers(master["session_token"]),
    )
    assert created.status_code == 201, created.text
    published = await client.patch(
        f"{PRACTICES_URL}/{created.json()['id']}",
        json={"status": "scheduled"},
        headers=auth_headers(master["session_token"]),
    )
    assert published.status_code == 200, published.text

    events = await _events(
        db_session, type_=MASTER_REMINDER_TYPE, to=master,
    )
    practice_ids = {e["action_data"]["practice_id"] for e in events}
    assert len(events) == 4
    assert len(practice_ids) == 4


@pytest.mark.asyncio
async def test_a_practice_published_inside_the_hour_gets_no_reminder(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A reminder already due is skipped, never scheduled into the past.

    Paired with a normal publication in the same test, so "no reminder" is
    shown to be a property of the timing and not of the code path.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    await _create_and_publish(
        client,
        master,
        scheduled_at=(datetime.now(UTC) + timedelta(minutes=20)).isoformat(),
    )
    assert await _events(
        db_session, type_=MASTER_REMINDER_TYPE, to=master,
    ) == []

    await _create_and_publish(client, master)
    assert len(
        await _events(db_session, type_=MASTER_REMINDER_TYPE, to=master)
    ) == 1


# ===========================================================================
# Item 1 -- booking cancellation reaches the master
# ===========================================================================


@pytest.mark.asyncio
async def test_a_cancelled_booking_tells_the_master_and_the_booker_keeps_theirs(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """One category, two addressees -- both still work.

    booking.cancelled_by_user goes to the MASTER while booking.confirmed
    goes to the BOOKER, and both sit in `bookings`. The pair is the point:
    a test that only checked the master's message would pass in a world
    where the participant's had stopped being emitted at all.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    booker = await _participant(client, _TID_PARTICIPANT)
    practice_id = await _create_and_publish(client, master)

    booked = await client.post(
        "/api/v1/bookings",
        json={"practice_id": practice_id},
        headers=auth_headers(booker["session_token"]),
    )
    assert booked.status_code == 201, booked.text
    booking_id = booked.json()["id"]

    confirmed = await _events(
        db_session, type_="booking.confirmed", to=booker,
    )
    assert [e["target_value"] for e in confirmed] == [booker["user"]["id"]]

    cancelled = await client.delete(
        f"/api/v1/bookings/{booking_id}",
        headers=auth_headers(booker["session_token"]),
    )
    assert cancelled.status_code in (200, 204), cancelled.text

    to_master = await _events(
        db_session, type_="booking.cancelled_by_user", to=master,
    )
    assert [e["target_value"] for e in to_master] == [master["user"]["id"]]


# ===========================================================================
# Items 5 and 6 -- check-ins and reviews reach the master
# ===========================================================================


@pytest.mark.asyncio
async def test_a_checkin_tells_the_master_with_the_name_and_the_comment(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """One message per check-in, carrying the thing worth reading.

    The comment is why these are sent one by one instead of as a digest
    (owner ruling): "болит спина" is actionable before the session and
    worthless in a count afterwards.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    booker = await _participant(client, _TID_PARTICIPANT, first_name="Аня")
    practice_id = await _create_and_publish(client, master)
    await _seed_booking(db_session, practice_id, booker)
    await _pull_practice_into_checkin_window(db_session, practice_id)

    done = await client.post(
        CHECKIN_URL.format(practice_id=practice_id),
        json={"mood": 9, "comment": "болит спина"},
        headers=auth_headers(booker["session_token"]),
    )
    assert done.status_code in (200, 201), done.text

    events = await _events(db_session, type_=_CHECKIN_TYPE, to=master)
    assert len(events) == 1
    assert events[0]["action_data"]["participant_name"] == "Аня"
    assert events[0]["action_data"]["comment"] == "болит спина"


@pytest.mark.asyncio
async def test_the_mood_leaves_as_a_bucket_while_the_roster_keeps_the_score(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The number stays inside the app; the notification carries a bucket.

    THE PAIR IS THE ARGUMENT. This is not the GT-28 ceiling -- the master
    reads the raw 1..10 in his own attendance roster, and this test asserts
    that he still does. What changes is the SURFACE: a Telegram message
    lands in a chat history that outlives the practice, and a participant's
    exact score has no business living there. Anyone "fixing" the bucket
    back to a number will break the first half of this test and read the
    reason here.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    booker = await _participant(client, _TID_PARTICIPANT)
    practice_id = await _create_and_publish(client, master)
    await _seed_booking(db_session, practice_id, booker)
    await _pull_practice_into_checkin_window(db_session, practice_id)

    done = await client.post(
        CHECKIN_URL.format(practice_id=practice_id),
        json={"mood": 9, "comment": None},
        headers=auth_headers(booker["session_token"]),
    )
    assert done.status_code in (200, 201), done.text

    events = await _events(db_session, type_=_CHECKIN_TYPE, to=master)
    assert len(events) == 1
    mood = events[0]["action_data"]["mood"]
    assert isinstance(mood, str)
    assert mood not in _RAW_SCORES
    assert "9" not in events[0]["body"]

    roster = await client.get(
        ATTENDANCE_URL.format(practice_id=practice_id),
        headers=auth_headers(master["session_token"]),
    )
    assert roster.status_code == 200, roster.text
    moods = [
        item["checkin"]["mood"]
        for item in roster.json()["items"]
        if item.get("checkin")
    ]
    assert moods == [9]


@pytest.mark.asyncio
async def test_a_master_checking_into_his_own_practice_is_not_told_about_it(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """No self-notification -- and somebody else's still arrives.

    The guard is on the MESSAGE, not the record: his check-in is real and
    his own diary keeps it. The paired participant check-in in the same
    test is what makes the silence mean something.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    booker = await _participant(client, _TID_PARTICIPANT)
    practice_id = await _create_and_publish(client, master)
    await _seed_booking(db_session, practice_id, master)
    await _seed_booking(db_session, practice_id, booker)
    practice = await _pull_practice_into_checkin_window(
        db_session, practice_id,
    )

    own = await client.post(
        CHECKIN_URL.format(practice_id=practice_id),
        json={"mood": 8},
        headers=auth_headers(master["session_token"]),
    )
    assert own.status_code in (200, 201), own.text
    assert await _events(db_session, type_=_CHECKIN_TYPE, to=master) == []

    theirs = await client.post(
        CHECKIN_URL.format(practice_id=practice_id),
        json={"mood": 8},
        headers=auth_headers(booker["session_token"]),
    )
    assert theirs.status_code in (200, 201), theirs.text
    events = await _events(db_session, type_=_CHECKIN_TYPE, to=master)
    assert len(events) == 1
    assert events[0]["target_value"] == str(practice.master_id)


@pytest.mark.asyncio
async def test_a_resubmitted_checkin_is_refused_and_tells_nobody_twice(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """upsert_checkin is create-only despite its name: the second attempt
    is a 409 and the master hears about the check-in exactly once."""
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    booker = await _participant(client, _TID_PARTICIPANT)
    practice_id = await _create_and_publish(client, master)
    await _seed_booking(db_session, practice_id, booker)
    await _pull_practice_into_checkin_window(db_session, practice_id)

    first = await client.post(
        CHECKIN_URL.format(practice_id=practice_id),
        json={"mood": 7},
        headers=auth_headers(booker["session_token"]),
    )
    assert first.status_code in (200, 201), first.text
    second = await client.post(
        CHECKIN_URL.format(practice_id=practice_id),
        json={"mood": 2},
        headers=auth_headers(booker["session_token"]),
    )
    assert second.status_code == 409, second.text

    assert len(
        await _events(db_session, type_=_CHECKIN_TYPE, to=master)
    ) == 1


@pytest.mark.asyncio
async def test_a_review_tells_the_master_and_the_rating_is_a_bucket(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Item 6, both halves in one test.

    The review is seeded through the service's own write path via the API,
    so the emit sits where a real review puts it; the rating is asserted
    NOT to be the stored 1..10 anywhere in the payload.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    booker = await _participant(client, _TID_PARTICIPANT, first_name="Аня")
    practice_id = await _create_and_publish(client, master)
    booking = await _seed_booking(
        db_session, practice_id, booker, status=BookingStatus.ATTENDED.value,
    )
    assert booking is not None

    practice = await db_session.get(Practice, UUID(practice_id))
    practice.scheduled_at = datetime.now(UTC) - timedelta(hours=2)
    practice.status = PracticeStatus.COMPLETED.value
    await db_session.flush()
    await db_session.commit()

    left = await client.post(
        FEEDBACK_URL.format(practice_id=practice_id),
        json={"rating": 9, "comment": "Спасибо"},
        headers=auth_headers(booker["session_token"]),
    )
    assert left.status_code in (200, 201), left.text

    events = await _events(db_session, type_=_FEEDBACK_TYPE, to=master)
    assert len(events) == 1
    assert events[0]["action_data"]["participant_name"] == "Аня"
    rating = events[0]["action_data"]["rating"]
    assert isinstance(rating, str)
    assert rating not in _RAW_SCORES
    assert "9" not in events[0]["body"]


@pytest.mark.asyncio
async def test_a_practice_with_no_checkins_and_no_reviews_emits_neither(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Nothing written, nothing sent -- and the reminder still is.

    The pair keeps this from being a test that passes on a dead emit path:
    the same published practice produces its master reminder.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    await _create_and_publish(client, master)

    assert await _events(db_session, type_=_CHECKIN_TYPE, to=master) == []
    assert await _events(db_session, type_=_FEEDBACK_TYPE, to=master) == []
    assert len(
        await _events(db_session, type_=MASTER_REMINDER_TYPE, to=master)
    ) == 1


@pytest.mark.asyncio
async def test_a_checkin_on_another_masters_practice_reaches_that_master(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Addressing follows the practice, not the person writing.

    A master who checks into somebody else's practice notifies the OTHER
    master and not himself -- the case that would break if the emit ever
    took its target from the author's own master profile.
    """
    host = await _make_verified_master(client, db_session, _TID_MASTER)
    guest = await _make_verified_master(client, db_session, _TID_MASTER_B)
    practice_id = await _create_and_publish(client, host)
    await _seed_booking(db_session, practice_id, guest)
    await _pull_practice_into_checkin_window(db_session, practice_id)

    done = await client.post(
        CHECKIN_URL.format(practice_id=practice_id),
        json={"mood": 6},
        headers=auth_headers(guest["session_token"]),
    )
    assert done.status_code in (200, 201), done.text

    assert len(await _events(db_session, type_=_CHECKIN_TYPE, to=host)) == 1
    assert await _events(db_session, type_=_CHECKIN_TYPE, to=guest) == []


@pytest.mark.asyncio
async def test_a_checkin_row_seeded_as_post_is_never_produced_by_the_api(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """PRE only, and not by choice: nothing in the tree writes a POST.

    The single writer in app/ is check_type=CheckType.PRE.value. This test
    pins that: the API's own check-in comes out PRE, so a notification
    branch for POST would describe a state the product cannot reach.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    booker = await _participant(client, _TID_PARTICIPANT)
    practice_id = await _create_and_publish(client, master)
    await _seed_booking(db_session, practice_id, booker)
    await _pull_practice_into_checkin_window(db_session, practice_id)

    done = await client.post(
        CHECKIN_URL.format(practice_id=practice_id),
        json={"mood": 5},
        headers=auth_headers(booker["session_token"]),
    )
    assert done.status_code in (200, 201), done.text

    types = (
        await db_session.execute(
            select(Checkin.check_type).where(
                Checkin.practice_id == UUID(practice_id),
            )
        )
    ).scalars().all()
    assert types == [CheckType.PRE.value]
    assert len(
        await _events(db_session, type_=_CHECKIN_TYPE, to=master)
    ) == 1


@pytest.mark.asyncio
async def test_a_rolled_back_review_leaves_no_notification(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The emit rides the same transaction as the row.

    A second review is a 409, and the refusal must leave nothing behind:
    one Feedback row, one notification. A notification written outside the
    transaction would show two.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    booker = await _participant(client, _TID_PARTICIPANT)
    practice_id = await _create_and_publish(client, master)
    await _seed_booking(
        db_session, practice_id, booker, status=BookingStatus.ATTENDED.value,
    )
    practice = await db_session.get(Practice, UUID(practice_id))
    practice.scheduled_at = datetime.now(UTC) - timedelta(hours=2)
    practice.status = PracticeStatus.COMPLETED.value
    await db_session.flush()
    await db_session.commit()

    first = await client.post(
        FEEDBACK_URL.format(practice_id=practice_id),
        json={"rating": 8},
        headers=auth_headers(booker["session_token"]),
    )
    assert first.status_code in (200, 201), first.text
    second = await client.post(
        FEEDBACK_URL.format(practice_id=practice_id),
        json={"rating": 1},
        headers=auth_headers(booker["session_token"]),
    )
    assert second.status_code == 409, second.text

    rows = (
        await db_session.execute(
            select(Feedback).where(
                Feedback.practice_id == UUID(practice_id),
            )
        )
    ).scalars().all()
    assert len(rows) == 1
    assert len(
        await _events(db_session, type_=_FEEDBACK_TYPE, to=master)
    ) == 1


@pytest.mark.asyncio
async def test_the_practice_type_default_is_not_disturbed(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A guard on the fixture, not on the feature.

    Every test above publishes through _create_and_publish; if that helper
    ever stopped producing a LIVE scheduled practice, most of them would
    fail for a reason that has nothing to do with notifications. One cheap
    assertion here names that dependency instead of leaving it implied.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    practice_id = await _create_and_publish(client, master)
    practice = await db_session.get(Practice, UUID(practice_id))
    assert practice.status == PracticeStatus.SCHEDULED.value
    assert practice.practice_type == PracticeType.LIVE.value
