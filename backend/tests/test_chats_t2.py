# =============================================================================
# VELO -- chat proxy + thread_started diary projection (Phase 6 / T2)
# =============================================================================
# Band 89720-89759.
#
# What is under test, and why each one exists:
#   1. ACTOR STAMPING -- comms trusts whatever actor id we send it, so the
#      proxy must derive every one of them from the session. Both halves of
#      the double: the stamped value reaches comms, AND an attempt to supply
#      one from the wire is refused rather than ignored.
#   2. MEMBERSHIP -- the comms read API is operator-scoped and cannot answer
#      "is this user in thread T", so a forged thread id must die here. A
#      stranger gets 404, not 403: 403 would confirm the thread exists.
#   3. THE DIARY ECHO -- written once per thread, healed if the write was
#      lost, never duplicated, and timestamped with the thread's own
#      created_at rather than the moment we noticed.
#
# comms is cut at the seam (app.modules.chats.router.comms_request) -- no
# comms stack needed; core/comms.py is exercised separately by T1's suite.
# =============================================================================

from datetime import datetime
from unittest.mock import AsyncMock
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session_factory
from app.modules.chats.models import ChatThread
from app.modules.diary.models import DiaryEvent, DiaryEventKind
from app.modules.masters.models import MasterProfile
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, cleanup_range, fresh_execute, login_user

BAND_MIN, BAND_MAX = 89720, 89759
_SEAM = "app.modules.chats.router.comms_request"

CHATS_URL = "/api/v1/chats"

# A stable comms thread id and creation instant: the projection must copy
# THIS instant into the diary, not "now".
THREAD_ID = "bbbbbbbb-8972-4000-8000-000000000001"
THREAD_CREATED_AT = "2026-08-01T10:30:00+00:00"


def _thread_payload(created: bool = True, thread_id: str = THREAD_ID) -> dict:
    """The frozen 3b create response, plus the additive `created` flag."""
    return {
        "id": thread_id,
        "client": str(uuid4()),
        "operator_kind": "user",
        "operator_value": str(uuid4()),
        "assignee": None,
        "kind": "dm",
        "status": "open",
        "subject_type": None,
        "subject_id": None,
        "title": None,
        "priority": None,
        "last_message_at": None,
        "created_at": THREAD_CREATED_AT,
        "created": created,
    }


@pytest.fixture(autouse=True)
async def _clean_band(db_session: AsyncSession):
    """Drop band users and anything we hung off them, around every test."""

    async def _drain() -> None:
        band = select(User.id).where(
            User.telegram_id.between(BAND_MIN, BAND_MAX)
        )
        ids = list((await db_session.execute(band)).scalars().all())
        if ids:
            await db_session.execute(
                delete(ChatThread).where(ChatThread.client_user_id.in_(ids))
            )
            await db_session.execute(
                delete(DiaryEvent).where(DiaryEvent.user_id.in_(ids))
            )
            await db_session.commit()
        await cleanup_range(db_session, BAND_MIN, BAND_MAX)
        await db_session.commit()

    await _drain()
    yield
    await _drain()


async def _make_master(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int
) -> dict:
    """A verified master, built directly: the apply/verify flow is another
    suite's subject and would only add coupling here."""
    auth = await login_user(
        client, telegram_id=telegram_id, first_name="Master",
    )
    user_id = UUID(auth["user"]["id"])
    db_session.add(
        MasterProfile(
            user_id=user_id,
            data={"account": {"status": "verified"}},
        )
    )
    await db_session.execute(
        select(User).where(User.id == user_id)
    )
    user = await db_session.get(User, user_id)
    user.role = UserRole.MASTER.value
    await db_session.commit()
    return auth


async def _diary_rows(
    db_session: AsyncSession, user_id: UUID
) -> list[DiaryEvent]:
    rows = await db_session.execute(
        select(DiaryEvent).where(
            DiaryEvent.user_id == user_id,
            DiaryEvent.kind == DiaryEventKind.THREAD_STARTED.value,
        )
    )
    return list(rows.scalars().all())


