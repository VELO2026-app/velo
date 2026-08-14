# =============================================================================
# VELO -- support proxy (B34, T-38)
# =============================================================================
# Band 89850-89859.
#
# What is under test:
#   1. LAZY SECTION RESOLUTION -- resolved via comms exactly once per
#      process (module-level cache), never persisted anywhere of ours.
#   2. THREAD CREATION -- one eternal thread per user (operator_kind=
#      "section", kind="dm"), local pointer written, `created` stripped
#      from the response.
#   3. THE ADMIN SIGNAL -- fires exactly once, on the call that actually
#      creates the comms thread; a reopen emits nothing new.
#   4. THE ADMIN LISTING -- is_supervisor/operator are never client-
#      controllable (not bound as request params at all), and the
#      response is scoped to SECTION threads even when comms' own page
#      also carries DM (operator_kind="user") traffic.
#
# comms is cut at two seams -- app.modules.support.service.comms_request
# (section resolution + thread creation) and
# app.modules.support.router.comms_request (the admin listing) -- no
# comms stack needed, same idiom as test_chats_t2.py / test_chats_t3_students.py.
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

BAND_MIN, BAND_MAX = 89850, 89859
_SECTION_SEAM = "app.modules.support.service.comms_request"
_LIST_SEAM = "app.modules.support.router.comms_request"

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
        await db_session.execute(
            delete(OutboxEvent).where(
                OutboxEvent.payload["type"].astext == "support.thread_created"
            )
        )
        await full_cleanup_range(
            db_session, BAND_MIN, BAND_MAX, delete_users=True,
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
        monkeypatch.setattr(_SECTION_SEAM, fake)

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
            _SECTION_SEAM,
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
            _SECTION_SEAM,
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

        monkeypatch.setattr(_SECTION_SEAM, AsyncMock(side_effect=_dispatch))

        await client.post(SUPPORT_URL, headers=auth_headers(alice["session_token"]))
        await client.post(SUPPORT_URL, headers=auth_headers(bob["session_token"]))

        assert len(section_calls) == 1


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
        monkeypatch.setattr(_LIST_SEAM, fake)

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
            _LIST_SEAM, AsyncMock(return_value=all_dm_page),
        )

        resp = await client.get(SUPPORT_URL, headers=headers)
        assert resp.status_code == 200
        assert resp.json()["threads"] == []
        assert resp.json()["next_cursor"] is None
