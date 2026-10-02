# =============================================================================
# VELO Backend -- comms protocol 3.0.0: profile, emitter, cancel fan-out
# =============================================================================
#
# telegram_id band: 88000-88099 (master 88001, participants 88010-88012).
# Declared module-level below as _TID_MIN/_TID_MAX, once. Checked free
# before it was claimed: free_windows(space=(55000, 99999)) listed
# (88000, 88999), and no literal 88xxx occurs in tests/.
#
# What 3.0.0 changed, and what each section pins:
#   1. The emitter's envelope: the idempotency key is the caller's and
#      required, channels/priority are gone, correlation is optional and
#      travels only when given; both opaque strings are refused HERE
#      outside comms' 1..200 bound.
#   2. Reminder identities: keys name the scheduling ACT (a cancelled job
#      holds its key forever in comms), correlations name one axis each.
#   3. The practice cancel as a fan-out: one per-booking cancel for every
#      booking the cancellation cancels -- collected BEFORE the refund --
#      plus the master's.
#   4. The profile: schema v2, closed records, channels routed by type.
#
# Section 3 drives the real endpoints; sections 1-2 emit against
# synthetic ids that no band user owns, cleaned up by those ids.
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
from app.core.events.notify import (
    ENVELOPE_STRING_MAX,
    emit_notification,
    emit_reminder_cancel,
)
from app.core.events.reminders import (
    BOOKED_ACT,
    BOOKING_REMINDER_TYPES,
    MASTER_REMINDER_TYPE,
    MASTER_REMINDER_TYPES,
    BookingRef,
    booking_correlation,
    cancel_practice_reminders,
    new_reschedule_act,
    practice_correlation,
    schedule_booking_reminders,
    schedule_master_practice_reminder,
)
from app.core.events.service import EVENT_REMINDER_CANCEL
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.masters.models import MasterProfile
from app.modules.payments.models import Purchase, PurchaseStatus
from app.modules.practices.models import Practice
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user

_TID_MIN = 88000
_TID_MAX = 88099

_TID_MASTER = 88001
_TID_P1 = 88010
_TID_P2 = 88011
_TID_P3 = 88012

PRACTICES_URL = "/api/v1/practices"

# Synthetic ids for the rows sections 1-2 emit directly.
SYNTH_USER = "bbbbbbbb-88000000-4000-8000-000000000001"
SYNTH_BOOKING = "bbbbbbbb-88000000-4000-8000-000000000002"
SYNTH_BOOKING_2 = "bbbbbbbb-88000000-4000-8000-000000000003"
SYNTH_BOOKING_3 = "bbbbbbbb-88000000-4000-8000-000000000004"
SYNTH_PRACTICE = "bbbbbbbb-88000000-4000-8000-000000000005"
_SYNTH_TARGETS = {SYNTH_USER}
_SYNTH_CORRELATIONS = {
    booking_correlation(SYNTH_BOOKING),
    booking_correlation(SYNTH_BOOKING_2),
    booking_correlation(SYNTH_BOOKING_3),
    practice_correlation(SYNTH_PRACTICE),
}

_PROFILE_CANDIDATES = (
    Path(__file__).resolve().parents[2] / "comms-profile",
    Path("/comms-profile"),
)


def _profile_dir() -> Path:
    for candidate in _PROFILE_CANDIDATES:
        if (candidate / "types.yaml").is_file():
            return candidate
    raise AssertionError(
        "comms-profile/types.yaml found in none of: "
        + ", ".join(str(c) for c in _PROFILE_CANDIDATES)
    )


