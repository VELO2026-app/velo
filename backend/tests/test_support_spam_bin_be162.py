# =============================================================================
# VELO -- handing tickets over, back to work, the spam bin (BE-162, delivery 2)
# =============================================================================
# Band 55040-55079.
#
# What is under test, and why each one exists:
#
#   1. HANDOVER: assign to an admin (only), release to the pool -- comms is
#      asked, the taker recorded, and velo tells the admins what comms does
#      not (assigned -> that admin, released -> every admin); a repeat is
#      silent; the person's messages follow the new taker.
#   2. BACK TO WORK / NOT SPAM: any non-open ticket back to OPEN; spam only
#      within the retention; comms' thread back to `open`.
#   3. THE BIN: spam past the retention -> a tombstone and a purge row in
#      the transaction that deletes our rows, then comms' DELETE; comms down
#      keeps the purge row; a repeat does nothing; the statistics keep the
#      date and the category; the person's conversation never trips on the
#      gone thread.
#   4. RACES: "not spam" against the bin, both ways; two "back to work".
# =============================================================================

import sys
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import MagicMock
from uuid import UUID, uuid4

import pytest
from fastapi import HTTPException
from httpx import AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.events.models import OutboxEvent
from app.core.exceptions import ConflictError, NotFoundError
from app.modules.support import purge, service
from app.modules.support.models import (
    TO_SUPPORT,
    TOPICS,
    SupportSpamTombstone,
    SupportThread,
    SupportThreadPurge,
    SupportTicket,
    SupportTranslationJob,
)
from app.modules.users.models import User, UserRole
from tests.curator_race_harness import assert_no_deadlock, race
from tests.helpers import auth_headers, fresh_execute, full_cleanup_range, login_user

BAND_MIN, BAND_MAX = 55040, 55079

_SEAMS = (
    "app.modules.support.service.comms_request",
    "app.modules.support.purge.comms_request",
    "app.modules.chats.router.comms_request",
)
TICKETS_URL = "/api/v1/support/tickets"
_SIGNALS = (service.ASSIGNED_TYPE, service.RELEASED_TYPE, service.MESSAGE_RECEIVED_TYPE)


# ---------------------------------------------------------------------------
# Fixtures and builders
# ---------------------------------------------------------------------------


async def _clean(session: AsyncSession) -> None:
    await full_cleanup_range(session, BAND_MIN, BAND_MAX, delete_users=True)
    await session.execute(
        delete(OutboxEvent).where(
            OutboxEvent.payload["type"].astext.in_(_SIGNALS),
            OutboxEvent.created_at > datetime.now(UTC) - timedelta(hours=1),
        )
    )
    await session.execute(delete(SupportThreadPurge))
    await session.execute(delete(SupportSpamTombstone))
    await session.commit()


