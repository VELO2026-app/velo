# =============================================================================
# VELO Backend -- comms 3.0.0: Idempotency-Key on the calls that create,
# refusals read by class (items 25-26)
# =============================================================================
#
# telegram_id band: 88400-88499 (student 88401, other student 88402,
# master 88403, admin 88404). Declared module-level below as
# _TID_MIN/_TID_MAX, once. Checked free before it was claimed: no literal
# 884xx occurs in tests/, and 88300-88399 (test_comms_message_feeds.py)
# ends below it.
#
# THE DEFECT THIS PINS. comms 3.0.0 REQUIRES an Idempotency-Key on
# POST /threads and POST /threads/{id}/messages and refuses without one
# (422, class `validation`). comms_request sent no such header, so every
# send and every open failed on the stand -- and the person saw a generic
# "rejected", because core/comms.py looked for `detail` while comms puts
# its text in `error.message`.
#
# The keys are asserted AT THE WIRE (the header comms_request puts on the
# HTTP request), not on the arguments of a mocked comms_request -- the
# layer the claim lives on.
# =============================================================================

import hashlib
from collections.abc import AsyncGenerator
from typing import Any
from unittest.mock import patch
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import HTTPException
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.comms import comms_request
from app.core.config import settings
from app.modules.chats.models import ChatThread
from app.modules.masters.models import MasterProfile
from app.modules.support.models import SupportThread
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user

_TID_MIN = 88400
_TID_MAX = 88499

_TID_STUDENT = 88401
_TID_OTHER = 88402
_TID_MASTER = 88403
_TID_ADMIN = 88404

_KEY = "Idempotency-Key"


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    # Committed each time: an open delete would hold the band's rows
    # locked, and the next login (another session) would wait on it.
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


# ===========================================================================
# A fake comms at the HTTP layer: records every request, answers by route.
# ===========================================================================


class _Wire:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.refusal: tuple[int, Any] | None = None

    def client_class(self):
        wire = self

        class _Client:
            def __init__(self, *args: object, **kwargs: object) -> None:
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc: object) -> None:
                return None

            async def request(self, method, url, *, params=None, json=None,
                              headers=None):
                wire.calls.append(
                    {"method": method, "url": url, "json": json,
                     "headers": dict(headers or {})}
                )
                if wire.refusal is not None:
                    status, body = wire.refusal
                    if isinstance(body, str):
                        return httpx.Response(status, text=body)
                    return httpx.Response(status, json=body)
                if url.endswith("/messages"):
                    return httpx.Response(200, json={
                        "id": str(uuid4()), "thread_id": str(uuid4()),
                        "sender": (json or {}).get("sender"),
                        "body": (json or {}).get("body"),
                        "created_at": "2026-09-28T10:00:00+00:00",
                    })
                if url.endswith("/api/v1/sections"):
                    return httpx.Response(200, json={
                        "id": str(uuid4()), "key": "support",
                        "label": "Support", "created_at": "2026-09-28T10:00:00+00:00",
                    })
                if url.endswith("/api/v1/threads"):
                    return httpx.Response(200, json={
                        "id": str(uuid4()), "client": (json or {}).get("client"),
                        "operator_kind": (json or {}).get("operator_kind"),
                        "operator_value": (json or {}).get("operator_value"),
                        "assignee": None, "kind": "dm", "status": "open",
                        "subject_type": None, "subject_id": None,
                        "title": (json or {}).get("title"), "priority": None,
                        "last_message_at": None,
                        "created_at": "2026-09-28T10:00:00+00:00",
                        "created": True,
                    })
                return httpx.Response(200, json={})

        return _Client

    def keys(self, suffix: str) -> list[str | None]:
        return [
            c["headers"].get(_KEY) for c in self.calls
            if c["method"] == "POST" and c["url"].endswith(suffix)
        ]


@pytest.fixture
def wire():
    w = _Wire()
    with (
        patch.object(settings, "comms_api_url", "http://comms-test.invalid"),
        patch("app.core.comms.httpx.AsyncClient", w.client_class()),
        # support/service.py caches the section id per process.
        patch("app.modules.support.service._support_section_id", None),
    ):
        yield w


async def _login(client, db_session, telegram_id: int, role: str | None = None):
    auth = await login_user(client, telegram_id=telegram_id, first_name="Me")
    if role is None:
        return auth
    user_id = UUID(auth["user"]["id"])
    if role == UserRole.MASTER.value:
        db_session.add(
            MasterProfile(
                user_id=user_id,
                data={"account": {"status": "verified"}, "profile": {"bio": "b"}},
            )
        )
    user = await db_session.get(User, user_id)
    user.role = role
    await db_session.commit()
    return await login_user(client, telegram_id=telegram_id, first_name="Me")


async def _chat_thread(client, db_session) -> tuple[dict, UUID, UUID]:
    """A student-master DM pointer: (student auth, master id, thread id)."""
    student = await _login(client, db_session, _TID_STUDENT)
    master = await _login(client, db_session, _TID_MASTER, UserRole.MASTER.value)
    thread_id = uuid4()
    db_session.add(
        ChatThread(
            comms_thread_id=thread_id,
            client_user_id=UUID(student["user"]["id"]),
            operator_user_id=UUID(master["user"]["id"]),
        )
    )
    await db_session.commit()
    return student, UUID(master["user"]["id"]), thread_id


