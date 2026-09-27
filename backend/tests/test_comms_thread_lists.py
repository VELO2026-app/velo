# =============================================================================
# VELO Backend -- comms thread lists: the unknown shape closes the door
# =============================================================================
#
# telegram_id band: 88200-88299 (master 88201, admin 88202, clients
# 88210-88212). Declared module-level below as _TID_MIN/_TID_MAX, once.
# Checked free before it was claimed: no literal 882xx occurs in tests/,
# and the bands of test_comms_protocol_3.py (88000-88099) and
# test_comms_snapshot_version.py (88100-88199) end below it.
#
# THE LEAK THIS PINS. comms 3.0.0 lists threads as {"items", "next_cursor"}.
# Both privacy filters over those lists looked for `threads`, found
# nothing and returned early, so the page went out unfiltered:
#   - GET /chats (master): the unclaimed support queue -- strangers' uuids
#     and the text of their requests;
#   - GET /support/threads (admin, is_supervisor=True): every thread on
#     the installation, every master's private DMs included.
#
# Every leak assertion is paired with "and the caller's own rows ARE
# there" -- a filter that hides everything would pass the first half.
# =============================================================================

from collections.abc import AsyncGenerator
from unittest.mock import AsyncMock, patch
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.masters.models import MasterProfile
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user

_TID_MIN = 88200
_TID_MAX = 88299

_TID_MASTER = 88201
_TID_ADMIN = 88202

CHATS_URL = "/api/v1/chats"
SUPPORT_URL = "/api/v1/support/threads"
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


async def _with_role(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int, role: str,
) -> dict:
    auth = await login_user(client, telegram_id=telegram_id, first_name="Me")
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


def _row(*, operator_kind: str, client: str | None = None, title: str) -> dict:
    """One thread as comms 3.0.0 lists it (app/api/messaging.py _thread_out)."""
    return {
        "id": str(uuid4()),
        "client": client or str(uuid4()),
        "operator_kind": operator_kind,
        "operator_value": str(uuid4()),
        "assignee": None,
        "kind": "dm" if operator_kind == "user" else "support",
        "status": "open",
        "subject_type": None,
        "subject_id": None,
        "title": title,
        "priority": None,
        "last_message_at": None,
        "created_at": "2026-09-28T10:00:00+00:00",
    }


def _page(*rows: dict, next_cursor: str | None = None) -> dict:
    return {"items": list(rows), "next_cursor": next_cursor}


# The shapes that are NOT comms 3.0.0's page. Each carries a stranger's
# uuid, so "nothing of it reached the body" is checkable.
def _unknown_shapes(stranger: str) -> list:
    row = _row(operator_kind="section", client=stranger, title="stranger")
    return [
        {"threads": [row], "next_cursor": None},  # the 2.0.0 key
        {"items": [row]},  # no next_cursor
        {"items": {"0": row}, "next_cursor": None},  # not a list
        {"items": [row], "next_cursor": 7},  # cursor of a wrong type
        {"results": [row], "next_cursor": None},  # a key never seen
        [row],  # not a mapping
        None,
    ]


# ===========================================================================
# 1. The master's chat list
# ===========================================================================


class TestMasterList:
    async def test_the_support_queue_stays_out_and_own_dms_are_there(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch,
    ) -> None:
        master = await _with_role(
            client, db_session, _TID_MASTER, UserRole.MASTER.value,
        )
        stranger = str(uuid4())
        own = _row(operator_kind="user", title="my own DM")
        pool = _row(operator_kind="section", client=stranger, title="refund!")
        monkeypatch.setattr(
            _CHATS_SEAM, AsyncMock(return_value=_page(pool, own, next_cursor="c2")),
        )

        resp = await client.get(
            CHATS_URL, headers=auth_headers(master["session_token"]),
        )

        assert resp.status_code == 200
        body = resp.json()
        assert set(body) == {"threads", "next_cursor"}
        assert [t["id"] for t in body["threads"]] == [own["id"]]
        assert body["next_cursor"] == "c2"
        assert stranger not in resp.text
        assert "refund!" not in resp.text

    async def test_every_unknown_shape_is_a_502_with_nothing_of_it_inside(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch,
    ) -> None:
        master = await _with_role(
            client, db_session, _TID_MASTER, UserRole.MASTER.value,
        )
        stranger = str(uuid4())
        for payload in _unknown_shapes(stranger):
            monkeypatch.setattr(_CHATS_SEAM, AsyncMock(return_value=payload))
            resp = await client.get(
                CHATS_URL, headers=auth_headers(master["session_token"]),
            )
            assert resp.status_code == 502, payload
            assert stranger not in resp.text

    async def test_an_empty_page_is_an_empty_list_not_a_refusal(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch,
    ) -> None:
        """PUSTOTA of the right shape: the door is shut on SHAPE, not on zero."""
        master = await _with_role(
            client, db_session, _TID_MASTER, UserRole.MASTER.value,
        )
        monkeypatch.setattr(_CHATS_SEAM, AsyncMock(return_value=_page()))
        resp = await client.get(
            CHATS_URL, headers=auth_headers(master["session_token"]),
        )
        assert resp.status_code == 200
        assert resp.json() == {"threads": [], "next_cursor": None}

    async def test_a_row_missing_its_form_is_dropped_and_its_title_stays_in(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch,
    ) -> None:
        """NEHVATKA: a row without operator_kind is foreign; a row with a
        client but no title is still the master's own and is kept."""
        master = await _with_role(
            client, db_session, _TID_MASTER, UserRole.MASTER.value,
        )
        stranger = str(uuid4())
        formless = _row(operator_kind="user", client=stranger, title="x")
        del formless["operator_kind"]
        untitled = _row(operator_kind="user", title="t")
        del untitled["title"]
        monkeypatch.setattr(
            _CHATS_SEAM, AsyncMock(return_value=_page(formless, untitled)),
        )
        resp = await client.get(
            CHATS_URL, headers=auth_headers(master["session_token"]),
        )
        assert resp.status_code == 200
        assert [t["id"] for t in resp.json()["threads"]] == [untitled["id"]]
        assert stranger not in resp.text

    async def test_two_calls_give_the_same_answer(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch,
    ) -> None:
        """POVTOR: the filter carries no state from one request to the next."""
        master = await _with_role(
            client, db_session, _TID_MASTER, UserRole.MASTER.value,
        )
        own = _row(operator_kind="user", title="mine")
        pool = _row(operator_kind="section", title="theirs")
        monkeypatch.setattr(
            _CHATS_SEAM, AsyncMock(side_effect=lambda *a, **k: _page(pool, own)),
        )
        first, second = [
            (
                await client.get(
                    CHATS_URL, headers=auth_headers(master["session_token"]),
                )
            ).json()
            for _ in range(2)
        ]
        assert first == second
        assert [t["id"] for t in first["threads"]] == [own["id"]]