@pytest.fixture(autouse=True)
async def _band(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await _clean(db_session)
    yield
    await _clean(db_session)


class _Comms:
    """comms 3.11.0 as these routes meet it. `gone` -- deleted threads: any
    call naming one is a 404, as comms answers after a DELETE."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, Any]] = []
        self.gone: set[str] = set()
        self.down = False
        self.on_assign = None
        self.on_status = None

    def made(self, suffix: str) -> list[tuple[str, Any]]:
        return [(c[1], c[2]) for c in self.calls if c[1].endswith(suffix)]

    async def __call__(self, method: str, path: str, **kw: Any) -> Any:
        self.calls.append((method, path, kw.get("json")))
        if self.down:
            raise HTTPException(status_code=502, detail="Chats unavailable")
        parts = path.split("/")
        thread = parts[4] if len(parts) > 4 else None
        if method == "DELETE":
            self.gone.add(thread)
            return None
        if thread in self.gone:
            raise HTTPException(status_code=404, detail="Not found")
        if path.endswith("/assign"):
            if self.on_assign is not None:
                await self.on_assign()
            return {"id": thread, "assignee": kw["json"]["assignee"]}
        if path.endswith("/release"):
            return {"id": thread, "assignee": None}
        if path.endswith("/status"):
            if self.on_status is not None:
                await self.on_status()
            return {"id": thread, "status": kw["json"]["status"]}
        if path.endswith("/messages") and method == "POST":
            return {
                "id": str(uuid4()),
                "thread_id": thread,
                "sender": kw["json"]["sender"],
                "body": kw["json"]["body"],
                "created_at": datetime.now(UTC).isoformat(),
            }
        if path.endswith("/messages") and method == "GET":
            return {"items": [], "next_cursor": None}
        if path == "/api/v1/threads" and method == "GET":
            return {"items": [], "next_cursor": None}
        raise AssertionError(f"unexpected comms call {method} {path}")


@pytest.fixture
def comms(monkeypatch: pytest.MonkeyPatch) -> _Comms:
    fake = _Comms()
    for seam in _SEAMS:
        monkeypatch.setattr(seam, fake)
    return fake


async def _person(
    client: AsyncClient,
    db_session: AsyncSession,
    offset: int,
    *,
    role: str | None = None,
) -> dict:
    tid = BAND_MIN + offset
    auth = await login_user(client, telegram_id=tid, first_name=f"BE162s-{offset}")
    if role is not None:
        user = await db_session.get(User, UUID(auth["user"]["id"]))
        user.role = role
        await db_session.commit()
        auth = await login_user(client, telegram_id=tid, first_name=f"BE162s-{offset}")
    return auth


async def _ticket(
    db_session: AsyncSession,
    user_id: str,
    *,
    topic: str = "technical",
    status: str = "open",
    changed_days_ago: float = 0,
    age_days: float = 0,
    claimed_by: str | None = None,
) -> UUID:
    thread_id = uuid4()
    pointer = SupportThread(comms_thread_id=thread_id, client_user_id=UUID(user_id))
    db_session.add(pointer)
    await db_session.flush()
    now = datetime.now(UTC)
    db_session.add(
        SupportTicket(
            support_thread_id=pointer.id,
            topic=topic,
            category=TOPICS[topic].category,
            status=status,
            created_at=now - timedelta(days=max(age_days, changed_days_ago)),
            status_changed_at=now - timedelta(days=changed_days_ago),
            claimed_by_user_id=UUID(claimed_by) if claimed_by else None,
            version=1,
        )
    )
    await db_session.commit()
    return thread_id


async def _row(thread_id: UUID) -> SupportTicket | None:
    return (
        await fresh_execute(
            select(SupportTicket)
            .join(SupportThread, SupportThread.id == SupportTicket.support_thread_id)
            .where(SupportThread.comms_thread_id == thread_id)
        )
    ).scalar_one_or_none()


async def _signals(thread_id: UUID, type_: str) -> list[dict]:
    p = OutboxEvent.payload
    return [
        e.payload
        for e in (
            await fresh_execute(
                select(OutboxEvent)
                .where(
                    p["type"].astext == type_,
                    p["action_data"]["params"]["thread_id"].astext == str(thread_id),
                )
                .order_by(OutboxEvent.id)
            )
        )
        .scalars()
        .all()
    ]


async def _post(client: AsyncClient, who: dict, url: str, body: Any = None) -> Any:
    return await client.post(url, json=body, headers=auth_headers(who["session_token"]))


# ---------------------------------------------------------------------------
# 1. Handover
# ---------------------------------------------------------------------------


class TestHandover:
    async def test_assign_hands_it_over_and_tells_the_assignee_alone(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
    ) -> None:
        a = await _person(client, db_session, 0, role=UserRole.ADMIN.value)
        b = await _person(client, db_session, 1, role=UserRole.ADMIN.value)
        user = await _person(client, db_session, 2)
        thread = await _ticket(
            db_session, user["user"]["id"], claimed_by=a["user"]["id"]
        )
        resp = await _post(
            client,
            a,
            f"{TICKETS_URL}/{thread}/assign",
            {"assignee": b["user"]["id"]},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["claimed_by"]["user_id"] == b["user"]["id"]
        assert comms.made("/assign") == [
            (
                f"/api/v1/threads/{thread}/assign",
                {"operator": a["user"]["id"], "assignee": b["user"]["id"]},
            )
        ]
        row = await _row(thread)
        assert (str(row.claimed_by_user_id), row.version) == (b["user"]["id"], 2)
        (signal,) = await _signals(thread, service.ASSIGNED_TYPE)
        assert (signal["target_type"], signal["target_value"]) == (
            "user",
            b["user"]["id"],
        )
        assert signal["idempotency_key"] == f"{service.ASSIGNED_TYPE}:{thread}:2"
        assert signal["action_data"]["action"] == "open_admin_support"
        assert signal["action_data"]["actor_name"] == "BE162s-0"
        assert signal["action_data"]["topic_line_ru"]
        assert await _signals(thread, service.RELEASED_TYPE) == []

        # The person's next message signals the new taker alone.
        await _post(client, user, f"/api/v1/chats/{thread}/messages", {"body": "?"})
        (ping,) = await _signals(thread, service.MESSAGE_RECEIVED_TYPE)
        assert (ping["target_type"], ping["target_value"]) == ("user", b["user"]["id"])

    async def test_the_same_assignee_again_is_silent(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
    ) -> None:
        a = await _person(client, db_session, 3, role=UserRole.ADMIN.value)
        user = await _person(client, db_session, 4)
        thread = await _ticket(
            db_session, user["user"]["id"], claimed_by=a["user"]["id"]
        )
        resp = await _post(
            client,
            a,
            f"{TICKETS_URL}/{thread}/assign",
            {"assignee": a["user"]["id"]},
        )
        assert resp.status_code == 200, resp.text
        assert len(comms.made("/assign")) == 1  # comms asked: it aligns comms
        assert (await _row(thread)).version == 1
        assert await _signals(thread, service.ASSIGNED_TYPE) == []

    async def test_assignee_must_be_an_admin_before_comms(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
    ) -> None:
        a = await _person(client, db_session, 5, role=UserRole.ADMIN.value)
        master = await _person(client, db_session, 6, role=UserRole.MASTER.value)
        user = await _person(client, db_session, 7)
        thread = await _ticket(db_session, user["user"]["id"])
        for body, status in (
            ({"assignee": user["user"]["id"]}, 422),
            ({"assignee": master["user"]["id"]}, 422),
            ({"assignee": str(uuid4())}, 422),
            ({}, 422),
            ({"assignee": a["user"]["id"], "operator": a["user"]["id"]}, 422),
        ):
            resp = await _post(client, a, f"{TICKETS_URL}/{thread}/assign", body)
            assert resp.status_code == status, body
        assert comms.calls == []
        assert (await _row(thread)).claimed_by_user_id is None

    async def test_release_returns_it_to_the_pool_and_tells_every_admin(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
    ) -> None:
        a = await _person(client, db_session, 8, role=UserRole.ADMIN.value)
        user = await _person(client, db_session, 9)
        thread = await _ticket(
            db_session, user["user"]["id"], claimed_by=a["user"]["id"]
        )
        resp = await _post(client, a, f"{TICKETS_URL}/{thread}/release")
        assert resp.status_code == 200, resp.text
        assert resp.json()["claimed_by"] is None
        assert comms.made("/release") == [
            (f"/api/v1/threads/{thread}/release", {"operator": a["user"]["id"]})
        ]
        (signal,) = await _signals(thread, service.RELEASED_TYPE)
        assert (signal["target_type"], signal["target_value"]) == ("group", "admins")
        await _post(client, user, f"/api/v1/chats/{thread}/messages", {"body": "?"})
        (ping,) = await _signals(thread, service.MESSAGE_RECEIVED_TYPE)
        assert (ping["target_type"], ping["target_value"]) == ("group", "admins")

        again = await _post(client, a, f"{TICKETS_URL}/{thread}/release")
        assert again.status_code == 200
        assert len(await _signals(thread, service.RELEASED_TYPE)) == 1

    async def test_comms_refusing_a_handover_writes_nothing(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        a = await _person(client, db_session, 10, role=UserRole.ADMIN.value)
        b = await _person(client, db_session, 11, role=UserRole.ADMIN.value)
        user = await _person(client, db_session, 12)
        thread = await _ticket(db_session, user["user"]["id"])

        async def _conflict() -> None:
            raise HTTPException(status_code=409, detail="conflict")

        comms.on_assign = _conflict
        resp = await _post(
            client,
            a,
            f"{TICKETS_URL}/{thread}/assign",
            {"assignee": b["user"]["id"]},
        )
        assert resp.status_code == 409
        row = await _row(thread)
        assert (row.claimed_by_user_id, row.version) == (None, 1)
        assert await _signals(thread, service.ASSIGNED_TYPE) == []

    async def test_a_handover_landing_meanwhile_is_a_409_and_the_drift_log(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The KNOWN CEILING's trigger: while comms is asked, the taker
        changes here (another handover's write) -- this write loses its
        compare-and-set, answers 409 and logs support_handover_drift."""
        a = await _person(client, db_session, 13, role=UserRole.ADMIN.value)
        b = await _person(client, db_session, 14, role=UserRole.ADMIN.value)
        c = await _person(client, db_session, 15, role=UserRole.ADMIN.value)
        user = await _person(client, db_session, 16)
        thread = await _ticket(db_session, user["user"]["id"])
        row = await _row(thread)

        async def _someone_else_meanwhile() -> None:
            await db_session.execute(
                SupportTicket.__table__.update()
                .where(SupportTicket.support_thread_id == row.support_thread_id)
                .values(claimed_by_user_id=UUID(c["user"]["id"]))
            )
            await db_session.commit()

        comms.on_assign = _someone_else_meanwhile
        log = MagicMock()
        monkeypatch.setattr("app.modules.support.service.logger", log)
        resp = await _post(
            client,
            a,
            f"{TICKETS_URL}/{thread}/assign",
            {"assignee": b["user"]["id"]},
        )
        assert resp.status_code == 409
        assert any(
            call.args[0] == "support_handover_drift"
            for call in log.warning.call_args_list
        )
        assert str((await _row(thread)).claimed_by_user_id) == c["user"]["id"]
        assert await _signals(thread, service.ASSIGNED_TYPE) == []

    async def test_handover_is_for_admins_and_not_for_history(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
    ) -> None:
        a = await _person(client, db_session, 17, role=UserRole.ADMIN.value)
        user = await _person(client, db_session, 18)
        thread = await _ticket(db_session, user["user"]["id"])
        history = uuid4()
        db_session.add(
            SupportThread(
                comms_thread_id=history, client_user_id=UUID(user["user"]["id"])
            )
        )
        await db_session.commit()
        for url in (
            f"{TICKETS_URL}/{thread}/release",
            f"{TICKETS_URL}/{thread}/reopen",
        ):
            assert (await _post(client, user, url)).status_code == 403
        assert (
            await _post(
                client,
                user,
                f"{TICKETS_URL}/{thread}/assign",
                {"assignee": a["user"]["id"]},
            )
        ).status_code == 403
        for url, body in (
            (f"{TICKETS_URL}/{history}/assign", {"assignee": a["user"]["id"]}),
            (f"{TICKETS_URL}/{history}/release", None),
            (f"{TICKETS_URL}/{history}/reopen", None),
        ):
            assert (await _post(client, a, url, body)).status_code == 409, url
        for url, body in (
            (f"{TICKETS_URL}/{uuid4()}/assign", {"assignee": a["user"]["id"]}),
            (f"{TICKETS_URL}/{uuid4()}/release", None),
            (f"{TICKETS_URL}/{uuid4()}/reopen", None),
        ):
            assert (await _post(client, a, url, body)).status_code == 404, url
        assert comms.calls == []


# ---------------------------------------------------------------------------
# 2. Back to work / not spam
# ---------------------------------------------------------------------------


class TestReopen:
    @pytest.mark.parametrize("status", ["resolved", "rejected", "duplicate"])
    async def test_back_to_work(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
        status: str,
    ) -> None:
        a = await _person(client, db_session, 19, role=UserRole.ADMIN.value)
        user = await _person(client, db_session, 20)
        thread = await _ticket(
            db_session, user["user"]["id"], status=status, changed_days_ago=90
        )
        before = await _row(thread)
        resp = await _post(client, a, f"{TICKETS_URL}/{thread}/reopen")
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] == "open"
        after = await _row(thread)
        assert (after.status, after.version) == ("open", 2)
        assert after.status_changed_at > before.status_changed_at
        assert comms.made("/status") == [
            (
                f"/api/v1/threads/{thread}/status",
                {"operator": a["user"]["id"], "status": "open"},
            )
        ]

    async def test_resolved_again_meanwhile_is_not_reopened_over(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
    ) -> None:
        """ABA: the admin read "resolved"; while comms is asked, the person
        wrote (open) and another admin resolved it again -- the status is
        "resolved" once more, the version is not. The compare-and-set on
        the version refuses (409): this admin's "back to work" was about
        the earlier resolution, not the new one."""
        a = await _person(client, db_session, 38, role=UserRole.ADMIN.value)
        user = await _person(client, db_session, 39)
        thread = await _ticket(db_session, user["user"]["id"], status="resolved")
        row = await _row(thread)

        async def _reopened_and_resolved_again() -> None:
            await db_session.execute(
                SupportTicket.__table__.update()
                .where(SupportTicket.support_thread_id == row.support_thread_id)
                .values(version=SupportTicket.version + 2)
            )
            await db_session.commit()

        comms.on_status = _reopened_and_resolved_again
        resp = await _post(client, a, f"{TICKETS_URL}/{thread}/reopen")
        assert resp.status_code == 409
        after = await _row(thread)
        assert (after.status, after.version) == ("resolved", 3)

    async def test_not_spam_within_the_retention(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
    ) -> None:
        a = await _person(client, db_session, 21, role=UserRole.ADMIN.value)
        user = await _person(client, db_session, 22)
        thread = await _ticket(
            db_session, user["user"]["id"], status="spam", changed_days_ago=29
        )
        resp = await _post(client, a, f"{TICKETS_URL}/{thread}/reopen")
        assert resp.status_code == 200, resp.text
        assert (await _row(thread)).status == "open"

    async def test_spam_past_the_retention_and_an_open_ticket_are_409(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
    ) -> None:
        a = await _person(client, db_session, 23, role=UserRole.ADMIN.value)
        user = await _person(client, db_session, 24)
        old_spam = await _ticket(
            db_session,
            user["user"]["id"],
            status="spam",
            changed_days_ago=31,
        )
        is_open = await _ticket(db_session, user["user"]["id"])
        for thread in (old_spam, is_open):
            assert (
                await _post(client, a, f"{TICKETS_URL}/{thread}/reopen")
            ).status_code == 409
        assert comms.calls == []
        assert (await _row(old_spam)).status == "spam"


