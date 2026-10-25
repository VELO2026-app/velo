# =============================================================================
# VELO -- support tickets, delivery 1 (BE-162)
# =============================================================================
# Band 60200-60239.
#
# What is under test, and why each one exists:
#
#   1. THE TABLE: the card's "form topic -> category" table, code by code,
#      and the wire's closed sets equal to the model's.
#   2. AN APPEAL IS A TICKET: two appeals in a row are two tickets, two
#      `ticket` threads, both open, two signals to every admin; one client
#      key is one ticket; the message goes in as written.
#   3. THE CONVERSATION: a message from it goes to the latest open ticket,
#      else the latest ticket (reopened -- unless spam, which stays spam,
#      translates nothing and signals nobody), else a new ticket "other".
#      All of a person's support threads read as ONE feed, one list row.
#   4. ADMINS: the ticket list is velo's table (comms is asked nothing),
#      spam apart; statuses move forward only and comms only ever hears
#      `resolved`; a person's history is read-only; the signal goes to the
#      taker alone once a ticket is taken.
#   5. PRIVACY: nobody else's ticket opens or lists, in any state.
#   6. RACES: two admins on one ticket; a person's message during a status
#      change -- both built with the harness, the rival seen waiting.
#
# comms is cut at its seams (support.service / chats.router comms_request).
# =============================================================================

import typing
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.events.models import OutboxEvent
from app.core.exceptions import ConflictError
from app.modules.support import router as support_router
from app.modules.support import service, translation
from app.modules.support.models import (
    CATEGORIES,
    CLOSING_STATUSES,
    STATUSES,
    TO_SUPPORT,
    TOPICS,
    SupportThread,
    SupportTicket,
    SupportTranslationJob,
)
from app.modules.users.models import User, UserRole
from tests.curator_race_harness import assert_no_deadlock, race
from tests.helpers import auth_headers, fresh_execute, full_cleanup_range, login_user

BAND_MIN, BAND_MAX = 60200, 60239

_SEAMS = (
    "app.modules.support.service.comms_request",
    "app.modules.chats.router.comms_request",
)
TICKETS_URL = "/api/v1/support/tickets"
CHATS_URL = "/api/v1/chats"


# ---------------------------------------------------------------------------
# Fixtures and builders
# ---------------------------------------------------------------------------


async def _clean(session: AsyncSession) -> None:
    await full_cleanup_range(session, BAND_MIN, BAND_MAX, delete_users=True)
    await session.execute(
        delete(OutboxEvent).where(
            OutboxEvent.payload["type"].astext == service.MESSAGE_RECEIVED_TYPE,
            OutboxEvent.payload["action_data"]["sender_name"].astext.like("BE162-%"),
        )
    )
    await session.commit()