# ===========================================================================
# Cleanup: band users and everything addressed to them, the master cancels
# of their practices (those carry no target), and the synthetic rows.
# ===========================================================================


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    async def _wipe() -> None:
        ids = [
            str(uid) for uid in (
                await db_session.execute(
                    select(User.id).where(
                        User.telegram_id.between(_TID_MIN, _TID_MAX),
                    )
                )
            ).scalars().all()
        ]
        practice_ids = [
            str(pid) for pid in (
                await db_session.execute(
                    select(Practice.id).where(
                        Practice.master_id.in_([UUID(i) for i in ids]),
                    )
                )
            ).scalars().all()
        ] if ids else []
        target = OutboxEvent.payload["target_value"].astext
        corr = OutboxEvent.payload["correlation"].astext
        await db_session.execute(
            delete(OutboxEvent).where(
                or_(
                    target.in_(_SYNTH_TARGETS | set(ids)),
                    corr.in_(
                        _SYNTH_CORRELATIONS
                        | {practice_correlation(p) for p in practice_ids}
                    ),
                )
            )
        )
        # Committed HERE: full_cleanup_range opens with a defensive
        # rollback, which would silently discard this delete.
        await db_session.commit()
        await full_cleanup_range(
            db_session, _TID_MIN, _TID_MAX, delete_users=True,
        )
        await db_session.commit()

    await _wipe()
    yield
    await _wipe()


async def _synth_events(session: AsyncSession) -> list[OutboxEvent]:
    target = OutboxEvent.payload["target_value"].astext
    corr = OutboxEvent.payload["correlation"].astext
    result = await session.execute(
        select(OutboxEvent)
        .where(
            or_(target.in_(_SYNTH_TARGETS), corr.in_(_SYNTH_CORRELATIONS)),
        )
        .order_by(OutboxEvent.id)
    )
    return list(result.scalars().all())


async def _emit(session: AsyncSession, **overrides: object) -> OutboxEvent:
    kwargs: dict = {
        "idempotency_key": "p3-valid",
        "type": "booking.confirmed",
        "target_type": "user",
        "target_value": SYNTH_USER,
        "title": "T",
        "body": "B",
    }
    kwargs.update(overrides)
    return await emit_notification(session, **kwargs)


# ===========================================================================
# 1. The emitter's envelope
# ===========================================================================


@pytest.mark.asyncio
class TestEnvelopeStrings:
    async def test_an_empty_key_is_refused_and_a_valid_one_is_queued(
        self, db_session: AsyncSession,
    ) -> None:
        """PUSTOTA, with its pair: the refusal is not "nothing works"."""
        with pytest.raises(ValueError, match="idempotency_key"):
            await _emit(db_session, idempotency_key="")
        await _emit(db_session)
        await db_session.commit()

        (event,) = await _synth_events(db_session)
        assert event.payload["idempotency_key"] == "p3-valid"

    async def test_the_bound_is_comms_own_and_inclusive(
        self, db_session: AsyncSession,
    ) -> None:
        """200 characters pass, 201 are refused -- at the emit site."""
        at_bound = "k" * ENVELOPE_STRING_MAX
        await _emit(db_session, idempotency_key=at_bound)
        with pytest.raises(ValueError, match="idempotency_key"):
            await _emit(
                db_session, idempotency_key="k" * (ENVELOPE_STRING_MAX + 1),
            )
        await db_session.commit()

        (event,) = await _synth_events(db_session)
        assert event.payload["idempotency_key"] == at_bound
        assert ENVELOPE_STRING_MAX == 200

    async def test_a_missing_key_is_a_call_error(
        self, db_session: AsyncSession,
    ) -> None:
        """NEHVATKA: required and keyword-only, so there is no default."""
        with pytest.raises(TypeError, match="idempotency_key"):
            await emit_notification(  # type: ignore[call-arg]
                db_session,
                type="booking.confirmed",
                target_type="user",
                target_value=SYNTH_USER,
                title="T",
                body="B",
            )

    @pytest.mark.parametrize(
        ("name", "value"),
        [("priority", 2), ("channels", ["in_app", "telegram"])],
    )
    async def test_routing_fields_can_no_longer_be_sent(
        self, db_session: AsyncSession, name: str, value: object,
    ) -> None:
        """3.0.0 refuses them at intake; the seam refuses them first."""
        with pytest.raises(TypeError, match=name):
            await _emit(db_session, **{name: value})

    async def test_correlation_travels_only_when_given(
        self, db_session: AsyncSession,
    ) -> None:
        """None -> absent (not null); given -> verbatim; empty -> refused."""
        with pytest.raises(ValueError, match="correlation"):
            await _emit(db_session, correlation="")
        await _emit(db_session, idempotency_key="p3-without")
        await _emit(
            db_session,
            idempotency_key="p3-with",
            correlation=booking_correlation(SYNTH_BOOKING),
        )
        await db_session.commit()

        without, with_ = await _synth_events(db_session)
        assert "correlation" not in without.payload
        assert with_.payload["correlation"] == (
            f"booking:{SYNTH_BOOKING}"
        )

    async def test_a_cancel_needs_a_type_and_a_correlation(
        self, db_session: AsyncSession,
    ) -> None:
        with pytest.raises(ValueError, match="at least one type"):
            await emit_reminder_cancel(
                db_session,
                types=[],
                correlation=booking_correlation(SYNTH_BOOKING),
            )
        with pytest.raises(ValueError, match="correlation"):
            await emit_reminder_cancel(
                db_session, types=BOOKING_REMINDER_TYPES, correlation="",
            )
        await emit_reminder_cancel(
            db_session,
            types=BOOKING_REMINDER_TYPES,
            correlation=booking_correlation(SYNTH_BOOKING),
        )
        await db_session.commit()

        (event,) = await _synth_events(db_session)
        assert event.event_type == EVENT_REMINDER_CANCEL
        assert set(event.payload) == {"v", "types", "correlation"}