def _expected(user_id: str, client_key: str) -> str:
    return f"msg:{user_id}:{hashlib.sha256(client_key.encode()).hexdigest()}"


# ===========================================================================
# 1. Keys on the wire
# ===========================================================================


@pytest.mark.asyncio
class TestMessageKeys:
    async def test_without_a_client_key_each_send_has_its_own(
        self, client: AsyncClient, db_session: AsyncSession, wire: _Wire,
    ) -> None:
        student, _master_id, thread_id = await _chat_thread(client, db_session)
        for _ in range(2):
            resp = await client.post(
                f"/api/v1/chats/{thread_id}/messages",
                json={"body": "ok"},
                headers=auth_headers(student["session_token"]),
            )
            assert resp.status_code == 200, resp.text
        first, second = wire.keys("/messages")
        assert first and second and first != second
        assert first.startswith("msg:")

    async def test_the_same_client_key_is_the_same_key_twice(
        self, client: AsyncClient, db_session: AsyncSession, wire: _Wire,
    ) -> None:
        """POVTOR: one intent, one key -- comms keeps one message for it."""
        student, _master_id, thread_id = await _chat_thread(client, db_session)
        for _ in range(2):
            resp = await client.post(
                f"/api/v1/chats/{thread_id}/messages",
                json={"body": "ok"},
                headers={
                    **auth_headers(student["session_token"]), _KEY: "tap-1",
                },
            )
            assert resp.status_code == 200, resp.text
        first, second = wire.keys("/messages")
        assert first == second == _expected(student["user"]["id"], "tap-1")
        assert len(first) == 105

    async def test_two_people_with_one_client_key_never_share_a_key(
        self, client: AsyncClient, db_session: AsyncSession, wire: _Wire,
    ) -> None:
        """comms' key index is global: the sender is part of the key."""
        student, master_id, thread_id = await _chat_thread(client, db_session)
        other = await _login(client, db_session, _TID_OTHER)
        other_thread = uuid4()
        db_session.add(
            ChatThread(
                comms_thread_id=other_thread,
                client_user_id=UUID(other["user"]["id"]),
                operator_user_id=master_id,
            )
        )
        await db_session.commit()
        for auth, tid in ((student, thread_id), (other, other_thread)):
            resp = await client.post(
                f"/api/v1/chats/{tid}/messages",
                json={"body": "ok"},
                headers={**auth_headers(auth["session_token"]), _KEY: "same"},
            )
            assert resp.status_code == 200, resp.text
        mine, theirs = wire.keys("/messages")
        assert mine != theirs
        assert mine == _expected(student["user"]["id"], "same")

    @pytest.mark.parametrize("bad", ["", "   ", "k" * 201])
    async def test_a_client_key_comms_would_refuse_is_refused_here(
        self, client: AsyncClient, db_session: AsyncSession, wire: _Wire,
        bad: str,
    ) -> None:
        """NEHVATKA / PUSTOTA, with the pair: 200 characters pass."""
        student, _master_id, thread_id = await _chat_thread(client, db_session)
        resp = await client.post(
            f"/api/v1/chats/{thread_id}/messages",
            json={"body": "ok"},
            headers={**auth_headers(student["session_token"]), _KEY: bad},
        )
        assert resp.status_code == 422
        assert wire.calls == []
        resp = await client.post(
            f"/api/v1/chats/{thread_id}/messages",
            json={"body": "ok"},
            headers={**auth_headers(student["session_token"]), _KEY: "k" * 200},
        )
        assert resp.status_code == 200, resp.text
        assert wire.keys("/messages") == [
            _expected(student["user"]["id"], "k" * 200)
        ]


