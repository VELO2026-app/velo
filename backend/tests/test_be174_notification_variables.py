# =============================================================================
# VELO -- BE-174: notifications a sheet can fill, and the guard on the class
# =============================================================================
# Band 88800-88819 (a free window of the 88xxx space, telegram_id_bands.py).
#
# What is under test:
#   1. A booking confirmed off the waitlist owes what a plain booking owes,
#      through ONE function (bookings/service.py announce_booking_confirmed):
#      the diary row, booking.confirmed with the same action_data --
#      {paid_amount} included, which the waitlist copy used to drop -- and
#      the reminder series.
#   2. waitlist.expired carries {scheduled_at}, in the HOLDER's zone.
#   3. wallet.topup_confirmed carries {balance}, the wallet after the topup.
#   4. The guard itself (tests/notification_guard.py): what it calls a
#      violation, that it is wired, and that it sees a real emit.
# =============================================================================

from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.events.models import OutboxEvent
from app.core.events.notify import emit_notification
from app.core.events.reminders import BOOKING_REMINDER_TYPES, format_event_time
from app.modules.diary.models import DiaryEvent
from app.modules.payments.models import (
    Payment,
    PaymentDirection,
    PaymentStatus,
)
from app.modules.payments.service import record_user_ledger
from app.modules.payments.stripe import handle_checkout_completed
from app.modules.practices.models import Practice
from app.modules.users.models import User, UserRole
from app.modules.waitlist.models import Waitlist
from tests.helpers import (
    auth_headers,
    fresh_execute,
    full_cleanup_range,
    login_user,
    switch_self_to_master,
)
from tests.notification_guard import GUARD, check

BAND_MIN, BAND_MAX = 88800, 88819

_MASTER, _ADMIN, _PLAIN, _FILLER, _WAITER = (BAND_MIN + i for i in range(5))
_TOPUP = BAND_MIN + 5

_PRICE_CENTS = 1500


@pytest.fixture(autouse=True)
async def _clean(db_session: AsyncSession):
    await full_cleanup_range(db_session, BAND_MIN, BAND_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, BAND_MIN, BAND_MAX, delete_users=True)
    await db_session.commit()


# ---------------------------------------------------------------------------
# The world: a verified master, a practice, people to book it
# ---------------------------------------------------------------------------


async def _verified_master(client: AsyncClient, db_session: AsyncSession) -> dict:
    master = await login_user(client, telegram_id=_MASTER, first_name="Master")
    await client.post(
        "/api/v1/masters/apply",
        json={
            "profile": {"display_name": "BE174 Master", "email": "be174@test.com"},
            "experience": {
                "methods": ["meditation"],
                "experience_years": 5,
                "bio": "be174",
            },
            "documents": [],
        },
        headers=auth_headers(master["session_token"]),
    )
    await login_user(client, telegram_id=_ADMIN, first_name="Admin")
    await db_session.execute(
        update(User)
        .where(User.telegram_id == _ADMIN)
        .values(role=UserRole.ADMIN.value)
    )
    await db_session.commit()
    admin = await login_user(client, telegram_id=_ADMIN, first_name="Admin")
    verified = await client.post(
        f"/api/v1/admin/masters/{master['user']['id']}/verify",
        json={},
        headers=auth_headers(admin["session_token"]),
    )
    assert verified.status_code == 200, verified.text
    await switch_self_to_master(client, master["session_token"])
    return await login_user(client, telegram_id=_MASTER, first_name="Master")


async def _practice(client: AsyncClient, master: dict, *, price_cents: int) -> str:
    headers = auth_headers(master["session_token"])
    created = await client.post(
        "/api/v1/practices",
        json={
            "practice_type": "live",
            "direction": "meditation",
            "difficulty": "beginner",
            "title": "BE174 Meditation",
            "description": "be174",
            "scheduled_at": (datetime.now(UTC) + timedelta(days=7)).isoformat(),
            "duration_minutes": 60,
            "timezone": "Europe/Moscow",
            "max_participants": 2,
            "is_free": price_cents == 0,
            "price_cents": price_cents,
            "currency": "eur",
        },
        headers=headers,
    )
    assert created.status_code == 201, created.text
    pid = created.json()["id"]
    scheduled = await client.patch(
        f"/api/v1/practices/{pid}", json={"status": "scheduled"}, headers=headers,
    )
    assert scheduled.status_code == 200, scheduled.text
    return pid


