# =============================================================================
# VELO -- support proxy (B34, T-38)
# =============================================================================
# Band 89870-89899 (widened PROMPT №713, see below).
#
# ⚠ NOT 89850-89859 as originally picked (PROMPT №711): the merge that landed
# the teammate's T-35 work brought in test_zoom_public_link.py, which claims
# 89840-89859 (own file, see its _TID_MIN/_TID_MAX) -- a genuine NEW collision
# with both this file's old band AND test_master_groups.py's PROMPT №710
# relocation (89840-89849), neither of which existed when either side picked
# its numbers. Re-scanned backend/tests/*.py fresh under PROMPT №712 (script,
# not memory): 89860-89897 came back with zero literal hits (89898 is a stale
# comment reference inside test_master_groups.py, read and discounted, not a
# real id). Took 89870-89889 for headroom; left 89860-89869 free.
#
# ⚠ WIDENED to 89870-89899 (PROMPT №713): re-scanned fresh again (per-id, per
# matched LINE, comment hits discounted by reading them, not by pattern) --
# 89890-89899 came back with zero literal hits anywhere in backend/tests/,
# only comment mentions (test_master_groups.py:133, test_comms_t1.py:5,
# test_student_entitlement_t20.py:8). Adjacent to this file's own existing
# band, so widened in place rather than opening a second disjoint pair.
# test_master_groups.py's own 89840-89849 vs test_zoom_public_link.py's
# 89840-89859 collision is STILL a separate, unrequested fix, still reported
# not touched (minimal scope, unchanged from №712).
#
# What is under test:
#   1. LAZY SECTION RESOLUTION -- resolved via comms exactly once per
#      process (module-level cache), never persisted anywhere of ours.
#   2. THREAD CREATION -- one eternal thread per user (operator_kind=
#      "section", kind="dm"), local pointer written, `created` stripped
#      from the response, topic reaches comms' own `title` (PROMPT №713).
#   3. THE ADMIN SIGNAL -- fires exactly once, on the call that actually
#      creates the comms thread; a reopen emits nothing new.
#   4. THE ADMIN LISTING -- is_supervisor/operator are never client-
#      controllable (not bound as request params at all), the response is
#      scoped to SECTION threads even when comms' own page also carries DM
#      (operator_kind="user") traffic, and (PROMPT №713) each row carries
#      the opener's resolved display identity.
#   5. THE SECTION/DM BOUNDARY ON THE NEW ADMIN ROUTES (PROMPT №713) --
#      /messages (GET+POST) and /claim 404 on a thread id with no local
#      support_threads row (i.e. a DM), never leaking whether it exists.
#   6. WRITE-AUTHZ IS COMMS', NOT OURS -- an admin who has not claimed gets
#      comms' own 403 back on a reply, forwarded rather than swallowed.
#
# comms is cut at ONE seam -- app.modules.support.service.comms_request.
# PROMPT №713 moved the admin listing's comms call into service.py too (it
# used to live in router.py, its own separate seam) -- every support
# endpoint now proxies through service.py, so one patched name covers
# section resolution, thread creation, the admin list, the feed, replies,
# and claim. No comms stack needed, same idiom as test_chats_t2.py /
# test_chats_t3_students.py.
# =============================================================================

from unittest.mock import AsyncMock
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

import app.modules.support.service as support_service
from app.core.events.models import OutboxEvent
from app.modules.support.models import SupportThread
from app.modules.users.models import User
from tests.helpers import auth_headers, fresh_execute, full_cleanup_range, login_user

BAND_MIN, BAND_MAX = 89870, 89899
_COMMS_SEAM = "app.modules.support.service.comms_request"

SUPPORT_URL = "/api/v1/support/threads"

SECTION_ID = "aaaaaaaa-5ec7-4000-8000-000000000001"
THREAD_ID = "aaaaaaaa-7412-4000-8000-000000000001"
THREAD_CREATED_AT = "2026-08-14T10:00:00+00:00"


def _section_payload(section_id: str = SECTION_ID) -> dict:
    return {
        "id": section_id,
        "key": "support",
        "label": "Support",
        "created_at": THREAD_CREATED_AT,
    }


