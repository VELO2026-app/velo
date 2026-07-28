# =============================================================================
# VELO Backend -- Comms T1 tests: emitters seam, reminders, proxy (Phase 6/T1)
# =============================================================================
#
# Test band: telegram_ids 89520-89599 (T1 window 89441-89899; 89441-89519
# consumed by the 88xxx band migration of this same delivery).
#
# Covers:
#   1. emit_notification -- notification_request document per the frozen
#      3c contract mirror: v stamped, idempotency_key minted, channels
#      default ["in_app", "telegram"], scheduled_at/expiry_at as tz-aware
#      iso strings.
#   2. Reminder orchestration (core/events/reminders.py):
#      - the 24h/1h/10m series anchored at practice.scheduled_at with
#        expiry_at = anchor and both correlation keys stored;
#      - the min-lead cutoff skips leads already (almost) due;
#      - cancel emits: per-booking (booking_id + user target) and
#        per-practice (practice_id, no target); half-target rejected;
#      - the feedback prompt: future scheduled_at + expiry window.
#   3. The notifications proxy (app/modules/comms_proxy/router.py):
#      - recipient_id is stamped server-side from the session (the comms
#        path carries the AUTHENTICATED user's id, whatever the client
#        sends elsewhere);
#      - a client-supplied recipient_id in the query -> 400, never
#        silently ignored;
#      - prefs schedule semantics conversion BOTH ways (comms quiet
#        window <-> UI delivery window), categories/timezone passthrough;
#      - unknown prefs body keys -> 422 (extra=forbid);
#      - comms down: empty COMMS_API_URL -> 502; a connect timeout -> 504
#        (through the real core/comms.py client).
#   4. POST /api/v1/admin/announcements -- the system.announcement emit
#      point (approved plan fork 6): admin-only, audience all|masters.
#
# The proxy's comms calls are cut at the comms_request seam
# (app.modules.comms_proxy.router.comms_request) -- no comms stack is
# needed; core/comms.py itself is exercised separately via a monkey-
# patched httpx client.
# =============================================================================

import json
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from sqlalchemy import delete, or_, select

from app.core.config import settings
from app.core.events.models import OutboxEvent
from app.core.events.notify import (
    DEFAULT_CHANNELS,
    emit_notification,
    emit_reminder_cancel,
)
from app.core.events.reminders import (
    BOOKING_REMINDER_TYPES,
    cancel_booking_reminders,
    cancel_practice_reminders,
    schedule_booking_reminders,
    schedule_feedback_prompt,
)
from app.core.events.service import (
    EVENT_NOTIFICATION_REQUEST,
    EVENT_REMINDER_CANCEL,
)
from app.modules.users.models import User
from tests.helpers import auth_headers, cleanup_range, login_user

pytestmark = pytest.mark.asyncio

# -- Band bookkeeping --------------------------------------------------------

TID_PROXY = 89520
TID_PREFS = 89521
TID_ADMIN = 89530
TID_NON_ADMIN = 89531

BAND_MIN, BAND_MAX = 89520, 89599

# Synthetic ids for rows emitted directly (no band user behind them):
# lets the cleanup fixture target OUR rows and only ours (same pattern
# as test_comms_outbox.py).
SYNTH_USER = "aaaaaaaa-89520000-4000-8000-000000000001"
SYNTH_BOOKING = "aaaaaaaa-89520000-4000-8000-000000000002"
SYNTH_PRACTICE = "aaaaaaaa-89520000-4000-8000-000000000003"
_SYNTH_IDS = {SYNTH_USER, SYNTH_BOOKING, SYNTH_PRACTICE}


@pytest.fixture(autouse=True)
async def _clean_band(db_session):
    """Reset band users + drain OUR outbox rows around every test."""

    async def _drain() -> None:
        result = await db_session.execute(
            select(User.id).where(
                User.telegram_id.between(BAND_MIN, BAND_MAX)
            )
        )
        band_ids = [str(uid) for uid in result.scalars().all()]
        await cleanup_range(db_session, BAND_MIN, BAND_MAX)
        target = OutboxEvent.payload["target_value"].astext
        corr_b = OutboxEvent.payload["correlation_value"].astext
        conditions = [
            target.in_(_SYNTH_IDS | set(band_ids)),
            corr_b.in_(_SYNTH_IDS),
        ]
        await db_session.execute(
            delete(OutboxEvent).where(or_(*conditions))
        )
        await db_session.commit()

    await _drain()
    yield
    await _drain()


async def _my_events(session) -> list[OutboxEvent]:
    target = OutboxEvent.payload["target_value"].astext
    corr = OutboxEvent.payload["correlation_value"].astext
    result = await session.execute(
        select(OutboxEvent)
        .where(or_(target.in_(_SYNTH_IDS), corr.in_(_SYNTH_IDS)))
        .order_by(OutboxEvent.id)
    )
    return list(result.scalars().all())


