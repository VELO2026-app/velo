# =============================================================================
# VELO -- BE-172: the support roster in comms and the admin signal
# =============================================================================
# Band 89860-89869 (the 89xxx free window, telegram_id_bands.py).
#
# What is under test:
#   1. THE ROSTER. An admin-capability delta projects the group AND the
#      `support` section roster (core/events emit_membership), in outbox
#      order user_upserted < group_changed < section_membership_changed on
#      an add; a drop removes both; no delta is silence; group:masters
#      declares no section. The section event's field set is comms'
#      closed set exactly.
#   2. THE PATHS that give or take the capability: set_role M then A on an
#      admin with a verified profile (the stand's live-check path, profile
#      untouched), seed's flip of an admin into a master, the backfill and
#      its repeat.
#   3. THE SIGNAL. support.message_received to group:admins on every user
#      message -- the form and the conversation alike -- keyed by the comms
#      message; the topic as a whole line or nothing; the sender-name
#      chain; nothing when comms refused the message; the profile's two
#      sheets read only variables the emit carries.
#
# comms is cut at app.modules.support.service.comms_request, the one seam
# both message doors reach (the chats door resolves the caller's support
# thread locally, chats/router.py _require_participant).
# =============================================================================

from string import Formatter
from unittest.mock import AsyncMock
from uuid import UUID, uuid4

import pytest
import yaml
from fastapi import HTTPException
from httpx import AsyncClient
from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session_factory
from app.core.events import (
    EVENT_GROUP_CHANGED,
    EVENT_SECTION_MEMBERSHIP_CHANGED,
    EVENT_USER_UPSERTED,
    GROUP_ADMINS,
    GROUP_MASTERS,
    sync_membership_delta,
)
from app.core.events.models import OutboxEvent
from app.modules.masters.models import MasterProfile
from app.modules.support import service as support_service
from app.modules.support.models import SupportThread
from app.modules.users.models import User
from scripts import seed, set_role
from tests.helpers import (
    auth_headers,
    fresh_execute,
    fresh_get,
    full_cleanup_range,
    login_user,
)
from tests.test_master_notifications import _profile_dir

BAND_MIN, BAND_MAX = 89860, 89869

_SEAM = "app.modules.support.service.comms_request"

# comms 3.10.0, app/transport/events.py _SECTION_MEMBERSHIP_CHANGED_FIELDS --
# a MIRROR, not an import (velo never imports comms code). comms refuses an
# event carrying any other field, naming it.
_COMMS_SECTION_FIELDS = {"v", "section_key", "section_label", "operator_id", "member"}

_SECTION_ADD = {
    "v": 1,
    "section_key": "support",
    "section_label": "Support",
    "member": True,
}


@pytest.fixture(autouse=True)
async def _clean(db_session: AsyncSession):
    """Band users and their outbox rows, plus the group-targeted signals.

    full_cleanup_range sees rows naming a band user (target_value,
    recipient_id, operator_id). support.message_received goes to the
    group and names nobody, so it is deleted by type, as in the other
    files that send support messages.
    """

    async def _drain() -> None:
        await full_cleanup_range(db_session, BAND_MIN, BAND_MAX, delete_users=True)
        await db_session.execute(
            delete(OutboxEvent).where(
                OutboxEvent.payload["type"].astext
                == support_service.MESSAGE_RECEIVED_TYPE
            )
        )
        await db_session.commit()

    await _drain()
    yield
    await _drain()


async def _user(client: AsyncClient, db_session: AsyncSession, tid: int, **kw) -> User:
    return (await _login(client, db_session, tid, **kw))[0]


async def _login(
    client: AsyncClient, db_session: AsyncSession, tid: int, **kw,
) -> tuple[User, str]:
    """One login: the user row and the session token. One, because a
    second login re-applies the Telegram name the helper defaults to."""
    auth = await login_user(client, telegram_id=tid, **kw)
    user = await db_session.get(User, UUID(auth["user"]["id"]))
    return user, auth["session_token"]


async def _events(uid: UUID) -> list[OutboxEvent]:
    """Sync events about this person, in outbox (= publication) order."""
    p = OutboxEvent.payload
    return list(
        (
            await fresh_execute(
                select(OutboxEvent)
                .where(
                    or_(
                        p["recipient_id"].astext == str(uid),
                        p["operator_id"].astext == str(uid),
                    )
                )
                .order_by(OutboxEvent.id)
            )
        ).scalars().all()
    )


async def _sections(uid: UUID) -> list[dict]:
    return [
        e.payload
        for e in await _events(uid)
        if e.event_type == EVENT_SECTION_MEMBERSHIP_CHANGED
    ]