def _thread_payload(
    *,
    created: bool = True,
    thread_id: str = THREAD_ID,
    operator_kind: str = "section",
    operator_value: str = SECTION_ID,
    client: str | None = None,
) -> dict:
    return {
        "id": thread_id,
        "client": client or str(uuid4()),
        "operator_kind": operator_kind,
        "operator_value": operator_value,
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


def _creation_seam(
    section_payload: dict, thread_payload: dict,
) -> AsyncMock:
    """One mock covering both comms calls the creation path makes,
    dispatched on the path -- mirrors how the real comms_request is a
    single function serving every endpoint."""

    async def _dispatch(method: str, path: str, **kwargs) -> dict:
        if path == "/api/v1/sections":
            return section_payload
        if path == "/api/v1/threads":
            return thread_payload
        raise AssertionError(f"unexpected comms path in test: {path}")

    return AsyncMock(side_effect=_dispatch)


@pytest.fixture(autouse=True)
async def _clean_band(db_session: AsyncSession):
    """Drop band users (and, via CASCADE, their support_threads rows) plus
    anything else full_cleanup_range knows about; reset the in-process
    section cache so it does not leak across tests or test FILES in the
    same process.

    OutboxEvent rows for a GROUP-targeted emit (target_value="admins", not
    a user id) are invisible to full_cleanup_range's user-scoped subqueries
    -- the same shape master.application_received already uses and which
    is untested elsewhere. Deleted here by TYPE directly, the same
    precaution test_chats_t2.py takes for chat_threads (a table
    full_cleanup_range also does not enumerate)."""

    async def _drain() -> None:
        # ORDER IS LOAD-BEARING AND IT WAS WRONG UNTIL THE 2026-08-14 DEPLOY.
        # full_cleanup_range OPENS WITH `await session.rollback()` -- a
        # deliberate guard, documented at helpers.py's H-R2 -- so ANY
        # uncommitted work queued before it is discarded, not just a second
        # cleanup call. The outbox delete used to sit above it and was
        # silently thrown away every time; the rows then accumulated across
        # the class until an assertion expecting 1 found 6. Nothing local
        # could catch it: the backend gate only runs on deploy.
        # full_cleanup_range FIRST, then our own delete, then ONE commit.
        await full_cleanup_range(
            db_session, BAND_MIN, BAND_MAX, delete_users=True,
        )
        # Group-targeted rows (target_value="admins") carry no user id, so
        # full_cleanup_range's user-scoped subqueries cannot see them.
        await db_session.execute(
            delete(OutboxEvent).where(
                OutboxEvent.payload["type"].astext == "support.thread_created"
            )
        )
        await db_session.commit()

    support_service._support_section_id = None
    await _drain()
    yield
    await _drain()
    support_service._support_section_id = None


async def _make_admin(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int,
) -> dict:
    auth = await login_user(client, telegram_id=telegram_id, first_name="Admin")
    user = await db_session.get(User, UUID(auth["user"]["id"]))
    user.role = "admin"
    await db_session.commit()
    return auth


# ---------------------------------------------------------------------------
# Section resolution + thread creation
# ---------------------------------------------------------------------------


class TestOpenSupportThread:
    async def test_open_creates_section_thread_local_pointer_and_signal(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch,
    ) -> None:
        student = await login_user(
            client, telegram_id=BAND_MIN, first_name="Student",
        )
        fake = _creation_seam(
            _section_payload(),
            _thread_payload(created=True, client=student["user"]["id"]),
        )
        monkeypatch.setattr(_COMMS_SEAM, fake)

        resp = await client.post(
            SUPPORT_URL, headers=auth_headers(student["session_token"]),
        )
        assert resp.status_code == 200

        # The section call happened first, and the resolved id -- not a
        # constant, not an env value -- is what the thread call carries.
        calls = fake.await_args_list
        assert calls[0].args[:2] == ("POST", "/api/v1/sections")
        assert calls[0].kwargs["json"] == {"key": "support", "label": "Support"}
        assert calls[1].args[:2] == ("POST", "/api/v1/threads")
        thread_body = calls[1].kwargs["json"]
        assert thread_body["client"] == student["user"]["id"]
        assert thread_body["operator_kind"] == "section"
        assert thread_body["operator_value"] == SECTION_ID
        assert thread_body["kind"] == "dm"
        assert "subject_type" not in thread_body

        # `created` is a seam detail, stripped before the frontend sees it.
        assert "created" not in resp.json()
        assert resp.json()["id"] == THREAD_ID

        # Local pointer: one row, this user, this comms thread.
        pointer = (
            await fresh_execute(
                select(SupportThread).where(
                    SupportThread.client_user_id == UUID(student["user"]["id"])
                )
            )
        ).scalar_one()
        assert str(pointer.comms_thread_id) == THREAD_ID

        # THE ADMIN SIGNAL: one outbox row, categoryless type, group:admins.
        rows = (
            await fresh_execute(
                select(OutboxEvent).where(
                    OutboxEvent.payload["type"].astext
                    == "support.thread_created"
                )
            )
        ).scalars().all()
        assert len(rows) == 1
        payload = rows[0].payload
        assert payload["target_type"] == "group"
        assert payload["target_value"] == "admins"
        assert payload["action_data"]["params"]["user_id"] == student["user"]["id"]

    async def test_reopen_returns_same_thread_and_emits_nothing_new(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch,
    ) -> None:
        student = await login_user(
            client, telegram_id=BAND_MIN + 1, first_name="Student",
        )
        headers = auth_headers(student["session_token"])

        monkeypatch.setattr(
            _COMMS_SEAM,
            _creation_seam(
                _section_payload(),
                _thread_payload(created=True, client=student["user"]["id"]),
            ),
        )
        first = await client.post(SUPPORT_URL, headers=headers)
        assert first.status_code == 200

        # Second call: comms reports a DEDUP HIT (created=False) -- the
        # real behaviour a repeat open would see.
        monkeypatch.setattr(
            _COMMS_SEAM,
            _creation_seam(
                _section_payload(),
                _thread_payload(created=False, client=student["user"]["id"]),
            ),
        )
        second = await client.post(SUPPORT_URL, headers=headers)
        assert second.status_code == 200
        assert second.json()["id"] == first.json()["id"]

        # Still exactly one local pointer, and no second signal.
        pointers = (
            await fresh_execute(
                select(SupportThread).where(
                    SupportThread.client_user_id == UUID(student["user"]["id"])
                )
            )
        ).scalars().all()
        assert len(pointers) == 1

        rows = (
            await fresh_execute(
                select(OutboxEvent).where(
                    OutboxEvent.payload["type"].astext
                    == "support.thread_created"
                )
            )
        ).scalars().all()
        assert len(rows) == 1

    async def test_section_id_resolved_once_across_two_opens(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch,
    ) -> None:
        """The in-process cache: two different users opening support in
        the same process must hit POST /api/v1/sections only ONCE."""
        alice = await login_user(
            client, telegram_id=BAND_MIN + 2, first_name="Alice",
        )
        bob = await login_user(
            client, telegram_id=BAND_MIN + 3, first_name="Bob",
        )

        section_calls: list[str] = []

        async def _dispatch(method: str, path: str, **kwargs) -> dict:
            if path == "/api/v1/sections":
                section_calls.append(path)
                return _section_payload()
            if path == "/api/v1/threads":
                client_id = kwargs["json"]["client"]
                return _thread_payload(
                    created=True,
                    thread_id=str(uuid4()),
                    client=client_id,
                )
            raise AssertionError(f"unexpected comms path: {path}")

        monkeypatch.setattr(_COMMS_SEAM, AsyncMock(side_effect=_dispatch))

        await client.post(SUPPORT_URL, headers=auth_headers(alice["session_token"]))
        await client.post(SUPPORT_URL, headers=auth_headers(bob["session_token"]))

        assert len(section_calls) == 1

    async def test_topic_enriches_the_creation_notification(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch,
    ) -> None:
        """PROMPT №712: the topic must survive into something an operator
        can see -- the immediate half is the notification text itself."""
        student = await login_user(
            client, telegram_id=BAND_MIN + 8, first_name="Student",
        )
        monkeypatch.setattr(
            _COMMS_SEAM,
            _creation_seam(
                _section_payload(),
                _thread_payload(created=True, client=student["user"]["id"]),
            ),
        )

        resp = await client.post(
            SUPPORT_URL,
            json={"topic": "Жалоба на мастера"},
            headers=auth_headers(student["session_token"]),
        )
        assert resp.status_code == 200

        row = (
            await fresh_execute(
                select(OutboxEvent).where(
                    OutboxEvent.payload["type"].astext
                    == "support.thread_created"
                )
            )
        ).scalar_one()
        assert "Жалоба на мастера" in row.payload["body"]
        assert row.payload["action_data"]["topic"] == "Жалоба на мастера"

    async def test_topic_is_optional_and_reopen_never_reenriches(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch,
    ) -> None:
        """No topic on open -> no crash, no topic clause; and a reopen
        (created=False) with a DIFFERENT topic must not emit a second,
        re-enriched notification -- the gate is `created`, not the
        presence of a topic."""
        student = await login_user(
            client, telegram_id=BAND_MIN + 9, first_name="Student",
        )
        headers = auth_headers(student["session_token"])

        monkeypatch.setattr(
            _COMMS_SEAM,
            _creation_seam(
                _section_payload(),
                _thread_payload(created=True, client=student["user"]["id"]),
            ),
        )
        first = await client.post(SUPPORT_URL, headers=headers)
        assert first.status_code == 200

        monkeypatch.setattr(
            _COMMS_SEAM,
            _creation_seam(
                _section_payload(),
                _thread_payload(created=False, client=student["user"]["id"]),
            ),
        )
        second = await client.post(
            SUPPORT_URL,
            json={"topic": "Другое"},
            headers=headers,
        )
        assert second.status_code == 200

        rows = (
            await fresh_execute(
                select(OutboxEvent).where(
                    OutboxEvent.payload["type"].astext
                    == "support.thread_created"
                )
            )
        ).scalars().all()
        assert len(rows) == 1
        assert "Другое" not in rows[0].payload["body"]


# ---------------------------------------------------------------------------
# Sending a message
# ---------------------------------------------------------------------------


class TestSendMessage:
    async def test_prefixes_topic_and_delivers_to_the_open_thread(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch,
    ) -> None:
        student = await login_user(
            client, telegram_id=BAND_MIN + 10, first_name="Student",
        )
        headers = auth_headers(student["session_token"])

        monkeypatch.setattr(
            _COMMS_SEAM,
            _creation_seam(
                _section_payload(),
                _thread_payload(created=True, client=student["user"]["id"]),
            ),
        )
        opened = await client.post(SUPPORT_URL, headers=headers)
        assert opened.status_code == 200

        fake_message = AsyncMock(
            return_value={
                "id": str(uuid4()),
                "thread_id": THREAD_ID,
                "sender": student["user"]["id"],
                "body": "[Технический вопрос] It won't load",
                "created_at": THREAD_CREATED_AT,
            }
        )
        monkeypatch.setattr(_COMMS_SEAM, fake_message)

        resp = await client.post(
            f"{SUPPORT_URL}/messages",
            json={"topic": "Технический вопрос", "body": "It won't load"},
            headers=headers,
        )
        assert resp.status_code == 200

        call = fake_message.await_args
        assert call.args[:2] == ("POST", f"/api/v1/threads/{THREAD_ID}/messages")
        assert call.kwargs["json"]["sender"] == student["user"]["id"]
        assert call.kwargs["json"]["body"] == "[Технический вопрос] It won't load"

    async def test_without_an_open_thread_is_404(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        student = await login_user(
            client, telegram_id=BAND_MIN + 11, first_name="Student",
        )
        resp = await client.post(
            f"{SUPPORT_URL}/messages",
            json={"body": "Hello?"},
            headers=auth_headers(student["session_token"]),
        )
        assert resp.status_code == 404

    async def test_no_topic_sends_the_body_unprefixed(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch,
    ) -> None:
        student = await login_user(
            client, telegram_id=BAND_MIN + 12, first_name="Student",
        )
        headers = auth_headers(student["session_token"])

        monkeypatch.setattr(
            _COMMS_SEAM,
            _creation_seam(
                _section_payload(),
                _thread_payload(created=True, client=student["user"]["id"]),
            ),
        )
        await client.post(SUPPORT_URL, headers=headers)

        fake_message = AsyncMock(
            return_value={
                "id": str(uuid4()),
                "thread_id": THREAD_ID,
                "sender": student["user"]["id"],
                "body": "just a question",
                "created_at": THREAD_CREATED_AT,
            }
        )
        monkeypatch.setattr(_COMMS_SEAM, fake_message)

        await client.post(
            f"{SUPPORT_URL}/messages",
            json={"body": "just a question"},
            headers=headers,
        )
        assert fake_message.await_args.kwargs["json"]["body"] == "just a question"


# ---------------------------------------------------------------------------
# Admin listing
# ---------------------------------------------------------------------------


class TestAdminListing:
    async def test_requires_admin_role(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        student = await login_user(
            client, telegram_id=BAND_MIN + 4, first_name="Student",
        )
        resp = await client.get(
            SUPPORT_URL, headers=auth_headers(student["session_token"]),
        )
        assert resp.status_code == 403

    async def test_is_supervisor_and_operator_are_never_accepted_from_client(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        """A client-supplied is_supervisor/operator must be REJECTED, not
        silently ignored -- silence would hide the attempt (chats/router.py's
        own rationale for _reject_actor_override, mirrored here)."""
        admin = await _make_admin(client, db_session, BAND_MIN + 5)
        headers = auth_headers(admin["session_token"])

        resp = await client.get(
            f"{SUPPORT_URL}?is_supervisor=false&operator={uuid4()}",
            headers=headers,
        )
        assert resp.status_code == 400

    async def test_scopes_to_section_threads_and_forces_supervisor(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch,
    ) -> None:
        admin = await _make_admin(client, db_session, BAND_MIN + 6)
        headers = auth_headers(admin["session_token"])

        mixed_page = {
            "threads": [
                _thread_payload(
                    thread_id=str(uuid4()),
                    operator_kind="user",
                    operator_value=str(uuid4()),
                ),
                _thread_payload(
                    thread_id=THREAD_ID,
                    operator_kind="section",
                    operator_value=SECTION_ID,
                ),
            ],
            "next_cursor": "opaque-cursor-value",
        }
        fake = AsyncMock(return_value=mixed_page)
        monkeypatch.setattr(_COMMS_SEAM, fake)

        resp = await client.get(SUPPORT_URL, headers=headers)
        assert resp.status_code == 200

        params = fake.await_args.kwargs["params"]
        assert params["is_supervisor"] is True
        assert params["operator"] == admin["user"]["id"]

        body = resp.json()
        # The DM thread never reaches an admin through this door.
        assert len(body["threads"]) == 1
        assert body["threads"][0]["id"] == THREAD_ID
        assert body["threads"][0]["operator_kind"] == "section"
        # next_cursor forwarded verbatim -- filtering never touches paging.
        assert body["next_cursor"] == "opaque-cursor-value"

    async def test_empty_page_after_filtering_stays_a_valid_response(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch,
    ) -> None:
        """An all-DM page must not error just because nothing survives
        the section filter -- it is a legitimately empty page, not a
        fault."""
        admin = await _make_admin(client, db_session, BAND_MIN + 7)
        headers = auth_headers(admin["session_token"])

        all_dm_page = {
            "threads": [
                _thread_payload(
                    thread_id=str(uuid4()), operator_kind="user",
                    operator_value=str(uuid4()),
                ),
            ],
            "next_cursor": None,
        }
        monkeypatch.setattr(
            _COMMS_SEAM, AsyncMock(return_value=all_dm_page),
        )

        resp = await client.get(SUPPORT_URL, headers=headers)
        assert resp.status_code == 200
        assert resp.json()["threads"] == []
        assert resp.json()["next_cursor"] is None

    async def test_list_attaches_the_opener_identity_and_the_topic_title(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch,
    ) -> None:
        """PROMPT №713: 'who' and 'the topic' on the list -- opener is a
        real user, resolved in bulk (P-1); the topic rides comms' own
        `title` field, set at creation (service.py::open_support_thread)."""
        admin = await _make_admin(client, db_session, BAND_MIN + 13)
        student = await login_user(
            client, telegram_id=BAND_MIN + 14, first_name="Dana",
            username="dana",
        )
        headers = auth_headers(admin["session_token"])

        page = {
            "threads": [
                _thread_payload(
                    thread_id=THREAD_ID,
                    client=student["user"]["id"],
                )
                | {"title": "Жалоба на мастера"},
            ],
            "next_cursor": None,
        }
        monkeypatch.setattr(_COMMS_SEAM, AsyncMock(return_value=page))

        resp = await client.get(SUPPORT_URL, headers=headers)
        assert resp.status_code == 200

        row = resp.json()["threads"][0]
        assert row["title"] == "Жалоба на мастера"
        assert row["opener"]["user_id"] == student["user"]["id"]
        assert row["opener"]["name"] == "Dana"

    async def test_list_opener_is_null_for_an_unresolvable_client(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch,
    ) -> None:
        """A client id with no matching User degrades to opener=null --
        never an exception that would take the whole list down."""
        admin = await _make_admin(client, db_session, BAND_MIN + 15)
        headers = auth_headers(admin["session_token"])

        page = {
            "threads": [
                _thread_payload(thread_id=THREAD_ID, client=str(uuid4())),
            ],
            "next_cursor": None,
        }
        monkeypatch.setattr(_COMMS_SEAM, AsyncMock(return_value=page))

        resp = await client.get(SUPPORT_URL, headers=headers)
        assert resp.status_code == 200
        assert resp.json()["threads"][0]["opener"] is None


# ---------------------------------------------------------------------------
# The admin thread screen: feed, reply, claim
# ---------------------------------------------------------------------------


async def _seed_support_thread(
    db_session: AsyncSession, *, client_user_id: UUID, comms_thread_id: UUID,
) -> None:
    """Insert a local support_threads pointer directly -- the section/DM
    boundary these tests exercise only needs the ROW to exist, not the
    full open_support_thread flow that would normally write it."""
    db_session.add(
        SupportThread(
            comms_thread_id=comms_thread_id, client_user_id=client_user_id,
        )
    )
    await db_session.commit()


class TestAdminThreadMessages:
    async def test_get_messages_404s_for_a_thread_id_with_no_local_pointer(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        """The section/DM boundary: an id comms would happily serve (it
        could be a real DM thread) 404s here because it is not in
        support_threads -- existence must not leak, so this is a plain
        404, not a 403."""
        admin = await _make_admin(client, db_session, BAND_MIN + 16)
        headers = auth_headers(admin["session_token"])

        resp = await client.get(
            f"{SUPPORT_URL}/{uuid4()}/messages", headers=headers,
        )
        assert resp.status_code == 404

    async def test_get_messages_proxies_the_feed_for_a_known_support_thread(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch,
    ) -> None:
        admin = await _make_admin(client, db_session, BAND_MIN + 17)
        student = await login_user(
            client, telegram_id=BAND_MIN + 18, first_name="Cleo",
        )
        thread_id = uuid4()
        # client_user_id is a real FK -> users.id; a bare uuid4() would 500.
        await _seed_support_thread(
            db_session,
            client_user_id=UUID(student["user"]["id"]),
            comms_thread_id=thread_id,
        )

        feed = {
            "messages": [
                {
                    "id": str(uuid4()), "thread_id": str(thread_id),
                    "sender": student["user"]["id"], "body": "[Тема] Помогите",
                    "created_at": THREAD_CREATED_AT,
                },
            ],
            "next_cursor": None,
        }
        fake = AsyncMock(return_value=feed)
        monkeypatch.setattr(_COMMS_SEAM, fake)

        resp = await client.get(
            f"{SUPPORT_URL}/{thread_id}/messages",
            headers=auth_headers(admin["session_token"]),
        )
        assert resp.status_code == 200
        assert resp.json() == feed
        assert fake.await_args.args[:2] == (
            "GET", f"/api/v1/threads/{thread_id}/messages",
        )


class TestAdminReply:
    async def test_reply_forwards_comms_403_when_not_claimed(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch,
    ) -> None:
        """Comms' own write-authz, not ours -- surfaced, not swallowed."""
        admin = await _make_admin(client, db_session, BAND_MIN + 19)
        student = await login_user(
            client, telegram_id=BAND_MIN + 20, first_name="Erin",
        )
        thread_id = uuid4()
        await _seed_support_thread(
            db_session,
            client_user_id=UUID(student["user"]["id"]),
            comms_thread_id=thread_id,
        )

        from fastapi import HTTPException

        async def _dispatch(method, path, **kwargs):
            if path == f"/api/v1/threads/{thread_id}/messages":
                assert kwargs.get("forward_403") is True
                raise HTTPException(
                    status_code=403,
                    detail="actor is not the serving operator of this thread",
                )
            raise AssertionError(f"unexpected path: {path}")

        monkeypatch.setattr(_COMMS_SEAM, AsyncMock(side_effect=_dispatch))

        resp = await client.post(
            f"{SUPPORT_URL}/{thread_id}/messages",
            json={"body": "Здравствуйте"},
            headers=auth_headers(admin["session_token"]),
        )
        assert resp.status_code == 403

    async def test_reply_succeeds_and_stamps_the_admin_as_sender(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch,
    ) -> None:
        admin = await _make_admin(client, db_session, BAND_MIN + 21)
        student = await login_user(
            client, telegram_id=BAND_MIN + 22, first_name="Farah",
        )
        thread_id = uuid4()
        await _seed_support_thread(
            db_session,
            client_user_id=UUID(student["user"]["id"]),
            comms_thread_id=thread_id,
        )

        sent = {
            "id": str(uuid4()), "thread_id": str(thread_id),
            "sender": admin["user"]["id"], "body": "Здравствуйте",
            "created_at": THREAD_CREATED_AT,
        }
        fake = AsyncMock(return_value=sent)
        monkeypatch.setattr(_COMMS_SEAM, fake)

        resp = await client.post(
            f"{SUPPORT_URL}/{thread_id}/messages",
            json={"body": "Здравствуйте"},
            headers=auth_headers(admin["session_token"]),
        )
        assert resp.status_code == 200
        assert resp.json() == sent
        assert fake.await_args.kwargs["json"]["sender"] == admin["user"]["id"]
        assert fake.await_args.kwargs["json"]["body"] == "Здравствуйте"


class TestClaimThread:
    async def test_claim_stamps_the_admin_as_operator(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch,
    ) -> None:
        admin = await _make_admin(client, db_session, BAND_MIN + 23)
        student = await login_user(
            client, telegram_id=BAND_MIN + 24, first_name="Gale",
        )
        thread_id = uuid4()
        await _seed_support_thread(
            db_session,
            client_user_id=UUID(student["user"]["id"]),
            comms_thread_id=thread_id,
        )

        claimed = {"claimed": True, "thread": _thread_payload(
            thread_id=str(thread_id), client=student["user"]["id"],
        ) | {"assignee": admin["user"]["id"]}}
        fake = AsyncMock(return_value=claimed)
        monkeypatch.setattr(_COMMS_SEAM, fake)

        resp = await client.post(
            f"{SUPPORT_URL}/{thread_id}/claim", headers=auth_headers(admin["session_token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["claimed"] is True
        assert fake.await_args.args[:2] == (
            "POST", f"/api/v1/threads/{thread_id}/claim",
        )
        assert fake.await_args.kwargs["json"] == {"operator": admin["user"]["id"]}

    async def test_claim_404s_for_a_thread_id_with_no_local_pointer(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        admin = await _make_admin(client, db_session, BAND_MIN + 25)
        resp = await client.post(
            f"{SUPPORT_URL}/{uuid4()}/claim",
            headers=auth_headers(admin["session_token"]),
        )
        assert resp.status_code == 404