# ===========================================================================
# 1. emit_notification -- the notification_request document
# ===========================================================================


class TestEmitNotification:
    async def test_document_form(self, db_session) -> None:
        await emit_notification(
            db_session,
            type="booking.confirmed",
            target_type="user",
            target_value=SYNTH_USER,
            title="T",
            body="B",
            action_data={"practice_title": "Yoga"},
        )
        await db_session.commit()

        (event,) = await _my_events(db_session)
        assert event.event_type == EVENT_NOTIFICATION_REQUEST
        p = event.payload
        assert p["v"] == 1
        assert p["type"] == "booking.confirmed"
        assert p["idempotency_key"]
        assert p["channels"] == DEFAULT_CHANNELS
        assert p["priority"] == 5
        assert p["action_data"]["practice_title"] == "Yoga"
        # The document is wire-clean (relay json.dumps must not choke).
        json.dumps(p)

    async def test_idempotency_keys_unique_per_emit(
        self, db_session,
    ) -> None:
        for _ in range(2):
            await emit_notification(
                db_session,
                type="booking.confirmed",
                target_type="user",
                target_value=SYNTH_USER,
                title="T",
                body="B",
            )
        await db_session.commit()
        events = await _my_events(db_session)
        keys = {e.payload["idempotency_key"] for e in events}
        assert len(keys) == 2


# ===========================================================================
# 2. Reminder orchestration
# ===========================================================================


class TestReminderOrchestration:
    async def test_series_anchored_with_correlation(
        self, db_session,
    ) -> None:
        anchor = datetime.now(UTC) + timedelta(days=2)
        emitted = await schedule_booking_reminders(
            db_session,
            booking_id=SYNTH_BOOKING,
            user_id=SYNTH_USER,
            practice_id=SYNTH_PRACTICE,
            practice_title="Yoga",
            master_name="Anna",
            scheduled_at=anchor,
        )
        await db_session.commit()

        assert emitted == 3
        events = await _my_events(db_session)
        assert [e.payload["type"] for e in events] == BOOKING_REMINDER_TYPES
        for event, lead in zip(
            events,
            (timedelta(hours=24), timedelta(hours=1), timedelta(minutes=10)),
            strict=True,
        ):
            p = event.payload
            sent_at = datetime.fromisoformat(p["scheduled_at"])
            assert sent_at == anchor - lead
            assert datetime.fromisoformat(p["expiry_at"]) == anchor
            assert p["action_data"]["booking_id"] == SYNTH_BOOKING
            assert p["action_data"]["practice_id"] == SYNTH_PRACTICE
            assert p["priority"] == 2

    async def test_min_lead_skips_near_reminders(self, db_session) -> None:
        """Anchor in 30 minutes: 24h and 1h sends are in the past,
        the 10m send (+20 min) clears the 5-minute cutoff -> 1 emit."""
        anchor = datetime.now(UTC) + timedelta(minutes=30)
        emitted = await schedule_booking_reminders(
            db_session,
            booking_id=SYNTH_BOOKING,
            user_id=SYNTH_USER,
            practice_id=SYNTH_PRACTICE,
            practice_title="Yoga",
            master_name="Anna",
            scheduled_at=anchor,
        )
        await db_session.commit()

        assert emitted == 1
        (event,) = await _my_events(db_session)
        assert event.payload["type"] == "booking.reminder_10m"

    async def test_cancel_forms(self, db_session) -> None:
        await cancel_booking_reminders(
            db_session,
            booking_id=SYNTH_BOOKING,
            user_id=SYNTH_USER,
        )
        await cancel_practice_reminders(
            db_session, practice_id=SYNTH_PRACTICE,
        )
        await db_session.commit()

        per_booking, per_practice = await _my_events(db_session)
        assert per_booking.event_type == EVENT_REMINDER_CANCEL
        p = per_booking.payload
        assert p["types"] == BOOKING_REMINDER_TYPES
        assert p["correlation_key"] == "booking_id"
        assert p["correlation_value"] == SYNTH_BOOKING
        assert p["target_type"] == "user"
        assert p["target_value"] == SYNTH_USER

        q = per_practice.payload
        assert q["correlation_key"] == "practice_id"
        assert q["correlation_value"] == SYNTH_PRACTICE
        assert "target_type" not in q and "target_value" not in q

    async def test_half_target_rejected(self, db_session) -> None:
        with pytest.raises(ValueError, match="together or not at all"):
            await emit_reminder_cancel(
                db_session,
                types=["booking.reminder_1h"],
                correlation_key="booking_id",
                correlation_value=SYNTH_BOOKING,
                target_type="user",
            )

    async def test_feedback_prompt_is_scheduled(self, db_session) -> None:
        before = datetime.now(UTC)
        await schedule_feedback_prompt(
            db_session,
            user_id=SYNTH_USER,
            practice_id=SYNTH_PRACTICE,
            practice_title="Yoga",
        )
        await db_session.commit()

        (event,) = await _my_events(db_session)
        p = event.payload
        assert p["type"] == "prompt.leave_feedback"
        sent_at = datetime.fromisoformat(p["scheduled_at"])
        expiry = datetime.fromisoformat(p["expiry_at"])
        delay = timedelta(seconds=settings.prompt_feedback_delay_seconds)
        window = timedelta(
            seconds=settings.prompt_feedback_expiry_seconds,
        )
        assert before + delay <= sent_at <= before + delay + timedelta(
            minutes=1,
        )
        assert expiry - sent_at == window - delay


