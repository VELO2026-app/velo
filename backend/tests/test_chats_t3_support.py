# =============================================================================
# VELO -- support threads, the admin boundary, master-initiated chats (T3)
# =============================================================================
# Band 89760-89799.
#
# THREE THINGS ARE UNDER TEST, and each one exists because its opposite was
# shipped once:
#
#   1. SUPPORT THREADS. A support conversation is an ordinary comms DM whose
#      operator is the designated support ACCOUNT (a real velo user named by
#      settings.support_operator_user_id). Unset -> 503 with the fix in the
#      message, never a 500 and never a silent 404. No diary card is written:
#      DiaryEventKind.THREAD_STARTED means "a conversation with a MASTER
#      began" and lives in the practice diary -- a support request is not an
#      event in anybody's practice.
#
#   2. THE ADMIN BOUNDARY, which is the whole point of the widening and the
#      half that is easy to lose. An admin passes membership on a SUPPORT
#      thread (the account is the desk, the admins are the staff) and on
#      NOTHING else: an ordinary master <-> client thread still 404s for
#      them, exactly as it does for any stranger. Both halves are asserted
#      in the same test so neither can be deleted without the other failing.
#
#   3. MASTER-INITIATED CHATS. The pair is DIRECTED and the direction is a
#      product rule, not a record of who tapped first: student = client,
#      master = operator, whoever pressed the button. That is what makes the
#      two directions find ONE thread, ONE pointer row (uq_chat_threads_pair)
#      and ONE diary card instead of manufacturing a mirror conversation.
#
# comms is cut at the same seam this module's T2 suite uses
# (app.modules.chats.router.comms_request) -- no comms stack needed.
# =============================================================================

from unittest.mock import AsyncMock
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.modules.chats.models import ChatThread
from app.modules.diary.models import DiaryEvent, DiaryEventKind
from app.modules.masters.models import MasterProfile
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, cleanup_range, fresh_execute, login_user

BAND_MIN, BAND_MAX = 89760, 89799
_SEAM = "app.modules.chats.router.comms_request"

CHATS_URL = "/api/v1/chats"
SUPPORT_URL = f"{CHATS_URL}/support"
STUDENTS_URL = f"{CHATS_URL}/students"