# ===========================================================================
# 2. Reminder identities
# ===========================================================================


async def _series_keys(
    session: AsyncSession, *, act: str, anchor: datetime,
) -> list[str]:
    await schedule_booking_reminders(
        session,
        booking_id=SYNTH_BOOKING,
        user_id=SYNTH_USER,
        practice_id=SYNTH_PRACTICE,
        practice_title="Yoga",
        master_name="Anna",
        scheduled_at=anchor,
        act=act,
    )
    await session.commit()
    events = await _synth_events(session)
    await session.execute(
        delete(OutboxEvent).where(
            OutboxEvent.id.in_([e.id for e in events]),
        )
    )
    await session.commit()
    return [e.payload["idempotency_key"] for e in events]


@pytest.mark.asyncio
class TestReminderIdentities:
    async def test_the_same_act_repeated_gives_the_same_keys(
        self, db_session: AsyncSession,
    ) -> None:
        """POVTOR: one fact twice is one set of keys (comms keeps one job)."""
        anchor = datetime.now(UTC) + timedelta(days=3)
        first = await _series_keys(db_session, act=BOOKED_ACT, anchor=anchor)
        again = await _series_keys(db_session, act=BOOKED_ACT, anchor=anchor)
        assert len(first) == 3
        assert first == again

    async def test_a_move_back_to_the_same_hour_is_a_new_set_of_keys(
        self, db_session: AsyncSession,
    ) -> None:
        """A -> B -> A: the reachable case that loses reminders silently.

        comms holds a key forever, whatever became of its job. With the
        anchor in the key and no act, the second A would repeat the bytes
        of the cancelled first A and be answered with that cancelled job.
        """
        a = datetime.now(UTC) + timedelta(days=3)
        b = a + timedelta(days=2)
        booked = await _series_keys(db_session, act=BOOKED_ACT, anchor=a)
        moved = await _series_keys(
            db_session, act=new_reschedule_act(), anchor=b,
        )
        back = await _series_keys(
            db_session, act=new_reschedule_act(), anchor=a,
        )
        assert len(set(booked) | set(moved) | set(back)) == 9

    async def test_the_master_reminder_names_its_act(
        self, db_session: AsyncSession,
    ) -> None:
        act = new_reschedule_act()
        emitted = await schedule_master_practice_reminder(
            db_session,
            practice_id=SYNTH_PRACTICE,
            master_user_id=SYNTH_USER,
            practice_title="Yoga",
            scheduled_at=datetime.now(UTC) + timedelta(days=3),
            act=act,
        )
        await db_session.commit()

        assert emitted is True
        (event,) = await _synth_events(db_session)
        assert event.payload["idempotency_key"] == (
            f"master-reminder:{SYNTH_PRACTICE}:{act}"
        )
        assert event.payload["correlation"] == (
            practice_correlation(SYNTH_PRACTICE)
        )


