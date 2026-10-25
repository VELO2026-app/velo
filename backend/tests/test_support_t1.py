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
#   3. OPENING SIGNALS NOBODY (BE-172) -- the admin signal belongs to a
#      message (support.message_received, test_support_message_signal.py);
#      an open, first or repeated, with a topic or without, emits none.
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

from datetime import UTC, datetime
from unittest.mock import AsyncMock
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

import app.modules.support.service as support_service
from app.core.config import settings
from app.core.events.models import OutboxEvent
from app.modules.support.models import SupportThread, SupportTicket
from app.modules.users.models import User
from tests.helpers import auth_headers, full_cleanup_range, login_user

BAND_MIN, BAND_MAX = 89870, 89899
_COMMS_SEAM = "app.modules.support.service.comms_request"

SUPPORT_URL = "/api/v1/support/threads"

SECTION_ID = "aaaaaaaa-5ec7-4000-8000-000000000001"
THREAD_ID = "aaaaaaaa-7412-4000-8000-000000000001"
THREAD_CREATED_AT = "2026-08-14T10:00:00+00:00"



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



@pytest.fixture(autouse=True)
async def _clean_band(db_session: AsyncSession):
    """Drop band users (and, via CASCADE, their support_threads rows) plus
    anything else full_cleanup_range knows about; reset the in-process
    section cache so it does not leak across tests or test FILES in the
    same process.

    OutboxEvent rows for a GROUP-targeted emit (target_value="admins", not
    a user id) are invisible to full_cleanup_range's user-scoped subqueries
    -- the same shape master.application_received already uses. Every
    support message these tests send emits support.message_received to
    group:admins (BE-172); deleted here by TYPE directly, the same
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
                OutboxEvent.payload["type"].astext
                == support_service.MESSAGE_RECEIVED_TYPE
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


# TestOpenSupportThread, TestSendMessage and TestAdminListing lived here
# until BE-162 removed what they tested: the one eternal thread opened by
# POST /support/threads, the topic prefixed onto the message text, and the
# admin list read from comms with is_supervisor=True. What of them still
# holds -- the section resolved once, the recipient never from the wire,
# admin-only access, no actor override, the opener's identity -- is held on
# the ticket routes in tests/test_support_tickets_be162.py.


async def _seed_support_thread(
    db_session: AsyncSession, *, client_user_id: UUID, comms_thread_id: UUID,
) -> None:
    """Insert a local support thread directly, as a TICKET -- the
    section/DM boundary these tests exercise only needs the rows to exist,
    not the full create_ticket flow that would normally write them. A
    ticket since BE-162: a pointer without one is a person's history,
    read-only for admins (claim and reply are 409 there)."""
    pointer = SupportThread(
        comms_thread_id=comms_thread_id, client_user_id=client_user_id,
    )
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
        """The admin feed of a known support thread: one read, in the support
        language, the student's message caught up.

        ONE read because the student reads the support language -- and that
        is SET HERE, not assumed of the environment. It used to be assumed:
        a fresh user reads the default language, `en`, as does
        SUPPORT_LANGUAGE by default. On the stand the owner set
        SUPPORT_LANGUAGE=ru on 24.10 for the live check of BE-166; the
        student became a reader of another language, the feed read the
        page a second time in `en` (get_admin_support_messages), and
        `await_args` -- the LAST call -- carried that second locale (BE-163
        fix).
        """
        admin = await _make_admin(client, db_session, BAND_MIN + 17)
        student = await login_user(
            client, telegram_id=BAND_MIN + 18, first_name="Cleo",
        )
        student_row = await db_session.get(User, UUID(student["user"]["id"]))
        student_row.language = settings.support_language
        await db_session.commit()
        thread_id = uuid4()
        # client_user_id is a real FK -> users.id; a bare uuid4() would 500.
        await _seed_support_thread(
            db_session,
            client_user_id=UUID(student["user"]["id"]),
            comms_thread_id=thread_id,
        )

        # comms 3.0.0's feed page. This used to be {"messages": [...]} and
        # the test asserted the response EQUAL to it -- true while the
        # proxy forwarded comms' body; 3.0.0 renamed the key to `items`, the
        # forwarded body lost the key the frontend reads, and every support
        # thread opened empty. The proxy now builds velo's own
        # {"messages", "next_cursor"} from the page it read.
        rows = [
            {
                "id": str(uuid4()), "thread_id": str(thread_id),
                "sender": student["user"]["id"], "body": "[Тема] Помогите",
                "created_at": THREAD_CREATED_AT,
            },
        ]
        feed = {"items": rows, "next_cursor": None}
        fake = AsyncMock(return_value=feed)
        monkeypatch.setattr(_COMMS_SEAM, fake)

        resp = await client.get(
            f"{SUPPORT_URL}/{thread_id}/messages",
            headers=auth_headers(admin["session_token"]),
        )
        assert resp.status_code == 200
        # BE-166: the page is read in the support language, and the
        # student's message -- with no translation job yet -- is caught up:
        # queued, so `preparing`; `body` stays the original until comms
        # has its variant, which is also `original` (admins only). Before
        # BE-166 this asserted the rows unchanged, and was right: nothing
        # was translated.
        assert resp.json() == {
            "messages": [
                {
                    **rows[0],
                    "original": rows[0]["body"],
                    "translation": {
                        "locale": settings.support_language,
                        "state": "preparing",
                        "source_locale": None,
                        "retryable": False,
                    },
                },
            ],
            "next_cursor": None,
        }
        assert fake.await_args.args[:2] == (
            "GET", f"/api/v1/threads/{thread_id}/messages",
        )
        assert fake.await_count == 1
        assert fake.await_args.kwargs["params"]["locale"] == settings.support_language


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