THREAD_ID = "cccccccc-8976-4000-8000-000000000001"
OTHER_THREAD_ID = "cccccccc-8976-4000-8000-000000000002"
THIRD_THREAD_ID = "cccccccc-8976-4000-8000-000000000003"
THREAD_CREATED_AT = "2026-08-02T09:15:00+00:00"


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
    """Drop band users and anything we hung off them, around every test.

    Deletes chat_threads on EITHER side of the pair, unlike the T2 fixture:
    a support thread's operator and a master-initiated thread's operator are
    both band users, and a client-only sweep would leave those rows behind
    to collide with uq_chat_threads_pair on the next run.
    """

    async def _drain() -> None:
        band = select(User.id).where(
            User.telegram_id.between(BAND_MIN, BAND_MAX)
        )
        ids = list((await db_session.execute(band)).scalars().all())
        if ids:
            await db_session.execute(
                delete(ChatThread).where(
                    or_(
                        ChatThread.client_user_id.in_(ids),
                        ChatThread.operator_user_id.in_(ids),
                    )
                )
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
    """A verified master, built directly (same shortcut as the T2 suite)."""
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
    user = await db_session.get(User, user_id)
    user.role = UserRole.MASTER.value
    await db_session.commit()
    return auth


async def _make_admin(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int,
    first_name: str = "Admin",
) -> dict:
    """An ADMIN, minted the way the T2 listing test mints one."""
    auth = await login_user(
        client, telegram_id=telegram_id, first_name=first_name,
    )
    user = await db_session.get(User, UUID(auth["user"]["id"]))
    user.role = UserRole.ADMIN.value
    await db_session.commit()
    return await login_user(
        client, telegram_id=telegram_id, first_name=first_name,
    )


def _configure_support(monkeypatch, support: dict) -> None:
    monkeypatch.setattr(
        settings, "support_operator_user_id", support["user"]["id"],
    )


async def _thread_started_rows(
    db_session: AsyncSession, user_id: UUID
) -> list[DiaryEvent]:
    rows = await db_session.execute(
        select(DiaryEvent).where(
            DiaryEvent.user_id == user_id,
            DiaryEvent.kind == DiaryEventKind.THREAD_STARTED.value,
        )
    )
    return list(rows.scalars().all())


async def _open_support(
    client: AsyncClient, monkeypatch, caller: dict, support: dict,
    thread_id: str = THREAD_ID,
) -> None:
    """Open caller's support thread through the real endpoint."""
    _configure_support(monkeypatch, support)
    monkeypatch.setattr(
        _SEAM,
        AsyncMock(return_value=_thread_payload(True, thread_id)),
    )
    resp = await client.post(
        SUPPORT_URL, headers=auth_headers(caller["session_token"]),
    )
    assert resp.status_code == 200, resp.text


# ---------------------------------------------------------------------------
# 1. The support thread
# ---------------------------------------------------------------------------


class TestSupportThread:
    async def test_unset_support_account_is_503_and_never_reaches_comms(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """The actionable-failure requirement: an installation that never
        configured support must say so, not 500 and not pretend the desk
        does not exist."""
        caller = await login_user(
            client, telegram_id=BAND_MIN, first_name="Caller",
        )
        monkeypatch.setattr(settings, "support_operator_user_id", "")
        fake = AsyncMock(return_value=_thread_payload())
        monkeypatch.setattr(_SEAM, fake)

        resp = await client.post(
            SUPPORT_URL, headers=auth_headers(caller["session_token"]),
        )

        assert resp.status_code == 503
        assert resp.json()["error"] == "support_not_configured"
        # The fix is IN the message -- that is the whole difference between
        # this and a bare 503.
        assert "SUPPORT_OPERATOR_USER_ID" in resp.json()["message"]
        fake.assert_not_awaited()

    async def test_a_configured_id_with_no_user_behind_it_is_503(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """comms only knows recipients identity sync shipped it, so a
        support id that is not a velo user would come back as an opaque
        upstream 404. Caught before the call instead."""
        caller = await login_user(
            client, telegram_id=BAND_MIN + 1, first_name="Caller",
        )
        monkeypatch.setattr(
            settings, "support_operator_user_id", str(uuid4()),
        )
        fake = AsyncMock(return_value=_thread_payload())
        monkeypatch.setattr(_SEAM, fake)

        resp = await client.post(
            SUPPORT_URL, headers=auth_headers(caller["session_token"]),
        )

        assert resp.status_code == 503
        assert resp.json()["error"] == "support_not_configured"
        fake.assert_not_awaited()

    async def test_a_malformed_support_id_is_503_not_500(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """A typo in the env var must not surface as an unhandled
        ValueError out of UUID()."""
        caller = await login_user(
            client, telegram_id=BAND_MIN + 2, first_name="Caller",
        )
        monkeypatch.setattr(
            settings, "support_operator_user_id", "not-a-uuid",
        )
        fake = AsyncMock(return_value=_thread_payload())
        monkeypatch.setattr(_SEAM, fake)

        resp = await client.post(
            SUPPORT_URL, headers=auth_headers(caller["session_token"]),
        )

        assert resp.status_code == 503
        assert resp.json()["error"] == "support_not_configured"
        # A typo and a never-configured box need different actions from the
        # operator, so they must not collapse into one opaque 503.
        assert "not a valid UUID" in resp.json()["message"]
        fake.assert_not_awaited()

    async def test_open_stamps_the_caller_as_client_and_the_desk_as_operator(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        caller = await login_user(
            client, telegram_id=BAND_MIN + 3, first_name="Caller",
        )
        support = await login_user(
            client, telegram_id=BAND_MIN + 4, first_name="Support",
        )
        _configure_support(monkeypatch, support)
        fake = AsyncMock(return_value=_thread_payload(created=True))
        monkeypatch.setattr(_SEAM, fake)

        resp = await client.post(
            SUPPORT_URL, headers=auth_headers(caller["session_token"]),
        )

        assert resp.status_code == 200
        # Actor stamping, same discipline as every other route here: the
        # client is the SESSION user and the operator is the CONFIGURED
        # desk -- neither came off the wire.
        body = fake.await_args.kwargs["json"]
        assert body["client"] == caller["user"]["id"]
        assert body["operator_value"] == support["user"]["id"]
        assert body["operator_kind"] == "user"
        assert body["kind"] == "dm"
        assert "subject_type" not in body

        # The seam detail stays a seam detail, and the peer block names
        # the desk.
        assert "created" not in resp.json()
        assert resp.json()["peer"]["user_id"] == support["user"]["id"]
        assert resp.json()["peer"]["name"] == "Support"

        # The local pointer -- the row that will later authorize both the
        # caller and any admin on this thread.
        pointer = (
            await fresh_execute(
                select(ChatThread).where(
                    ChatThread.comms_thread_id == UUID(THREAD_ID)
                )
            )
        ).scalar_one()
        assert str(pointer.client_user_id) == caller["user"]["id"]
        assert str(pointer.operator_user_id) == support["user"]["id"]

    async def test_support_writes_no_diary_card(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """THE DIARY DECISION, pinned. THREAD_STARTED means "a conversation
        with a MASTER began", renders from a master_id/master_name snapshot
        and lives in the practice diary. A support request is an
        operational fact, not an event in the user's practice -- writing
        the card would file the support desk under "your masters"."""
        caller = await login_user(
            client, telegram_id=BAND_MIN + 5, first_name="Caller",
        )
        support = await login_user(
            client, telegram_id=BAND_MIN + 6, first_name="Support",
        )
        await _open_support(client, monkeypatch, caller, support)

        assert await _thread_started_rows(
            db_session, UUID(caller["user"]["id"])
        ) == []
        assert await _thread_started_rows(
            db_session, UUID(support["user"]["id"])
        ) == []

    async def test_reopening_returns_the_same_thread_and_one_pointer(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """Create-or-get, same as the master path: the UI calls this every
        time the support screen opens."""
        caller = await login_user(
            client, telegram_id=BAND_MIN + 7, first_name="Caller",
        )
        support = await login_user(
            client, telegram_id=BAND_MIN + 8, first_name="Support",
        )
        await _open_support(client, monkeypatch, caller, support)

        monkeypatch.setattr(
            _SEAM, AsyncMock(return_value=_thread_payload(created=False))
        )
        second = await client.post(
            SUPPORT_URL, headers=auth_headers(caller["session_token"]),
        )

        assert second.status_code == 200
        assert second.json()["id"] == THREAD_ID
        rows = (
            await fresh_execute(
                select(ChatThread).where(
                    ChatThread.client_user_id == UUID(caller["user"]["id"])
                )
            )
        ).scalars().all()
        assert len(rows) == 1

    async def test_the_desk_cannot_open_support_with_itself(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        support = await login_user(
            client, telegram_id=BAND_MIN + 9, first_name="Support",
        )
        _configure_support(monkeypatch, support)
        fake = AsyncMock(return_value=_thread_payload())
        monkeypatch.setattr(_SEAM, fake)

        resp = await client.post(
            SUPPORT_URL, headers=auth_headers(support["session_token"]),
        )

        assert resp.status_code == 400
        fake.assert_not_awaited()

    async def test_an_actor_in_the_query_is_refused(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """Refused, not ignored -- the new routes inherit the same stance."""
        caller = await login_user(
            client, telegram_id=BAND_MIN + 10, first_name="Caller",
        )
        support = await login_user(
            client, telegram_id=BAND_MIN + 11, first_name="Support",
        )
        _configure_support(monkeypatch, support)
        fake = AsyncMock(return_value=_thread_payload())
        monkeypatch.setattr(_SEAM, fake)

        for query in ("client", "operator", "is_supervisor"):
            resp = await client.post(
                f"{SUPPORT_URL}?{query}={uuid4()}",
                headers=auth_headers(caller["session_token"]),
            )
            assert resp.status_code == 400, query
        fake.assert_not_awaited()

    async def test_the_support_thread_shows_up_in_the_callers_own_list(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """A student's list is local pointers, and the support thread is
        one -- so the conversation is reachable from the chat list rather
        than only from whatever screen opened it."""
        caller = await login_user(
            client, telegram_id=BAND_MIN + 12, first_name="Caller",
        )
        support = await login_user(
            client, telegram_id=BAND_MIN + 13, first_name="Support",
        )
        await _open_support(client, monkeypatch, caller, support)

        fake = AsyncMock(return_value={"threads": ["SHOULD NOT BE USED"]})
        monkeypatch.setattr(_SEAM, fake)
        resp = await client.get(
            CHATS_URL, headers=auth_headers(caller["session_token"]),
        )

        assert resp.status_code == 200
        (thread,) = resp.json()["threads"]
        assert thread["id"] == THREAD_ID
        assert thread["peer"]["user_id"] == support["user"]["id"]
        fake.assert_not_awaited()


# ---------------------------------------------------------------------------
# 2. The admin boundary -- support threads and NOTHING else
# ---------------------------------------------------------------------------


class TestAdminOnSupportThreads:
    async def _two_threads(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch,
        base: int,
    ) -> tuple[dict, dict, dict]:
        """A support thread (THREAD_ID) and an ordinary master <-> client
        thread (OTHER_THREAD_ID). Returns (support, admin, student)."""
        support = await login_user(
            client, telegram_id=base, first_name="Support",
        )
        caller = await login_user(
            client, telegram_id=base + 1, first_name="Caller",
        )
        await _open_support(client, monkeypatch, caller, support)

        student = await login_user(
            client, telegram_id=base + 2, first_name="Student",
        )
        master = await _make_master(client, db_session, base + 3)
        monkeypatch.setattr(
            _SEAM,
            AsyncMock(
                return_value=_thread_payload(True, OTHER_THREAD_ID)
            ),
        )
        opened = await client.post(
            CHATS_URL,
            json={"master_id": master["user"]["id"]},
            headers=auth_headers(student["session_token"]),
        )
        assert opened.status_code == 200, opened.text

        admin = await _make_admin(client, db_session, base + 4)
        _configure_support(monkeypatch, support)
        return support, admin, student

    async def test_admin_acts_on_support_and_is_a_stranger_everywhere_else(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """THE OWNER REQUIREMENT, both halves in one test so neither can
        be dropped: an admin who is in neither thread's id pair passes
        membership on the SUPPORT thread and gets the stranger's 404 on
        the ordinary master <-> client thread."""
        _, admin, _ = await self._two_threads(
            client, db_session, monkeypatch, BAND_MIN + 14,
        )
        headers = auth_headers(admin["session_token"])
        fake = AsyncMock(return_value={"id": str(uuid4()), "unread": 0})
        monkeypatch.setattr(_SEAM, fake)

        posted = await client.post(
            f"{CHATS_URL}/{THREAD_ID}/messages",
            json={"body": "support here"},
            headers=headers,
        )
        listed = await client.get(
            f"{CHATS_URL}/{THREAD_ID}/messages", headers=headers,
        )
        read = await client.post(
            f"{CHATS_URL}/{THREAD_ID}/read", headers=headers,
        )
        unread = await client.get(
            f"{CHATS_URL}/{THREAD_ID}/unread-count", headers=headers,
        )
        assert [r.status_code for r in (posted, listed, read, unread)] == [
            200, 200, 200, 200,
        ]
        # The admin answers AS THEMSELVES -- the widening grants access,
        # it does not let anyone speak as the desk account.
        assert (
            fake.await_args_list[0].kwargs["json"]["sender"]
            == admin["user"]["id"]
        )

        other_posted = await client.post(
            f"{CHATS_URL}/{OTHER_THREAD_ID}/messages",
            json={"body": "let me in"},
            headers=headers,
        )
        other_listed = await client.get(
            f"{CHATS_URL}/{OTHER_THREAD_ID}/messages", headers=headers,
        )
        other_read = await client.post(
            f"{CHATS_URL}/{OTHER_THREAD_ID}/read", headers=headers,
        )
        other_unread = await client.get(
            f"{CHATS_URL}/{OTHER_THREAD_ID}/unread-count", headers=headers,
        )
        assert [
            r.status_code
            for r in (other_posted, other_listed, other_read, other_unread)
        ] == [404, 404, 404, 404]

    async def test_a_non_admin_stranger_still_404s_on_a_support_thread(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """The widening is bound to the ADMIN role, not to "support threads
        are public": a plain user and a master who are not the client both
        stay out."""
        support, _, student = await self._two_threads(
            client, db_session, monkeypatch, BAND_MIN + 19,
        )
        outsider = await login_user(
            client, telegram_id=BAND_MIN + 24, first_name="Outsider",
        )
        master = await _make_master(client, db_session, BAND_MIN + 25)
        _configure_support(monkeypatch, support)
        fake = AsyncMock(return_value={})
        monkeypatch.setattr(_SEAM, fake)

        for actor in (outsider, master, student):
            resp = await client.get(
                f"{CHATS_URL}/{THREAD_ID}/messages",
                headers=auth_headers(actor["session_token"]),
            )
            assert resp.status_code == 404, actor["user"]["id"]
        fake.assert_not_awaited()

    async def test_the_widening_dies_with_the_setting(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """Proves the branch keys on the CONFIGURED id and not on "the
        operator happens to be an admin-ish account": clear the setting and
        the very same admin loses the very same thread."""
        _, admin, _ = await self._two_threads(
            client, db_session, monkeypatch, BAND_MIN + 26,
        )
        headers = auth_headers(admin["session_token"])
        monkeypatch.setattr(_SEAM, AsyncMock(return_value={}))

        monkeypatch.setattr(settings, "support_operator_user_id", "")
        resp = await client.get(
            f"{CHATS_URL}/{THREAD_ID}/messages", headers=headers,
        )
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# 3. The admin list -- exactly what the admin can open, and no more
# ---------------------------------------------------------------------------


class TestAdminList:
    async def test_admin_list_is_own_plus_support_and_never_touches_comms(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """The replacement for is_supervisor=True. Three threads exist; the
        admin is entitled to two of them, and the third -- somebody else's
        master <-> client conversation -- must not appear, name or avatar.

        The strong form of the assertion is the loop at the end: EVERY id
        in the list opens. The old behavior failed exactly there -- it
        listed every thread on the box and 404'd on all of them."""
        support = await login_user(
            client, telegram_id=BAND_MIN + 31, first_name="Support",
        )
        caller = await login_user(
            client, telegram_id=BAND_MIN + 32, first_name="Caller",
        )
        await _open_support(client, monkeypatch, caller, support)

        # Somebody else's conversation -- the leak that must not reappear.
        student = await login_user(
            client, telegram_id=BAND_MIN + 33, first_name="Student",
        )
        stranger_master = await _make_master(
            client, db_session, BAND_MIN + 34,
        )
        monkeypatch.setattr(
            _SEAM,
            AsyncMock(return_value=_thread_payload(True, OTHER_THREAD_ID)),
        )
        await client.post(
            CHATS_URL,
            json={"master_id": stranger_master["user"]["id"]},
            headers=auth_headers(student["session_token"]),
        )

        # The admin's OWN thread: an admin is a person too and may have
        # written to a master.
        admin = await _make_admin(client, db_session, BAND_MIN + 35)
        own_master = await _make_master(client, db_session, BAND_MIN + 36)
        monkeypatch.setattr(
            _SEAM,
            AsyncMock(return_value=_thread_payload(True, THIRD_THREAD_ID)),
        )
        mine = await client.post(
            CHATS_URL,
            json={"master_id": own_master["user"]["id"]},
            headers=auth_headers(admin["session_token"]),
        )
        assert mine.status_code == 200, mine.text

        _configure_support(monkeypatch, support)
        fake = AsyncMock(return_value={"threads": ["EVERY THREAD ON THE BOX"]})
        monkeypatch.setattr(_SEAM, fake)
        resp = await client.get(
            CHATS_URL, headers=auth_headers(admin["session_token"]),
        )

        assert resp.status_code == 200
        threads = resp.json()["threads"]
        ids = {t["id"] for t in threads}
        assert ids == {THREAD_ID, THIRD_THREAD_ID}
        assert OTHER_THREAD_ID not in ids
        # Local, not comms: the operator-scoped API cannot express
        # "mine plus the desk" and is not asked to.
        fake.assert_not_awaited()

        # Peers are viewer-relative: on the support thread the admin needs
        # to see WHO wrote in, not the desk they are staffing.
        by_id = {t["id"]: t for t in threads}
        assert by_id[THREAD_ID]["peer"]["user_id"] == caller["user"]["id"]
        assert by_id[THREAD_ID]["peer"]["name"] == "Caller"
        assert (
            by_id[THIRD_THREAD_ID]["peer"]["user_id"]
            == own_master["user"]["id"]
        )

        # LISTED == OPENABLE. This is the property the old admin list broke.
        monkeypatch.setattr(_SEAM, AsyncMock(return_value={"messages": []}))
        for thread_id in ids:
            opened = await client.get(
                f"{CHATS_URL}/{thread_id}/messages",
                headers=auth_headers(admin["session_token"]),
            )
            assert opened.status_code == 200, thread_id

    async def test_master_list_still_comes_from_comms_unwidened(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """The master branch must not have moved: same call, same params,
        is_supervisor still hard False."""
        master = await _make_master(client, db_session, BAND_MIN + 37)
        fake = AsyncMock(return_value={"threads": [], "next_cursor": None})
        monkeypatch.setattr(_SEAM, fake)

        resp = await client.get(
            CHATS_URL, headers=auth_headers(master["session_token"]),
        )

        assert resp.status_code == 200
        params = fake.await_args.kwargs["params"]
        assert params["operator"] == master["user"]["id"]
        assert params["is_supervisor"] is False


# ---------------------------------------------------------------------------
# 4. Master-initiated chats
# ---------------------------------------------------------------------------


class TestMasterInitiatedChat:
    async def test_master_opens_with_a_student_in_the_storage_direction(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """Roles are the PRODUCT's, not the caller's: the master is the
        operator and the student the client even though the master pressed
        the button -- in the comms payload and in the pointer row alike."""
        master = await _make_master(client, db_session, BAND_MIN + 38)
        student = await login_user(
            client, telegram_id=BAND_MIN + 39, first_name="Student",
        )
        fake = AsyncMock(return_value=_thread_payload(created=True))
        monkeypatch.setattr(_SEAM, fake)

        resp = await client.post(
            STUDENTS_URL,
            json={"student_id": student["user"]["id"]},
            headers=auth_headers(master["session_token"]),
        )

        assert resp.status_code == 200
        body = fake.await_args.kwargs["json"]
        assert body["client"] == student["user"]["id"]
        assert body["operator_value"] == master["user"]["id"]
        assert body["kind"] == "dm"

        pointer = (
            await fresh_execute(
                select(ChatThread).where(
                    ChatThread.comms_thread_id == UUID(THREAD_ID)
                )
            )
        ).scalar_one()
        assert str(pointer.client_user_id) == student["user"]["id"]
        assert str(pointer.operator_user_id) == master["user"]["id"]

        # The counterparty from the CALLER's side is the student.
        assert resp.json()["peer"]["user_id"] == student["user"]["id"]
        assert "created" not in resp.json()

        # The diary card is the student's, and names the master -- same
        # fact, same owner as when the student opens it themselves.
        events = await _thread_started_rows(
            db_session, UUID(student["user"]["id"])
        )
        assert len(events) == 1
        assert events[0].snapshot["master_id"] == master["user"]["id"]
        assert await _thread_started_rows(
            db_session, UUID(master["user"]["id"])
        ) == []

    async def test_both_parties_can_use_the_master_initiated_thread(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """The pointer row is what authorizes the thread, so the student
        must be able to answer a conversation they did not open."""
        master = await _make_master(client, db_session, BAND_MIN + 15)
        student = await login_user(
            client, telegram_id=BAND_MIN + 16, first_name="Student",
        )
        monkeypatch.setattr(
            _SEAM, AsyncMock(return_value=_thread_payload(created=True))
        )
        await client.post(
            STUDENTS_URL,
            json={"student_id": student["user"]["id"]},
            headers=auth_headers(master["session_token"]),
        )

        fake = AsyncMock(return_value={"id": str(uuid4())})
        monkeypatch.setattr(_SEAM, fake)
        for actor in (master, student):
            resp = await client.post(
                f"{CHATS_URL}/{THREAD_ID}/messages",
                json={"body": "hello"},
                headers=auth_headers(actor["session_token"]),
            )
            assert resp.status_code == 200
            assert (
                fake.await_args.kwargs["json"]["sender"] == actor["user"]["id"]
            )

    async def test_student_first_then_master_finds_the_same_thread(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """The dedup claim, in the order that actually happens: the student
        writes first, the master answers from their own screen. ONE thread,
        ONE pointer row (uq_chat_threads_pair), ONE diary card -- because
        both directions key the pair the same way."""
        master = await _make_master(client, db_session, BAND_MIN + 17)
        student = await login_user(
            client, telegram_id=BAND_MIN + 18, first_name="Student",
        )
        monkeypatch.setattr(
            _SEAM, AsyncMock(return_value=_thread_payload(created=True))
        )
        first = await client.post(
            CHATS_URL,
            json={"master_id": master["user"]["id"]},
            headers=auth_headers(student["session_token"]),
        )

        # comms answers create-or-get with the SAME thread, created=False.
        fake = AsyncMock(return_value=_thread_payload(created=False))
        monkeypatch.setattr(_SEAM, fake)
        second = await client.post(
            STUDENTS_URL,
            json={"student_id": student["user"]["id"]},
            headers=auth_headers(master["session_token"]),
        )

        assert first.json()["id"] == second.json()["id"] == THREAD_ID
        # The pair the master's call sent is the pair the student's call
        # sent -- which is WHY comms deduped.
        body = fake.await_args.kwargs["json"]
        assert body["client"] == student["user"]["id"]
        assert body["operator_value"] == master["user"]["id"]

        rows = (
            await fresh_execute(
                select(ChatThread).where(
                    ChatThread.client_user_id == UUID(student["user"]["id"])
                )
            )
        ).scalars().all()
        assert len(rows) == 1
        assert len(
            await _thread_started_rows(
                db_session, UUID(student["user"]["id"])
            )
        ) == 1

    async def test_master_first_then_student_finds_the_same_thread(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """The reverse order, which is the one the new endpoint
        introduces."""
        master = await _make_master(client, db_session, BAND_MIN + 20)
        student = await login_user(
            client, telegram_id=BAND_MIN + 21, first_name="Student",
        )
        monkeypatch.setattr(
            _SEAM, AsyncMock(return_value=_thread_payload(created=True))
        )
        first = await client.post(
            STUDENTS_URL,
            json={"student_id": student["user"]["id"]},
            headers=auth_headers(master["session_token"]),
        )

        monkeypatch.setattr(
            _SEAM, AsyncMock(return_value=_thread_payload(created=False))
        )
        second = await client.post(
            CHATS_URL,
            json={"master_id": master["user"]["id"]},
            headers=auth_headers(student["session_token"]),
        )

        assert first.json()["id"] == second.json()["id"] == THREAD_ID
        rows = (
            await fresh_execute(
                select(ChatThread).where(
                    ChatThread.client_user_id == UUID(student["user"]["id"])
                )
            )
        ).scalars().all()
        assert len(rows) == 1
        assert len(
            await _thread_started_rows(
                db_session, UUID(student["user"]["id"])
            )
        ) == 1

    async def test_a_non_master_cannot_open_a_student_chat(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """Including an admin: the admin's channel is the support desk,
        not the master zone."""
        plain = await login_user(
            client, telegram_id=BAND_MIN + 22, first_name="Plain",
        )
        target = await login_user(
            client, telegram_id=BAND_MIN + 23, first_name="Target",
        )
        admin = await _make_admin(client, db_session, BAND_MIN + 27)
        fake = AsyncMock(return_value=_thread_payload())
        monkeypatch.setattr(_SEAM, fake)

        for actor in (plain, admin):
            resp = await client.post(
                STUDENTS_URL,
                json={"student_id": target["user"]["id"]},
                headers=auth_headers(actor["session_token"]),
            )
            assert resp.status_code == 403, actor["user"]["id"]
        fake.assert_not_awaited()

    async def test_role_master_without_a_verified_profile_is_refused(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """The role column alone is not the authorization: the same
        verified predicate that gates the inbound direction gates this
        outbound one, so a revoked or pending application cannot
        cold-message the user base."""
        pretender = await login_user(
            client, telegram_id=BAND_MIN + 28, first_name="Pretender",
        )
        user = await db_session.get(User, UUID(pretender["user"]["id"]))
        user.role = UserRole.MASTER.value
        await db_session.commit()
        target = await login_user(
            client, telegram_id=BAND_MIN + 29, first_name="Target",
        )
        fake = AsyncMock(return_value=_thread_payload())
        monkeypatch.setattr(_SEAM, fake)

        resp = await client.post(
            STUDENTS_URL,
            json={"student_id": target["user"]["id"]},
            headers=auth_headers(pretender["session_token"]),
        )

        assert resp.status_code == 403
        fake.assert_not_awaited()

    async def test_an_unknown_target_is_404_and_never_reaches_comms(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """comms trusts whatever ids we send it; an id with no velo user
        behind it must die here, not become an opaque upstream error."""
        master = await _make_master(client, db_session, BAND_MIN + 30)
        fake = AsyncMock(return_value=_thread_payload())
        monkeypatch.setattr(_SEAM, fake)

        resp = await client.post(
            STUDENTS_URL,
            json={"student_id": str(uuid4())},
            headers=auth_headers(master["session_token"]),
        )

        assert resp.status_code == 404
        fake.assert_not_awaited()

    async def test_master_cannot_open_a_chat_with_themselves(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        master = await _make_master(client, db_session, BAND_MIN + 34)
        fake = AsyncMock(return_value=_thread_payload())
        monkeypatch.setattr(_SEAM, fake)

        resp = await client.post(
            STUDENTS_URL,
            json={"student_id": master["user"]["id"]},
            headers=auth_headers(master["session_token"]),
        )

        assert resp.status_code == 400
        fake.assert_not_awaited()

    async def test_body_and_query_actor_overrides_are_both_refused(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """extra="forbid" on the body, _reject_actor_override on the query
        -- the new route inherits both halves."""
        master = await _make_master(client, db_session, BAND_MIN + 35)
        student = await login_user(
            client, telegram_id=BAND_MIN + 36, first_name="Student",
        )
        fake = AsyncMock(return_value=_thread_payload())
        monkeypatch.setattr(_SEAM, fake)
        headers = auth_headers(master["session_token"])

        extra = await client.post(
            STUDENTS_URL,
            json={
                "student_id": student["user"]["id"],
                "operator": str(uuid4()),
            },
            headers=headers,
        )
        assert extra.status_code == 422

        for query in ("client", "operator", "is_supervisor"):
            resp = await client.post(
                f"{STUDENTS_URL}?{query}={uuid4()}",
                json={"student_id": student["user"]["id"]},
                headers=headers,
            )
            assert resp.status_code == 400, query
        fake.assert_not_awaited()
