# =============================================================================
# VELO -- unread without N+1: one comms call per screen (T-51)
# =============================================================================
# Band 89760-89799.
#
# ON THIS BAND, because the neighbouring file warns about it. The header of
# test_chats_t3_students.py records that it MOVED OFF 89760-89799 in August
# 2026, when the T-20 handoff had reserved the range. THAT RESERVATION IS
# LIFTED: T-20 landed on 99100-99149 instead (see
# test_student_entitlement_t20.py) and never touched 89xxx. The window is
# free, and this file holds it. Declared as BAND_MIN / BAND_MAX rather than
# in prose, because that pair is what the next person greps for.
#
# WHAT IS UNDER TEST, and why each one exists:
#
#   1. THE CALL COUNT IS THE FEATURE. Three screens used to spend one comms
#      request PER THREAD; each now spends exactly one, whatever the row
#      count. Asserted by counting awaits on the seam, not by timing --
#      "faster" is not a property a test can hold.
#
#   2. ABSENCE IS NOT ZERO. comms omits `unread` for a thread the caller
#      takes no part in, and for an id that matches no thread. velo passes
#      that through untouched: no key, never a 0. A zero would mean "your
#      thread, nothing to read" and would hide both a foreign row and a
#      pointer table drifting out of sync with comms.
#
#   3. DEGRADATION IS A CONTRACT, not an accident. comms down -> the LOCAL
#      lists still answer 200 with rows and no badges. The master list is
#      NOT part of that promise and must not be made to fake one: its rows
#      come FROM comms, so it has always died with comms and still does.
#      That asymmetry predates this change; unread neither created nor
#      widened it.
#
#   4. ACTORS ARE STAMPED, still. Every new call sends `participant` from
#      the session, and the actor-override rejection covers the new route
#      like every other.
#
# comms is cut at the seam (app.modules.chats.router.comms_request /
# app.modules.bookings.service.comms_request) -- no comms stack needed.
# =============================================================================

from unittest.mock import AsyncMock
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.chats.models import ChatThread
from app.modules.masters.models import MasterProfile
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, cleanup_range, login_user

BAND_MIN, BAND_MAX = 89760, 89799

_CHATS_SEAM = "app.modules.chats.router.comms_request"
_STATS_SEAM = "app.modules.bookings.service.comms_request"

CHATS_URL = "/api/v1/chats"
SUMMARY_URL = "/api/v1/chats/unread-summary"
STATS_URL = "/api/v1/bookings/me/stats"


@pytest.fixture(autouse=True)
async def _clean_band(db_session: AsyncSession):
    """Drop band users and their chat pointers, around every test."""

    async def _drain() -> None:
        band = select(User.id).where(
            User.telegram_id.between(BAND_MIN, BAND_MAX)
        )
        ids = list((await db_session.execute(band)).scalars().all())
        if ids:
            await db_session.execute(
                delete(ChatThread).where(
                    ChatThread.client_user_id.in_(ids)
                )
            )
            await db_session.execute(
                delete(ChatThread).where(
                    ChatThread.operator_user_id.in_(ids)
                )
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
    return await login_user(
        client, telegram_id=telegram_id, first_name="Master",
    )


async def _make_admin(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int
) -> dict:
    auth = await login_user(
        client, telegram_id=telegram_id, first_name="Admin",
    )
    user = await db_session.get(User, UUID(auth["user"]["id"]))
    user.role = UserRole.ADMIN.value
    await db_session.commit()
    return await login_user(
        client, telegram_id=telegram_id, first_name="Admin",
    )


async def _pointer(
    db_session: AsyncSession, *, client_id: UUID, operator_id: UUID
) -> UUID:
    """A local chat pointer row -- what the local lists are built from."""
    comms_thread_id = uuid4()
    db_session.add(
        ChatThread(
            comms_thread_id=comms_thread_id,
            client_user_id=client_id,
            operator_user_id=operator_id,
        )
    )
    await db_session.commit()
    return comms_thread_id


def _comms_thread(thread_id: str, **extra) -> dict:
    """The frozen 3b thread shape as comms' operator list returns it."""
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
        "created_at": "2026-08-01T10:30:00+00:00",
        **extra,
    }


# ---------------------------------------------------------------------------
# The student profile dot -- one call, three roles
# ---------------------------------------------------------------------------