@pytest.fixture(autouse=True)
async def _band(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await _clean(db_session)
    yield
    await _clean(db_session)


class FakeComms:
    """comms 3.10.0 as these routes meet it. Threads are created fresh
    per call (`ticket`) and replay by key; messages replay by key; feeds
    page by an offset cursor, newest first."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict, Any]] = []
        self.feeds: dict[str, list[dict]] = {}
        self.client_items: list[Any] = []
        self.unread: dict[str, int] = {}
        self._keys: dict[tuple[str, str], Any] = {}
        self._clock = datetime(2026, 10, 25, 12, tzinfo=UTC)

    def posted(self, suffix: str) -> list[tuple[str, Any]]:
        return [
            (c[1], c[3]) for c in self.calls if c[0] == "POST" and c[1].endswith(suffix)
        ]

    async def __call__(
        self,
        method: str,
        path: str,
        *,
        params: dict | None = None,
        json: Any = None,
        forward_403: bool = False,
        idempotency_key: str | None = None,
    ) -> Any:
        self.calls.append((method, path, dict(params or {}), json))
        if idempotency_key is not None and (path, idempotency_key) in self._keys:
            return self._keys[(path, idempotency_key)]
        out = self._route(method, path, dict(params or {}), json)
        if idempotency_key is not None:
            self._keys[(path, idempotency_key)] = out
        return out

    def _route(self, method: str, path: str, params: dict, body: Any) -> Any:
        if path == "/api/v1/sections":
            return {"id": "5ec7a000-0000-4000-8000-000000000001", "key": "support"}
        if path == "/api/v1/threads" and method == "POST":
            return {"id": str(uuid4()), **body}
        if path == "/api/v1/threads" and method == "GET":
            return {"items": self.client_items, "next_cursor": None}
        if path == "/api/v1/threads/unread-counts":
            return {
                "counts": {
                    t: self.unread[t] for t in body["thread_ids"] if t in self.unread
                }
            }
        thread_id = path.split("/")[4]
        if path.endswith("/messages") and method == "POST":
            self._clock += timedelta(seconds=1)
            message = {
                "id": str(uuid4()),
                "thread_id": thread_id,
                "sender": body["sender"],
                "body": body["body"],
                "created_at": self._clock.isoformat(),
            }
            self.feeds.setdefault(thread_id, []).insert(0, message)
            return message
        if path.endswith("/messages") and method == "GET":
            rows = self.feeds.get(thread_id, [])
            start = int(params.get("cursor") or 0)
            page = rows[start : start + params["limit"]]
            more = start + params["limit"] < len(rows)
            return {
                "items": page,
                "next_cursor": str(start + params["limit"]) if more else None,
            }
        if path.endswith("/read"):
            return {"unread": 0}
        if path.endswith("/status"):
            return {"id": thread_id, "status": body["status"]}
        if path.endswith("/claim"):
            return {"claimed": True, "thread": {"id": thread_id}}
        raise AssertionError(f"unexpected comms call {method} {path}")


@pytest.fixture
def comms(monkeypatch: pytest.MonkeyPatch) -> FakeComms:
    fake = FakeComms()
    for seam in _SEAMS:
        monkeypatch.setattr(seam, fake)
    monkeypatch.setattr(service, "_support_section_id", None)
    return fake


async def _person(
    client: AsyncClient,
    db_session: AsyncSession,
    offset: int,
    *,
    role: str | None = None,
    language: str = "ru",
) -> dict:
    tid = BAND_MIN + offset
    name = f"BE162-{offset}"
    auth = await login_user(client, telegram_id=tid, first_name=name)
    user = await db_session.get(User, UUID(auth["user"]["id"]))
    user.language = language
    if role is not None:
        user.role = role
    await db_session.commit()
    if role is not None:
        auth = await login_user(client, telegram_id=tid, first_name=name)
    return auth


async def _ticket(
    db_session: AsyncSession,
    user_id: str,
    *,
    topic: str = "technical",
    status: str = "open",
    age_minutes: int = 0,
    claimed_by: str | None = None,
) -> UUID:
    thread_id = uuid4()
    pointer = SupportThread(comms_thread_id=thread_id, client_user_id=UUID(user_id))
    db_session.add(pointer)
    await db_session.flush()
    when = datetime.now(UTC) - timedelta(minutes=age_minutes)
    db_session.add(
        SupportTicket(
            support_thread_id=pointer.id,
            topic=topic,
            category=TOPICS[topic].category,
            status=status,
            status_changed_at=when,
            created_at=when,
            claimed_by_user_id=UUID(claimed_by) if claimed_by else None,
            version=1,
        )
    )
    await db_session.commit()
    return thread_id


async def _history(db_session: AsyncSession, user_id: str) -> UUID:
    thread_id = uuid4()
    db_session.add(
        SupportThread(comms_thread_id=thread_id, client_user_id=UUID(user_id))
    )
    await db_session.commit()
    return thread_id


async def _row(thread_id: UUID) -> SupportTicket:
    return (
        await fresh_execute(
            select(SupportTicket)
            .join(SupportThread, SupportThread.id == SupportTicket.support_thread_id)
            .where(SupportThread.comms_thread_id == thread_id)
        )
    ).scalar_one()


async def _signals(thread_id: UUID) -> list[dict]:
    p = OutboxEvent.payload
    return [
        e.payload
        for e in (
            await fresh_execute(
                select(OutboxEvent)
                .where(
                    p["type"].astext == service.MESSAGE_RECEIVED_TYPE,
                    p["action_data"]["params"]["thread_id"].astext == str(thread_id),
                )
                .order_by(OutboxEvent.id)
            )
        )
        .scalars()
        .all()
    ]


async def _jobs(thread_id: UUID) -> list[SupportTranslationJob]:
    return list(
        (
            await fresh_execute(
                select(SupportTranslationJob)
                .join(
                    SupportThread,
                    SupportThread.id == SupportTranslationJob.support_thread_id,
                )
                .where(SupportThread.comms_thread_id == thread_id)
            )
        ).scalars()
    )


# ---------------------------------------------------------------------------
# 1. The table
# ---------------------------------------------------------------------------

# The card's table, form by form: (topic code, category).
_CARD = [
    ("payment", "payments"),  # user: Проблема с оплатой / транзакцией
    ("complaint_master", "complaint_master"),
    ("practice", "practices"),
    ("technical", "tech"),  # both forms
    ("other", "other"),  # both forms
    ("withdrawal", "payments"),  # master: Проблема с выводом
    ("practices", "practices"),
    ("add_direction", "practices"),
    ("complaint_user", "complaint_user"),  # master: the NEW topic
]


def test_the_topic_table_is_the_cards() -> None:
    assert {code: TOPICS[code].category for code, _ in _CARD} == dict(_CARD)
    assert set(TOPICS) == {code for code, _ in _CARD}
    assert set(CATEGORIES) == {category for _, category in _CARD}
    assert len(CATEGORIES) == 6


def test_the_wire_accepts_exactly_the_models_sets() -> None:
    def literal(name: str) -> set[str]:
        return set(typing.get_args(getattr(support_router, name)))

    assert literal("TopicCode") == set(TOPICS)
    assert literal("CategoryCode") == set(CATEGORIES)
    assert literal("StatusCode") == set(STATUSES)
    assert literal("ClosingStatus") == set(CLOSING_STATUSES)
    assert "open" not in CLOSING_STATUSES


# ---------------------------------------------------------------------------
# 2. An appeal is a ticket
# ---------------------------------------------------------------------------


class TestAppeal:
    async def test_two_appeals_are_two_open_tickets_and_two_signals(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        """Even with the first one open (owner ruling 1). The message goes
        in as written -- no topic in its text; the section is resolved
        once; the recipient is the section, never anything from the wire."""
        user = await _person(client, db_session, 0)
        headers = auth_headers(user["session_token"])
        ids = []
        for topic in ("payment", "complaint_master"):
            resp = await client.post(
                TICKETS_URL,
                json={"topic": topic, "body": f"about {topic}"},
                headers=headers,
            )
            assert resp.status_code == 200, resp.text
            ticket = resp.json()["ticket"]
            assert (ticket["status"], ticket["topic"]) == ("open", topic)
            assert ticket["category"] == TOPICS[topic].category
            ids.append(UUID(ticket["id"]))
        assert ids[0] != ids[1]
        opens = [body for _, body in comms.posted("/api/v1/threads")]
        assert [o["kind"] for o in opens] == ["ticket", "ticket"]
        assert {o["operator_kind"] for o in opens} == {"section"}
        assert {o["client"] for o in opens} == {user["user"]["id"]}
        assert len(comms.posted("/api/v1/sections")) == 1
        sends = [body for _, body in comms.posted("/messages")]
        assert [s["body"] for s in sends] == ["about payment", "about complaint_master"]
        for thread_id in ids:
            (signal,) = await _signals(thread_id)
            assert (signal["target_type"], signal["target_value"]) == (
                "group",
                "admins",
            )
            assert (await _row(thread_id)).status == "open"

    async def test_one_client_key_is_one_ticket_one_message_one_signal(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        user = await _person(client, db_session, 1)
        headers = {**auth_headers(user["session_token"]), "Idempotency-Key": "tap-1"}
        answers = [
            (
                await client.post(
                    TICKETS_URL,
                    json={"topic": "technical", "body": "help"},
                    headers=headers,
                )
            ).json()
            for _ in range(2)
        ]
        assert answers[0]["ticket"]["id"] == answers[1]["ticket"]["id"]
        assert answers[0]["message"] == answers[1]["message"]
        thread_id = UUID(answers[0]["ticket"]["id"])
        tickets = (
            (
                await fresh_execute(
                    select(SupportThread).where(
                        SupportThread.client_user_id == UUID(user["user"]["id"])
                    )
                )
            )
            .scalars()
            .all()
        )
        assert [t.comms_thread_id for t in tickets] == [thread_id]
        assert len(comms.feeds[str(thread_id)]) == 1
        first, second = await _signals(thread_id)
        assert first == second  # the same document: comms collapses it

    @pytest.mark.parametrize(
        "body",
        [
            {"topic": "technical", "body": ""},
            {"topic": "technical"},
            {"topic": "technical", "body": "x", "operator_value": str(uuid4())},
        ],
    )
    async def test_a_malformed_appeal_is_a_422_before_comms(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
        body,
    ) -> None:
        user = await _person(client, db_session, 2)
        resp = await client.post(
            TICKETS_URL,
            json=body,
            headers=auth_headers(user["session_token"]),
        )
        assert resp.status_code == 422
        assert comms.calls == []


# ---------------------------------------------------------------------------
# 3. The conversation
# ---------------------------------------------------------------------------


class TestDialog:
    async def test_it_goes_to_the_latest_open_ticket(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        user = await _person(client, db_session, 3)
        uid = user["user"]["id"]
        older = await _ticket(db_session, uid, age_minutes=30)
        latest_open = await _ticket(db_session, uid, age_minutes=20)
        await _ticket(db_session, uid, status="resolved", age_minutes=10)
        resp = await client.post(
            f"{CHATS_URL}/{older}/messages",
            json={"body": "and also"},
            headers=auth_headers(user["session_token"]),
        )
        assert resp.status_code == 200, resp.text
        assert [path for path, _ in comms.posted("/messages")] == [
            f"/api/v1/threads/{latest_open}/messages"
        ]
        assert len(await _signals(latest_open)) == 1

    async def test_with_none_open_it_reopens_the_latest(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        user = await _person(client, db_session, 4)
        uid = user["user"]["id"]
        await _ticket(db_session, uid, status="rejected", age_minutes=20)
        latest = await _ticket(db_session, uid, status="resolved", age_minutes=10)
        before = await _row(latest)
        resp = await client.post(
            f"{CHATS_URL}/{latest}/messages",
            json={"body": "still broken"},
            headers=auth_headers(user["session_token"]),
        )
        assert resp.status_code == 200, resp.text
        after = await _row(latest)
        assert after.status == "open"
        assert after.version == before.version + 1
        assert after.status_changed_at > before.status_changed_at
        assert len(await _signals(latest)) == 1
        assert [j.direction for j in await _jobs(latest)] == [TO_SUPPORT]

    async def test_a_spam_ticket_stays_spam_and_says_nothing_until_an_admin_reads(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        """Owner ruling (BE-162 gate): the message lies in the thread, the
        ticket stays spam, no signal, no paid translation -- and the admin
        who opens it gets the translation queued by the feed's catch-up."""
        user = await _person(client, db_session, 5)
        admin = await _person(client, db_session, 6, role=UserRole.ADMIN.value)
        spam = await _ticket(db_session, user["user"]["id"], status="spam")
        before = await _row(spam)
        resp = await client.post(
            f"{CHATS_URL}/{spam}/messages",
            json={"body": "buy now"},
            headers=auth_headers(user["session_token"]),
        )
        assert resp.status_code == 200, resp.text
        assert len(comms.feeds[str(spam)]) == 1
        after = await _row(spam)
        assert (after.status, after.version) == ("spam", before.version)
        assert await _signals(spam) == []
        assert await _jobs(spam) == []

        resp = await client.get(
            f"/api/v1/support/threads/{spam}/messages",
            headers=auth_headers(admin["session_token"]),
        )
        assert resp.status_code == 200
        assert [j.direction for j in await _jobs(spam)] == [TO_SUPPORT]

    async def test_with_only_history_it_opens_a_ticket_other(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        user = await _person(client, db_session, 7)
        history = await _history(db_session, user["user"]["id"])
        resp = await client.post(
            f"{CHATS_URL}/{history}/messages",
            json={"body": "hello again"},
            headers=auth_headers(user["session_token"]),
        )
        assert resp.status_code == 200, resp.text
        ((_, opened),) = comms.posted("/api/v1/threads")
        assert opened["kind"] == "ticket"
        new_thread = UUID(resp.json()["thread_id"])
        assert new_thread != history
        ticket = await _row(new_thread)
        assert (ticket.topic, ticket.category, ticket.status) == (
            "other",
            "other",
            "open",
        )
        assert comms.feeds.get(str(history)) is None

    @pytest.mark.parametrize("taken", [False, True])
    async def test_the_signal_goes_to_the_taker_alone_once_taken(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
        taken,
    ) -> None:
        user = await _person(client, db_session, 8)
        admin = await _person(client, db_session, 9, role=UserRole.ADMIN.value)
        thread = await _ticket(
            db_session,
            user["user"]["id"],
            claimed_by=admin["user"]["id"] if taken else None,
        )
        await client.post(
            f"{CHATS_URL}/{thread}/messages",
            json={"body": "?"},
            headers=auth_headers(user["session_token"]),
        )
        (signal,) = await _signals(thread)
        target = (signal["target_type"], signal["target_value"])
        assert target == (
            ("user", admin["user"]["id"]) if taken else ("group", "admins")
        )


class TestOneConversation:
    async def _three_threads(
        self,
        client,
        db_session,
        comms: FakeComms,
        offset: int,
    ) -> tuple[dict, list[UUID], list[str]]:
        """A person with history and two tickets, messages interleaved in
        time across the three; returns the ids and every message id,
        newest first."""
        user = await _person(client, db_session, offset)
        uid = user["user"]["id"]
        threads = [
            await _history(db_session, uid),
            await _ticket(db_session, uid, age_minutes=20),
            await _ticket(db_session, uid, age_minutes=10),
        ]
        order = [0, 1, 0, 2, 1, 2, 0, 2]
        for n, which in enumerate(order):
            await comms(
                "POST",
                f"/api/v1/threads/{threads[which]}/messages",
                json={"sender": uid, "body": f"m{n}"},
            )
        everything = sorted(
            (m for t in threads for m in comms.feeds[str(t)]),
            key=lambda m: (m["created_at"], m["id"]),
            reverse=True,
        )
        comms.calls.clear()
        return user, threads, [m["id"] for m in everything]

    @pytest.mark.parametrize("limit", [2, 3])
    async def test_every_thread_is_one_feed_in_time_order_across_pages(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
        limit: int,
    ) -> None:
        """limit=2: a thread is longer than one comms page, so a page takes
        part of a comms page and the thread must stand right after its last
        message taken -- not at comms' next page."""
        user, threads, everything = await self._three_threads(
            client,
            db_session,
            comms,
            10,
        )
        headers = auth_headers(user["session_token"])
        seen: list[str] = []
        cursor = None
        for _ in range(8):
            params = {"limit": limit, **({"cursor": cursor} if cursor else {})}
            resp = await client.get(
                f"{CHATS_URL}/{threads[1]}/messages",
                params=params,
                headers=headers,
            )
            assert resp.status_code == 200, resp.text
            seen += [m["id"] for m in resp.json()["messages"]]
            cursor = resp.json()["next_cursor"]
            if cursor is None:
                break
        assert seen == everything

    async def test_a_message_between_pages_waits_for_the_first_page(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        """A message that arrives after page one is newer than everything
        on it: it belongs to a fresh first page, never to page two -- even
        in a thread page one did not touch, which page two reads from its
        top again."""
        user, threads, everything = await self._three_threads(
            client,
            db_session,
            comms,
            9,
        )
        headers = auth_headers(user["session_token"])
        first = (
            await client.get(
                f"{CHATS_URL}/{threads[0]}/messages",
                params={"limit": 2},
                headers=headers,
            )
        ).json()
        taken = {m["id"] for m in first["messages"]}
        untouched = next(
            t for t in threads if not any(m["id"] in taken for m in comms.feeds[str(t)])
        )
        late = await comms(
            "POST",
            f"/api/v1/threads/{untouched}/messages",
            json={"sender": user["user"]["id"], "body": "late"},
        )
        seen = [m["id"] for m in first["messages"]]
        cursor = first["next_cursor"]
        while cursor is not None:
            body = (
                await client.get(
                    f"{CHATS_URL}/{threads[0]}/messages",
                    params={"limit": 2, "cursor": cursor},
                    headers=headers,
                )
            ).json()
            seen += [m["id"] for m in body["messages"]]
            cursor = body["next_cursor"]
        assert late["id"] not in seen
        assert seen == everything

    async def test_any_own_id_opens_it_and_nobody_elses_does(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        user, threads, everything = await self._three_threads(
            client,
            db_session,
            comms,
            11,
        )
        other = await _person(client, db_session, 12)
        headers = auth_headers(user["session_token"])
        for thread in threads:
            resp = await client.get(f"{CHATS_URL}/{thread}/messages", headers=headers)
            assert [m["id"] for m in resp.json()["messages"]] == everything
        comms.calls.clear()
        for thread in threads:
            for method, url, body in (
                ("GET", f"{CHATS_URL}/{thread}/messages", None),
                ("POST", f"{CHATS_URL}/{thread}/messages", {"body": "x"}),
                ("POST", f"{CHATS_URL}/{thread}/read", None),
                ("GET", f"{CHATS_URL}/{thread}/unread-count", None),
            ):
                resp = await client.request(
                    method,
                    url,
                    json=body,
                    headers=auth_headers(other["session_token"]),
                )
                assert resp.status_code == 404, (method, url)
        assert comms.calls == []

    async def test_a_cursor_velo_did_not_make_is_a_400(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        user = await _person(client, db_session, 13)
        thread = await _ticket(db_session, user["user"]["id"])
        resp = await client.get(
            f"{CHATS_URL}/{thread}/messages",
            params={"cursor": "comms-cursor"},
            headers=auth_headers(user["session_token"]),
        )
        assert resp.status_code == 400
        assert comms.calls == []

    async def test_read_and_unread_cover_every_thread(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        user, threads, _ = await self._three_threads(client, db_session, comms, 14)
        headers = auth_headers(user["session_token"])
        comms.unread = {str(threads[0]): 1, str(threads[2]): 4}
        resp = await client.get(
            f"{CHATS_URL}/{threads[1]}/unread-count", headers=headers
        )
        assert resp.json() == {"unread": 5}
        resp = await client.post(f"{CHATS_URL}/{threads[1]}/read", headers=headers)
        assert resp.status_code == 200
        assert {path for path, _ in comms.posted("/read")} == {
            f"/api/v1/threads/{t}/read" for t in threads
        }

    async def test_the_list_shows_one_support_row(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        user = await _person(client, db_session, 15)
        uid = user["user"]["id"]
        history = await _history(db_session, uid)
        older = await _ticket(db_session, uid, age_minutes=20)
        empty_newest = await _ticket(db_session, uid)
        stranger = await _person(client, db_session, 16)
        theirs = await _ticket(db_session, stranger["user"]["id"])

        def section_row(tid: UUID, minute: int, *, message: bool = True) -> dict:
            return {
                "id": str(tid),
                "client": uid,
                "operator_kind": "section",
                "operator_value": str(uuid4()),
                "assignee": None,
                "kind": "ticket",
                "status": "open",
                "title": None,
                "last_message_at": f"2026-10-25T10:{minute:02d}:00+00:00"
                if message
                else None,
                "created_at": "2026-10-25T09:00:00+00:00",
                "unread": 1,
                "last_message": (
                    {
                        "id": str(uuid4()),
                        "sender": uid,
                        "body": f"in {minute}",
                        "created_at": f"2026-10-25T10:{minute:02d}:00+00:00",
                    }
                    if message
                    else None
                ),
            }

        comms.client_items = [
            section_row(empty_newest, 59, message=False),
            section_row(theirs, 50),
            section_row(older, 40),
            section_row(history, 30),
        ]
        comms.unread = {str(older): 1, str(history): 2}
        resp = await client.get(CHATS_URL, headers=auth_headers(user["session_token"]))
        (row,) = resp.json()["threads"]
        assert row["id"] == str(older)
        assert row["channel"] == "support"
        assert set(row["thread_ids"]) == {str(history), str(older), str(empty_newest)}
        assert row["unread"] == 3
        assert row["last_message"]["body"] == "in 40"
        assert str(theirs) not in resp.text


# ---------------------------------------------------------------------------
# 4. Admins
# ---------------------------------------------------------------------------


class TestAdmin:
    async def test_the_list_is_tickets_spam_apart_and_comms_is_not_asked(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        admin = await _person(client, db_session, 17, role=UserRole.ADMIN.value)
        user = await _person(client, db_session, 18)
        uid = user["user"]["id"]
        history = await _history(db_session, uid)
        pay = await _ticket(db_session, uid, topic="payment", age_minutes=30)
        tech = await _ticket(
            db_session,
            uid,
            topic="technical",
            status="resolved",
            age_minutes=20,
            claimed_by=admin["user"]["id"],
        )
        spam = await _ticket(
            db_session, uid, topic="other", status="spam", age_minutes=10
        )
        headers = auth_headers(admin["session_token"])

        async def ids(**params) -> list[str]:
            resp = await client.get(TICKETS_URL, params=params, headers=headers)
            assert resp.status_code == 200, resp.text
            return [t["id"] for t in resp.json()["tickets"]]

        assert await ids() == [str(tech), str(pay)]
        assert await ids(status="spam") == [str(spam)]
        assert await ids(category="payments") == [str(pay)]
        assert await ids(status="resolved") == [str(tech)]
        cut = (datetime.now(UTC) - timedelta(minutes=25)).isoformat()
        assert await ids(created_from=cut) == [str(tech)]
        assert await ids(created_to=cut) == [str(pay)]
        resp = await client.get(TICKETS_URL, headers=headers)
        row = resp.json()["tickets"][0]
        assert row["history_thread_id"] == str(history)
        assert row["opener"]["user_id"] == uid
        assert row["claimed_by"]["user_id"] == admin["user"]["id"]
        assert comms.calls == []

    async def test_the_list_pages_by_its_own_cursor(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        admin = await _person(client, db_session, 19, role=UserRole.ADMIN.value)
        user = await _person(client, db_session, 20)
        made = [
            await _ticket(db_session, user["user"]["id"], age_minutes=m)
            for m in (50, 40, 30, 20, 10)
        ]
        headers = auth_headers(admin["session_token"])
        seen, cursor = [], None
        while True:
            params = {"limit": 2, **({"cursor": cursor} if cursor else {})}
            body = (
                await client.get(TICKETS_URL, params=params, headers=headers)
            ).json()
            seen += [t["id"] for t in body["tickets"]]
            cursor = body["next_cursor"]
            if cursor is None:
                break
        assert seen == [str(t) for t in reversed(made)]

    @pytest.mark.parametrize(
        "params,status",
        [
            ({"is_supervisor": "true"}, 400),
            ({"category": "billing"}, 422),
            ({"created_from": "2026-10-25T10:00:00"}, 400),
            ({"cursor": "x"}, 400),
        ],
    )
    async def test_the_list_refuses_what_it_does_not_take(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
        params,
        status,
    ) -> None:
        admin = await _person(client, db_session, 21, role=UserRole.ADMIN.value)
        resp = await client.get(
            TICKETS_URL,
            params=params,
            headers=auth_headers(admin["session_token"]),
        )
        assert resp.status_code == status

    async def test_the_list_and_the_status_are_for_admins(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        user = await _person(client, db_session, 22)
        thread = await _ticket(db_session, user["user"]["id"])
        headers = auth_headers(user["session_token"])
        assert (await client.get(TICKETS_URL, headers=headers)).status_code == 403
        resp = await client.post(
            f"{TICKETS_URL}/{thread}/status",
            json={"status": "spam"},
            headers=headers,
        )
        assert resp.status_code == 403
        assert comms.calls == []

    @pytest.mark.parametrize("status", CLOSING_STATUSES)
    async def test_an_open_ticket_closes_and_comms_hears_resolved(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
        status,
    ) -> None:
        admin = await _person(client, db_session, 23, role=UserRole.ADMIN.value)
        user = await _person(client, db_session, 24)
        thread = await _ticket(db_session, user["user"]["id"])
        resp = await client.post(
            f"{TICKETS_URL}/{thread}/status",
            json={"status": status},
            headers=auth_headers(admin["session_token"]),
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] == status
        assert comms.posted("/status") == [
            (
                f"/api/v1/threads/{thread}/status",
                {"operator": admin["user"]["id"], "status": "resolved"},
            )
        ]
        assert (await _row(thread)).status == status

    @pytest.mark.parametrize("status", ["open", "closed"])
    async def test_open_and_closed_are_never_set_by_an_admin(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
        status,
    ) -> None:
        admin = await _person(client, db_session, 25, role=UserRole.ADMIN.value)
        user = await _person(client, db_session, 26)
        thread = await _ticket(db_session, user["user"]["id"])
        resp = await client.post(
            f"{TICKETS_URL}/{thread}/status",
            json={"status": status},
            headers=auth_headers(admin["session_token"]),
        )
        assert resp.status_code == 422
        assert comms.calls == []

    async def test_a_ticket_not_open_is_a_409_and_comms_is_not_told(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        admin = await _person(client, db_session, 27, role=UserRole.ADMIN.value)
        user = await _person(client, db_session, 28)
        thread = await _ticket(db_session, user["user"]["id"], status="resolved")
        resp = await client.post(
            f"{TICKETS_URL}/{thread}/status",
            json={"status": "spam"},
            headers=auth_headers(admin["session_token"]),
        )
        assert resp.status_code == 409
        assert comms.calls == []
        assert (await _row(thread)).status == "resolved"

    async def test_history_is_read_only(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        admin = await _person(client, db_session, 29, role=UserRole.ADMIN.value)
        user = await _person(client, db_session, 30)
        history = await _history(db_session, user["user"]["id"])
        headers = auth_headers(admin["session_token"])
        for method, url, body in (
            ("POST", f"/api/v1/support/threads/{history}/claim", None),
            ("POST", f"/api/v1/support/threads/{history}/messages", {"body": "x"}),
            ("POST", f"{TICKETS_URL}/{history}/status", {"status": "spam"}),
        ):
            resp = await client.request(method, url, json=body, headers=headers)
            assert resp.status_code == 409, url
        assert comms.calls == []
        resp = await client.get(
            f"/api/v1/support/threads/{history}/messages",
            headers=headers,
        )
        assert resp.status_code == 200

    async def test_a_claim_records_the_taker(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        admin = await _person(client, db_session, 31, role=UserRole.ADMIN.value)
        user = await _person(client, db_session, 32)
        thread = await _ticket(db_session, user["user"]["id"])
        resp = await client.post(
            f"/api/v1/support/threads/{thread}/claim",
            headers=auth_headers(admin["session_token"]),
        )
        assert resp.status_code == 200
        assert str((await _row(thread)).claimed_by_user_id) == admin["user"]["id"]

    @pytest.mark.parametrize("status", ["open", "resolved", "spam"])
    async def test_nobody_elses_ticket_opens_in_any_state(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
        status,
    ) -> None:
        owner = await _person(client, db_session, 33)
        taker = await _person(client, db_session, 34, role=UserRole.ADMIN.value)
        other = await _person(client, db_session, 35)
        await _ticket(db_session, other["user"]["id"])  # has support of their own
        thread = await _ticket(
            db_session,
            owner["user"]["id"],
            status=status,
            claimed_by=taker["user"]["id"],
        )
        resp = await client.get(
            f"{CHATS_URL}/{thread}/messages",
            headers=auth_headers(other["session_token"]),
        )
        assert resp.status_code == 404
        assert comms.calls == []


# ---------------------------------------------------------------------------
# 6. Races
# ---------------------------------------------------------------------------


async def test_two_admins_on_one_ticket_the_second_is_refused(
    client: AsyncClient,
    db_session: AsyncSession,
    comms: FakeComms,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Admin A marks spam and stands with the row written, uncommitted;
    admin B's change runs into it and must be seen WAITING. When A commits,
    B's compare-and-set finds the ticket no longer open: 409, A's stands."""
    a = await _person(client, db_session, 36, role=UserRole.ADMIN.value)
    b = await _person(client, db_session, 37, role=UserRole.ADMIN.value)
    user = await _person(client, db_session, 38)
    thread = await _ticket(db_session, user["user"]["id"])

    async def _as(admin: dict, status: str, session: AsyncSession) -> object:
        actor = await session.get(User, UUID(admin["user"]["id"]))
        return await service.set_ticket_status(
            session,
            admin=actor,
            thread_id=thread,
            status=status,
        )

    result = await race(
        monkeypatch,
        holder=lambda s: _as(a, "spam", s),
        pause_in=(service, "_ticket_now"),
        rival=lambda s: _as(b, "resolved", s),
    )
    assert result.rival_waited
    assert_no_deadlock(result)
    assert result.holder.committed
    assert isinstance(result.rival.error, ConflictError)
    row = await _row(thread)
    assert (row.status, row.version) == ("spam", 2)


async def test_a_message_meanwhile_refuses_the_status_change(
    client: AsyncClient,
    db_session: AsyncSession,
    comms: FakeComms,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The person writes and stands with the ticket written (open,
    version bumped), uncommitted; the admin's change -- read before, comms
    told -- runs into the row and must be seen WAITING. On commit its
    compare-and-set sees another version: 409, the ticket stays open for
    the message nobody has answered. Without the version in the
    compare-and-set the admin would close the ticket over that message."""
    admin = await _person(client, db_session, 39, role=UserRole.ADMIN.value)
    user = await _person(client, db_session, 0)
    thread = await _ticket(db_session, user["user"]["id"])

    async def _writes(session: AsyncSession) -> object:
        person = await session.get(User, UUID(user["user"]["id"]))
        return await service.send_dialog_message(session, user=person, body="wait!")

    async def _closes(session: AsyncSession) -> object:
        actor = await session.get(User, UUID(admin["user"]["id"]))
        return await service.set_ticket_status(
            session,
            admin=actor,
            thread_id=thread,
            status="resolved",
        )

    result = await race(
        monkeypatch,
        holder=_writes,
        pause_in=(translation, "enqueue"),
        rival=_closes,
    )
    assert result.rival_waited
    assert_no_deadlock(result)
    assert result.holder.committed
    assert isinstance(result.rival.error, ConflictError)
    row = await _row(thread)
    assert (row.status, row.version) == ("open", 2)