# ===========================================================================
# 2. The admin support list (is_supervisor=True: every thread on the box)
# ===========================================================================


class TestAdminSupportList:
    async def test_private_dms_stay_out_and_support_threads_are_there(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch,
    ) -> None:
        admin = await _with_role(
            client, db_session, _TID_ADMIN, UserRole.ADMIN.value,
        )
        dm_client = str(uuid4())
        private = _row(operator_kind="user", client=dm_client, title="just us")
        support = _row(operator_kind="section", title="help")
        monkeypatch.setattr(
            _SUPPORT_SEAM,
            AsyncMock(return_value=_page(private, support, next_cursor="n")),
        )

        resp = await client.get(
            SUPPORT_URL, headers=auth_headers(admin["session_token"]),
        )

        assert resp.status_code == 200
        body = resp.json()
        assert set(body) == {"threads", "next_cursor"}
        assert [t["id"] for t in body["threads"]] == [support["id"]]
        assert body["next_cursor"] == "n"
        # Built, not spread: comms' own `items` must not ride along.
        assert "items" not in body
        assert dm_client not in resp.text
        assert "just us" not in resp.text

    async def test_every_unknown_shape_is_a_502_with_nothing_of_it_inside(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch,
    ) -> None:
        admin = await _with_role(
            client, db_session, _TID_ADMIN, UserRole.ADMIN.value,
        )
        stranger = str(uuid4())
        for payload in _unknown_shapes(stranger):
            monkeypatch.setattr(_SUPPORT_SEAM, AsyncMock(return_value=payload))
            resp = await client.get(
                SUPPORT_URL, headers=auth_headers(admin["session_token"]),
            )
            assert resp.status_code == 502, payload
            assert stranger not in resp.text

    async def test_an_empty_page_is_an_empty_list(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch,
    ) -> None:
        admin = await _with_role(
            client, db_session, _TID_ADMIN, UserRole.ADMIN.value,
        )
        monkeypatch.setattr(_SUPPORT_SEAM, AsyncMock(return_value=_page()))
        resp = await client.get(
            SUPPORT_URL, headers=auth_headers(admin["session_token"]),
        )
        assert resp.status_code == 200
        assert resp.json() == {"threads": [], "next_cursor": None}


# ===========================================================================
# 3. The log: the shape, never the content
# ===========================================================================


async def test_the_refusal_logs_keys_and_type_and_no_row_content(
    client: AsyncClient, db_session: AsyncSession, monkeypatch,
) -> None:
    """Logging the rows would move the leak from the response to the logs."""
    master = await _with_role(
        client, db_session, _TID_MASTER, UserRole.MASTER.value,
    )
    stranger = str(uuid4())
    payload = {
        "threads": [_row(operator_kind="section", client=stranger, title="s")],
        "next_cursor": None,
    }
    monkeypatch.setattr(_CHATS_SEAM, AsyncMock(return_value=payload))
    with patch(_LOG_SEAM) as log:
        resp = await client.get(
            CHATS_URL, headers=auth_headers(master["session_token"]),
        )

    assert resp.status_code == 502
    log.error.assert_called_once()
    event, = log.error.call_args.args
    fields = log.error.call_args.kwargs
    assert event == "comms_list_shape_unexpected"
    assert fields == {
        "path": "/api/v1/threads",
        "payload_type": "dict",
        "keys": ["next_cursor", "threads"],
    }
    assert stranger not in repr(log.error.call_args)
