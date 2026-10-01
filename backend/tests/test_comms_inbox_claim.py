# =============================================================================
# VELO Backend -- comms 3.0.0: the inbox is read, not forwarded; the claim
# answers by outcome (delivery 3B)
# =============================================================================
#
# telegram_id band: 88500-88599 (user 88501, admin 88502, opener 88503).
# Declared module-level below as _TID_MIN/_TID_MAX, once. Checked free
# before it was claimed: no literal 885xx occurs in tests/, and 88400-88499
# (test_comms_refusals.py) ends below it.
#
#   1. GET /notifications builds velo's own {items, next_cursor, unread}
#      from comms' page (read_comms_page + read_comms_counter); any other
#      shape is a 502 with nothing of it inside, logged as its shape.
#   2. POST /support/threads/{id}/claim: comms 3.0.0 answers
#      {claimed: true} for the claimer -- a repeat included -- and a 409
#      class `conflict` when another operator holds the thread; the 409
#      reaches the admin with comms' own message.
# =============================================================================

from collections.abc import AsyncGenerator
from typing import Any
from unittest.mock import AsyncMock, patch
from uuid import UUID, uuid4

import httpx
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.modules.support.models import SupportThread
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user

_TID_MIN = 88500
_TID_MAX = 88599

_TID_USER = 88501
_TID_ADMIN = 88502
_TID_OPENER = 88503

INBOX_URL = "/api/v1/notifications"
_INBOX_SEAM = "app.modules.comms_proxy.router.comms_request"
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


def _item(title: str) -> dict:
    """One inbox row as comms 3.0.0 serializes it -- no `priority`."""
    return {
        "delivery_id": str(uuid4()),
        "type": "booking.confirmed",
        "title": title,
        "body": "b",
        "action_data": None,
        "status": "delivered",
        "read_at": None,
        "created_at": "2026-09-30T10:00:00+00:00",
    }


def _unknown_shapes(secret: str) -> list:
    row = _item(secret)
    return [
        {"items": [row], "next_cursor": None},  # no unread
        {"items": [row], "next_cursor": None, "unread": "3"},
        {"items": [row], "next_cursor": None, "unread": True},
        {"items": [row], "next_cursor": None, "unread": -1},
        {"items": [row], "unread": 1},  # no next_cursor
        {"items": {"0": row}, "next_cursor": None, "unread": 1},
        [row],
        None,
    ]


# ===========================================================================
# 1. The inbox
# ===========================================================================


class TestInbox:
    async def test_a_page_is_delivered_as_velos_own_three_keys(
        self, client: AsyncClient, monkeypatch,
    ) -> None:
        user = await login_user(client, telegram_id=_TID_USER)
        rows = [_item("one"), _item("two")]
        monkeypatch.setattr(
            _INBOX_SEAM,
            AsyncMock(return_value={
                "items": rows, "next_cursor": "c2", "unread": 2,
                "debug": "a key comms might add one day",
            }),
        )
        resp = await client.get(
            INBOX_URL, headers=auth_headers(user["session_token"]),
        )
        assert resp.status_code == 200
        assert resp.json() == {"items": rows, "next_cursor": "c2", "unread": 2}

    async def test_every_unknown_shape_is_a_502_with_nothing_of_it_inside(
        self, client: AsyncClient, monkeypatch,
    ) -> None:
        user = await login_user(client, telegram_id=_TID_USER)
        secret = f"secret-{uuid4()}"
        for payload in _unknown_shapes(secret):
            monkeypatch.setattr(_INBOX_SEAM, AsyncMock(return_value=payload))
            resp = await client.get(
                INBOX_URL, headers=auth_headers(user["session_token"]),
            )
            assert resp.status_code == 502, payload
            assert secret not in resp.text

    async def test_an_empty_page_with_zero_unread_is_a_value(
        self, client: AsyncClient, monkeypatch,
    ) -> None:
        """PUSTOTA: zero is a count, an empty page is a page -- 200."""
        user = await login_user(client, telegram_id=_TID_USER)
        empty = {"items": [], "next_cursor": None, "unread": 0}
        monkeypatch.setattr(_INBOX_SEAM, AsyncMock(return_value=empty))
        resp = await client.get(
            INBOX_URL, headers=auth_headers(user["session_token"]),
        )
        assert resp.status_code == 200
        assert resp.json() == empty

    async def test_two_calls_give_the_same_answer(
        self, client: AsyncClient, monkeypatch,
    ) -> None:
        user = await login_user(client, telegram_id=_TID_USER)
        rows = [_item("again")]
        monkeypatch.setattr(
            _INBOX_SEAM,
            AsyncMock(side_effect=lambda *a, **k: {
                "items": rows, "next_cursor": None, "unread": 1,
            }),
        )
        first, second = [
            (
                await client.get(
                    INBOX_URL, headers=auth_headers(user["session_token"]),
                )
            ).json()
            for _ in range(2)
        ]
        assert first == second == {
            "items": rows, "next_cursor": None, "unread": 1,
        }

    async def test_the_refusal_logs_the_shape_and_no_row_content(
        self, client: AsyncClient, monkeypatch,
    ) -> None:
        user = await login_user(client, telegram_id=_TID_USER)
        secret = f"secret-{uuid4()}"
        monkeypatch.setattr(
            _INBOX_SEAM,
            AsyncMock(return_value={
                "items": [_item(secret)], "next_cursor": None, "unread": "1",
            }),
        )
        with patch(_LOG_SEAM) as log:
            resp = await client.get(
                INBOX_URL, headers=auth_headers(user["session_token"]),
            )
        assert resp.status_code == 502
        log.error.assert_called_once()
        assert log.error.call_args.args == ("comms_list_shape_unexpected",)
        assert log.error.call_args.kwargs == {
            # The route template, not the recipient's id.
            "path": "/api/v1/recipients/{recipient_id}/inbox",
            "payload_type": "dict",
            "keys": ["items", "next_cursor", "unread"],
        }
        assert secret not in repr(log.error.call_args)
        assert user["user"]["id"] not in repr(log.error.call_args)


