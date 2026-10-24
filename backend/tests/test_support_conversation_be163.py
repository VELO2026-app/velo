# =============================================================================
# VELO -- the support conversation in «Сообщения» (BE-163)
# =============================================================================
# Band 79400-79439.
#
# What is under test, and why each one exists:
#
#   1. WHAT A USER READS OF A SUPPORT THREAD (handoffer section 4): an
#      admin's reply in a language the user does not read never leaves the
#      process -- not in the feed, not in the list preview. The grid is
#      held whole on the pure renderer, then end to end through the routes,
#      where "the original is not in the body" is checked against the WHOLE
#      response text, paired with "what should be there is there".
#
#   2. PRIVACY (BE-87): a person sees only their own support conversation.
#      The support row is admitted only when its id IS the caller's own
#      pointer; another person's support thread -- in the pool, claimed, or
#      handed over by a misbehaving list -- is in nobody's list and opens
#      for nobody (404 before comms is asked anything).
#
#   3. THE ORDER: every list by last message. A master's list is two comms
#      lists, merged by a window into the operator pages, with velo's own
#      cursor -- held across two pages and on a tie in activity.
#
#   4. THE CATCH-UP on the user's feed (BE-166's mechanism): a reply whose
#      job was lost is queued once, in the user's language -- and the race
#      with the admin's feed is built with the harness, which deadlocks
#      against a reversed insert order.
#
# comms is cut at its seams (chats.router / support.service comms_request).
# =============================================================================

from collections.abc import AsyncGenerator
from typing import Any
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID, uuid4

import pytest
from fastapi import HTTPException
from httpx import AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.events.models import OutboxEvent
from app.modules.chats.models import ChatThread
from app.modules.chats.router import _decode_master_cursor
from app.modules.masters.models import MasterProfile
from app.modules.support import translation
from app.modules.support.models import (
    TO_SUPPORT,
    TO_USER,
    SupportThread,
    SupportTranslationJob,
)
from app.modules.support.service import MESSAGE_RECEIVED_TYPE
from app.modules.support.translation import (
    TRANSLATING,
    UNAVAILABLE,
    admin_feed,
    client_feed,
    render_for_client,
)
from app.modules.users.models import User, UserRole
from tests.curator_race_harness import assert_no_deadlock, race
from tests.helpers import auth_headers, full_cleanup_range, login_user

BAND_MIN, BAND_MAX = 79400, 79439

_SEAMS = (
    "app.modules.chats.router.comms_request",
    "app.modules.support.service.comms_request",
)
CHATS_URL = "/api/v1/chats"

# Every comms message id minted here starts with this, so the outbox rows
# of this file's llm jobs can be cleaned by key without touching anyone
# else's.
_MID_PREFIX = "be163be1-"


def _mid() -> str:
    return _MID_PREFIX + str(uuid4())[9:]


# ---------------------------------------------------------------------------
# Fixtures and builders
# ---------------------------------------------------------------------------


