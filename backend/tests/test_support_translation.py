# =============================================================================
# VELO -- support translation through comms variants (BE-166) and the comms
# push listener (BE-134)
# =============================================================================
# telegram_id band: 88700-88799 (admin 88701, user 88702, user 88703).
#
# comms is a FAKE here (FakeComms): one stateful stand-in behind every seam
# the code reaches comms through -- the support service, the translation
# module, the llm client and the listener. It keeps the thread's messages,
# the llm jobs (a job exists for comms only once the test SHIPS it from the
# outbox -- comms takes jobs asynchronously), the variant requests and the
# variants, and decides the feed's variant_state by comms
# deploy/INTEGRATION.md section 12's table. It refuses what comms refuses:
# a request naming a job it does not have (422), a variant from a job
# without an answer (422), a second variant in a language (409).
# =============================================================================

import asyncio
import json
from collections.abc import AsyncGenerator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi import HTTPException
from httpx import AsyncClient
from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import comms_listener, llm
from app.core.config import Settings, settings
from app.core.database import get_engine
from app.core.events.models import CommsFeedCursor, OutboxEvent
from app.core.llm import LlmResult
from app.modules.support import translation
from app.modules.support.models import (
    SupportThread,
    SupportTicket,
    SupportTranslationJob,
)
from app.modules.support.router import router as support_router
from app.modules.support.service import MESSAGE_RECEIVED_TYPE
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user

_TID_MIN = 88700
_TID_MAX = 88799
_TID_ADMIN = 88701
_TID_USER = 88702

_SEAMS = (
    "app.modules.support.service.comms_request",
    "app.modules.support.translation.comms_request",
    "app.core.llm.comms_request",
    "app.core.comms_listener.comms_request",
)

pytestmark = pytest.mark.asyncio


# ---------------------------------------------------------------------------
# The fake comms
# ---------------------------------------------------------------------------


class FakeComms:
    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []  # oldest first
        self.jobs: dict[str, dict[str, Any]] = {}
        self.requests: list[tuple[str, str, str]] = []  # (mid, locale, job)
        self.variants: dict[tuple[str, str], dict[str, Any]] = {}
        self.calls: list[tuple[str, str, Any, dict, str | None]] = []
        self.changes: list[str] = []
        self.keys: dict[str, Any] = {}

    # -- what the tests do to it --
    def answer(self, key: str, content: str, finish: str = "stop") -> None:
        body = {"choices": [{"finish_reason": finish, "message": {"content": content}}]}
        self.jobs[key] |= {"status": "sent", "answer": json.dumps(body)}

    def fail(self, key: str, status: str = "failed") -> None:
        self.jobs[key] |= {"status": status, "answer": None}

    def count(self, method: str, suffix: str) -> int:
        return sum(1 for c in self.calls if c[0] == method and c[1].endswith(suffix))

    # -- comms --
    def _state(self, mid: str, locale: str) -> str:
        own = self.variants.get((mid, locale))
        if own is not None:
            if own["declined"]:
                return "impossible"
            return "ready" if own["body"] else "not_needed"
        if any(
            m == mid and v["source_locale"] == locale
            for (m, _), v in self.variants.items()
        ):
            return "not_needed"
        mine = [r for r in self.requests if r[0] == mid and r[1] == locale]
        if mine:
            status = self.jobs[mine[-1][2]]["status"]
            return (
                "impossible"
                if status in ("failed", "expired", "cancelled")
                else "preparing"
            )
        return "not_requested"

    async def __call__(
        self,
        method: str,
        path: str,
        *,
        params: dict | None = None,
        json: dict | None = None,
        forward_403: bool = False,
        idempotency_key: str | None = None,
    ) -> Any:
        params = dict(params or {})
        self.calls.append((method, path, json, params, idempotency_key))
        if idempotency_key is not None and (method, path, idempotency_key) in self.keys:
            return self.keys[(method, path, idempotency_key)]
        result = self._route(method, path, params, json)
        if idempotency_key is not None:
            self.keys[(method, path, idempotency_key)] = result
        return result

    def _route(self, method: str, path: str, params: dict, body: dict | None) -> Any:
        parts = path.strip("/").split("/")
        if path == "/api/v1/notifications/by-key":
            job = self.jobs.get(params["key"])
            if job is None:
                raise HTTPException(404)
            if job.get("intake_rejected"):
                return {
                    "idempotency_key": params["key"],
                    "intake": [{"reason": "x"}],
                    "job": None,
                }
            answer = (
                {"state": "kept", "body": job["answer"]}
                if job.get("answer") is not None
                else None
            )
            return {"job": {"status": job["status"], "answer": answer}}
        if path == "/api/v1/notifications/changes":
            cursor = int(params.get("cursor") or 0)
            items = self.changes[cursor : cursor + params.get("limit", 100)]
            return {
                "items": [{"idempotency_key": k} for k in items],
                "next_cursor": str(cursor + len(items)),
            }
        if (
            parts[:3] == ["api", "v1", "threads"]
            and len(parts) == 5
            and method == "POST"
        ):
            message = {
                "id": str(uuid4()),
                "thread_id": parts[3],
                "sender": body["sender"],
                "body": body["body"],
                "created_at": datetime.now(UTC).isoformat(),
            }
            self.messages.append(message)
            return message
        if (
            parts[:3] == ["api", "v1", "threads"]
            and len(parts) == 5
            and method == "GET"
        ):
            newest = list(reversed(self.messages))
            start = int(params.get("cursor") or 0)
            page = newest[start : start + params.get("limit", 20)]
            nxt = str(start + len(page)) if start + len(page) < len(newest) else None
            locale = params.get("locale")
            items = []
            for m in page:
                item = dict(m)
                if locale is not None:
                    state = self._state(m["id"], locale)
                    v = self.variants.get((m["id"], locale))
                    item["variant_state"] = state
                    item["variant"] = (
                        {
                            "locale": locale,
                            "source_locale": v["source_locale"],
                            "body": v["body"],
                        }
                        if state == "ready"
                        else None
                    )
                items.append(item)
            return {"items": items, "next_cursor": nxt}
        if parts[-1] == "variant-requests":
            mid = parts[5]
            job = self.jobs.get(body["job_key"])
            if job is None or job.get("intake_rejected"):
                # comms keeps no job for a request it refused at intake.
                raise HTTPException(422, "job_key names no job of the llm kind")
            self.requests.append((mid, body["locale"], body["job_key"]))
            return {"message_id": mid, **body}
        if parts[-1] == "variants":
            mid = parts[5]
            job = self.jobs.get(body["job_key"])
            if job is None or job.get("answer") is None:
                raise HTTPException(422, "no answer")
            if (mid, body["locale"]) in self.variants:
                raise HTTPException(409, "already written")
            self.variants[(mid, body["locale"])] = {
                "source_locale": body.get("source_locale"),
                "body": body.get("body"),
                "declined": body.get("declined", False),
            }
            return {"message_id": mid, **body}
        raise AssertionError(f"unexpected comms call {method} {path}")