# ===========================================================================
# 3. The notifications proxy
# ===========================================================================

_PROXY_SEAM = "app.modules.comms_proxy.router.comms_request"

_QUIET_PREFS = {
    "categories": {"bookings": True, "reminders": False},
    # comms speaks the QUIET window: silence 22:00 -> 09:00.
    "schedule": {"from": "22:00", "to": "09:00", "days": ["mon", "fri"]},
    "timezone": "Europe/Berlin",
}


class TestNotificationsProxy:
    async def test_inbox_recipient_id_is_session_derived(
        self, client, db_session,
    ) -> None:
        login = await login_user(client, telegram_id=TID_PROXY)
        seam = AsyncMock(return_value={
            "items": [], "next_cursor": None, "unread": 0,
        })
        with patch(_PROXY_SEAM, seam):
            response = await client.get(
                "/api/v1/notifications?limit=5",
                headers=auth_headers(login["session_token"]),
            )
        assert response.status_code == 200
        assert response.json()["unread"] == 0
        path = seam.await_args.args[1]
        assert path == (
            f"/api/v1/recipients/{login['user']['id']}/inbox"
        )
        assert seam.await_args.kwargs["params"] == {"limit": 5}

    async def test_client_supplied_recipient_id_rejected(
        self, client,
    ) -> None:
        login = await login_user(client, telegram_id=TID_PROXY)
        seam = AsyncMock()
        with patch(_PROXY_SEAM, seam):
            response = await client.get(
                "/api/v1/notifications?recipient_id=someone-else",
                headers=auth_headers(login["session_token"]),
            )
        assert response.status_code == 400
        seam.assert_not_awaited()

    async def test_prefs_get_converts_quiet_to_delivery(
        self, client,
    ) -> None:
        login = await login_user(client, telegram_id=TID_PREFS)
        seam = AsyncMock(return_value=dict(_QUIET_PREFS))
        with patch(_PROXY_SEAM, seam):
            response = await client.get(
                "/api/v1/notifications/prefs",
                headers=auth_headers(login["session_token"]),
            )
        assert response.status_code == 200
        body = response.json()
        # Quiet 22:00->09:00 == deliver 09:00->22:00; days pass through.
        assert body["schedule"] == {
            "from": "09:00", "to": "22:00", "days": ["mon", "fri"],
        }
        # Categories and timezone are NOT re-assembled.
        assert body["categories"] == _QUIET_PREFS["categories"]
        assert body["timezone"] == "Europe/Berlin"

    async def test_prefs_put_converts_delivery_to_quiet(
        self, client,
    ) -> None:
        login = await login_user(client, telegram_id=TID_PREFS)
        seam = AsyncMock(return_value=dict(_QUIET_PREFS))
        with patch(_PROXY_SEAM, seam):
            response = await client.put(
                "/api/v1/notifications/prefs",
                headers=auth_headers(login["session_token"]),
                json={
                    "categories": {"reminders": False},
                    "schedule": {
                        "from": "09:00", "to": "22:00",
                        "days": ["mon", "fri"],
                    },
                },
            )
        assert response.status_code == 200
        sent = seam.await_args.kwargs["json"]
        assert sent["categories"] == {"reminders": False}
        assert sent["schedule"] == {
            "from": "22:00", "to": "09:00", "days": ["mon", "fri"],
        }

    async def test_prefs_put_null_schedule_clears(self, client) -> None:
        login = await login_user(client, telegram_id=TID_PREFS)
        seam = AsyncMock(return_value={
            "categories": {}, "schedule": None, "timezone": None,
        })
        with patch(_PROXY_SEAM, seam):
            response = await client.put(
                "/api/v1/notifications/prefs",
                headers=auth_headers(login["session_token"]),
                json={"schedule": None},
            )
        assert response.status_code == 200
        assert seam.await_args.kwargs["json"] == {"schedule": None}

    async def test_prefs_unknown_key_rejected(self, client) -> None:
        login = await login_user(client, telegram_id=TID_PREFS)
        seam = AsyncMock()
        with patch(_PROXY_SEAM, seam):
            response = await client.put(
                "/api/v1/notifications/prefs",
                headers=auth_headers(login["session_token"]),
                json={"timezone": "Europe/Berlin"},
            )
        assert response.status_code == 422
        seam.assert_not_awaited()

    async def test_comms_unconfigured_means_502(self, client) -> None:
        """Empty COMMS_API_URL -> 502 through the REAL core/comms.py
        client. PATCHED empty, not asserted empty: on the test VPS the
        Phase 5 installer has already written a live comms url into
        .env, so the environment must not be assumed unconfigured
        (post-T1 finding: this assert was env-dependent and went red
        on the VPS while green in a bare sandbox)."""
        login = await login_user(client, telegram_id=TID_PROXY)
        with patch.object(settings, "comms_api_url", ""):
            response = await client.get(
                "/api/v1/notifications/unread-count",
                headers=auth_headers(login["session_token"]),
            )
        assert response.status_code == 502

    async def test_comms_timeout_means_504(self, client) -> None:
        """Patch the AsyncClient CLASS inside core/comms.py only -- the
        ASGI test client is itself an httpx.AsyncClient, so patching
        the shared class method would sever the test's own transport."""
        login = await login_user(client, telegram_id=TID_PROXY)

        class _TimingOutClient:
            def __init__(self, *args: object, **kwargs: object) -> None:
                pass

            async def __aenter__(self) -> "_TimingOutClient":
                return self

            async def __aexit__(self, *exc: object) -> None:
                return None

            async def request(self, *args: object, **kwargs: object):
                raise httpx.ConnectTimeout("slow")

        with (
            patch.object(
                settings, "comms_api_url", "http://comms-test.invalid",
            ),
            patch(
                "app.core.comms.httpx.AsyncClient", _TimingOutClient,
            ),
        ):
            response = await client.get(
                "/api/v1/notifications/unread-count",
                headers=auth_headers(login["session_token"]),
            )
        assert response.status_code == 504


