# =============================================================================
# VELO Backend -- comms message feeds: read, not forwarded (BE-88)
# =============================================================================
#
# telegram_id band: 88300-88399 (student 88301, master 88302, admin 88303,
# support client 88304). Declared module-level below as _TID_MIN/_TID_MAX,
# once. Checked free before it was claimed: no literal 883xx occurs in
# tests/, and 88200-88299 (test_comms_thread_lists.py) ends below it.
#
# THE DEFECT THIS PINS. comms 3.0.0 pages a thread's feed as
# {"items", "next_cursor"} (app/api/paging.py page()). Both velo feeds --
# GET /chats/{id}/messages and the admin GET /support/threads/{id}/messages
# -- forwarded comms' body as is, and the frontend reads `messages`: every
# open chat and every support thread showed empty. The proxies now build
# velo's own {"messages", "next_cursor"} from what read_comms_page
# accepted; any other shape is a 502 with nothing of it inside.
#
# Every refusal is paired with "and a well-shaped page IS delivered, own
# messages included" -- a proxy that refused everything would pass alone.
# =============================================================================

from collections.abc import AsyncGenerator
from unittest.mock import AsyncMock, patch
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.chats.models import ChatThread
from app.modules.masters.models import MasterProfile
from app.modules.support.models import SupportThread
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user

_TID_MIN = 88300
_TID_MAX = 88399

_TID_STUDENT = 88301
_TID_MASTER = 88302
_TID_ADMIN = 88303
_TID_OPENER = 88304

_CHATS_SEAM = "app.modules.chats.router.comms_request"
_SUPPORT_SEAM = "app.modules.support.service.comms_request"
_LOG_SEAM = "app.core.comms.logger"

pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    # Committed each time: an open delete would hold the band's rows
    # locked, and the next login (another session) would wait on it.
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


async def _login(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int,
    role: str | None = None,
) -> dict:
    auth = await login_user(client, telegram_id=telegram_id, first_name="Me")
    if role is None:
        return auth
    user_id = UUID(auth["user"]["id"])
    if role == UserRole.MASTER.value:
        db_session.add(
            MasterProfile(
                user_id=user_id, data={"account": {"status": "verified"}},
            )
        )
    user = await db_session.get(User, user_id)
    user.role = role
    await db_session.commit()
    return await login_user(client, telegram_id=telegram_id, first_name="Me")


def _message(thread_id: UUID, sender: str, body: str) -> dict:
    """One row as comms 3.0.0 serializes it (messaging.py _message_out)."""
    return {
        "id": str(uuid4()),
        "thread_id": str(thread_id),
        "sender": sender,
        "body": body,
        "created_at": "2026-09-28T10:00:00+00:00",
    }


def _unknown_shapes(secret: str, thread_id: UUID) -> list:
    """Shapes that are not comms 3.0.0's page -- each carrying a secret."""
    row = _message(thread_id, str(uuid4()), secret)
    return [
        {"messages": [row], "next_cursor": None},  # the 2.0.0 key
        {"items": [row]},  # no next_cursor
        {"items": {"0": row}, "next_cursor": None},  # not a list
        {"items": [row], "next_cursor": 7},  # cursor of a wrong type
        [row],  # not a mapping
        None,
    ]


async def _chat(client: AsyncClient, db_session: AsyncSession):
    """A student-master DM pointer; returns (student auth, thread id)."""
    student = await _login(client, db_session, _TID_STUDENT)
    master = await _login(
        client, db_session, _TID_MASTER, UserRole.MASTER.value,
    )
    thread_id = uuid4()
    db_session.add(
        ChatThread(
            comms_thread_id=thread_id,
            client_user_id=UUID(student["user"]["id"]),
            operator_user_id=UUID(master["user"]["id"]),
        )
    )
    await db_session.commit()
    return student, thread_id


async def _support(client: AsyncClient, db_session: AsyncSession):
    """A support thread pointer; returns (admin auth, thread id)."""
    admin = await _login(client, db_session, _TID_ADMIN, UserRole.ADMIN.value)
    opener = await _login(client, db_session, _TID_OPENER)
    thread_id = uuid4()
    db_session.add(
        SupportThread(
            comms_thread_id=thread_id,
            client_user_id=UUID(opener["user"]["id"]),
        )
    )
    await db_session.commit()
    return admin, thread_id


# The two feeds, as (builder, seam, url) -- each test runs on both.
_FEEDS = [
    pytest.param(_chat, _CHATS_SEAM, "/api/v1/chats/{}/messages", id="chat"),
    pytest.param(
        _support,
        _SUPPORT_SEAM,
        "/api/v1/support/threads/{}/messages",
        id="support",
    ),
]