# ---------------------------------------------------------------------------
# 3. The bin
# ---------------------------------------------------------------------------


class TestBin:
    async def test_old_spam_goes_leaving_its_date_and_category(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
    ) -> None:
        user = await _person(client, db_session, 25)
        uid = user["user"]["id"]
        old = await _ticket(
            db_session,
            uid,
            topic="payment",
            status="spam",
            changed_days_ago=31,
            age_days=35,
        )
        young = await _ticket(db_session, uid, status="spam", changed_days_ago=29)
        old_resolved = await _ticket(
            db_session, uid, status="resolved", changed_days_ago=90
        )
        pointer = (
            await fresh_execute(
                select(SupportThread).where(SupportThread.comms_thread_id == old)
            )
        ).scalar_one()
        db_session.add(
            SupportTranslationJob(
                support_thread_id=pointer.id,
                comms_message_id=uuid4(),
                direction=TO_SUPPORT,
                locale="en",
                attempt=1,
                job_key=f"llm-support-tr:{uuid4()}",
            )
        )
        await db_session.commit()
        appealed = (await _row(old)).created_at

        assert await purge.purge_spam_step() == (1, 1)

        assert await _row(old) is None
        assert await _row(young) is not None and await _row(old_resolved) is not None
        assert (
            await fresh_execute(
                select(SupportThread).where(SupportThread.comms_thread_id == old)
            )
        ).scalar_one_or_none() is None
        assert (
            await fresh_execute(
                select(SupportTranslationJob).where(
                    SupportTranslationJob.support_thread_id == pointer.id
                )
            )
        ).scalars().all() == []
        (tombstone,) = (
            (await fresh_execute(select(SupportSpamTombstone))).scalars().all()
        )
        assert (tombstone.appealed_at, tombstone.category) == (appealed, "payments")
        assert [c for c in comms.calls if c[0] == "DELETE"] == [
            ("DELETE", f"/api/v1/threads/{old}", None)
        ]
        assert (await fresh_execute(select(SupportThreadPurge))).scalars().all() == []

        # A repeat finds nothing to do.
        assert await purge.purge_spam_step() == (0, 0)

    async def test_comms_down_keeps_the_purge_row_for_the_next_step(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
    ) -> None:
        user = await _person(client, db_session, 26)
        old = await _ticket(
            db_session, user["user"]["id"], status="spam", changed_days_ago=40
        )
        comms.down = True
        assert await purge.purge_spam_step() == (1, 0)
        assert await _row(old) is None  # ours first: our rows are gone already
        (queued,) = (await fresh_execute(select(SupportThreadPurge))).scalars().all()
        assert (queued.comms_thread_id, queued.attempts) == (old, 1)
        assert queued.last_error_at is not None

        comms.down = False
        assert await purge.purge_spam_step() == (0, 1)
        assert (await fresh_execute(select(SupportThreadPurge))).scalars().all() == []
        assert old and str(old) in comms.gone

    async def test_a_retention_of_zero_takes_spam_at_once(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The owner's live check: the retention set to 0 days empties the
        bin of every spam ticket on the next step."""
        monkeypatch.setattr(settings, "support_spam_retention_days", 0)
        user = await _person(client, db_session, 27)
        fresh = await _ticket(db_session, user["user"]["id"], status="spam")
        assert await purge.purge_spam_step() == (1, 1)
        assert await _row(fresh) is None

    async def test_statistics_keep_the_gone_spam(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
    ) -> None:
        admin = await _person(client, db_session, 28, role=UserRole.ADMIN.value)
        user = await _person(client, db_session, 29)
        uid = user["user"]["id"]
        await _ticket(
            db_session,
            uid,
            topic="other",
            status="spam",
            changed_days_ago=31,
            age_days=32,
        )
        await _ticket(
            db_session,
            uid,
            topic="payment",
            status="spam",
            changed_days_ago=1,
            age_days=32,
        )
        await _ticket(db_session, uid, topic="payment", status="open", age_days=32)
        now = datetime.now(UTC)
        period = {
            "created_from": (now - timedelta(days=40)).isoformat(),
            "created_to": now.isoformat(),
        }
        headers = auth_headers(admin["session_token"])
        before = (
            await client.get("/api/v1/support/stats", params=period, headers=headers)
        ).json()
        assert await purge.purge_spam_step() == (1, 1)
        after = (
            await client.get("/api/v1/support/stats", params=period, headers=headers)
        ).json()
        assert before["spam"] == after["spam"] == 2
        assert before["categories"] == after["categories"]
        assert after["total"] == 1

    async def test_the_persons_conversation_never_reads_the_gone_thread(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
    ) -> None:
        """After the bin, the person's conversation reads only their other
        threads -- the fake comms answers 404 for the gone one, as comms
        3.11.0 does, so reading it would fail the feed -- and the gone
        id itself is a 404 (the front shows "this conversation is gone")."""
        user = await _person(client, db_session, 30)
        uid = user["user"]["id"]
        gone = await _ticket(db_session, uid, status="spam", changed_days_ago=31)
        kept = await _ticket(db_session, uid)
        assert await purge.purge_spam_step() == (1, 1)
        headers = auth_headers(user["session_token"])
        resp = await client.get(f"/api/v1/chats/{kept}/messages", headers=headers)
        assert resp.status_code == 200, resp.text
        read = {c[1] for c in comms.calls if c[0] == "GET"}
        assert f"/api/v1/threads/{gone}/messages" not in read
        assert f"/api/v1/threads/{kept}/messages" in read
        for method, suffix in (
            ("GET", "messages"),
            ("GET", "unread-count"),
            ("POST", "read"),
        ):
            resp = await client.request(
                method,
                f"/api/v1/chats/{gone}/{suffix}",
                headers=headers,
            )
            assert resp.status_code == 404, suffix


@pytest.mark.parametrize("raw,days", [("", 30), ("  ", 30), ("0", 0), ("30", 30)])
def test_the_retention_setting_reads_the_owners_values(
    monkeypatch: pytest.MonkeyPatch,
    raw: str,
    days: int,
) -> None:
    """The owner sets it with `velo env set SUPPORT_SPAM_RETENTION_DAYS`,
    whose empty answer writes the key EMPTY ("empty clears it"): that must
    read as the 30 days, not stop the backend from starting."""
    from app.core.config import Settings

    monkeypatch.setenv("SUPPORT_SPAM_RETENTION_DAYS", raw)
    assert Settings().support_spam_retention_days == days


def test_a_negative_retention_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    from pydantic import ValidationError

    from app.core.config import Settings

    monkeypatch.setenv("SUPPORT_SPAM_RETENTION_DAYS", "-1")
    with pytest.raises(ValidationError):
        Settings()


# ---------------------------------------------------------------------------
# 4. Races
# ---------------------------------------------------------------------------


async def _stand() -> None:
    """Where a holder stands with its write done and not committed."""


async def test_the_bin_holding_a_ticket_makes_not_spam_a_404(
    client: AsyncClient,
    db_session: AsyncSession,
    comms: _Comms,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The bin has taken the ticket -- tombstone written, rows deleted, not
    committed. "Not spam", read before, runs into the row and must be seen
    WAITING; on the bin's commit the ticket is gone: 404."""
    admin = await _person(client, db_session, 31, role=UserRole.ADMIN.value)
    user = await _person(client, db_session, 32)
    # 29 days a spam: within the retention for "not spam" now, past it for
    # a bin step that runs two days ahead.
    thread = await _ticket(
        db_session, user["user"]["id"], status="spam", changed_days_ago=29
    )
    module = sys.modules[__name__]

    async def _bin(session: AsyncSession) -> object:
        taken = await purge.bury_spam(
            session, now=datetime.now(UTC) + timedelta(days=2)
        )
        await module._stand()
        return taken

    async def _not_spam(session: AsyncSession) -> object:
        actor = await session.get(User, UUID(admin["user"]["id"]))
        return await service.reopen_ticket(session, admin=actor, thread_id=thread)

    result = await race(
        monkeypatch,
        holder=_bin,
        pause_in=(module, "_stand"),
        rival=_not_spam,
    )
    assert result.rival_waited
    assert_no_deadlock(result)
    assert result.holder.committed
    assert isinstance(result.rival.error, NotFoundError)
    assert await _row(thread) is None


async def test_not_spam_holding_a_ticket_makes_the_bin_skip_it(
    client: AsyncClient,
    db_session: AsyncSession,
    comms: _Comms,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ "Not spam" has written the ticket open, not committed; the bin's
    SKIP LOCKED passes the row by WITHOUT waiting and takes nothing -- and
    after the commit the ticket is open, so the next step does not take
    it either."""
    admin = await _person(client, db_session, 33, role=UserRole.ADMIN.value)
    user = await _person(client, db_session, 34)
    thread = await _ticket(
        db_session, user["user"]["id"], status="spam", changed_days_ago=29
    )
    module = sys.modules[__name__]

    async def _not_spam(session: AsyncSession) -> object:
        actor = await session.get(User, UUID(admin["user"]["id"]))
        out = await service.reopen_ticket(session, admin=actor, thread_id=thread)
        await module._stand()
        return out

    async def _bin(session: AsyncSession) -> object:
        return await purge.bury_spam(session, now=datetime.now(UTC) + timedelta(days=2))

    result = await race(
        monkeypatch,
        holder=_not_spam,
        pause_in=(module, "_stand"),
        rival=_bin,
    )
    assert not result.rival_waited
    assert_no_deadlock(result)
    assert result.holder.committed and result.rival.committed
    assert (await _row(thread)).status == "open"
    assert (await fresh_execute(select(SupportSpamTombstone))).scalars().all() == []


async def test_two_back_to_work_the_second_is_refused(
    client: AsyncClient,
    db_session: AsyncSession,
    comms: _Comms,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    a = await _person(client, db_session, 35, role=UserRole.ADMIN.value)
    b = await _person(client, db_session, 36, role=UserRole.ADMIN.value)
    user = await _person(client, db_session, 37)
    thread = await _ticket(db_session, user["user"]["id"], status="resolved")
    module = sys.modules[__name__]

    async def _reopen(admin: dict, session: AsyncSession, *, stand: bool) -> object:
        actor = await session.get(User, UUID(admin["user"]["id"]))
        out = await service.reopen_ticket(session, admin=actor, thread_id=thread)
        if stand:
            await module._stand()
        return out

    result = await race(
        monkeypatch,
        holder=lambda s: _reopen(a, s, stand=True),
        pause_in=(module, "_stand"),
        rival=lambda s: _reopen(b, s, stand=False),
    )
    assert result.rival_waited
    assert_no_deadlock(result)
    assert result.holder.committed
    assert isinstance(result.rival.error, ConflictError)
    row = await _row(thread)
    assert (row.status, row.version) == ("open", 2)