class TestProfileStatsDot:
    async def test_one_comms_call_regardless_of_thread_count(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """Three threads used to cost three requests. Now: one, always."""
        student = await login_user(
            client, telegram_id=BAND_MIN, first_name="Student",
        )
        student_id = UUID(student["user"]["id"])
        for offset in (1, 2, 3):
            master = await _make_master(
                client, db_session, BAND_MIN + offset,
            )
            await _pointer(
                db_session,
                client_id=student_id,
                operator_id=UUID(master["user"]["id"]),
            )

        fake = AsyncMock(
            return_value={
                "has_unread": True,
                "threads_with_unread": 2,
                "unread_messages": 7,
            }
        )
        monkeypatch.setattr(_STATS_SEAM, fake)

        resp = await client.get(
            STATS_URL, headers=auth_headers(student["session_token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["has_unread_messages"] is True
        assert fake.await_count == 1
        # The participant is the SESSION user, in the path comms trusts.
        assert str(student_id) in fake.await_args.args[1]

    async def test_no_unread_is_a_false_dot_not_an_error(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        student = await login_user(
            client, telegram_id=BAND_MIN + 4, first_name="Student",
        )
        monkeypatch.setattr(
            _STATS_SEAM,
            AsyncMock(
                return_value={
                    "has_unread": False,
                    "threads_with_unread": 0,
                    "unread_messages": 0,
                }
            ),
        )

        resp = await client.get(
            STATS_URL, headers=auth_headers(student["session_token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["has_unread_messages"] is False

    async def test_comms_down_darkens_the_dot_and_spares_the_cards(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """The other two fields are pure local aggregates and have never
        depended on comms; a chat outage must not start breaking them."""
        student = await login_user(
            client, telegram_id=BAND_MIN + 5, first_name="Student",
        )
        monkeypatch.setattr(
            _STATS_SEAM, AsyncMock(side_effect=RuntimeError("comms down")),
        )

        resp = await client.get(
            STATS_URL, headers=auth_headers(student["session_token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["has_unread_messages"] is False
        assert body["practices_attended"] == 0
        assert body["hours_attended"] == 0


# ---------------------------------------------------------------------------
# The chat list -- three branches, one call each
# ---------------------------------------------------------------------------


class TestMasterListBranch:
    async def test_asks_comms_for_unread_inline_and_stays_one_call(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        master = await _make_master(client, db_session, BAND_MIN + 6)
        fake = AsyncMock(
            return_value={
                "threads": [
                    _comms_thread(str(uuid4()), unread=3),
                    _comms_thread(str(uuid4()), unread=0),
                ],
                "next_cursor": None,
            }
        )
        monkeypatch.setattr(_CHATS_SEAM, fake)

        resp = await client.get(
            CHATS_URL, headers=auth_headers(master["session_token"]),
        )
        assert resp.status_code == 200

        # ONE call, and it carries the opt-in flag plus the stamped actor.
        assert fake.await_count == 1
        params = fake.await_args.kwargs["params"]
        assert params["with_unread"] is True
        assert params["operator"] == master["user"]["id"]
        assert params["is_supervisor"] is False

        rows = resp.json()["threads"]
        assert [r["unread"] for r in rows] == [3, 0]

    async def test_pool_row_arrives_without_the_key_and_keeps_it_that_way(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """An unclaimed support thread reaches every operator's list and
        belongs to none of them, so comms sends no `unread`. The proxy must
        not helpfully invent a 0 -- that would put a badge on somebody
        else's queue."""
        master = await _make_master(client, db_session, BAND_MIN + 7)
        pool_row = _comms_thread(str(uuid4()))
        pool_row["operator_kind"] = "section"
        monkeypatch.setattr(
            _CHATS_SEAM,
            AsyncMock(
                return_value={
                    "threads": [pool_row, _comms_thread(str(uuid4()), unread=4)],
                    "next_cursor": None,
                }
            ),
        )

        resp = await client.get(
            CHATS_URL, headers=auth_headers(master["session_token"]),
        )
        rows = resp.json()["threads"]
        assert "unread" not in rows[0]
        assert rows[1]["unread"] == 4

    async def test_comms_down_still_fails_the_master_list_as_it_always_has(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """NOT a regression and NOT a thing to fix here. This branch IS
        comms' list -- one call before T-51, the same one call with one
        extra parameter after it. No fallback is invented: an empty list on
        a chat outage would be a product decision nobody made."""
        from fastapi import HTTPException

        master = await _make_master(client, db_session, BAND_MIN + 8)
        monkeypatch.setattr(
            _CHATS_SEAM,
            AsyncMock(side_effect=HTTPException(status_code=502)),
        )

        resp = await client.get(
            CHATS_URL, headers=auth_headers(master["session_token"]),
        )
        assert resp.status_code == 502


class TestLocalListBranches:
    async def test_student_list_gets_one_batch_call_for_the_whole_page(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        student = await login_user(
            client, telegram_id=BAND_MIN + 9, first_name="Student",
        )
        student_id = UUID(student["user"]["id"])
        thread_ids = []
        for offset in (10, 11, 12):
            master = await _make_master(client, db_session, BAND_MIN + offset)
            thread_ids.append(
                await _pointer(
                    db_session,
                    client_id=student_id,
                    operator_id=UUID(master["user"]["id"]),
                )
            )

        fake = AsyncMock(
            return_value={
                "counts": {
                    str(thread_ids[0]): 2,
                    str(thread_ids[1]): 0,
                    str(thread_ids[2]): 9,
                }
            }
        )
        monkeypatch.setattr(_CHATS_SEAM, fake)

        resp = await client.get(
            CHATS_URL, headers=auth_headers(student["session_token"]),
        )
        assert resp.status_code == 200

        # Three rows, ONE comms call -- the whole point of the change.
        assert fake.await_count == 1
        body = fake.await_args.kwargs["json"]
        assert body["participant"] == str(student_id)
        assert sorted(body["thread_ids"]) == sorted(
            str(t) for t in thread_ids
        )

        rows = {r["id"]: r for r in resp.json()["threads"]}
        assert rows[str(thread_ids[0])]["unread"] == 2
        assert rows[str(thread_ids[1])]["unread"] == 0
        assert rows[str(thread_ids[2])]["unread"] == 9

    async def test_admin_list_takes_the_same_path(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """An admin's list is local too -- their own threads, either side of
        the pair -- so it gets the same single batch call."""
        admin = await _make_admin(client, db_session, BAND_MIN + 13)
        admin_id = UUID(admin["user"]["id"])
        master = await _make_master(client, db_session, BAND_MIN + 14)
        thread_id = await _pointer(
            db_session,
            client_id=admin_id,
            operator_id=UUID(master["user"]["id"]),
        )

        fake = AsyncMock(return_value={"counts": {str(thread_id): 6}})
        monkeypatch.setattr(_CHATS_SEAM, fake)

        resp = await client.get(
            CHATS_URL, headers=auth_headers(admin["session_token"]),
        )
        assert resp.status_code == 200
        assert fake.await_count == 1
        assert fake.await_args.kwargs["json"]["participant"] == str(admin_id)
        assert resp.json()["threads"][0]["unread"] == 6

    async def test_id_absent_from_counts_gets_no_key_not_a_zero(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """The pointer table drifting out of sync with comms is exactly what
        the absence rule is for: comms omits an id it does not recognise,
        and velo shows no badge instead of a confident 0."""
        student = await login_user(
            client, telegram_id=BAND_MIN + 15, first_name="Student",
        )
        student_id = UUID(student["user"]["id"])
        master = await _make_master(client, db_session, BAND_MIN + 16)
        known = await _pointer(
            db_session,
            client_id=student_id,
            operator_id=UUID(master["user"]["id"]),
        )
        master2 = await _make_master(client, db_session, BAND_MIN + 17)
        stale = await _pointer(
            db_session,
            client_id=student_id,
            operator_id=UUID(master2["user"]["id"]),
        )

        monkeypatch.setattr(
            _CHATS_SEAM,
            AsyncMock(return_value={"counts": {str(known): 1}}),
        )

        resp = await client.get(
            CHATS_URL, headers=auth_headers(student["session_token"]),
        )
        rows = {r["id"]: r for r in resp.json()["threads"]}
        assert rows[str(known)]["unread"] == 1
        assert "unread" not in rows[str(stale)]

    async def test_comms_down_leaves_the_local_list_alive_without_badges(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """200 with rows and no keys. NOT 502, NOT an empty list, NOT a key
        set to 0 -- a lying badge is worse than no badge, and a chat outage
        must not take the screen down."""
        from fastapi import HTTPException

        student = await login_user(
            client, telegram_id=BAND_MIN + 18, first_name="Student",
        )
        student_id = UUID(student["user"]["id"])
        master = await _make_master(client, db_session, BAND_MIN + 19)
        thread_id = await _pointer(
            db_session,
            client_id=student_id,
            operator_id=UUID(master["user"]["id"]),
        )

        monkeypatch.setattr(
            _CHATS_SEAM,
            AsyncMock(side_effect=HTTPException(status_code=502)),
        )

        resp = await client.get(
            CHATS_URL, headers=auth_headers(student["session_token"]),
        )
        assert resp.status_code == 200
        rows = resp.json()["threads"]
        assert [r["id"] for r in rows] == [str(thread_id)]
        assert "unread" not in rows[0]

    async def test_empty_page_spends_no_comms_call_at_all(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """comms would answer {} -- there is no reason to ask."""
        student = await login_user(
            client, telegram_id=BAND_MIN + 20, first_name="Student",
        )
        fake = AsyncMock(return_value={"counts": {}})
        monkeypatch.setattr(_CHATS_SEAM, fake)

        resp = await client.get(
            CHATS_URL, headers=auth_headers(student["session_token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["threads"] == []
        assert fake.await_count == 0

    async def test_repeated_identical_request_returns_the_same_answer(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """Reading a list is a read: it clears nothing (only mark-read
        does), so asking twice answers twice the same."""
        student = await login_user(
            client, telegram_id=BAND_MIN + 21, first_name="Student",
        )
        student_id = UUID(student["user"]["id"])
        master = await _make_master(client, db_session, BAND_MIN + 22)
        thread_id = await _pointer(
            db_session,
            client_id=student_id,
            operator_id=UUID(master["user"]["id"]),
        )
        monkeypatch.setattr(
            _CHATS_SEAM,
            AsyncMock(return_value={"counts": {str(thread_id): 3}}),
        )
        headers = auth_headers(student["session_token"])

        first = await client.get(CHATS_URL, headers=headers)
        second = await client.get(CHATS_URL, headers=headers)
        assert first.json() == second.json()
        assert first.json()["threads"][0]["unread"] == 3


# ---------------------------------------------------------------------------
# The master hub summary route
# ---------------------------------------------------------------------------


class TestUnreadSummaryRoute:
    async def test_returns_the_aggregate_and_stamps_the_session_actor(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        master = await _make_master(client, db_session, BAND_MIN + 23)
        fake = AsyncMock(
            return_value={
                "has_unread": True,
                "threads_with_unread": 3,
                "unread_messages": 11,
            }
        )
        monkeypatch.setattr(_CHATS_SEAM, fake)

        resp = await client.get(
            SUMMARY_URL, headers=auth_headers(master["session_token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["unread_messages"] == 11
        assert fake.await_count == 1
        # The participant is the session user, in the path comms trusts.
        assert master["user"]["id"] in fake.await_args.args[1]

    async def test_route_is_not_parsed_as_a_thread_id(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """A literal segment must win over /{thread_id}: a 422 here would
        mean FastAPI tried to read "unread-summary" as a UUID."""
        master = await _make_master(client, db_session, BAND_MIN + 24)
        monkeypatch.setattr(
            _CHATS_SEAM,
            AsyncMock(
                return_value={
                    "has_unread": False,
                    "threads_with_unread": 0,
                    "unread_messages": 0,
                }
            ),
        )

        resp = await client.get(
            SUMMARY_URL, headers=auth_headers(master["session_token"]),
        )
        assert resp.status_code == 200

    async def test_participant_override_from_the_wire_is_refused(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """Silence would hide the attempt; comms trusts whatever we forward,
        so the attempt is rejected rather than ignored."""
        master = await _make_master(client, db_session, BAND_MIN + 25)
        fake = AsyncMock(
            return_value={
                "has_unread": False,
                "threads_with_unread": 0,
                "unread_messages": 0,
            }
        )
        monkeypatch.setattr(_CHATS_SEAM, fake)

        resp = await client.get(
            f"{SUMMARY_URL}?participant={uuid4()}",
            headers=auth_headers(master["session_token"]),
        )
        assert resp.status_code == 400
        assert fake.await_count == 0

    async def test_requires_a_session(self, client: AsyncClient) -> None:
        resp = await client.get(SUMMARY_URL)
        assert resp.status_code in (401, 403)

    async def test_repeated_request_is_idempotent(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        master = await _make_master(client, db_session, BAND_MIN + 26)
        monkeypatch.setattr(
            _CHATS_SEAM,
            AsyncMock(
                return_value={
                    "has_unread": True,
                    "threads_with_unread": 1,
                    "unread_messages": 2,
                }
            ),
        )
        headers = auth_headers(master["session_token"])

        first = await client.get(SUMMARY_URL, headers=headers)
        second = await client.get(SUMMARY_URL, headers=headers)
        assert first.json() == second.json()

    async def test_a_participant_with_nothing_gets_zeros_not_a_404(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        master = await _make_master(client, db_session, BAND_MIN + 27)
        monkeypatch.setattr(
            _CHATS_SEAM,
            AsyncMock(
                return_value={
                    "has_unread": False,
                    "threads_with_unread": 0,
                    "unread_messages": 0,
                }
            ),
        )

        resp = await client.get(
            SUMMARY_URL, headers=auth_headers(master["session_token"]),
        )
        assert resp.status_code == 200
        assert resp.json() == {
            "has_unread": False,
            "threads_with_unread": 0,
            "unread_messages": 0,
        }