def test_the_two_axes_never_share_a_correlation() -> None:
    """The prefixes exist for this: one uuid on both axes stays two."""
    assert booking_correlation(SYNTH_PRACTICE) != (
        practice_correlation(SYNTH_PRACTICE)
    )


@pytest.mark.asyncio
class TestPracticeFanOut:
    async def test_no_bookings_still_cancels_the_masters_reminder(
        self, db_session: AsyncSession,
    ) -> None:
        """PUSTOTA, with its pair: zero booking cancels AND the master's."""
        queued = await cancel_practice_reminders(
            db_session, practice_id=SYNTH_PRACTICE, bookings=[],
        )
        await db_session.commit()

        assert queued == 1
        (master,) = await _synth_events(db_session)
        assert master.payload["types"] == MASTER_REMINDER_TYPES
        assert master.payload["correlation"] == (
            practice_correlation(SYNTH_PRACTICE)
        )

    async def test_one_cancel_per_booking_on_its_own_axis(
        self, db_session: AsyncSession,
    ) -> None:
        refs = [
            BookingRef(booking_id=b, user_id=SYNTH_USER)
            for b in (SYNTH_BOOKING, SYNTH_BOOKING_2, SYNTH_BOOKING_3)
        ]
        queued = await cancel_practice_reminders(
            db_session, practice_id=SYNTH_PRACTICE, bookings=refs,
        )
        await db_session.commit()

        assert queued == 4
        *per_booking, master = await _synth_events(db_session)
        assert [e.payload["correlation"] for e in per_booking] == [
            booking_correlation(r.booking_id) for r in refs
        ]
        for event in per_booking:
            assert event.payload["types"] == BOOKING_REMINDER_TYPES
            assert event.payload["target_value"] == SYNTH_USER
        assert master.payload["types"] == MASTER_REMINDER_TYPES
        assert "target_type" not in master.payload


# ===========================================================================
# 3. The domain paths, through the real endpoints
# ===========================================================================


async def _make_verified_master(
    client: AsyncClient, db_session: AsyncSession,
) -> dict:
    auth = await login_user(client, telegram_id=_TID_MASTER, first_name="M")
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
    await db_session.commit()
    return await login_user(client, telegram_id=_TID_MASTER, first_name="M")