# ---------------------------------------------------------------------------
# Opening a chat
# ---------------------------------------------------------------------------


class TestOpenChat:
    async def test_open_stamps_actor_and_records_the_diary_echo(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        student = await login_user(
            client, telegram_id=BAND_MIN, first_name="Student",
        )
        master = await _make_master(client, db_session, BAND_MIN + 1)

        fake = AsyncMock(return_value=_thread_payload(created=True))
        monkeypatch.setattr(_SEAM, fake)

        resp = await client.post(
            CHATS_URL,
            json={"master_id": master["user"]["id"]},
            headers=auth_headers(student["session_token"]),
        )
        assert resp.status_code == 200

        # The actor comms receives is the SESSION user, whatever else exists.
        body = fake.await_args.kwargs["json"]
        assert body["client"] == student["user"]["id"]
        assert body["operator_value"] == master["user"]["id"]
        assert body["operator_kind"] == "user"
        assert body["kind"] == "dm"
        # An eternal DM: no subject ref, so comms dedups on the pair.
        assert "subject_type" not in body

        # `created` is a seam detail and does not leak to the frontend.
        assert "created" not in resp.json()

        # Local pointer written -- this is what later authorizes the thread.
        pointer = (
            await fresh_execute(
                select(ChatThread).where(
                    ChatThread.comms_thread_id == UUID(THREAD_ID)
                )
            )
        ).scalar_one()
        assert str(pointer.client_user_id) == student["user"]["id"]
        assert str(pointer.operator_user_id) == master["user"]["id"]

        # The diary echo: student's timeline, thread's own instant.
        events = await _diary_rows(db_session, UUID(student["user"]["id"]))
        assert len(events) == 1
        assert events[0].occurred_at == datetime.fromisoformat(
            THREAD_CREATED_AT
        )
        assert events[0].source_id == UUID(THREAD_ID)
        assert events[0].snapshot["master_id"] == master["user"]["id"]

        # And nothing lands in the master's diary (ID-5: the diary is the
        # student's personal space).
        assert await _diary_rows(db_session, UUID(master["user"]["id"])) == []

    async def test_reopening_adds_nothing(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """The dedup hit: same thread, and exactly one of everything."""
        student = await login_user(
            client, telegram_id=BAND_MIN + 2, first_name="Student",
        )
        master = await _make_master(client, db_session, BAND_MIN + 3)
        headers = auth_headers(student["session_token"])

        monkeypatch.setattr(
            _SEAM, AsyncMock(return_value=_thread_payload(created=True))
        )
        await client.post(
            CHATS_URL, json={"master_id": master["user"]["id"]}, headers=headers,
        )
        monkeypatch.setattr(
            _SEAM, AsyncMock(return_value=_thread_payload(created=False))
        )
        second = await client.post(
            CHATS_URL, json={"master_id": master["user"]["id"]}, headers=headers,
        )

        assert second.status_code == 200
        assert second.json()["id"] == THREAD_ID
        assert len(await _diary_rows(db_session, UUID(student["user"]["id"]))) == 1
        pointers = (
            await db_session.execute(
                select(ChatThread).where(
                    ChatThread.comms_thread_id == UUID(THREAD_ID)
                )
            )
        ).scalars().all()
        assert len(pointers) == 1

    async def test_lost_first_response_is_healed_on_the_next_open(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """The reason the projection is upsert-if-absent and not
        write-on-created: comms says `true` exactly once in a thread's life.
        If that response never landed here, the retry sees `false` -- and the
        row must still appear, or the fact is lost forever."""
        student = await login_user(
            client, telegram_id=BAND_MIN + 4, first_name="Student",
        )
        master = await _make_master(client, db_session, BAND_MIN + 5)
        headers = auth_headers(student["session_token"])

        monkeypatch.setattr(
            _SEAM, AsyncMock(return_value=_thread_payload(created=True))
        )
        await client.post(
            CHATS_URL, json={"master_id": master["user"]["id"]}, headers=headers,
        )
        # Simulate the loss: the thread exists in comms, our echo does not.
        await db_session.execute(
            delete(DiaryEvent).where(
                DiaryEvent.user_id == UUID(student["user"]["id"])
            )
        )
        await db_session.commit()

        monkeypatch.setattr(
            _SEAM, AsyncMock(return_value=_thread_payload(created=False))
        )
        await client.post(
            CHATS_URL, json={"master_id": master["user"]["id"]}, headers=headers,
        )

        events = await _diary_rows(db_session, UUID(student["user"]["id"]))
        assert len(events) == 1
        # Healed late, but placed where the conversation actually started.
        assert events[0].occurred_at == datetime.fromisoformat(
            THREAD_CREATED_AT
        )

    async def test_unverified_master_is_not_reachable(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        student = await login_user(
            client, telegram_id=BAND_MIN + 6, first_name="Student",
        )
        stranger = await login_user(
            client, telegram_id=BAND_MIN + 7, first_name="NotAMaster",
        )
        fake = AsyncMock(return_value=_thread_payload())
        monkeypatch.setattr(_SEAM, fake)

        resp = await client.post(
            CHATS_URL,
            json={"master_id": stranger["user"]["id"]},
            headers=auth_headers(student["session_token"]),
        )
        assert resp.status_code == 404
        fake.assert_not_awaited()

    async def test_cannot_open_a_chat_with_yourself(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        master = await _make_master(client, db_session, BAND_MIN + 8)
        fake = AsyncMock(return_value=_thread_payload())
        monkeypatch.setattr(_SEAM, fake)

        resp = await client.post(
            CHATS_URL,
            json={"master_id": master["user"]["id"]},
            headers=auth_headers(master["session_token"]),
        )
        assert resp.status_code == 400
        fake.assert_not_awaited()

    async def test_actor_in_the_query_is_refused(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """Refused, not ignored: a silent drop hides the attempt."""
        student = await login_user(
            client, telegram_id=BAND_MIN + 9, first_name="Student",
        )
        master = await _make_master(client, db_session, BAND_MIN + 10)
        fake = AsyncMock(return_value=_thread_payload())
        monkeypatch.setattr(_SEAM, fake)

        for query in ("client", "sender", "participant", "is_supervisor"):
            resp = await client.post(
                f"{CHATS_URL}?{query}={uuid4()}",
                json={"master_id": master["user"]["id"]},
                headers=auth_headers(student["session_token"]),
            )
            assert resp.status_code == 400, query
        fake.assert_not_awaited()


# ---------------------------------------------------------------------------
# Membership -- the check comms cannot make for us
# ---------------------------------------------------------------------------


class TestRepointing:
    """comms can be rebuilt underneath us -- the test contour's projection
    resync truncates recipients CASCADE, and threads go with it. The next
    create-or-get then returns a NEW thread id for the SAME pair. Keyed by
    thread id, that would insert a second row for the pair, violate
    uq_chat_threads_pair and 500 forever."""

    async def test_a_recreated_thread_repoints_the_existing_pointer(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        student = await login_user(
            client, telegram_id=BAND_MIN + 28, first_name="Student",
        )
        master = await _make_master(client, db_session, BAND_MIN + 29)
        headers = auth_headers(student["session_token"])

        monkeypatch.setattr(
            _SEAM, AsyncMock(return_value=_thread_payload(created=True))
        )
        await client.post(
            CHATS_URL, json={"master_id": master["user"]["id"]}, headers=headers,
        )

        # comms was wiped and rebuilt: same two people, new thread id.
        new_id = "bbbbbbbb-8972-4000-8000-000000000002"
        monkeypatch.setattr(
            _SEAM,
            AsyncMock(
                return_value=_thread_payload(created=True, thread_id=new_id)
            ),
        )
        resp = await client.post(
            CHATS_URL, json={"master_id": master["user"]["id"]}, headers=headers,
        )

        assert resp.status_code == 200
        assert resp.json()["id"] == new_id

        pointers = (
            await fresh_execute(
                select(ChatThread).where(
                    ChatThread.client_user_id == UUID(student["user"]["id"])
                )
            )
        ).scalars().all()
        assert len(pointers) == 1
        assert pointers[0].comms_thread_id == UUID(new_id)

        # The conversation did not start twice: one card, on the original
        # instant. A second one would claim something that never happened.
        events = await _diary_rows(db_session, UUID(student["user"]["id"]))
        assert len(events) == 1
        assert events[0].source_id == UUID(THREAD_ID)

    async def test_the_repointed_thread_is_usable(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """Membership must follow the new id -- otherwise the chat is
        authorized against a thread that no longer exists."""
        student = await login_user(
            client, telegram_id=BAND_MIN + 30, first_name="Student",
        )
        master = await _make_master(client, db_session, BAND_MIN + 31)
        headers = auth_headers(student["session_token"])
        new_id = "bbbbbbbb-8972-4000-8000-000000000003"

        monkeypatch.setattr(
            _SEAM, AsyncMock(return_value=_thread_payload(created=True))
        )
        await client.post(
            CHATS_URL, json={"master_id": master["user"]["id"]}, headers=headers,
        )
        monkeypatch.setattr(
            _SEAM,
            AsyncMock(
                return_value=_thread_payload(created=True, thread_id=new_id)
            ),
        )
        await client.post(
            CHATS_URL, json={"master_id": master["user"]["id"]}, headers=headers,
        )

        fake = AsyncMock(return_value={"id": str(uuid4())})
        monkeypatch.setattr(_SEAM, fake)
        posted = await client.post(
            f"{CHATS_URL}/{new_id}/messages",
            json={"body": "still here"},
            headers=headers,
        )
        stale = await client.post(
            f"{CHATS_URL}/{THREAD_ID}/messages",
            json={"body": "gone"},
            headers=headers,
        )

        assert posted.status_code == 200
        # The old id is nobody's thread any more.
        assert stale.status_code == 404


class TestConcurrentFirstOpen:
    """C-1: two requests open the same chat at once. Both find no pointer,
    both insert, and the loser hit uq_chat_threads_pair -> 500. A double tap
    on the button is enough to reach it."""

    async def test_the_losing_insert_is_absorbed(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        student = await login_user(
            client, telegram_id=BAND_MIN + 32, first_name="Student",
        )
        master = await _make_master(client, db_session, BAND_MIN + 33)
        factory = get_session_factory()

        # Stand in for the race WINNER: its row is already committed by the
        # time this request tries to insert its own -- exactly what the loser
        # sees. Deterministic, unlike firing two live requests and hoping.
        async with factory() as other:
            other.add(
                ChatThread(
                    comms_thread_id=uuid4(),
                    client_user_id=UUID(student["user"]["id"]),
                    operator_user_id=UUID(master["user"]["id"]),
                )
            )
            await other.commit()

        payload = _thread_payload(created=False)
        monkeypatch.setattr(_SEAM, AsyncMock(return_value=payload))

        resp = await client.post(
            CHATS_URL,
            json={"master_id": master["user"]["id"]},
            headers=auth_headers(student["session_token"]),
        )

        # No 500: the loser finds the winner's row instead of dying on it.
        assert resp.status_code == 200

        async with factory() as check:
            rows = (
                await check.execute(
                    select(ChatThread).where(
                        ChatThread.client_user_id
                        == UUID(student["user"]["id"])
                    )
                )
            ).scalars().all()
        assert len(rows) == 1


class TestMembership:
    async def _chat(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch, base: int
    ) -> tuple[dict, dict]:
        student = await login_user(
            client, telegram_id=base, first_name="Student",
        )
        master = await _make_master(client, db_session, base + 1)
        monkeypatch.setattr(
            _SEAM, AsyncMock(return_value=_thread_payload(created=True))
        )
        await client.post(
            CHATS_URL,
            json={"master_id": master["user"]["id"]},
            headers=auth_headers(student["session_token"]),
        )
        return student, master

    async def test_participants_may_post_and_the_sender_is_stamped(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        student, master = await self._chat(
            client, db_session, monkeypatch, BAND_MIN + 12,
        )
        fake = AsyncMock(return_value={"id": str(uuid4())})
        monkeypatch.setattr(_SEAM, fake)

        for actor in (student, master):
            resp = await client.post(
                f"{CHATS_URL}/{THREAD_ID}/messages",
                json={"body": "hello"},
                headers=auth_headers(actor["session_token"]),
            )
            assert resp.status_code == 200
            assert (
                fake.await_args.kwargs["json"]["sender"] == actor["user"]["id"]
            )

    async def test_a_stranger_gets_404_not_403(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        await self._chat(client, db_session, monkeypatch, BAND_MIN + 14)
        outsider = await login_user(
            client, telegram_id=BAND_MIN + 16, first_name="Outsider",
        )
        fake = AsyncMock(return_value={})
        monkeypatch.setattr(_SEAM, fake)
        headers = auth_headers(outsider["session_token"])

        posted = await client.post(
            f"{CHATS_URL}/{THREAD_ID}/messages",
            json={"body": "let me in"},
            headers=headers,
        )
        listed = await client.get(
            f"{CHATS_URL}/{THREAD_ID}/messages", headers=headers,
        )
        read = await client.post(f"{CHATS_URL}/{THREAD_ID}/read", headers=headers)
        unread = await client.get(
            f"{CHATS_URL}/{THREAD_ID}/unread-count", headers=headers,
        )

        assert [r.status_code for r in (posted, listed, read, unread)] == [
            404, 404, 404, 404,
        ]
        # Nothing reached comms: the refusal happens before the seam.
        fake.assert_not_awaited()

    async def test_unknown_thread_is_404(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        student = await login_user(
            client, telegram_id=BAND_MIN + 17, first_name="Student",
        )
        monkeypatch.setattr(_SEAM, AsyncMock(return_value={}))
        resp = await client.get(
            f"{CHATS_URL}/{uuid4()}/messages",
            headers=auth_headers(student["session_token"]),
        )
        assert resp.status_code == 404

    async def test_read_and_unread_stamp_the_caller(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        student, _ = await self._chat(
            client, db_session, monkeypatch, BAND_MIN + 18,
        )
        fake = AsyncMock(return_value={"unread": 0})
        monkeypatch.setattr(_SEAM, fake)
        headers = auth_headers(student["session_token"])

        await client.post(f"{CHATS_URL}/{THREAD_ID}/read", headers=headers)
        assert (
            fake.await_args.kwargs["json"]["participant"]
            == student["user"]["id"]
        )
        await client.get(
            f"{CHATS_URL}/{THREAD_ID}/unread-count", headers=headers,
        )
        assert (
            fake.await_args.kwargs["params"]["participant"]
            == student["user"]["id"]
        )


# ---------------------------------------------------------------------------
# Listing -- two different lists, because comms only knows one
# ---------------------------------------------------------------------------


class TestListing:
    async def test_master_list_comes_from_comms_without_supervisor(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        master = await _make_master(client, db_session, BAND_MIN + 20)
        fake = AsyncMock(return_value={"threads": [], "next_cursor": None})
        monkeypatch.setattr(_SEAM, fake)

        resp = await client.get(
            CHATS_URL, headers=auth_headers(master["session_token"]),
        )
        assert resp.status_code == 200
        params = fake.await_args.kwargs["params"]
        assert params["operator"] == master["user"]["id"]
        assert params["is_supervisor"] is False

    async def test_admin_no_longer_gets_the_widened_read(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """T3 REVERSAL of this suite's original assertion.

        This test used to assert `is_supervisor is True` for an admin. It
        was asserting a privacy exposure: the flag widened the comms read
        to EVERY conversation on the installation, each row enriched with
        the counterparty's real name and avatar -- and every one of those
        threads 404'd the moment the admin opened it, because
        _require_participant never honoured the widening. The listing and
        the membership check disagreed, and the listing was the loose one.

        An admin's list is now local and equals what they can open (their
        own threads, on either side of the pair); the widening is gone,
        not narrowed. The populated form is tested in
        test_chats_t3_students.py. Here we pin the thing this file can say
        alone: an admin with no threads gets an empty list and the comms
        seam is never touched at all.
        """
        admin = await login_user(
            client, telegram_id=BAND_MIN + 21, first_name="Admin",
        )
        user = await db_session.get(User, UUID(admin["user"]["id"]))
        user.role = UserRole.ADMIN.value
        await db_session.commit()
        admin = await login_user(
            client, telegram_id=BAND_MIN + 21, first_name="Admin",
        )

        fake = AsyncMock(return_value={"threads": ["EVERY THREAD ON THE BOX"]})
        monkeypatch.setattr(_SEAM, fake)
        resp = await client.get(
            CHATS_URL, headers=auth_headers(admin["session_token"]),
        )

        assert resp.status_code == 200
        assert resp.json() == {"threads": [], "next_cursor": None}
        fake.assert_not_awaited()

    async def test_student_list_is_local_and_touches_no_comms(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """A client is invisible to the operator-scoped comms API, so their
        own list can only come from the local pointers."""
        student = await login_user(
            client, telegram_id=BAND_MIN + 22, first_name="Student",
        )
        master = await _make_master(client, db_session, BAND_MIN + 23)
        headers = auth_headers(student["session_token"])
        monkeypatch.setattr(
            _SEAM, AsyncMock(return_value=_thread_payload(created=True))
        )
        await client.post(
            CHATS_URL, json={"master_id": master["user"]["id"]}, headers=headers,
        )

        fake = AsyncMock(return_value={"threads": ["SHOULD NOT BE USED"]})
        monkeypatch.setattr(_SEAM, fake)
        resp = await client.get(CHATS_URL, headers=headers)

        assert resp.status_code == 200
        threads = resp.json()["threads"]
        assert [t["id"] for t in threads] == [THREAD_ID]
        assert threads[0]["operator_value"] == master["user"]["id"]
        fake.assert_not_awaited()


# ---------------------------------------------------------------------------
# Body shape
# ---------------------------------------------------------------------------


class TestBodies:
    async def test_unknown_body_keys_are_rejected(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """extra=forbid is the other half of actor stamping: a `sender` in
        the BODY must not slip past either."""
        student = await login_user(
            client, telegram_id=BAND_MIN + 24, first_name="Student",
        )
        master = await _make_master(client, db_session, BAND_MIN + 25)
        monkeypatch.setattr(
            _SEAM, AsyncMock(return_value=_thread_payload(created=True))
        )
        headers = auth_headers(student["session_token"])
        await client.post(
            CHATS_URL, json={"master_id": master["user"]["id"]}, headers=headers,
        )

        resp = await client.post(
            f"{CHATS_URL}/{THREAD_ID}/messages",
            json={"body": "hi", "sender": str(uuid4())},
            headers=headers,
        )
        assert resp.status_code == 422

    async def test_empty_message_is_rejected(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        student = await login_user(
            client, telegram_id=BAND_MIN + 26, first_name="Student",
        )
        master = await _make_master(client, db_session, BAND_MIN + 27)
        monkeypatch.setattr(
            _SEAM, AsyncMock(return_value=_thread_payload(created=True))
        )
        headers = auth_headers(student["session_token"])
        await client.post(
            CHATS_URL, json={"master_id": master["user"]["id"]}, headers=headers,
        )

        resp = await client.post(
            f"{CHATS_URL}/{THREAD_ID}/messages",
            json={"body": ""},
            headers=headers,
        )
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Peer enrichment (P-1)
# ---------------------------------------------------------------------------
#
# The chat is a pre-sale channel, so a master's counterparty may be nobody's
# student -- /masters/me/students/{id} 404s for them, and comms only knows a
# bare uuid. The proxy therefore stamps a `peer` display block (name +
# avatar) from velo's own users onto every list row and onto the open
# response. Negative twin per the T1-review methodology: the guard (an
# unresolvable client id) yields peer=null without breaking the row, AND the
# adjacent legitimate rows still arrive enriched in the same response.


class TestPeerEnrichment:
    async def test_open_response_carries_the_masters_peer_block(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        student = await login_user(
            client, telegram_id=BAND_MIN + 34, first_name="Student",
        )
        master = await _make_master(client, db_session, BAND_MIN + 35)
        monkeypatch.setattr(
            _SEAM, AsyncMock(return_value=_thread_payload(created=True))
        )

        resp = await client.post(
            CHATS_URL,
            json={"master_id": master["user"]["id"]},
            headers=auth_headers(student["session_token"]),
        )

        assert resp.status_code == 200
        peer = resp.json()["peer"]
        assert peer["user_id"] == master["user"]["id"]
        # login_user creates first_name-only users; the name convention is
        # get_master_full_name's ("First Last" from Telegram fields).
        assert peer["name"] == "Master"
        assert "avatar_url" in peer
        # The seam detail stays a seam detail even with the block added.
        assert "created" not in resp.json()

    async def test_student_list_names_the_masters_without_comms(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        student = await login_user(
            client, telegram_id=BAND_MIN + 36, first_name="Student",
        )
        master = await _make_master(client, db_session, BAND_MIN + 37)
        headers = auth_headers(student["session_token"])
        monkeypatch.setattr(
            _SEAM, AsyncMock(return_value=_thread_payload(created=True))
        )
        await client.post(
            CHATS_URL, json={"master_id": master["user"]["id"]}, headers=headers,
        )

        fake = AsyncMock(return_value={"threads": ["SHOULD NOT BE USED"]})
        monkeypatch.setattr(_SEAM, fake)
        resp = await client.get(CHATS_URL, headers=headers)

        assert resp.status_code == 200
        (thread,) = resp.json()["threads"]
        assert thread["peer"]["user_id"] == master["user"]["id"]
        assert thread["peer"]["name"] == "Master"
        # Enrichment is local knowledge (ID-11 pointer + users): the
        # student's list still never touches comms.
        fake.assert_not_awaited()

    async def test_master_list_is_enriched_and_a_stray_client_survives(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """Both halves in one response: a resolvable client arrives named,
        an unresolvable one (comms knows a uuid velo does not) degrades to
        peer=null instead of failing the whole page."""
        student = await login_user(
            client, telegram_id=BAND_MIN + 38, first_name="Student",
        )
        master = await _make_master(client, db_session, BAND_MIN + 39)

        known = _thread_payload()
        known["client"] = student["user"]["id"]
        stray = _thread_payload(
            thread_id="bbbbbbbb-8972-4000-8000-00000000feed"
        )
        stray["client"] = str(uuid4())  # no such velo user
        fake = AsyncMock(
            return_value={"threads": [known, stray], "next_cursor": None}
        )
        monkeypatch.setattr(_SEAM, fake)

        resp = await client.get(
            CHATS_URL, headers=auth_headers(master["session_token"]),
        )

        assert resp.status_code == 200
        threads = resp.json()["threads"]
        assert threads[0]["peer"]["user_id"] == student["user"]["id"]
        assert threads[0]["peer"]["name"] == "Student"
        assert threads[1]["peer"] is None