@pytest.mark.parametrize(("setup", "seam", "url"), _FEEDS)
class TestFeeds:
    async def test_a_page_is_delivered_as_messages(
        self, client, db_session, monkeypatch, setup, seam, url,
    ) -> None:
        auth, thread_id = await setup(client, db_session)
        rows = [
            _message(thread_id, auth["user"]["id"], "hello"),
            _message(thread_id, str(uuid4()), "hi back"),
        ]
        monkeypatch.setattr(
            seam,
            AsyncMock(return_value={"items": rows, "next_cursor": "older"}),
        )

        resp = await client.get(
            url.format(thread_id), headers=auth_headers(auth["session_token"]),
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body == {"messages": rows, "next_cursor": "older"}
        assert "items" not in body

    async def test_every_unknown_shape_is_a_502_with_nothing_of_it_inside(
        self, client, db_session, monkeypatch, setup, seam, url,
    ) -> None:
        auth, thread_id = await setup(client, db_session)
        secret = f"secret-{uuid4()}"
        for payload in _unknown_shapes(secret, thread_id):
            monkeypatch.setattr(seam, AsyncMock(return_value=payload))
            resp = await client.get(
                url.format(thread_id),
                headers=auth_headers(auth["session_token"]),
            )
            assert resp.status_code == 502, payload
            assert secret not in resp.text

    async def test_an_empty_page_is_an_empty_feed_not_a_refusal(
        self, client, db_session, monkeypatch, setup, seam, url,
    ) -> None:
        """PUSTOTA of the right shape: the door is shut on SHAPE, not zero."""
        auth, thread_id = await setup(client, db_session)
        monkeypatch.setattr(
            seam, AsyncMock(return_value={"items": [], "next_cursor": None}),
        )
        resp = await client.get(
            url.format(thread_id), headers=auth_headers(auth["session_token"]),
        )
        assert resp.status_code == 200
        assert resp.json() == {"messages": [], "next_cursor": None}

    async def test_a_row_short_of_fields_is_passed_as_it_came(
        self, client, db_session, monkeypatch, setup, seam, url,
    ) -> None:
        """NEHVATKA: rows are the participant's own feed and are not
        filtered -- read_comms_page judges the PAGE, not the rows (a feed
        has no foreign rows to drop; access is the participant check)."""
        auth, thread_id = await setup(client, db_session)
        short = {"id": str(uuid4()), "body": "no sender, no time"}
        monkeypatch.setattr(
            seam, AsyncMock(return_value={"items": [short], "next_cursor": None}),
        )
        resp = await client.get(
            url.format(thread_id), headers=auth_headers(auth["session_token"]),
        )
        assert resp.status_code == 200
        assert resp.json() == {"messages": [short], "next_cursor": None}

    async def test_two_calls_give_the_same_answer(
        self, client, db_session, monkeypatch, setup, seam, url,
    ) -> None:
        """POVTOR: nothing is carried from one request to the next."""
        auth, thread_id = await setup(client, db_session)
        rows = [_message(thread_id, auth["user"]["id"], "again")]
        monkeypatch.setattr(
            seam,
            AsyncMock(
                side_effect=lambda *a, **k: {"items": rows, "next_cursor": None},
            ),
        )
        first, second = [
            (
                await client.get(
                    url.format(thread_id),
                    headers=auth_headers(auth["session_token"]),
                )
            ).json()
            for _ in range(2)
        ]
        assert first == second == {"messages": rows, "next_cursor": None}

    async def test_the_refusal_logs_the_shape_and_no_message_text(
        self, client, db_session, monkeypatch, setup, seam, url,
    ) -> None:
        auth, thread_id = await setup(client, db_session)
        secret = f"secret-{uuid4()}"
        payload = {
            "messages": [_message(thread_id, str(uuid4()), secret)],
            "next_cursor": None,
        }
        monkeypatch.setattr(seam, AsyncMock(return_value=payload))
        with patch(_LOG_SEAM) as log:
            resp = await client.get(
                url.format(thread_id),
                headers=auth_headers(auth["session_token"]),
            )

        assert resp.status_code == 502
        log.error.assert_called_once()
        assert log.error.call_args.args == ("comms_list_shape_unexpected",)
        assert log.error.call_args.kwargs == {
            # The route template, not the id: the log names the endpoint.
            "path": "/api/v1/threads/{thread_id}/messages",
            "payload_type": "dict",
            "keys": ["messages", "next_cursor"],
        }
        assert secret not in repr(log.error.call_args)
        assert str(thread_id) not in repr(log.error.call_args)