async def _person(
    client: AsyncClient, db_session: AsyncSession, tid: int, *, funds: int,
) -> dict:
    auth = await login_user(client, telegram_id=tid, first_name=f"P{tid}")
    if funds:
        await record_user_ledger(
            user_id=UUID(auth["user"]["id"]),
            amount_cents=funds,
            reason=f"be174-funds:{tid}",
            session=db_session,
        )
        await db_session.commit()
    return auth


async def _book(client: AsyncClient, pid: str, person: dict) -> str:
    resp = await client.post(
        "/api/v1/bookings",
        json={"practice_id": pid},
        headers=auth_headers(person["session_token"]),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _notified_waiter(
    client: AsyncClient, db_session: AsyncSession, pid: str, *, funds: int,
) -> tuple[dict, str]:
    """The practice's last seat taken, a waiter queued, the seat freed:
    the waiter is NOTIFIED. Returns (waiter, waitlist id)."""
    filler = await _person(client, db_session, _FILLER, funds=funds)
    filler_booking = await _book(client, pid, filler)
    waiter = await _person(client, db_session, _WAITER, funds=funds)
    joined = await client.post(
        f"/api/v1/practices/{pid}/waitlist",
        headers=auth_headers(waiter["session_token"]),
    )
    assert joined.status_code == 201, joined.text
    freed = await client.delete(
        f"/api/v1/bookings/{filler_booking}",
        headers=auth_headers(filler["session_token"]),
    )
    assert freed.status_code in (200, 204), freed.text
    return waiter, joined.json()["id"]


async def _confirm(client: AsyncClient, waiter: dict, wid: str):
    return await client.post(
        f"/api/v1/waitlist/{wid}/confirm",
        headers=auth_headers(waiter["session_token"]),
    )


async def _notifications(user_id: str, type_key: str) -> list[dict]:
    p = OutboxEvent.payload
    rows = (
        await fresh_execute(
            select(OutboxEvent)
            .where(
                p["type"].astext == type_key,
                p["target_value"].astext == user_id,
            )
            .order_by(OutboxEvent.id)
        )
    ).scalars().all()
    return [row.payload for row in rows]


async def _effects(user_id: str, booking_id: str) -> dict:
    """What a confirmed booking left behind for its booker."""
    (confirmed,) = await _notifications(user_id, "booking.confirmed")
    reminders = set()
    for type_key in BOOKING_REMINDER_TYPES:
        for payload in await _notifications(user_id, type_key):
            assert payload["correlation"] == f"booking:{booking_id}", payload
            reminders.add(type_key)
    diary = (
        await fresh_execute(
            select(DiaryEvent).where(
                DiaryEvent.user_id == UUID(user_id),
                DiaryEvent.kind == "booking_confirmed",
                DiaryEvent.source_id == UUID(booking_id),
            )
        )
    ).scalars().all()
    return {
        "action_data": confirmed["action_data"],
        "reminders": reminders,
        "diary": [row.snapshot for row in diary],
    }


# ---------------------------------------------------------------------------
# 1. booking.confirmed -- one function, both paths
# ---------------------------------------------------------------------------


class TestBookingConfirmed:
    async def test_waitlist_and_plain_booking_owe_the_same(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        """A plain booking and one taken off the waitlist, same practice,
        same zone: the same action_data byte for byte -- {paid_amount} the
        price paid -- the same reminder series, and a diary row each. The
        waitlist path used to send no {paid_amount} and project no diary
        row: two copies of one announcement, drifted."""
        master = await _verified_master(client, db_session)
        pid = await _practice(client, master, price_cents=_PRICE_CENTS)
        plain = await _person(client, db_session, _PLAIN, funds=5000)
        plain_booking = await _book(client, pid, plain)
        waiter, wid = await _notified_waiter(client, db_session, pid, funds=5000)

        resp = await _confirm(client, waiter, wid)
        assert resp.status_code == 201, resp.text
        waiter_booking = resp.json()["booking_id"]

        plain_effects = await _effects(plain["user"]["id"], plain_booking)
        waiter_effects = await _effects(waiter["user"]["id"], waiter_booking)
        assert waiter_effects == plain_effects
        assert plain_effects["action_data"]["paid_amount"] == "15.00"
        assert plain_effects["reminders"] == set(BOOKING_REMINDER_TYPES)
        assert len(plain_effects["diary"]) == 1

    async def test_a_free_practice_off_the_waitlist_says_zero(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        """Free: the purchase charges nothing and {paid_amount} says so, in
        the same form -- present, not None, not missing."""
        master = await _verified_master(client, db_session)
        pid = await _practice(client, master, price_cents=0)
        await _book(client, pid, await _person(client, db_session, _PLAIN, funds=0))
        waiter, wid = await _notified_waiter(client, db_session, pid, funds=0)

        resp = await _confirm(client, waiter, wid)
        assert resp.status_code == 201, resp.text

        (confirmed,) = await _notifications(waiter["user"]["id"], "booking.confirmed")
        assert confirmed["action_data"]["paid_amount"] == "0.00"


# ---------------------------------------------------------------------------
# 2. waitlist.expired -- the time, in the holder's zone
# ---------------------------------------------------------------------------


class TestWaitlistExpired:
    async def test_the_lapsed_hold_names_the_practice_time_in_the_holders_zone(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        master = await _verified_master(client, db_session)
        pid = await _practice(client, master, price_cents=0)
        await _book(client, pid, await _person(client, db_session, _PLAIN, funds=0))
        waiter, wid = await _notified_waiter(client, db_session, pid, funds=0)
        await db_session.execute(
            update(User)
            .where(User.id == UUID(waiter["user"]["id"]))
            .values(timezone="Asia/Tokyo")
        )
        await db_session.execute(
            update(Waitlist)
            .where(Waitlist.id == UUID(wid))
            .values(expires_at=datetime.now(UTC) - timedelta(minutes=1))
        )
        await db_session.commit()

        resp = await _confirm(client, waiter, wid)
        assert resp.status_code == 400, resp.text

        (expired,) = await _notifications(waiter["user"]["id"], "waitlist.expired")
        practice = (
            await fresh_execute(select(Practice).where(Practice.id == UUID(pid)))
        ).scalar_one()
        expected = format_event_time(practice.scheduled_at, "Asia/Tokyo")
        assert expired["action_data"]["scheduled_at"] == expected
        # The holder's zone, not the practice's.
        assert expected != format_event_time(practice.scheduled_at, "Europe/Moscow")


# ---------------------------------------------------------------------------
# 3. wallet.topup_confirmed -- the balance after the topup
# ---------------------------------------------------------------------------


class TestTopupConfirmed:
    async def test_balance_is_the_wallet_after_the_topup(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        """A wallet that already held 12.34 takes 25.00: {amount} is the
        topup, {balance} the 37.34 now there -- written alike, and not the
        same number (a balance that only echoed the amount would pass a
        test that started from zero)."""
        person = await _person(client, db_session, _TOPUP, funds=1234)
        user_id = UUID(person["user"]["id"])
        db_session.add(
            Payment(
                user_id=user_id,
                direction=PaymentDirection.IN.value,
                amount_cents=2500,
                currency="eur",
                status=PaymentStatus.PENDING.value,
                stripe_session_id="cs_be174_topup",
            )
        )
        await db_session.flush()

        await handle_checkout_completed(
            {
                "id": "cs_be174_topup",
                "payment_intent": "pi_be174",
                "amount_total": 2500,
                "currency": "eur",
                "customer_email": "be174@test.com",
            },
            db_session,
        )
        await db_session.commit()

        (topup,) = await _notifications(str(user_id), "wallet.topup_confirmed")
        assert topup["action_data"]["amount"] == "25.00"
        assert topup["action_data"]["balance"] == "37.34"


# ---------------------------------------------------------------------------
# 4. The guard
# ---------------------------------------------------------------------------


def _booking_confirmed(**action_data) -> dict:
    full = {
        "action": "open_practice",
        "params": {"practice_id": "p"},
        "practice_title": "Yoga",
        "master_name": "Anna",
        "scheduled_at": "7 March, 18:30",
        "paid_amount": "15.00",
    }
    return {"type": "booking.confirmed", "action_data": {**full, **action_data}}


class TestGuardVerdict:
    def test_a_full_job_is_clean(self) -> None:
        assert check(_booking_confirmed()) == []

    def test_a_variable_not_sent_is_named_with_type_locale_and_field(self) -> None:
        payload = _booking_confirmed()
        del payload["action_data"]["paid_amount"]
        assert check(payload) == [
            "booking.confirmed: {paid_amount} is not sent (en/telegram/body)",
            "booking.confirmed: {paid_amount} is not sent (ru/telegram/body)",
        ]

    def test_none_is_a_violation_and_an_empty_string_is_not(self) -> None:
        """comms prints None as "None"; "" is a value (BE-172 sends a
        whole optional line as "" when there is none)."""
        assert check(_booking_confirmed(paid_amount=None)) == [
            "booking.confirmed: {paid_amount} is None (en/telegram/body)",
            "booking.confirmed: {paid_amount} is None (ru/telegram/body)",
        ]
        assert check(_booking_confirmed(paid_amount="")) == []

    def test_an_undeclared_type_is_a_violation(self) -> None:
        assert check({"type": "booking.confirmd", "action_data": {}}) == [
            "'booking.confirmd': not declared in comms-profile/types.yaml"
        ]

    def test_title_and_body_are_comms_own(self) -> None:
        """system.announcement's sheets read {title} and {body}: comms
        sets both from the job's own text, never from action_data."""
        assert check({"type": "system.announcement", "action_data": {}}) == []

    def test_a_type_without_sheets_reads_nothing(self) -> None:
        """An llm type has no sheet (comms refuses one) -- nothing to fill."""
        assert check({"type": "support.translate_for_support"}) == []


class TestGuardWiring:
    def test_the_listener_is_installed(self) -> None:
        assert GUARD.installed()

    async def test_it_sees_a_real_emit(self, db_session: AsyncSession) -> None:
        """A broken job through emit_notification lands in the record --
        the listener, not just check(), sees the outbox. The record is
        taken back here so this test itself ends clean."""
        before = len(GUARD.violations)
        payload = _booking_confirmed()
        del payload["action_data"]["paid_amount"]
        await emit_notification(
            db_session,
            idempotency_key="be174-guard-sees",
            type="booking.confirmed",
            target_type="user",
            target_value="00000000-0000-4000-8000-000000000174",
            title="T",
            body="B",
            action_data=payload["action_data"],
        )
        seen = GUARD.violations[before:]
        del GUARD.violations[before:]
        await db_session.rollback()
        assert seen == [
            "booking.confirmed: {paid_amount} is not sent (en/telegram/body)",
            "booking.confirmed: {paid_amount} is not sent (ru/telegram/body)",
        ]

    @pytest.mark.notification_by_hand
    async def test_the_by_hand_marker_silences_only_its_test(
        self, db_session: AsyncSession,
    ) -> None:
        before = len(GUARD.violations)
        await emit_notification(
            db_session,
            idempotency_key="be174-guard-by-hand",
            type="booking.confirmed",
            target_type="user",
            target_value="00000000-0000-4000-8000-000000000174",
            title="T",
            body="B",
            action_data={"practice_title": "Yoga"},
        )
        await db_session.rollback()
        assert GUARD.violations[before:] == []
        assert GUARD.by_hand