@pytest.mark.asyncio
class TestOpenKeys:
    async def test_every_chat_open_gets_its_own_key(
        self, client: AsyncClient, db_session: AsyncSession, wire: _Wire,
    ) -> None:
        """A stable key would turn the second open into a replay that says
        `created: True` -- a second "conversation started" in the diary."""
        student = await _login(client, db_session, _TID_STUDENT)
        master = await _login(
            client, db_session, _TID_MASTER, UserRole.MASTER.value,
        )
        for _ in range(2):
            resp = await client.post(
                "/api/v1/chats",
                json={"master_id": master["user"]["id"]},
                headers=auth_headers(student["session_token"]),
            )
            assert resp.status_code in (200, 201), resp.text
        first, second = wire.keys("/api/v1/threads")
        assert first and second and first != second
        assert first.startswith("thread-open:")

    async def test_support_open_and_send_follow_their_two_rules(
        self, client: AsyncClient, db_session: AsyncSession, wire: _Wire,
    ) -> None:
        student = await _login(client, db_session, _TID_STUDENT)
        headers = auth_headers(student["session_token"])
        for _ in range(2):
            resp = await client.post(
                "/api/v1/support/threads", json={"topic": "t"}, headers=headers,
            )
            assert resp.status_code in (200, 201), resp.text
            resp = await client.post(
                "/api/v1/support/threads/messages",
                json={"topic": "t", "body": "help"},
                headers={**headers, _KEY: "form-1"},
            )
            assert resp.status_code == 200, resp.text
        opens = wire.keys("/api/v1/threads")
        assert len(opens) == 2 and opens[0] != opens[1]
        assert all(k.startswith("support-open:") for k in opens)
        assert wire.keys("/messages") == [
            _expected(student["user"]["id"], "form-1")
        ] * 2

    async def test_an_admin_reply_carries_the_admins_key(
        self, client: AsyncClient, db_session: AsyncSession, wire: _Wire,
    ) -> None:
        admin = await _login(client, db_session, _TID_ADMIN, UserRole.ADMIN.value)
        opener = await _login(client, db_session, _TID_STUDENT)
        thread_id = uuid4()
        db_session.add(
            SupportThread(
                comms_thread_id=thread_id,
                client_user_id=UUID(opener["user"]["id"]),
            )
        )
        await db_session.commit()
        resp = await client.post(
            f"/api/v1/support/threads/{thread_id}/messages",
            json={"body": "on it"},
            headers={**auth_headers(admin["session_token"]), _KEY: "r-1"},
        )
        assert resp.status_code == 200, resp.text
        assert wire.keys("/messages") == [_expected(admin["user"]["id"], "r-1")]


# ===========================================================================
# 2. Refusals read by class
# ===========================================================================


def _refusal(cls: str, message: str = "comms says") -> dict:
    return {"error": {"class": cls, "message": message}}


@pytest.mark.asyncio
class TestRefusals:
    @pytest.mark.parametrize(
        ("status", "cls"),
        [(422, "validation"), (404, "not_found"), (409, "conflict")],
    )
    async def test_a_client_meaningful_class_is_forwarded_with_its_text(
        self, wire: _Wire, status: int, cls: str,
    ) -> None:
        wire.refusal = (status, _refusal(cls, "the reason"))
        with pytest.raises(HTTPException) as caught:
            await comms_request("GET", "/api/v1/x")
        assert caught.value.status_code == status
        assert caught.value.detail == "the reason"

    async def test_forbidden_is_ours_unless_the_call_opted_in(
        self, wire: _Wire,
    ) -> None:
        wire.refusal = (403, _refusal("forbidden", "claim it first"))
        with pytest.raises(HTTPException) as default:
            await comms_request("GET", "/api/v1/x")
        with pytest.raises(HTTPException) as opted:
            await comms_request("GET", "/api/v1/x", forward_403=True)
        assert default.value.status_code == 502
        assert (opted.value.status_code, opted.value.detail) == (
            403, "claim it first",
        )

    @pytest.mark.parametrize(
        ("status", "body"),
        [
            (401, _refusal("unauthorized")),  # our token -- never a logout
            (405, _refusal("method_not_allowed")),
            (409, _refusal("stale_snapshot")),  # a sync-event class
            (409, _refusal("recipient_deleted")),
            (404, _refusal("conflict")),  # class and status disagree
            (422, _refusal("no_such_class")),
            (422, {"detail": "comms 2.0.0 form"}),  # no envelope
            (422, {"error": "a string"}),
            (422, "not json at all"),
        ],
    )
    async def test_a_refusal_we_cannot_read_is_a_502(
        self, wire: _Wire, status: int, body: Any,
    ) -> None:
        wire.refusal = (status, body)
        with pytest.raises(HTTPException) as caught:
            await comms_request("GET", "/api/v1/x")
        assert caught.value.status_code == 502

    async def test_the_unreadable_refusal_logs_class_and_status_not_text(
        self, wire: _Wire,
    ) -> None:
        wire.refusal = (404, _refusal("conflict", "secret text"))
        with patch("app.core.comms.logger") as log, pytest.raises(HTTPException):
            await comms_request("GET", "/api/v1/x")
        log.error.assert_called_once()
        assert log.error.call_args.args == ("comms_refusal_shape_unexpected",)
        assert log.error.call_args.kwargs == {
            "path": "/api/v1/x", "status": 404, "error_class": "conflict",
            "body_type": "dict",
        }
        assert "secret text" not in repr(log.error.call_args)

    async def test_a_missing_key_refusal_now_reaches_the_person_as_text(
        self, client: AsyncClient, db_session: AsyncSession, wire: _Wire,
    ) -> None:
        """The stand's symptom, end to end: comms' 422 with its message is
        a 422 with THAT message, not "Notification service rejected"."""
        student, _master_id, thread_id = await _chat_thread(client, db_session)
        wire.refusal = (
            422, _refusal("validation", "the Idempotency-Key header is required"),
        )
        resp = await client.post(
            f"/api/v1/chats/{thread_id}/messages",
            json={"body": "ok"},
            headers=auth_headers(student["session_token"]),
        )
        assert resp.status_code == 422
        assert "Idempotency-Key" in resp.text