async def ship(session: AsyncSession, fake: FakeComms) -> list[dict]:
    """What the relay and comms' intake would do: every llm job in the outbox
    becomes a job comms knows. Returns the shipped payloads."""
    rows = (
        (
            await session.execute(
                select(OutboxEvent).where(
                    OutboxEvent.payload["idempotency_key"].astext.like(
                        f"{translation.JOB_PREFIX}%",
                    )
                )
            )
        )
        .scalars()
        .all()
    )
    shipped = []
    for row in rows:
        key = row.payload["idempotency_key"]
        if key not in fake.jobs:
            fake.jobs[key] = {
                "status": "pending",
                "answer": None,
                "payload": row.payload,
            }
            shipped.append(row.payload)
    return shipped


# ---------------------------------------------------------------------------
# Fixtures and helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch) -> FakeComms:
    comms = FakeComms()
    for seam in _SEAMS:
        monkeypatch.setattr(seam, comms)
    monkeypatch.setattr(settings, "support_language", "en")
    return comms


async def _clean(session: AsyncSession) -> None:
    await full_cleanup_range(session, _TID_MIN, _TID_MAX, delete_users=True)
    await session.execute(
        delete(OutboxEvent).where(
            OutboxEvent.payload["idempotency_key"].astext.like("llm-support-tr:%")
            | OutboxEvent.payload["idempotency_key"].astext.like("support-tr-%")
        )
    )
    # BE-172: every support message these tests send emits
    # support.message_received to group:admins; a group-targeted row names
    # no user, so full_cleanup_range cannot see it -- deleted by type.
    await session.execute(
        delete(OutboxEvent).where(
            OutboxEvent.payload["type"].astext == MESSAGE_RECEIVED_TYPE
        )
    )
    await session.execute(delete(CommsFeedCursor))
    await session.commit()


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await _clean(db_session)
    yield
    await _clean(db_session)


@dataclass(frozen=True)
class Thread:
    """The pointer's values, read once: an ORM row would expire under the
    tests' own expire_all and lazy-load outside the async context."""

    id: UUID
    comms_thread_id: UUID
    client_user_id: UUID