# ===========================================================================
# 4. Admin announcements (plan fork 6 -- the system.announcement emit point)
# ===========================================================================


class TestAnnouncements:
    async def _make_admin(self, client, db_session, telegram_id: int):
        login = await login_user(client, telegram_id=telegram_id)
        result = await db_session.execute(
            select(User).where(User.telegram_id == telegram_id)
        )
        user = result.scalar_one()
        user.role = "admin"
        await db_session.commit()
        return login

    async def test_announcement_emits_to_all(
        self, client, db_session,
    ) -> None:
        login = await self._make_admin(client, db_session, TID_ADMIN)
        response = await client.post(
            "/api/v1/admin/announcements",
            headers=auth_headers(login["session_token"]),
            json={"title": "Апдейт", "body": "Мы обновились."},
        )
        assert response.status_code == 200
        assert response.json() == {"queued": True, "audience": "all"}

        result = await db_session.execute(
            select(OutboxEvent)
            .where(
                OutboxEvent.payload["type"].astext
                == "system.announcement",
            )
            .order_by(OutboxEvent.id.desc())
        )
        event = result.scalars().first()
        assert event is not None
        assert event.payload["target_type"] == "all"
        assert event.payload["target_value"] == "*"
        # Clean up the broadcast row (it has no band target).
        await db_session.delete(event)
        await db_session.commit()

    async def test_announcement_masters_audience(
        self, client, db_session,
    ) -> None:
        login = await self._make_admin(client, db_session, TID_ADMIN)
        response = await client.post(
            "/api/v1/admin/announcements",
            headers=auth_headers(login["session_token"]),
            json={
                "title": "Мастерам",
                "body": "Новые правила выплат.",
                "audience": "masters",
            },
        )
        assert response.status_code == 200

        result = await db_session.execute(
            select(OutboxEvent)
            .where(
                OutboxEvent.payload["type"].astext
                == "system.announcement",
            )
            .order_by(OutboxEvent.id.desc())
        )
        event = result.scalars().first()
        assert event is not None
        assert event.payload["target_type"] == "group"
        assert event.payload["target_value"] == "masters"
        await db_session.delete(event)
        await db_session.commit()

    async def test_announcement_requires_admin(self, client) -> None:
        login = await login_user(client, telegram_id=TID_NON_ADMIN)
        response = await client.post(
            "/api/v1/admin/announcements",
            headers=auth_headers(login["session_token"]),
            json={"title": "X", "body": "Y"},
        )
        assert response.status_code in (401, 403)