async def _publish(
    client: AsyncClient, master: dict, scheduled_at: datetime,
) -> str:
    created = await client.post(
        PRACTICES_URL,
        json={
            "practice_type": "live",
            "direction": "meditation",
            "difficulty": "beginner",
            "title": "Протокол",
            "description": "Guided session",
            "scheduled_at": scheduled_at.isoformat(),
            "duration_minutes": 60,
            "timezone": "UTC",
            "max_participants": 20,
            "is_free": True,
            "price_cents": 0,
            "currency": "eur",
        },
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


async def _seed_booking(
    db_session: AsyncSession, practice_id: str, user_id: str, status: str,
) -> str:
    """A booking with the purchase row the refund flow reads for it."""
    booking = Booking(
        practice_id=UUID(practice_id), user_id=UUID(user_id), status=status,
    )
    db_session.add(booking)
    await db_session.flush()
    db_session.add(
        Purchase(
            user_id=UUID(user_id),
            practice_id=UUID(practice_id),
            booking_id=booking.id,
            amount_cents=0,
            paid_cents=0,
            status=PurchaseStatus.PENDING.value,
        )
    )
    await db_session.commit()
    return str(booking.id)


async def _cancels_of(session: AsyncSession, correlations: set[str]) -> list:
    result = await session.execute(
        select(OutboxEvent)
        .where(
            OutboxEvent.event_type == EVENT_REMINDER_CANCEL,
            OutboxEvent.payload["correlation"].astext.in_(correlations),
        )
        .order_by(OutboxEvent.id)
    )
    return [row.payload for row in result.scalars().all()]


async def _requests(
    session: AsyncSession, *, type_: str, practice_id: str,
) -> list[dict]:
    result = await session.execute(
        select(OutboxEvent)
        .where(
            OutboxEvent.payload["type"].astext == type_,
            OutboxEvent.payload["action_data"]["params"]["practice_id"].astext
            == practice_id,
        )
        .order_by(OutboxEvent.id)
    )
    return [row.payload for row in result.scalars().all()]


@pytest.mark.asyncio
class TestDomainFanOut:
    async def test_cancelling_a_practice_cancels_every_refunded_booking(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        """The refund runs first -- the list must not be read after it.

        Two live bookings and one cancelled earlier. The live two get a
        cancel each on their own "booking:<id>" axis; the earlier one got
        its cancel when it was cancelled and gets none now. A list read
        after the refund would hold no live booking at all, and every
        participant's reminders would outlive the practice.
        """
        master = await _make_verified_master(client, db_session)
        practice_id = await _publish(
            client, master, datetime.now(UTC) + timedelta(days=8),
        )
        users = [
            (await login_user(client, telegram_id=t))["user"]["id"]
            for t in (_TID_P1, _TID_P2, _TID_P3)
        ]
        live = [
            await _seed_booking(
                db_session, practice_id, users[0],
                BookingStatus.CONFIRMED.value,
            ),
            await _seed_booking(
                db_session, practice_id, users[1],
                BookingStatus.CONFIRMED.value,
            ),
        ]
        earlier = await _seed_booking(
            db_session, practice_id, users[2], BookingStatus.CANCELLED.value,
        )

        cancelled = await client.post(
            f"{PRACTICES_URL}/{practice_id}/cancel",
            json={},
            headers=auth_headers(master["session_token"]),
        )
        assert cancelled.status_code in (200, 204), cancelled.text

        per_booking = await _cancels_of(
            db_session, {booking_correlation(b) for b in live},
        )
        assert sorted(c["correlation"] for c in per_booking) == sorted(
            booking_correlation(b) for b in live
        )
        assert {c["target_value"] for c in per_booking} == set(users[:2])
        assert await _cancels_of(
            db_session, {booking_correlation(earlier)},
        ) == []
        master_cancels = await _cancels_of(
            db_session, {practice_correlation(practice_id)},
        )
        assert [c["types"] for c in master_cancels] == [[MASTER_REMINDER_TYPE]]

    async def test_a_practice_with_no_bookings_cancels_only_the_masters(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        """PUSTOTA through the endpoint: an empty fan-out is a success."""
        master = await _make_verified_master(client, db_session)
        practice_id = await _publish(
            client, master, datetime.now(UTC) + timedelta(days=8),
        )
        cancelled = await client.post(
            f"{PRACTICES_URL}/{practice_id}/cancel",
            json={},
            headers=auth_headers(master["session_token"]),
        )
        assert cancelled.status_code in (200, 204), cancelled.text

        booking_types = set(BOOKING_REMINDER_TYPES)
        all_cancels = (
            await db_session.execute(
                select(OutboxEvent).where(
                    OutboxEvent.event_type == EVENT_REMINDER_CANCEL,
                    OutboxEvent.payload["target_value"].astext.in_(
                        [master["user"]["id"]],
                    ),
                )
            )
        ).scalars().all()
        assert [
            e for e in all_cancels
            if booking_types & set(e.payload["types"])
        ] == []
        master_cancels = await _cancels_of(
            db_session, {practice_correlation(practice_id)},
        )
        assert len(master_cancels) == 1

    async def test_moving_there_and_back_keeps_every_key_new(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        """A -> B -> A through PATCH: three generations, no key reused.

        The master's reminder, the participant's series and the
        rescheduled message each carry the act of their own move -- with
        the anchor alone, the return to A would repeat the cancelled
        first generation and comms would answer with that dead job.
        """
        master = await _make_verified_master(client, db_session)
        a = (datetime.now(UTC) + timedelta(days=8)).replace(microsecond=0)
        b = a + timedelta(days=4)
        practice_id = await _publish(client, master, a)
        participant = (
            await login_user(client, telegram_id=_TID_P1)
        )["user"]["id"]
        await _seed_booking(
            db_session, practice_id, participant,
            BookingStatus.CONFIRMED.value,
        )

        for when in (b, a):
            moved = await client.patch(
                f"{PRACTICES_URL}/{practice_id}",
                json={"scheduled_at": when.isoformat()},
                headers=auth_headers(master["session_token"]),
            )
            assert moved.status_code == 200, moved.text

        master_reminders = await _requests(
            db_session, type_=MASTER_REMINDER_TYPE, practice_id=practice_id,
        )
        assert len(master_reminders) == 3
        assert len({r["idempotency_key"] for r in master_reminders}) == 3
        assert master_reminders[0]["action_data"]["scheduled_at"] == (
            master_reminders[2]["action_data"]["scheduled_at"]
        )

        series = await _requests(
            db_session, type_="booking.reminder_24h", practice_id=practice_id,
        )
        assert len(series) == 2
        assert len({r["idempotency_key"] for r in series}) == 2

        moves = await _requests(
            db_session, type_="practice.rescheduled", practice_id=practice_id,
        )
        assert len(moves) == 2
        assert len({r["idempotency_key"] for r in moves}) == 2

    async def test_a_repeated_move_to_the_same_time_emits_nothing(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        """The domain gate that makes a minted act safe (POVTOR)."""
        master = await _make_verified_master(client, db_session)
        a = (datetime.now(UTC) + timedelta(days=8)).replace(microsecond=0)
        b = a + timedelta(days=4)
        practice_id = await _publish(client, master, a)

        for _ in range(2):
            moved = await client.patch(
                f"{PRACTICES_URL}/{practice_id}",
                json={"scheduled_at": b.isoformat()},
                headers=auth_headers(master["session_token"]),
            )
            assert moved.status_code == 200, moved.text

        master_reminders = await _requests(
            db_session, type_=MASTER_REMINDER_TYPE, practice_id=practice_id,
        )
        # Publication + ONE move: the second PATCH changed nothing.
        assert len(master_reminders) == 2
        master_cancels = await _cancels_of(
            db_session, {practice_correlation(practice_id)},
        )
        assert len(master_cancels) == 1


# ===========================================================================
# 4. The profile (no database)
# ===========================================================================


class TestProfileV2:
    def _doc(self) -> dict:
        return yaml.safe_load((_profile_dir() / "types.yaml").read_text())

    def test_schema_version_and_a_non_empty_dictionary(self) -> None:
        doc = self._doc()
        assert set(doc) == {"version", "types"}
        assert doc["version"] == 2
        # 44 since BE-104 (master.application_submitted); 43 after BE-63
        # (master_practice_published/_edited/_deleted); 40 after BE-102
        # (practice_created_for_master); 39 after BE-59 B1 (member_demoted);
        # 38 after BE-59 A (master_verification_required,
        # master_offer_closed); 36 before.
        assert len(doc["types"]) == 44

    def test_every_record_is_closed(self) -> None:
        """An unknown key refuses comms startup; only x-... is tolerated."""
        for key, record in self._doc()["types"].items():
            assert isinstance(record, dict), key
            extra = {
                k for k in record
                if k not in {"category", "channels"}
                and not str(k).startswith("x-")
            }
            assert extra == set(), key

    def test_velo_types_are_routed_and_msg_types_are_not(self) -> None:
        """The DEFAULT_CHANNELS the emitter sent now live in the profile.

        NEHVATKA of the pair: a velo type without channels would fall to
        comms' default (in_app only) and lose telegram silently.
        """
        types = self._doc()["types"]
        velo = {k: v for k, v in types.items() if not k.startswith("msg.")}
        comms_own = {k: v for k, v in types.items() if k.startswith("msg.")}
        # 33 pre-BE-59, +2 A, +1 B1, +1 BE-102, +3 BE-63, +1 BE-104
        assert len(velo) == 41
        assert sorted(comms_own) == [
            "msg.participant_message",
            "msg.support_message",
            "msg.thread_closed",
        ]
        for key, record in velo.items():
            assert record["channels"] == ["in_app", "telegram"], key
        for key, record in comms_own.items():
            assert "channels" not in record, key
            assert record["category"], key

    def test_the_header_states_the_closed_record(self) -> None:
        text = (_profile_dir() / "types.yaml").read_text()
        assert (
            "The type record is closed: an unknown key refuses comms "
            "startup; only `x-...` keys are tolerated."
        ) in text
        assert "Unknown spec keys are tolerated" not in text