async def _setup(
    client: AsyncClient,
    db_session: AsyncSession,
    *,
    user_language: str,
) -> tuple[dict, dict, Thread]:
    """An admin, a user reading `user_language`, and the user's support
    thread pointer -- an OPEN TICKET since BE-162 (a pointer without a
    ticket is a person's history: admins only read it)."""
    admin = await login_user(client, telegram_id=_TID_ADMIN, first_name="Admin")
    admin_user = await db_session.get(User, UUID(admin["user"]["id"]))
    admin_user.role = UserRole.ADMIN.value
    user = await login_user(client, telegram_id=_TID_USER, first_name="User")
    user_row = await db_session.get(User, UUID(user["user"]["id"]))
    user_row.language = user_language
    pointer = SupportThread(comms_thread_id=uuid4(), client_user_id=user_row.id)
    db_session.add(pointer)
    await db_session.flush()
    db_session.add(
        SupportTicket(
            support_thread_id=pointer.id,
            topic="technical",
            category="tech",
            status="open",
            status_changed_at=datetime.now(UTC),
            version=1,
        )
    )
    await db_session.commit()
    thread = Thread(pointer.id, pointer.comms_thread_id, pointer.client_user_id)
    admin = await login_user(client, telegram_id=_TID_ADMIN, first_name="Admin")
    return admin, user, thread