# ===========================================================================
# 2. The claim, through the real HTTP boundary of core/comms.py
# ===========================================================================


def _wire(status: int, body: Any):
    class _Client:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc: object) -> None:
            return None

        async def request(self, *args: object, **kwargs: object):
            return httpx.Response(status, json=body)

    return _Client


async def _admin_and_thread(client, db_session) -> tuple[dict, UUID]:
    auth = await login_user(client, telegram_id=_TID_ADMIN, first_name="A")
    admin = await db_session.get(User, UUID(auth["user"]["id"]))
    admin.role = UserRole.ADMIN.value
    opener = await login_user(client, telegram_id=_TID_OPENER)
    thread_id = uuid4()
    db_session.add(
        SupportThread(
            comms_thread_id=thread_id,
            client_user_id=UUID(opener["user"]["id"]),
        )
    )
    await db_session.commit()
    return await login_user(client, telegram_id=_TID_ADMIN), thread_id


class TestClaim:
    async def test_the_claim_and_its_repeat_are_both_yours(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        """POVTOR: comms answers by outcome -- claimed: true both times."""
        admin, thread_id = await _admin_and_thread(client, db_session)
        body = {
            "claimed": True,
            "thread": {"id": str(thread_id), "assignee": admin["user"]["id"]},
        }
        with (
            patch.object(settings, "comms_api_url", "http://comms-test.invalid"),
            patch("app.core.comms.httpx.AsyncClient", _wire(200, body)),
        ):
            answers = [
                await client.post(
                    f"/api/v1/support/threads/{thread_id}/claim",
                    headers=auth_headers(admin["session_token"]),
                )
                for _ in range(2)
            ]
        for resp in answers:
            assert resp.status_code == 200, resp.text
            assert resp.json()["claimed"] is True

    async def test_a_thread_held_by_another_admin_is_a_409_with_its_reason(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        """NEHVATKA: the old `claimed: false` is now comms' 409 `conflict`,
        and the admin reads comms' message, not a generic refusal."""
        admin, thread_id = await _admin_and_thread(client, db_session)
        refusal = {"error": {
            "class": "conflict",
            "message": f"thread {thread_id} is assigned to another operator",
        }}
        with (
            patch.object(settings, "comms_api_url", "http://comms-test.invalid"),
            patch("app.core.comms.httpx.AsyncClient", _wire(409, refusal)),
        ):
            resp = await client.post(
                f"/api/v1/support/threads/{thread_id}/claim",
                headers=auth_headers(admin["session_token"]),
            )
        assert resp.status_code == 409
        assert "assigned to another operator" in resp.text