async def _forget_events(db_session: AsyncSession, uid: UUID) -> None:
    p = OutboxEvent.payload
    await db_session.execute(
        delete(OutboxEvent).where(
            or_(
                p["recipient_id"].astext == str(uid),
                p["operator_id"].astext == str(uid),
            )
        )
    )
    await db_session.commit()


# ---------------------------------------------------------------------------
# 1. The roster
# ---------------------------------------------------------------------------


class TestRoster:
    async def test_admin_add_is_snapshot_then_group_then_section(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        user = await _user(client, db_session, BAND_MIN)
        await _forget_events(db_session, user.id)

        await sync_membership_delta(
            db_session, user, group_key=GROUP_ADMINS, had=False, has=True,
        )
        await db_session.commit()

        events = await _events(user.id)
        assert [e.event_type for e in events] == [
            EVENT_USER_UPSERTED,
            EVENT_GROUP_CHANGED,
            EVENT_SECTION_MEMBERSHIP_CHANGED,
        ]
        section = events[-1].payload
        assert set(section) == _COMMS_SECTION_FIELDS
        assert section == {**_SECTION_ADD, "operator_id": str(user.id)}

    async def test_admin_drop_is_group_then_section_without_snapshot(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        user = await _user(client, db_session, BAND_MIN + 1)
        await _forget_events(db_session, user.id)

        await sync_membership_delta(
            db_session, user, group_key=GROUP_ADMINS, had=True, has=False,
        )
        await db_session.commit()

        events = await _events(user.id)
        assert [e.event_type for e in events] == [
            EVENT_GROUP_CHANGED,
            EVENT_SECTION_MEMBERSHIP_CHANGED,
        ]
        assert events[0].payload["member"] is False
        assert events[1].payload == {
            **_SECTION_ADD, "member": False, "operator_id": str(user.id),
        }

    async def test_no_delta_is_silence_and_one_delta_is_heard(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        """Both no-delta pairs emit nothing; the same call with a delta,
        right after, does -- so the empty answer is the code's, not the
        query's."""
        user = await _user(client, db_session, BAND_MIN + 2)
        await _forget_events(db_session, user.id)

        for both in (True, False):
            await sync_membership_delta(
                db_session, user, group_key=GROUP_ADMINS, had=both, has=both,
            )
        await db_session.commit()
        assert await _events(user.id) == []

        await sync_membership_delta(
            db_session, user, group_key=GROUP_ADMINS, had=False, has=True,
        )
        await db_session.commit()
        assert len(await _sections(user.id)) == 1

    async def test_masters_group_declares_no_section(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        user = await _user(client, db_session, BAND_MIN + 3)
        await _forget_events(db_session, user.id)

        await sync_membership_delta(
            db_session, user, group_key=GROUP_MASTERS, had=False, has=True,
        )
        await db_session.commit()

        events = await _events(user.id)
        groups = [e.payload for e in events if e.event_type == EVENT_GROUP_CHANGED]
        assert [(g["group_key"], g["member"]) for g in groups] == [
            (GROUP_MASTERS, True)
        ]
        assert await _sections(user.id) == []


# ---------------------------------------------------------------------------
# 2. The paths
# ---------------------------------------------------------------------------


class TestPaths:
    async def test_set_role_m_then_a_cycles_the_roster_and_keeps_the_profile(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        """The stand's live-check path (BE-172 gate): an admin who holds a
        verified master profile -- `velo setrole <id> M`, then `A`.

        M drops the admin capability (role master, marker cleared) and
        leaves the profile as it was; A gives the capability back. The
        roster sees member False, then True.
        """
        user = await _user(client, db_session, BAND_MIN + 4)
        assert await set_role.to_master(db_session, user, assume_yes=True)
        assert await set_role.to_admin(db_session, user, assume_yes=True)
        await db_session.commit()
        profile = await db_session.get(MasterProfile, user.id)
        before = dict(profile.data)
        await _forget_events(db_session, user.id)

        assert await set_role.to_master(db_session, user, assume_yes=True)
        await db_session.commit()
        assert [s["member"] for s in await _sections(user.id)] == [False]

        assert await set_role.to_admin(db_session, user, assume_yes=True)
        await db_session.commit()
        assert [s["member"] for s in await _sections(user.id)] == [False, True]

        profile = await fresh_get(MasterProfile, user.id)
        assert profile.data == before
        assert profile.data["account"]["status"] == "verified"

    async def test_seed_flipping_an_admin_into_a_master_leaves_the_roster(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        """scripts/seed.py ensure_master on a reused account that is an
        admin: the flip to master is the admin drop, projected like every
        other path's -- group:admins and the roster both say False."""
        user = await _user(client, db_session, BAND_MIN + 5)
        user.role = "admin"
        await db_session.commit()
        uid = user.id
        await _forget_events(db_session, uid)

        async with get_session_factory()() as s:
            await seed.ensure_master(
                s,
                {
                    "key": "m",
                    "telegram_id": BAND_MIN + 5,
                    "display_name": "Seed Master",
                    "bio": "bio",
                    "methods": ["meditation — presence"],
                    "experience_years": 1,
                },
            )
            await s.commit()

        events = await _events(uid)
        admins = [
            e.payload["member"]
            for e in events
            if e.event_type == EVENT_GROUP_CHANGED
            and e.payload["group_key"] == GROUP_ADMINS
        ]
        assert admins == [False]
        assert [s["member"] for s in await _sections(uid)] == [False]

    async def test_backfill_declares_every_capability_holder_and_repeats_alike(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        """Role admin and the switched-away marker both seat a person on
        the roster; a plain user gets no section event. A second run emits
        the same section events again -- identical documents, which comms
        applies as "ensure member"."""
        from scripts.backfill_comms_sync import backfill

        admin = await _user(client, db_session, BAND_MIN + 6)
        admin.role = "admin"
        marker = await _user(client, db_session, BAND_MIN + 7)
        marker.credentials = {
            **(marker.credentials or {}),
            "role_switch": {"home_role": "admin"},
        }
        plain = await _user(client, db_session, BAND_MIN + 8)
        await db_session.commit()
        ids = (admin.id, marker.id, plain.id)
        for uid in ids:
            await _forget_events(db_session, uid)

        await backfill()
        first = {uid: await _sections(uid) for uid in ids}
        assert first[admin.id] == [{**_SECTION_ADD, "operator_id": str(admin.id)}]
        assert first[marker.id] == [{**_SECTION_ADD, "operator_id": str(marker.id)}]
        assert first[plain.id] == []
        assert len(await _events(plain.id)) == 1  # its snapshot -- it was seen

        await backfill()
        for uid in ids:
            assert await _sections(uid) == first[uid] * 2


# ---------------------------------------------------------------------------
# 3. The signal
# ---------------------------------------------------------------------------


def _message(body: str = "help", message_id: str | None = None) -> dict:
    return {
        "id": message_id or str(uuid4()),
        "thread_id": str(uuid4()),
        "sender": str(uuid4()),
        "body": body,
        "created_at": "2026-10-25T10:00:00+00:00",
    }


async def _with_thread(db_session: AsyncSession, user: User) -> UUID:
    thread_id = uuid4()
    db_session.add(SupportThread(comms_thread_id=thread_id, client_user_id=user.id))
    await db_session.commit()
    return thread_id


async def _signals(uid: UUID) -> list[dict]:
    p = OutboxEvent.payload
    return [
        e.payload
        for e in (
            await fresh_execute(
                select(OutboxEvent)
                .where(
                    p["type"].astext == support_service.MESSAGE_RECEIVED_TYPE,
                    p["action_data"]["params"]["user_id"].astext == str(uid),
                )
                .order_by(OutboxEvent.id)
            )
        ).scalars().all()
    ]


class TestSignal:
    async def test_form_message_signals_every_admin_with_its_topic(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch,
    ) -> None:
        user, token = await _login(client, db_session, BAND_MIN, first_name="Анна")
        await _with_thread(db_session, user)
        message = _message()
        monkeypatch.setattr(_SEAM, AsyncMock(return_value=message))

        resp = await client.post(
            "/api/v1/support/threads/messages",
            json={"topic": " Оплата ", "body": "help"},
            headers=auth_headers(token),
        )
        assert resp.status_code == 200, resp.text

        (signal,) = await _signals(user.id)
        assert signal["idempotency_key"] == f"support-message:{message['id']}"
        assert (signal["target_type"], signal["target_value"]) == ("group", "admins")
        assert signal["action_data"] == {
            "action": "open_admin_support",
            "params": {"user_id": str(user.id)},
            "sender_name": "Анна",
            "topic_line": "\n🏷 Оплата",
        }
        assert signal["title"] and signal["body"] == "Анна\n🏷 Оплата"

    async def test_conversation_message_signals_too_without_a_topic(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch,
    ) -> None:
        user, token = await _login(client, db_session, BAND_MIN + 1, first_name="Bob")
        thread_id = await _with_thread(db_session, user)
        message = _message()
        monkeypatch.setattr(_SEAM, AsyncMock(return_value=message))

        resp = await client.post(
            f"/api/v1/chats/{thread_id}/messages",
            json={"body": "and one more thing"},
            headers=auth_headers(token),
        )
        assert resp.status_code == 200, resp.text

        (signal,) = await _signals(user.id)
        assert signal["idempotency_key"] == f"support-message:{message['id']}"
        assert signal["action_data"]["topic_line"] == ""
        assert signal["action_data"]["sender_name"] == "Bob"

    async def test_blank_topic_is_no_topic(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch,
    ) -> None:
        user, token = await _login(client, db_session, BAND_MIN + 2)
        await _with_thread(db_session, user)
        monkeypatch.setattr(_SEAM, AsyncMock(return_value=_message()))

        resp = await client.post(
            "/api/v1/support/threads/messages",
            json={"topic": "   ", "body": "help"},
            headers=auth_headers(token),
        )
        assert resp.status_code == 200, resp.text
        (signal,) = await _signals(user.id)
        assert signal["action_data"]["topic_line"] == ""

    async def test_a_replayed_message_repeats_the_same_document(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch,
    ) -> None:
        """A client retry with its key gets the SAME comms message back;
        the second emit carries the same key and the same bytes, which
        comms intake answers as a duplicate -- one signal reaches people."""
        user, token = await _login(client, db_session, BAND_MIN + 3)
        await _with_thread(db_session, user)
        message = _message()
        monkeypatch.setattr(_SEAM, AsyncMock(return_value=message))
        headers = {
            **auth_headers(token),
            "Idempotency-Key": "form-1",
        }

        for _ in range(2):
            resp = await client.post(
                "/api/v1/support/threads/messages",
                json={"topic": "t", "body": "help"},
                headers=headers,
            )
            assert resp.status_code == 200, resp.text

        first, second = await _signals(user.id)
        assert first == second
        assert first["idempotency_key"] == f"support-message:{message['id']}"

    async def test_no_signal_when_comms_refused_the_message(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch,
    ) -> None:
        """comms down on the POST: the request fails and the outbox holds
        no signal; the same request once comms answers holds exactly one."""
        user, token = await _login(client, db_session, BAND_MIN + 4)
        await _with_thread(db_session, user)

        # What comms_request raises when comms does not answer (core/comms).
        monkeypatch.setattr(
            _SEAM,
            AsyncMock(side_effect=HTTPException(status_code=502, detail="down")),
        )
        resp = await client.post(
            "/api/v1/support/threads/messages",
            json={"body": "help"},
            headers=auth_headers(token),
        )
        assert resp.status_code == 502
        assert await _signals(user.id) == []

        monkeypatch.setattr(_SEAM, AsyncMock(return_value=_message()))
        resp = await client.post(
            "/api/v1/support/threads/messages",
            json={"body": "help"},
            headers=auth_headers(token),
        )
        assert resp.status_code == 200, resp.text
        assert len(await _signals(user.id)) == 1


class TestSenderName:
    @pytest.mark.parametrize(
        ("first", "last", "credentials", "expected"),
        [
            ("Анна", "Ким", {}, "Анна Ким"),
            (" Анна ", "  ", {"telegram_username": "anna"}, "Анна"),
            (None, None, {"telegram_username": "anna"}, "@anna"),
            ("", " ", {"telegram_username": "  "}, "—"),
            (None, None, None, "—"),
        ],
    )
    def test_name_then_username_then_dash(
        self, first, last, credentials, expected,
    ) -> None:
        user = User(first_name=first, last_name=last, credentials=credentials)
        assert support_service._sender_name(user) == expected


class TestProfileSheets:
    def test_both_sheets_read_only_what_the_emit_carries(self) -> None:
        """comms fills a sheet with str.format; a variable the job does not
        carry drops the whole sheet to the stored English text without a
        word. Every variable of both sheets must be a key the emit sends,
        and both of the emit's text variables must be read."""
        carried = {"sender_name", "topic_line"}
        for locale in ("ru", "en"):
            sheets = yaml.safe_load(
                (_profile_dir() / "templates" / f"{locale}.yaml").read_text()
            )
            sheet = sheets[support_service.MESSAGE_RECEIVED_TYPE]["telegram"]
            used = {
                field
                for text in (sheet["title"], sheet["body"])
                for _, field, _, _ in Formatter().parse(text)
                if field
            }
            assert used == carried, locale

    def test_the_type_is_unmutable_and_reaches_telegram(self) -> None:
        types = yaml.safe_load((_profile_dir() / "types.yaml").read_text())["types"]
        record = types[support_service.MESSAGE_RECEIVED_TYPE]
        assert record == {"channels": ["in_app", "telegram"]}
        assert "support.thread_created" not in types