async def _user_writes(
    client: AsyncClient, user: dict, pointer: Thread, body: str,
) -> dict:
    """The user writes in their support conversation (BE-163 / BE-162:
    POST /chats/{id}/messages) -- it lands in their open ticket, the one
    _setup made. Until BE-162 this was POST /support/threads/messages,
    removed with the one eternal thread."""
    resp = await client.post(
        f"/api/v1/chats/{pointer.comms_thread_id}/messages",
        json={"body": body},
        headers=auth_headers(user["session_token"]),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _admin_replies(
    client: AsyncClient,
    admin: dict,
    pointer: Thread,
    body: str,
) -> dict:
    resp = await client.post(
        f"/api/v1/support/threads/{pointer.comms_thread_id}/messages",
        json={"body": body},
        headers=auth_headers(admin["session_token"]),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _retry_url(pointer: Thread, mid: str) -> str:
    return (
        f"/api/v1/support/threads/{pointer.comms_thread_id}/messages/"
        f"{mid}/translation/retry"
    )


async def _feed(client: AsyncClient, admin: dict, pointer: Thread) -> dict:
    resp = await client.get(
        f"/api/v1/support/threads/{pointer.comms_thread_id}/messages",
        headers=auth_headers(admin["session_token"]),
    )
    assert resp.status_code == 200, resp.text
    return {m["id"]: m for m in resp.json()["messages"]}


async def _rows(session: AsyncSession, message_id: str) -> list[SupportTranslationJob]:
    session.expire_all()
    return list(
        (
            await session.execute(
                select(SupportTranslationJob)
                .where(SupportTranslationJob.comms_message_id == UUID(message_id))
                .order_by(SupportTranslationJob.attempt)
            )
        )
        .scalars()
        .all()
    )


async def _notifications(session: AsyncSession, message_id: str) -> int:
    return (
        await session.execute(
            select(func.count())
            .select_from(OutboxEvent)
            .where(
                OutboxEvent.payload["type"].astext == translation.UNAVAILABLE_TYPE,
                OutboxEvent.payload["idempotency_key"].astext.like(
                    f"support-tr-unavailable:{message_id}:%",
                ),
            )
        )
    ).scalar_one()


def _answer(source: str, text_: str | None, declined: bool = False) -> str:
    return json.dumps(
        {"source_language": source, "translation": text_, "declined": declined},
    )


# ---------------------------------------------------------------------------
# 1. The whole path, both directions
# ---------------------------------------------------------------------------


async def test_a_users_message_goes_in_at_once_and_its_translation_follows(
    client: AsyncClient,
    db_session: AsyncSession,
    fake: FakeComms,
    capsys: pytest.CaptureFixture,
) -> None:
    admin, user, pointer = await _setup(client, db_session, user_language="de")
    sent = await _user_writes(client, user, pointer, "Ich kann mich nicht anmelden")
    mid = sent["id"]

    # In the thread AS WRITTEN, before any model is asked.
    assert [m["body"] for m in fake.messages] == ["Ich kann mich nicht anmelden"]
    [row] = await _rows(db_session, mid)
    assert (row.direction, row.locale, row.attempt, row.outcome) == (
        "to_support",
        "en",
        1,
        None,
    )

    # The request waits for comms to take the job: 422 until shipped.
    await translation.sweep()
    assert fake.count("POST", "/variant-requests") == 1 and fake.requests == []
    [row] = await _rows(db_session, mid)
    assert row.request_written_at is None and row.outcome is None

    [payload] = await ship(db_session, fake)
    assert payload["type"] == translation.FOR_SUPPORT_TYPE
    system, letter = payload["llm"]["messages"]
    assert letter == {"role": "user", "content": "Ich kann mich nicht anmelden"}
    assert "English (en)" in system["content"]
    await translation.sweep()
    assert fake.requests == [(mid, "en", row.job_key)]
    assert (await _feed(client, admin, pointer))[mid]["translation"][
        "state"
    ] == "preparing"

    fake.answer(row.job_key, _answer("de", "I cannot log in"))
    await translation.on_key(row.job_key)
    assert fake.variants[(mid, "en")] == {
        "source_locale": "de",
        "body": "I cannot log in",
        "declined": False,
    }
    seen = (await _feed(client, admin, pointer))[mid]
    assert seen["body"] == "I cannot log in"
    assert seen["original"] == "Ich kann mich nicht anmelden"
    assert seen["translation"] == {
        "locale": "en",
        "state": "ready",
        "source_locale": "de",
        "retryable": False,
    }
    [row] = await _rows(db_session, mid)
    assert row.outcome == "variant"

    out = capsys.readouterr().out
    assert "anmelden" not in out and "log in" not in out


async def test_an_admins_reply_goes_in_at_once_and_gets_a_variant_in_the_users_language(
    client: AsyncClient,
    db_session: AsyncSession,
    fake: FakeComms,
    capsys: pytest.CaptureFixture,
) -> None:
    admin, _, pointer = await _setup(client, db_session, user_language="de")
    sent = await _admin_replies(client, admin, pointer, "Please reset your password")
    mid = sent["id"]

    # The reply is in the thread at once, as written, and the answer is
    # comms' message, as before BE-166.
    assert fake.messages[-1]["body"] == "Please reset your password"
    assert sent["body"] == "Please reset your password"
    [row] = await _rows(db_session, mid)
    assert (row.direction, row.locale) == ("to_user", "de")

    [payload] = await ship(db_session, fake)
    assert payload["type"] == translation.FOR_USER_TYPE
    assert "German (de)" in payload["llm"]["messages"][0]["content"]
    await translation.sweep()
    fake.answer(row.job_key, _answer("en", "Bitte setzen Sie Ihr Passwort zurück"))
    await translation.on_key(row.job_key)

    seen = (await _feed(client, admin, pointer))[mid]
    assert seen["body"] == "Please reset your password"  # the admin's own text
    assert seen["translation"]["locale"] == "de"
    assert seen["translation"]["state"] == "ready"
    assert seen["translation"]["variant_body"] == "Bitte setzen Sie Ihr Passwort zurück"
    # Read twice: the support language and the user's.
    locales = [
        c[3].get("locale")
        for c in fake.calls
        if c[0] == "GET" and c[1].endswith("/messages")
    ]
    assert locales[-2:] == ["en", "de"]
    out = capsys.readouterr().out
    assert "Passwort" not in out and "reset your" not in out


async def test_a_reply_to_a_user_of_the_support_language_queues_nothing(
    client: AsyncClient,
    db_session: AsyncSession,
    fake: FakeComms,
) -> None:
    """Owner ruling 5: same language, no translation -- no job, no request.
    Pair: the same reply to a German reader does queue one."""
    admin, _, pointer = await _setup(client, db_session, user_language="en")
    sent = await _admin_replies(client, admin, pointer, "Hello")
    assert await _rows(db_session, sent["id"]) == []
    assert await ship(db_session, fake) == []
    await translation.sweep()
    assert fake.count("POST", "/variant-requests") == 0
    seen = (await _feed(client, admin, pointer))[sent["id"]]
    assert seen["translation"] is None and seen["body"] == "Hello"
    # One read only: the user reads the support language.
    assert [c[3].get("locale") for c in fake.calls if c[0] == "GET"] == ["en"]

    user_row = (
        await db_session.execute(select(User).where(User.telegram_id == _TID_USER))
    ).scalar_one()
    user_row.language = "de"
    await db_session.commit()
    sent = await _admin_replies(client, admin, pointer, "Hello again")
    assert len(await _rows(db_session, sent["id"])) == 1


async def test_original_is_on_the_admin_feed_only_and_no_user_route_reads_a_thread(
    client: AsyncClient,
    db_session: AsyncSession,
    fake: FakeComms,
) -> None:
    """`original` exists on the admin feed and on no user route: the user's
    one support route is the form's write (BE-162: POST /support/tickets),
    and it does not answer with `original` or `translation` -- the user's
    read is the chat routes' (BE-163). Until BE-162 the support router had
    two user writes, the open and the send of №712; both went with the one
    eternal thread."""
    admin, user, pointer = await _setup(client, db_session, user_language="de")
    sent = await _user_writes(client, user, pointer, "Hallo")
    assert "original" not in sent and "translation" not in sent
    assert "original" in (await _feed(client, admin, pointer))[sent["id"]]

    user_routes = set()
    for route in support_router.routes:
        deps = {d.call.__name__ for d in route.dependant.dependencies}
        if "get_current_admin" not in deps:
            user_routes |= {(m, route.path) for m in route.methods}
    assert user_routes == {("POST", "/api/v1/support/tickets")}


async def test_not_needed_when_the_model_finds_the_support_language(
    client: AsyncClient,
    db_session: AsyncSession,
    fake: FakeComms,
) -> None:
    """A user's message is ALWAYS sent to the model; already in the support
    language -> the variant "none needed", the body stays the original."""
    admin, user, pointer = await _setup(client, db_session, user_language="de")
    sent = await _user_writes(client, user, pointer, "Hi, I need help")
    [row] = await _rows(db_session, sent["id"])
    await ship(db_session, fake)
    fake.answer(row.job_key, _answer("EN-us", None))
    await translation.on_key(row.job_key)
    assert fake.variants[(sent["id"], "en")] == {
        "source_locale": "en",
        "body": None,
        "declined": False,
    }
    seen = (await _feed(client, admin, pointer))[sent["id"]]
    assert seen["translation"]["state"] == "not_needed"
    assert seen["body"] == "Hi, I need help"


# ---------------------------------------------------------------------------
# 2. Failures: the transport's, the model's, the unreadable
# ---------------------------------------------------------------------------


async def test_a_failed_job_tells_the_user_once_and_an_admin_retry_delivers(
    client: AsyncClient,
    db_session: AsyncSession,
    fake: FakeComms,
) -> None:
    admin, _, pointer = await _setup(client, db_session, user_language="de")
    mid = (await _admin_replies(client, admin, pointer, "Your refund is on its way"))[
        "id"
    ]
    [row] = await _rows(db_session, mid)
    await ship(db_session, fake)
    await translation.sweep()
    fake.fail(row.job_key, "expired")
    await translation.on_key(row.job_key)
    await translation.on_key(row.job_key)  # a repeated push

    assert (await _rows(db_session, mid))[0].outcome == "failed"
    assert (mid, "de") not in fake.variants
    assert await _notifications(db_session, mid) == 1
    block = (await _feed(client, admin, pointer))[mid]["translation"]
    assert (block["state"], block["retryable"]) == ("impossible", True)

    url = _retry_url(pointer, mid)
    resp = await client.post(url, headers=auth_headers(admin["session_token"]))
    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "message_id": mid,
        "locale": "de",
        "attempt": 2,
        "state": "preparing",
    }
    # A second retry while attempt 2 runs: nothing to retry.
    resp2 = await client.post(url, headers=auth_headers(admin["session_token"]))
    assert resp2.status_code == 409

    second = (await _rows(db_session, mid))[1]
    await ship(db_session, fake)
    await translation.sweep()
    fake.fail(second.job_key)
    await translation.on_key(second.job_key)
    assert await _notifications(db_session, mid) == 1  # once per message

    resp = await client.post(url, headers=auth_headers(admin["session_token"]))
    third = (await _rows(db_session, mid))[2]
    await ship(db_session, fake)
    await translation.sweep()
    fake.answer(third.job_key, _answer("en", "Ihre Erstattung ist unterwegs"))
    await translation.on_key(third.job_key)
    block = (await _feed(client, admin, pointer))[mid]["translation"]
    assert (block["state"], block["variant_body"]) == (
        "ready",
        "Ihre Erstattung ist unterwegs",
    )


async def test_a_declined_answer_is_final_and_tells_the_user(
    client: AsyncClient,
    db_session: AsyncSession,
    fake: FakeComms,
) -> None:
    admin, _, pointer = await _setup(client, db_session, user_language="de")
    mid = (await _admin_replies(client, admin, pointer, "x"))["id"]
    [row] = await _rows(db_session, mid)
    await ship(db_session, fake)
    fake.answer(row.job_key, _answer("en", None, declined=True))
    await translation.on_key(row.job_key)
    assert fake.variants[(mid, "de")]["declined"] is True
    assert fake.variants[(mid, "de")]["source_locale"] == "en"
    assert await _notifications(db_session, mid) == 1
    block = (await _feed(client, admin, pointer))[mid]["translation"]
    assert (block["state"], block["retryable"]) == ("impossible", False)
    resp = await client.post(
        f"/api/v1/support/threads/{pointer.comms_thread_id}/messages/{mid}/translation/retry",
        headers=auth_headers(admin["session_token"]),
    )
    assert resp.status_code == 409


async def test_an_unreadable_answer_is_asked_again_once_then_declined(
    client: AsyncClient,
    db_session: AsyncSession,
    fake: FakeComms,
) -> None:
    _, user, pointer = await _setup(client, db_session, user_language="de")
    mid = (await _user_writes(client, user, pointer, "Hallo"))["id"]
    [first] = await _rows(db_session, mid)
    await ship(db_session, fake)
    fake.answer(first.job_key, "Sure! Here is the translation: Hello")
    await translation.on_key(first.job_key)

    rows = await _rows(db_session, mid)
    assert [(r.attempt, r.outcome) for r in rows] == [(1, "retried"), (2, None)]
    assert fake.variants == {}
    [payload] = await ship(db_session, fake)
    assert payload["llm"]["messages"][1]["content"] == "Hallo"  # found in the feed

    fake.answer(rows[1].job_key, "{}", finish="length")
    await translation.on_key(rows[1].job_key)
    assert fake.variants[(mid, "en")]["declined"] is True
    assert [r.outcome for r in await _rows(db_session, mid)] == ["retried", "declined"]
    assert await _notifications(db_session, mid) == 0  # to_support: nobody told


async def test_a_job_refused_at_intake_fails_through_the_sweep(
    client: AsyncClient,
    db_session: AsyncSession,
    fake: FakeComms,
) -> None:
    """422 on the request, and by key `job: null` with intake: never taken
    -> a transport failure, the user told. Pair: 422 with the job merely
    not shipped keeps waiting (the first test)."""
    admin, _, pointer = await _setup(client, db_session, user_language="de")
    mid = (await _admin_replies(client, admin, pointer, "x"))["id"]
    [row] = await _rows(db_session, mid)
    fake.jobs[row.job_key] = {"status": None, "intake_rejected": True}
    await translation.sweep()
    assert (await _rows(db_session, mid))[0].outcome == "failed"
    assert await _notifications(db_session, mid) == 1
    await translation.sweep()  # not swept again: it has an outcome
    assert fake.count("POST", "/variant-requests") == 1


async def test_a_retry_does_not_reach_past_its_pages(
    client: AsyncClient,
    db_session: AsyncSession,
    fake: FakeComms,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """KNOWN CEILING of translation.find_message, built: the message is
    one page too deep -> 404. Pair: one page more reaches it."""
    admin, _, pointer = await _setup(client, db_session, user_language="de")
    mid = (await _admin_replies(client, admin, pointer, "old"))["id"]
    [row] = await _rows(db_session, mid)
    await ship(db_session, fake)
    fake.fail(row.job_key)
    await translation.on_key(row.job_key)
    for i in range(3):
        fake.messages.append({**fake.messages[0], "id": str(uuid4()), "body": f"n{i}"})
    monkeypatch.setattr(translation, "_SEARCH_PAGE", 1)
    monkeypatch.setattr(translation, "RETRY_SEARCH_PAGES", 3)
    url = _retry_url(pointer, mid)
    resp = await client.post(url, headers=auth_headers(admin["session_token"]))
    assert resp.status_code == 404
    monkeypatch.setattr(translation, "RETRY_SEARCH_PAGES", 4)
    resp = await client.post(url, headers=auth_headers(admin["session_token"]))
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# 3. Repeats and catch-up
# ---------------------------------------------------------------------------


async def test_a_repeated_outcome_writes_one_variant(
    client: AsyncClient,
    db_session: AsyncSession,
    fake: FakeComms,
) -> None:
    _, user, pointer = await _setup(client, db_session, user_language="de")
    mid = (await _user_writes(client, user, pointer, "Hallo"))["id"]
    [row] = await _rows(db_session, mid)
    await ship(db_session, fake)
    fake.answer(row.job_key, _answer("de", "Hello"))
    await asyncio.gather(
        translation.on_key(row.job_key), translation.on_key(row.job_key)
    )
    await translation.on_key(row.job_key)
    assert len(fake.variants) == 1
    # Read once more after the outcome: never.
    reads = fake.count("GET", "/by-key")
    await translation.on_key(row.job_key)
    assert fake.count("GET", "/by-key") == reads


async def test_the_feed_catches_up_a_message_without_a_job_once(
    client: AsyncClient,
    db_session: AsyncSession,
    fake: FakeComms,
) -> None:
    """A message in the thread whose job was lost (its request rolled back)
    is queued when an admin reads the feed -- once, however many read.
    Pair: a message that has its job is not queued again."""
    admin, user, pointer = await _setup(client, db_session, user_language="de")
    lost = {
        "id": str(uuid4()),
        "thread_id": str(pointer.comms_thread_id),
        "sender": user["user"]["id"],
        "body": "Verloren",
        "created_at": datetime.now(UTC).isoformat(),
    }
    fake.messages.append(lost)
    kept = (await _user_writes(client, user, pointer, "Behalten"))["id"]
    await asyncio.gather(
        _feed(client, admin, pointer),
        _feed(client, admin, pointer),
    )
    await _feed(client, admin, pointer)
    assert len(await _rows(db_session, lost["id"])) == 1
    assert len(await _rows(db_session, kept)) == 1
    shipped = await ship(db_session, fake)
    assert sorted(p["llm"]["messages"][1]["content"] for p in shipped) == [
        "Behalten",
        "Verloren",
    ]


# ---------------------------------------------------------------------------
# 4. The parse -- every form of the gate's grid (pure)
# ---------------------------------------------------------------------------


def _ok(content: str) -> LlmResult:
    return LlmResult("answer", text=content)


@pytest.mark.parametrize(
    ("result", "kind", "body", "source"),
    [
        (_ok(_answer("de", "Hello")), "text", "Hello", "de"),
        (_ok("```json\n" + _answer("de", "Hello") + "\n```"), "text", "Hello", "de"),
        (_ok(_answer("de-AT", " Hello ")), "text", "Hello", "de"),
        (_ok(_answer("en", "Hello")), "not_needed", None, "en"),
        (_ok(_answer("en_GB", None)), "not_needed", None, "en"),
        (_ok(_answer("de", None, declined=True)), "declined", None, "de"),
        (_ok(_answer("en", None, declined=True)), "declined", None, None),
        (_ok(json.dumps({"declined": True})), "declined", None, None),
        (_ok("Hello"), "unreadable", None, None),
        (_ok("[1]"), "unreadable", None, None),
        (_ok(_answer("de", None)), "unreadable", None, None),
        (_ok(_answer("de", "   ")), "unreadable", None, None),
        (_ok(_answer("de", "x" * 5001)), "unreadable", None, None),
        (_ok(json.dumps({"translation": "Hello"})), "unreadable", None, None),
        (_ok(_answer("??", "Hello")), "unreadable", None, None),
        (
            _ok(
                json.dumps(
                    {"source_language": "de", "translation": "a", "declined": "no"}
                )
            ),
            "unreadable",
            None,
            None,
        ),
        (LlmResult("unreadable", reason="not_finished"), "unreadable", None, None),
        (LlmResult("failed", reason="status_expired"), "failed", None, None),
        (LlmResult("in_progress"), "in_progress", None, None),
    ],
)
async def test_parse_translation(
    result: LlmResult, kind: str, body: str | None, source: str | None
) -> None:
    outcome = translation.parse_translation(result, "en")
    assert (outcome.kind, outcome.body, outcome.source_locale) == (kind, body, source)


def _completion(content: Any = "x", finish: str = "stop") -> str:
    return json.dumps(
        {"choices": [{"finish_reason": finish, "message": {"content": content}}]}
    )


@pytest.mark.parametrize(
    ("summary", "kind", "reason"),
    [
        (
            {
                "job": {
                    "status": "sent",
                    "answer": {"state": "kept", "body": _completion(" hi ")},
                }
            },
            "answer",
            None,
        ),
        ({"job": {"status": "pending"}}, "in_progress", None),
        ({"job": {"status": "processing"}}, "in_progress", None),
        ({"job": None, "intake": []}, "in_progress", "no_job_yet"),
        ({"job": None, "intake": [{"x": 1}]}, "failed", "rejected_at_intake"),
        ({"job": {"status": "failed"}}, "failed", "status_failed"),
        ({"job": {"status": "expired"}}, "failed", "status_expired"),
        ({"job": {"status": "cancelled"}}, "failed", "status_cancelled"),
        (
            {"job": {"status": "sent", "answer": {"state": "purged", "body": None}}},
            "unreadable",
            "purged",
        ),
        ({"job": {"status": "sent", "answer": None}}, "unreadable", "no_answer"),
        (
            {
                "job": {
                    "status": "sent",
                    "answer": {"state": "kept", "body": "not json"},
                }
            },
            "unreadable",
            "body_not_json",
        ),
        (
            {"job": {"status": "sent", "answer": {"state": "kept", "body": "{}"}}},
            "unreadable",
            "no_choices",
        ),
        (
            {
                "job": {
                    "status": "sent",
                    "answer": {"state": "kept", "body": _completion(finish="length")},
                }
            },
            "unreadable",
            "not_finished",
        ),
        (
            {
                "job": {
                    "status": "sent",
                    "answer": {"state": "kept", "body": _completion("  ")},
                }
            },
            "unreadable",
            "blank_answer",
        ),
        (
            {
                "job": {
                    "status": "sent",
                    "answer": {"state": "kept", "body": _completion(None)},
                }
            },
            "unreadable",
            "blank_answer",
        ),
        ([], "failed", "summary_not_an_object"),
    ],
)
async def test_decide(summary: Any, kind: str, reason: str | None) -> None:
    result = llm.decide(summary)
    assert (result.kind, result.reason) == (kind, reason)
    if kind == "answer":
        assert result.text == "hi"


# ---------------------------------------------------------------------------
# 5. The listener
# ---------------------------------------------------------------------------


async def test_a_key_not_ours_is_never_read(fake: FakeComms) -> None:
    """The feed carries every job of the product: a key no handler claims
    is passed by without one request. Pair: ours is read."""
    assert (
        await comms_listener.handle_key("reminder:abc:booking.reminder_1h:1") is False
    )
    assert await comms_listener.handle_key("msg:123") is False
    assert fake.calls == []
    assert comms_listener.handler_for(f"{translation.JOB_PREFIX}x") is not None


async def test_entries_are_read_then_acknowledged_and_an_unknown_format_stops(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[str] = []
    acked: list[bytes] = []

    class Redis:
        async def xack(self, stream: str, group: str, entry_id: bytes) -> None:
            acked.append(entry_id)

    async def handle(key: str) -> bool:
        seen.append(key)
        if key == "boom":
            raise RuntimeError("handler died")
        return True

    monkeypatch.setattr(comms_listener, "handle_key", handle)
    await comms_listener.process_entries(
        Redis(),
        [(b"1-0", {b"v": b"1", b"idempotency_key": b"a"})],
    )
    assert (seen, acked) == (["a"], [b"1-0"])
    with pytest.raises(RuntimeError):
        await comms_listener.process_entries(
            Redis(),
            [(b"2-0", {b"v": b"1", b"idempotency_key": b"boom"})],
        )
    assert acked == [b"1-0"]  # died before its ack: redelivered later
    with pytest.raises(comms_listener.PushFormatError):
        await comms_listener.process_entries(
            Redis(),
            [(b"3-0", {b"v": b"2", b"idempotency_key": b"c"})],
        )
    assert seen == ["a", "boom"] and acked == [b"1-0"]


async def test_reconcile_keeps_the_cursor_after_each_page_and_restarts_on_410(
    fake: FakeComms,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handled: list[str] = []
    resumed: list[int] = []

    async def handle(key: str) -> bool:
        handled.append(key)
        if key == "k3":
            raise RuntimeError("crash mid-page")
        return True

    async def resume_all() -> None:
        resumed.append(1)

    monkeypatch.setattr(comms_listener, "handle_key", handle)
    monkeypatch.setattr(comms_listener, "_resume_all", resume_all)
    monkeypatch.setattr(comms_listener, "_PAGE_LIMIT", 2)
    fake.changes = ["k1", "k2", "k3", "k4"]
    with pytest.raises(RuntimeError):
        await comms_listener.reconcile()
    # The first page was acted on: its cursor kept. The second was not.
    assert await comms_listener.load_cursor() == "2"
    handled.clear()
    fake.changes = ["k1", "k2", "k3x", "k4"]
    await comms_listener.reconcile()
    assert handled == ["k3x", "k4"]
    assert await comms_listener.load_cursor() == "4"

    real = fake._route

    stale = {"4"}  # the kept cursor, past comms' retention -- once

    def expired(method: str, path: str, params: dict, body: Any) -> Any:
        if path.endswith("/changes") and params.get("cursor") in stale:
            stale.clear()
            raise HTTPException(410, "cursor_expired")
        return real(method, path, params, body)

    monkeypatch.setattr(fake, "_route", expired)
    handled.clear()
    resumed.clear()
    await comms_listener.reconcile()
    assert resumed == [1, 1]  # on start, and on 410
    assert handled == ["k1", "k2", "k3x", "k4"]  # the feed from its beginning


async def test_one_listener_holds_the_lock_and_a_dead_connection_frees_it() -> None:
    engine = get_engine()
    async with engine.connect() as a, engine.connect() as b:
        assert await comms_listener.try_lock(a) is True
        assert await comms_listener.try_lock(b) is False
        pid = (await a.execute(text("SELECT pg_backend_pid()"))).scalar()
        await a.commit()
        await b.execute(text("SELECT pg_terminate_backend(:p)"), {"p": pid})
        await b.commit()
        for _ in range(50):
            if await comms_listener.try_lock(b):
                break
            await asyncio.sleep(0.05)
        else:
            raise AssertionError("the lock outlived its connection")
        await comms_listener._release(b)
        with pytest.raises(Exception):  # noqa: B017 -- the connection is gone
            await comms_listener._still_holding(a)
        await a.invalidate()


# ---------------------------------------------------------------------------
# 6. The setting
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("value", ["xx", "", "EN", "pt"])
async def test_a_support_language_the_backend_does_not_know_refuses_the_start(
    value: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SUPPORT_LANGUAGE", value)
    with pytest.raises(ValueError, match="SUPPORT_LANGUAGE"):
        Settings()


@pytest.mark.parametrize("value", ["en", "de", "es", "ru", "uk"])
async def test_every_backend_language_is_a_support_language(
    value: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SUPPORT_LANGUAGE", value)
    assert Settings().support_language == value