async def _clean(session: AsyncSession) -> None:
    await full_cleanup_range(session, BAND_MIN, BAND_MAX, delete_users=True)
    await session.execute(
        delete(OutboxEvent).where(
            OutboxEvent.payload["idempotency_key"].astext.like(
                f"llm-support-tr:{_MID_PREFIX}%"
            )
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
    await session.commit()


@pytest.fixture(autouse=True)
async def _band(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await _clean(db_session)
    yield
    await _clean(db_session)


@pytest.fixture(autouse=True)
def _support_language(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "support_language", "en")


class FakeComms:
    """comms at the two seams, as 3.9.0 answers: the two lists, a feed, a
    send, a read. Records every call; an Idempotency-Key replays."""

    def __init__(self) -> None:
        self.operator_pages: dict[str | None, dict[str, Any]] = {}
        self.client_items: list[Any] = []
        self.client_next: str | None = None
        self.feed: list[Any] = []
        self.calls: list[tuple[str, str, dict, Any]] = []
        self._replay: dict[tuple[str, str, str], Any] = {}

    def lists(self, reader: str) -> list[dict]:
        return [
            c[2]
            for c in self.calls
            if c[0] == "GET" and c[1] == "/api/v1/threads" and reader in c[2]
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
        params = dict(params or {})
        self.calls.append((method, path, params, json))
        if idempotency_key and (method, path, idempotency_key) in self._replay:
            return self._replay[(method, path, idempotency_key)]
        result = self._route(method, path, params, json)
        if idempotency_key:
            self._replay[(method, path, idempotency_key)] = result
        return result

    def _route(self, method: str, path: str, params: dict, body: Any) -> Any:
        if path == "/api/v1/threads" and method == "GET":
            if "client" in params:
                return {"items": self.client_items, "next_cursor": self.client_next}
            return self.operator_pages.get(
                params.get("cursor"),
                {"items": [], "next_cursor": None},
            )
        if path.endswith("/messages") and method == "GET":
            return {"items": self.feed, "next_cursor": None}
        if path.endswith("/messages") and method == "POST":
            return {
                "id": _mid(),
                "thread_id": path.split("/")[4],
                "sender": body["sender"],
                "body": body["body"],
                "created_at": "2026-10-25T10:00:00+00:00",
            }
        if path.endswith("/read"):
            return {"unread": 0}
        if path.endswith("/unread-count"):
            return {"unread": 0}
        raise AssertionError(f"unexpected comms call {method} {path}")


@pytest.fixture
def comms(monkeypatch: pytest.MonkeyPatch) -> FakeComms:
    fake = FakeComms()
    for seam in _SEAMS:
        monkeypatch.setattr(seam, fake)
    return fake


async def _person(
    client: AsyncClient,
    db_session: AsyncSession,
    offset: int,
    *,
    language: str = "ru",
    role: str | None = None,
    name: str = "Person",
) -> dict:
    tid = BAND_MIN + offset
    auth = await login_user(client, telegram_id=tid, first_name=name)
    user = await db_session.get(User, UUID(auth["user"]["id"]))
    user.language = language
    if role == UserRole.MASTER.value:
        db_session.add(
            MasterProfile(
                user_id=user.id,
                data={"account": {"status": "verified"}},
            )
        )
    if role is not None:
        user.role = role
    await db_session.commit()
    if role is not None:
        auth = await login_user(client, telegram_id=tid, first_name=name)
    return auth


async def _support_pointer(db_session: AsyncSession, user_id: str) -> UUID:
    thread_id = uuid4()
    db_session.add(
        SupportThread(comms_thread_id=thread_id, client_user_id=UUID(user_id))
    )
    await db_session.commit()
    return thread_id


async def _dm_pointer(
    db_session: AsyncSession,
    *,
    client_id: str,
    operator_id: str,
) -> UUID:
    thread_id = uuid4()
    db_session.add(
        ChatThread(
            comms_thread_id=thread_id,
            client_user_id=UUID(client_id),
            operator_user_id=UUID(operator_id),
        )
    )
    await db_session.commit()
    return thread_id


def _at(seconds: int) -> str:
    return f"2026-10-20T10:{seconds // 60:02d}:{seconds % 60:02d}+00:00"


def _row(
    thread_id: Any,
    *,
    form: str = "user",
    client: str | None = None,
    operator_value: str | None = None,
    activity: int = 0,
    last_message: Any = None,
    **extra: Any,
) -> dict:
    """One thread as comms 3.9.0 lists it, with the opt-in keys."""
    return {
        "id": str(thread_id),
        "client": client or str(uuid4()),
        "operator_kind": form,
        "operator_value": operator_value or str(uuid4()),
        "assignee": None,
        "kind": "dm",
        "status": "open",
        "subject_type": None,
        "subject_id": None,
        "title": None,
        "priority": None,
        "last_message_at": _at(activity) if activity else None,
        "created_at": _at(0),
        "unread": 0,
        "last_message": last_message,
        **extra,
    }


def _msg(
    sender: str,
    body: str,
    *,
    state: str | None = None,
    variant: str | None = None,
    variant_locale: str = "ru",
    mid: str | None = None,
) -> dict:
    """A message as comms gives it, read with ?locale when `state` is set."""
    out: dict[str, Any] = {
        "id": mid or _mid(),
        "thread_id": str(uuid4()),
        "sender": sender,
        "body": body,
        "created_at": "2026-10-20T10:00:00+00:00",
    }
    if state is not None:
        out["variant_state"] = state
        out["variant"] = (
            {
                "locale": variant_locale,
                "source_locale": "en",
                "body": variant,
                "job_key": "k",
                "answered_provider": "p",
                "answered_model": "m",
                "created_at": "2026-10-20T10:00:01+00:00",
            }
            if variant is not None
            else None
        )
    return out


async def _jobs(db_session: AsyncSession, pointer: UUID) -> list[SupportTranslationJob]:
    """The queue rows of one support thread, read fresh: the routes and the
    race write them in their own sessions."""
    db_session.expire_all()
    return list(
        (
            await db_session.execute(
                select(SupportTranslationJob)
                .join(
                    SupportThread,
                    SupportThread.id == SupportTranslationJob.support_thread_id,
                )
                .where(SupportThread.comms_thread_id == pointer)
            )
        ).scalars()
    )


# ---------------------------------------------------------------------------
# 1. The renderer -- section 4, whole grid
# ---------------------------------------------------------------------------

_ME = str(uuid4())
_ADMIN = str(uuid4())


class TestRenderForClient:
    @pytest.mark.parametrize(
        "message,user_locale,body,state",
        [
            # own message: the original, whatever comms says of it
            (_msg(_ME, "mine", state="not_requested"), "ru", "mine", None),
            (_msg(_ME, "mine", state="impossible"), "ru", "mine", None),
            # the user reads the support language: the original
            (_msg(_ADMIN, "Hello", state="impossible"), None, "Hello", None),
            (_msg(_ADMIN, "Hello"), None, "Hello", None),
            # ready, a body in the user's language: the variant
            (
                _msg(_ADMIN, "Hello", state="ready", variant="Привет"),
                "ru",
                "Привет",
                None,
            ),
            # not_needed: the original is in the user's language already
            (_msg(_ADMIN, "Привет", state="not_needed"), "ru", "Привет", None),
            # a translation on its way: no text
            (_msg(_ADMIN, "Hello", state="preparing"), "ru", None, TRANSLATING),
            (_msg(_ADMIN, "Hello", state="not_requested"), "ru", None, TRANSLATING),
            # there will be none: no text
            (_msg(_ADMIN, "Hello", state="impossible"), "ru", None, UNAVAILABLE),
            # forms nobody promised -- fall to no text, never the original
            (_msg(_ADMIN, "Hello", state="ready"), "ru", None, UNAVAILABLE),
            (
                _msg(_ADMIN, "Hello", state="ready", variant="  "),
                "ru",
                None,
                UNAVAILABLE,
            ),
            (
                _msg(
                    _ADMIN, "Hello", state="ready", variant="Hallo", variant_locale="de"
                ),
                "ru",
                None,
                UNAVAILABLE,
            ),
            (_msg(_ADMIN, "Hello", state="mystery"), "ru", None, UNAVAILABLE),
            (_msg(_ADMIN, "Hello"), "ru", None, UNAVAILABLE),
        ],
    )
    def test_the_grid(
        self,
        message: dict,
        user_locale: str | None,
        body: str | None,
        state: str | None,
    ) -> None:
        out = render_for_client(message, client_id=_ME, user_locale=user_locale)
        assert out is not None
        assert out["body"] == body
        assert out["translation"] == state
        assert out["id"] == message["id"]
        assert out["sender"] == message["sender"]

    def test_only_the_four_fields_and_the_two_ride_out(self) -> None:
        """comms' `variant` carries a body too, and whatever comms adds next
        must not ride out by default -- the item is BUILT, not filtered."""
        message = _msg(_ADMIN, "Hello", state="ready", variant="Привет")
        message["original"] = "SHOULD-NOT-LEAK"
        out = render_for_client(message, client_id=_ME, user_locale="ru")
        assert set(out) == {
            "id",
            "thread_id",
            "sender",
            "created_at",
            "body",
            "translation",
        }
        assert "SHOULD-NOT-LEAK" not in repr(out)
        assert "Hello" not in repr(out)
        assert out["body"] == "Привет"

    @pytest.mark.parametrize("junk", [None, "Hello", 7, ["Hello"]])
    def test_not_a_mapping_is_nothing(self, junk: Any) -> None:
        assert render_for_client(junk, client_id=_ME, user_locale="ru") is None


# ---------------------------------------------------------------------------
# 2. The user's list
# ---------------------------------------------------------------------------


class TestUserList:
    async def test_support_row_and_dm_in_comms_order_preview_by_section_4(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        user = await _person(client, db_session, 0)
        uid = user["user"]["id"]
        master = await _person(
            client,
            db_session,
            1,
            role=UserRole.MASTER.value,
            name="Master",
        )
        support = await _support_pointer(db_session, uid)
        dm = await _dm_pointer(
            db_session,
            client_id=uid,
            operator_id=master["user"]["id"],
        )
        comms.client_items = [
            _row(
                support,
                form="section",
                client=uid,
                activity=50,
                assignee=str(uuid4()),
                title="[Оплата] my topic",
                unread=2,
                last_message=_msg(
                    _ADMIN,
                    "ORIGINAL-ENGLISH",
                    state="ready",
                    variant="Перевод",
                ),
            ),
            _row(
                dm,
                client=uid,
                operator_value=master["user"]["id"],
                activity=30,
                last_message=_msg(
                    master["user"]["id"], "as written", state="not_requested"
                ),
            ),
        ]

        resp = await client.get(CHATS_URL, headers=auth_headers(user["session_token"]))

        assert resp.status_code == 200
        rows = resp.json()["threads"]
        assert [r["id"] for r in rows] == [str(support), str(dm)]
        sup, chat = rows
        assert sup["channel"] == "support" and sup["peer"] is None
        assert sup["unread"] == 2
        assert sup["last_message"]["body"] == "Перевод"
        assert sup["last_message"]["translation"] is None
        # the support row is built: no assignee, no section id, no topic
        assert set(sup) == {
            "id",
            "channel",
            "peer",
            "created_at",
            "last_message_at",
            "last_message",
            "unread",
        }
        # a DM is not translated -- as written, whatever its variant state
        assert chat["channel"] == "chat"
        assert chat["peer"]["user_id"] == master["user"]["id"]
        assert chat["last_message"]["body"] == "as written"
        assert chat["last_message"]["translation"] is None
        assert "variant_state" not in chat["last_message"]
        assert "ORIGINAL-ENGLISH" not in resp.text
        # the read: one client list, the user's language asked for
        (params,) = comms.lists("client")
        assert params["client"] == uid
        assert params["locale"] == "ru"
        assert params["with_last_message"] is True
        assert params["with_unread"] is True
        assert comms.lists("operator") == []

    @pytest.mark.parametrize(
        "state,shown",
        [
            ("preparing", TRANSLATING),
            ("not_requested", TRANSLATING),
            ("impossible", UNAVAILABLE),
        ],
    )
    async def test_a_reply_without_a_translation_is_never_previewed(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
        state: str,
        shown: str,
    ) -> None:
        user = await _person(client, db_session, 2)
        uid = user["user"]["id"]
        support = await _support_pointer(db_session, uid)
        comms.client_items = [
            _row(
                support,
                form="section",
                client=uid,
                activity=10,
                last_message=_msg(_ADMIN, "ORIGINAL-ENGLISH", state=state),
            )
        ]
        resp = await client.get(CHATS_URL, headers=auth_headers(user["session_token"]))
        (row,) = resp.json()["threads"]
        assert row["last_message"]["body"] is None
        assert row["last_message"]["translation"] == shown
        assert "ORIGINAL-ENGLISH" not in resp.text

    async def test_a_user_of_the_support_language_reads_the_original(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        """No locale is asked for, and the reply shows as written."""
        user = await _person(client, db_session, 3, language="en")
        uid = user["user"]["id"]
        support = await _support_pointer(db_session, uid)
        comms.client_items = [
            _row(
                support,
                form="section",
                client=uid,
                activity=10,
                last_message=_msg(_ADMIN, "Hello there"),
            )
        ]
        resp = await client.get(CHATS_URL, headers=auth_headers(user["session_token"]))
        (row,) = resp.json()["threads"]
        assert row["last_message"]["body"] == "Hello there"
        (params,) = comms.lists("client")
        assert "locale" not in params

    async def test_no_support_row_before_the_first_message(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        user = await _person(client, db_session, 4)
        uid = user["user"]["id"]
        master = await _person(client, db_session, 5, role=UserRole.MASTER.value)
        support = await _support_pointer(db_session, uid)
        dm = await _dm_pointer(
            db_session,
            client_id=uid,
            operator_id=master["user"]["id"],
        )
        comms.client_items = [
            _row(support, form="section", client=uid, last_message=None),
            _row(dm, client=uid, operator_value=master["user"]["id"]),
        ]
        resp = await client.get(CHATS_URL, headers=auth_headers(user["session_token"]))
        assert [r["id"] for r in resp.json()["threads"]] == [str(dm)]

    async def test_a_user_who_never_wrote_has_no_support_row(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        """ПУСТОТА: no pointer, nothing listed -- an empty list, not an error."""
        user = await _person(client, db_session, 6)
        resp = await client.get(CHATS_URL, headers=auth_headers(user["session_token"]))
        assert resp.status_code == 200
        assert resp.json() == {"threads": [], "next_cursor": None}

    async def test_nothing_of_anyone_elses_ever_passes(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A list comms ought never to give -- another person's support
        thread, a DM with no pointer of mine, a form nobody knows, a row
        with no form, junk -- passes nothing; the warning counts, never
        names."""
        user = await _person(client, db_session, 7)
        uid = user["user"]["id"]
        other = await _person(client, db_session, 8, name="Zinaida")
        other_support = await _support_pointer(db_session, other["user"]["id"])
        mine = await _support_pointer(db_session, uid)
        keyless = _row(uuid4(), title="keyless-title")
        del keyless["operator_kind"]
        comms.client_items = [
            _row(
                other_support,
                form="section",
                client=other["user"]["id"],
                title="Zinaida-topic",
                activity=40,
                last_message=_msg(other["user"]["id"], "Zinaida-words"),
            ),
            _row(
                uuid4(),
                form="section",
                client=uid,
                title="orphan-topic",
                activity=35,
                last_message=_msg(uid, "orphan-words"),
            ),
            _row(uuid4(), client=uid, title="unpointed-dm", activity=30),
            _row(uuid4(), form="team", title="team-title", activity=20),
            keyless,
            "junk-row",
            _row(
                mine,
                form="section",
                client=uid,
                activity=10,
                last_message=_msg(uid, "my own words"),
            ),
        ]
        log = MagicMock()
        monkeypatch.setattr("app.modules.chats.router.logger", log)

        resp = await client.get(CHATS_URL, headers=auth_headers(user["session_token"]))

        assert [r["id"] for r in resp.json()["threads"]] == [str(mine)]
        assert resp.json()["threads"][0]["last_message"]["body"] == "my own words"
        for leak in (
            "Zinaida",
            str(other_support),
            other["user"]["id"],
            "orphan",
            "unpointed-dm",
            "team-title",
            "keyless-title",
            "junk-row",
        ):
            assert leak not in resp.text, leak
        (warning,) = [
            c
            for c in log.warning.call_args_list
            if c.args[0] == "chat_client_rows_dropped"
        ]
        assert warning.kwargs["dropped"] == {
            "section": 2,
            "user": 1,
            "team": 1,
            "<no operator_kind>": 1,
            "<not a mapping>": 1,
        }
        assert "Zinaida" not in repr(warning)

    async def test_comms_cursor_is_forwarded_both_ways(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        user = await _person(client, db_session, 9)
        comms.client_next = "client-next"
        resp = await client.get(
            CHATS_URL,
            params={"cursor": "client-prev", "limit": 7},
            headers=auth_headers(user["session_token"]),
        )
        assert resp.json()["next_cursor"] == "client-next"
        (params,) = comms.lists("client")
        assert params["cursor"] == "client-prev"
        assert params["limit"] == 7

    async def test_client_from_the_wire_is_refused(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        user = await _person(client, db_session, 10)
        resp = await client.get(
            CHATS_URL,
            params={"client": str(uuid4())},
            headers=auth_headers(user["session_token"]),
        )
        assert resp.status_code == 400
        assert comms.calls == []


# ---------------------------------------------------------------------------
# 3. The master's list -- two lists, one order
# ---------------------------------------------------------------------------


class TestMasterList:
    async def test_own_support_once_and_nobody_elses_in_any_state(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        """ПОВТОР: the master's own UNCLAIMED support thread is in BOTH raw
        lists -- the pool of his operator list, and his client list. It is
        listed once, as the support row: the sentry drops the pool copy.

        Strangers' support threads in every state a master's lists can
        carry them: unclaimed in the pool; claimed by an admin, slipped
        into the client list by a misbehaving comms. Neither passes."""
        master = await _person(
            client,
            db_session,
            11,
            role=UserRole.MASTER.value,
            name="Master",
        )
        mid_ = master["user"]["id"]
        stranger = await _person(client, db_session, 12, name="Zinaida")
        sid = stranger["user"]["id"]
        own = await _support_pointer(db_session, mid_)
        theirs = await _support_pointer(db_session, sid)
        own_raw = _row(
            own,
            form="section",
            client=mid_,
            activity=40,
            last_message=_msg(mid_, "my payout question"),
        )
        comms.operator_pages[None] = {
            "items": [
                own_raw,
                _row(
                    theirs,
                    form="section",
                    client=sid,
                    activity=30,
                    title="Zinaida-topic",
                ),
            ],
            "next_cursor": None,
        }
        comms.client_items = [
            own_raw,
            _row(
                theirs,
                form="section",
                client=sid,
                activity=20,
                assignee=str(uuid4()),
                title="Zinaida-claimed",
                last_message=_msg(sid, "Zinaida-words"),
            ),
        ]

        resp = await client.get(
            CHATS_URL, headers=auth_headers(master["session_token"])
        )

        assert resp.status_code == 200
        rows = resp.json()["threads"]
        assert [(r["id"], r["channel"]) for r in rows] == [(str(own), "support")]
        assert rows[0]["last_message"]["body"] == "my payout question"
        for leak in ("Zinaida", sid, str(theirs)):
            assert leak not in resp.text

    async def test_two_pages_merge_by_last_message_and_nothing_repeats(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        master = await _person(
            client,
            db_session,
            13,
            role=UserRole.MASTER.value,
            name="Master",
        )
        mid_ = master["user"]["id"]
        peer = await _person(client, db_session, 14, role=UserRole.MASTER.value)
        support = await _support_pointer(db_session, mid_)
        as_client = await _dm_pointer(
            db_session,
            client_id=mid_,
            operator_id=peer["user"]["id"],
        )
        o1, o2, o3 = uuid4(), uuid4(), uuid4()
        comms.operator_pages[None] = {
            "items": [_row(o1, activity=50), _row(o2, activity=30)],
            "next_cursor": "operator-page-2",
        }
        comms.operator_pages["operator-page-2"] = {
            "items": [_row(o3, activity=10)],
            "next_cursor": None,
        }
        comms.client_items = [
            _row(
                support,
                form="section",
                client=mid_,
                activity=40,
                last_message=_msg(mid_, "help"),
            ),
            _row(
                as_client, client=mid_, operator_value=peer["user"]["id"], activity=20
            ),
        ]
        headers = auth_headers(master["session_token"])

        first = (await client.get(CHATS_URL, headers=headers)).json()
        assert [r["id"] for r in first["threads"]] == [str(o1), str(support), str(o2)]
        comms_cursor, edge = _decode_master_cursor(first["next_cursor"])
        assert comms_cursor == "operator-page-2"
        assert edge[1] == o2

        second = (
            await client.get(
                CHATS_URL,
                params={"cursor": first["next_cursor"]},
                headers=headers,
            )
        ).json()
        assert [r["id"] for r in second["threads"]] == [str(as_client), str(o3)]
        assert second["next_cursor"] is None
        assert second["threads"][0]["peer"]["user_id"] == peer["user"]["id"]
        # the operator list was walked by ITS cursor, the client list read whole
        assert [p.get("cursor") for p in comms.lists("operator")] == [
            None,
            "operator-page-2",
        ]
        assert all("cursor" not in p for p in comms.lists("client"))
        assert all(p["limit"] == 100 for p in comms.lists("client"))

    async def test_a_tie_in_activity_is_broken_by_id_as_comms_does(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        """Same instant, the greater id is newer (comms orders id DESC
        too): the client row with the greater id belongs above the page's
        edge, the one with the smaller id to the next page."""
        master = await _person(client, db_session, 15, role=UserRole.MASTER.value)
        mid_ = master["user"]["id"]
        p1 = await _person(client, db_session, 16, role=UserRole.MASTER.value)
        p2 = await _person(client, db_session, 17, role=UserRole.MASTER.value)
        edge = UUID("80000000-0000-4000-8000-000000000000")
        above = UUID("90000000-0000-4000-8000-000000000000")
        below = UUID("70000000-0000-4000-8000-000000000000")
        for thread_id, peer in ((above, p1), (below, p2)):
            db_session.add(
                ChatThread(
                    comms_thread_id=thread_id,
                    client_user_id=UUID(mid_),
                    operator_user_id=UUID(peer["user"]["id"]),
                )
            )
        await db_session.commit()
        comms.operator_pages[None] = {
            "items": [_row(edge, activity=30)],
            "next_cursor": "more",
        }
        comms.client_items = [
            _row(above, client=mid_, operator_value=p1["user"]["id"], activity=30),
            _row(below, client=mid_, operator_value=p2["user"]["id"], activity=30),
        ]
        resp = await client.get(
            CHATS_URL, headers=auth_headers(master["session_token"])
        )
        assert [r["id"] for r in resp.json()["threads"]] == [str(above), str(edge)]

    async def test_only_client_rows_when_the_operator_list_is_empty(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        master = await _person(client, db_session, 18, role=UserRole.MASTER.value)
        mid_ = master["user"]["id"]
        support = await _support_pointer(db_session, mid_)
        last = _msg(_ADMIN, "Hello", state="preparing")
        del last["thread_id"]  # a list row's last message has four fields
        comms.client_items = [
            _row(support, form="section", client=mid_, activity=5, last_message=last),
        ]
        resp = await client.get(
            CHATS_URL, headers=auth_headers(master["session_token"])
        )
        (row,) = resp.json()["threads"]
        assert row["id"] == str(support)
        assert row["last_message"] == {
            "id": row["last_message"]["id"],
            "sender": _ADMIN,
            "created_at": "2026-10-20T10:00:00+00:00",
            "body": None,
            "translation": TRANSLATING,
        }
        (params,) = comms.lists("client")
        assert params["locale"] == "ru"

    @pytest.mark.parametrize(
        "cursor",
        ["not-base64-%%%", "e30", "eyJjIjogMX0", "bm90IGpzb24"],
    )
    async def test_a_cursor_we_did_not_make_is_a_400_before_comms(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
        cursor: str,
    ) -> None:
        master = await _person(client, db_session, 19, role=UserRole.MASTER.value)
        resp = await client.get(
            CHATS_URL,
            params={"cursor": cursor},
            headers=auth_headers(master["session_token"]),
        )
        assert resp.status_code == 400
        assert comms.calls == []

    async def test_the_ceiling_is_announced_when_comms_has_more(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        master = await _person(client, db_session, 20, role=UserRole.MASTER.value)
        comms.client_next = "there-is-more"
        log = MagicMock()
        monkeypatch.setattr("app.modules.chats.router.logger", log)
        resp = await client.get(
            CHATS_URL, headers=auth_headers(master["session_token"])
        )
        assert resp.status_code == 200
        assert any(
            c.args[0] == "chat_list_client_threads_truncated"
            for c in log.warning.call_args_list
        )

    async def test_an_unreadable_page_end_is_a_502(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        """НЕХВАТКА: comms says there is more but its last row has no place
        in the order -- the next page could not be cut, so no page."""
        master = await _person(client, db_session, 21, role=UserRole.MASTER.value)
        broken = _row(uuid4(), created_at="not-a-time")
        comms.operator_pages[None] = {"items": [broken], "next_cursor": "more"}
        resp = await client.get(
            CHATS_URL, headers=auth_headers(master["session_token"])
        )
        assert resp.status_code == 502

    async def test_comms_down_on_the_client_list_fails_the_master_list(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        master = await _person(client, db_session, 22, role=UserRole.MASTER.value)

        async def _half_down(method: str, path: str, **kw: Any) -> Any:
            if "client" in (kw.get("params") or {}):
                raise HTTPException(status_code=502)
            return {"items": [_row(uuid4(), activity=5)], "next_cursor": None}

        monkeypatch.setattr("app.modules.chats.router.comms_request", _half_down)
        resp = await client.get(
            CHATS_URL, headers=auth_headers(master["session_token"])
        )
        assert resp.status_code == 502


# ---------------------------------------------------------------------------
# 4. The conversation: feed, catch-up, send, read -- and who may
# ---------------------------------------------------------------------------


class TestConversation:
    async def test_feed_by_section_4_and_one_job_for_the_lost_reply(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        user = await _person(client, db_session, 23)
        uid = user["user"]["id"]
        support = await _support_pointer(db_session, uid)
        lost = _msg(_ADMIN, "ORIGINAL-LOST", state="not_requested")
        comms.feed = [
            lost,
            _msg(_ADMIN, "ORIGINAL-READY", state="ready", variant="Готово"),
            _msg(_ADMIN, "ORIGINAL-PREPARING", state="preparing"),
            _msg(_ADMIN, "ORIGINAL-IMPOSSIBLE", state="impossible"),
            _msg(_ADMIN, "Уже по-русски", state="not_needed"),
            _msg(uid, "my question", state="not_needed"),
            _msg(uid, "my unasked question", state="not_requested"),
            "junk-item",
        ]
        headers = auth_headers(user["session_token"])

        resp = await client.get(f"{CHATS_URL}/{support}/messages", headers=headers)

        assert resp.status_code == 200
        got = [(m["body"], m["translation"]) for m in resp.json()["messages"]]
        assert got == [
            (None, TRANSLATING),
            ("Готово", None),
            (None, TRANSLATING),
            (None, UNAVAILABLE),
            ("Уже по-русски", None),
            ("my question", None),
            ("my unasked question", None),
        ]
        for leak in ("ORIGINAL-", "junk-item", "variant_state"):
            assert leak not in resp.text
        feed_call = next(c for c in comms.calls if c[1].endswith("/messages"))
        assert feed_call[1] == f"/api/v1/threads/{support}/messages"
        assert feed_call[2]["locale"] == "ru"
        # the catch-up: ONE job, for the reply nothing was asked for, in
        # the user's language -- not for the user's own message
        (job,) = await _jobs(db_session, support)
        assert str(job.comms_message_id) == lost["id"]
        assert (job.direction, job.locale, job.attempt) == (TO_USER, "ru", 1)

        # ПОВТОР: reading again queues nothing more
        await client.get(f"{CHATS_URL}/{support}/messages", headers=headers)
        assert len(await _jobs(db_session, support)) == 1

    @pytest.mark.parametrize("language", ["en", "fr"])
    async def test_a_reader_of_the_support_language_gets_the_thread_as_is(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
        language: str,
    ) -> None:
        """ "fr" is not a language of the product: it reads as the default,
        which is the support language here -- nothing to translate."""
        user = await _person(client, db_session, 24, language=language)
        support = await _support_pointer(db_session, user["user"]["id"])
        comms.feed = [_msg(_ADMIN, "Hello as written")]
        resp = await client.get(
            f"{CHATS_URL}/{support}/messages",
            headers=auth_headers(user["session_token"]),
        )
        assert [m["body"] for m in resp.json()["messages"]] == ["Hello as written"]
        feed_call = next(c for c in comms.calls if c[1].endswith("/messages"))
        assert "locale" not in feed_call[2]
        assert await _jobs(db_session, support) == []

    async def test_an_empty_feed_is_empty(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        user = await _person(client, db_session, 25)
        support = await _support_pointer(db_session, user["user"]["id"])
        resp = await client.get(
            f"{CHATS_URL}/{support}/messages",
            headers=auth_headers(user["session_token"]),
        )
        assert resp.json() == {"messages": [], "next_cursor": None}
        assert await _jobs(db_session, support) == []

    async def test_a_reply_goes_into_the_same_thread_queued_for_the_admin(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        user = await _person(client, db_session, 26)
        uid = user["user"]["id"]
        support = await _support_pointer(db_session, uid)
        headers = {**auth_headers(user["session_token"]), "Idempotency-Key": "once"}

        for _ in range(2):  # ПОВТОР: one intent, one message, one job
            resp = await client.post(
                f"{CHATS_URL}/{support}/messages",
                json={"body": "thanks"},
                headers=headers,
            )
            assert resp.status_code == 200

        posts = [
            c for c in comms.calls if c[0] == "POST" and c[1].endswith("/messages")
        ]
        assert {c[1] for c in posts} == {f"/api/v1/threads/{support}/messages"}
        assert posts[0][3] == {"sender": uid, "body": "thanks"}  # no topic
        (job,) = await _jobs(db_session, support)
        assert (job.direction, job.locale) == (TO_SUPPORT, "en")
        assert str(job.comms_message_id) == resp.json()["id"]

    async def test_an_empty_reply_is_refused_before_comms(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        user = await _person(client, db_session, 27)
        support = await _support_pointer(db_session, user["user"]["id"])
        resp = await client.post(
            f"{CHATS_URL}/{support}/messages",
            json={"body": ""},
            headers=auth_headers(user["session_token"]),
        )
        assert resp.status_code == 422
        assert comms.calls == []

    async def test_read_is_the_callers_own(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        user = await _person(client, db_session, 28)
        uid = user["user"]["id"]
        support = await _support_pointer(db_session, uid)
        resp = await client.post(
            f"{CHATS_URL}/{support}/read",
            headers=auth_headers(user["session_token"]),
        )
        assert resp.status_code == 200
        (call,) = comms.calls
        assert call[1] == f"/api/v1/threads/{support}/read"
        assert call[3] == {"participant": uid}

    async def test_nobody_else_opens_it_and_comms_is_never_asked(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: FakeComms,
    ) -> None:
        """Another user (with a support thread of their own), a master, an
        admin: every verb is the same 404 -- strict equality with the
        CALLER's pointer, no role widens it. The owner, the pair: 200."""
        owner = await _person(client, db_session, 29)
        support = await _support_pointer(db_session, owner["user"]["id"])
        other = await _person(client, db_session, 30)
        await _support_pointer(db_session, other["user"]["id"])
        master = await _person(client, db_session, 31, role=UserRole.MASTER.value)
        admin = await _person(client, db_session, 32, role=UserRole.ADMIN.value)
        verbs = (
            ("GET", f"{CHATS_URL}/{support}/messages", None),
            ("POST", f"{CHATS_URL}/{support}/messages", {"body": "x"}),
            ("POST", f"{CHATS_URL}/{support}/read", None),
            ("GET", f"{CHATS_URL}/{support}/unread-count", None),
        )
        for stranger in (other, master, admin):
            for method, url, body in verbs:
                resp = await client.request(
                    method,
                    url,
                    json=body,
                    headers=auth_headers(stranger["session_token"]),
                )
                assert resp.status_code == 404, (method, url)
        assert comms.calls == []
        for method, url, body in verbs:
            resp = await client.request(
                method,
                url,
                json=body,
                headers=auth_headers(owner["session_token"]),
            )
            assert resp.status_code == 200, (method, url)


# ---------------------------------------------------------------------------
# 5. The "not delivered" notice opens the conversation
# ---------------------------------------------------------------------------


async def test_translation_unavailable_opens_the_thread(
    client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = await _person(client, db_session, 33)
    support = await _support_pointer(db_session, user["user"]["id"])
    thread = (
        await db_session.execute(
            select(SupportThread).where(SupportThread.comms_thread_id == support)
        )
    ).scalar_one()
    row = SupportTranslationJob(
        support_thread_id=thread.id,
        comms_message_id=UUID(_mid()),
        direction=TO_USER,
        locale="ru",
        attempt=1,
        job_key="llm-support-tr:x",
    )
    sent = AsyncMock()
    monkeypatch.setattr(translation, "emit_notification", sent)

    await translation._emit_unavailable(db_session, row)

    sent.assert_awaited_once()
    assert sent.await_args.kwargs["action_data"] == {
        "action": "open_thread",
        "params": {"thread_id": str(support)},
    }
    assert sent.await_args.kwargs["target_value"] == user["user"]["id"]


# ---------------------------------------------------------------------------
# 6. The race: the user's catch-up against the admin's
# ---------------------------------------------------------------------------


async def test_two_feeds_catching_up_the_same_replies_do_not_deadlock(
    client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The user's feed (holder) and the admin's feed (rival) catch up the
    SAME two lost replies. The holder stops right after its first insert,
    still uncommitted; the rival runs into it and must be seen WAITING on
    the lock -- otherwise the two never met and green proves nothing.

    Both insert in the feed's order, so the rival waits on the first row
    and nothing waits on it: no deadlock, one job per reply. Reverse the
    order on one side (catch_up's docstring) and each holds one row the
    other needs -- 40P01, which this test then reports as a deadlock."""
    monkeypatch.setattr(translation, "enqueue_llm_job", AsyncMock())
    user = await _person(client, db_session, 34)
    support = await _support_pointer(db_session, user["user"]["id"])
    pointer = (
        await db_session.execute(
            select(SupportThread).where(SupportThread.comms_thread_id == support)
        )
    ).scalar_one()
    newer = _msg(_ADMIN, "second reply", state="not_requested")
    older = _msg(_ADMIN, "first reply", state="not_requested")
    user_page = [newer, older]  # comms pages newest first
    admin_page = [
        {k: v for k, v in m.items() if k not in ("variant", "variant_state")}
        for m in user_page
    ]

    async def _user_feed(session: AsyncSession) -> object:
        return await client_feed(
            session,
            pointer=pointer,
            user_locale="ru",
            messages=user_page,
        )

    async def _admin_feed(session: AsyncSession) -> object:
        return await admin_feed(
            session,
            pointer=pointer,
            messages=admin_page,
            user_locale="ru",
            user_items=user_page,
        )

    result = await race(
        monkeypatch,
        holder=_user_feed,
        pause_in=(translation, "enqueue"),
        pause="after",
        rival=_admin_feed,
    )

    assert result.rival_waited
    assert_no_deadlock(result)
    assert result.holder.committed and result.rival.committed
    jobs = await _jobs(db_session, support)
    assert sorted(str(j.comms_message_id) for j in jobs) == sorted(
        [newer["id"], older["id"]]
    )
    assert all((j.direction, j.locale, j.attempt) == (TO_USER, "ru", 1) for j in jobs)
