# =============================================================================
# VELO -- unread without N+1 (T-51) + the master-list privacy filter (T-53)
# =============================================================================
# Band 89760-89799.
#
# TWO DELIVERIES, ONE FILE, ON PURPOSE: T-53 reuses this band and every
# builder here (_make_master, _comms_thread, the band drain), and both
# deliveries make claims about the SAME surface -- what a master's chat
# list contains. Splitting them would have duplicated the fixtures and
# put two halves of one contract in two places.
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

from copy import deepcopy
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

    async def test_every_row_left_in_a_masters_list_carries_the_unread_key(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """RETRACTION OF A T-51 CLAIM, and why the old one was right then.

        T-51 asserted here that a master's list can contain a row with NO
        `unread` key -- the unclaimed support POOL ROW, which comms hands
        every operator and which belongs to none of them. That was true of
        the code as it stood, and the assertion was the honest one to make.

        T-53 removed the pool from this list entirely (it was a privacy
        leak, not a badge question), so the state that assertion described
        is no longer reachable HERE: everything the master branch returns
        is a user-form thread they are the assignee of, hence a
        participant, hence always keyed. Documenting an unreachable state
        is what this project forbids, so the claim is inverted rather than
        deleted -- the key is now guaranteed, and that is worth holding.

        The absence RULE itself is untouched and still tested, on the local
        branches where it remains reachable (see
        test_id_absent_from_counts_gets_no_key_not_a_zero).
        """
        master = await _make_master(client, db_session, BAND_MIN + 7)
        monkeypatch.setattr(
            _CHATS_SEAM,
            AsyncMock(
                return_value={
                    "threads": [
                        _comms_thread(str(uuid4()), unread=4),
                        _comms_thread(str(uuid4()), unread=0),
                    ],
                    "next_cursor": None,
                }
            ),
        )

        resp = await client.get(
            CHATS_URL, headers=auth_headers(master["session_token"]),
        )
        rows = resp.json()["threads"]
        assert len(rows) == 2
        assert all("unread" in r for r in rows)

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


class TestMasterListPrivacyFilter:
    """T-53. The unclaimed support queue must not appear in a personal list.

    comms' operator read returns `assignee == me` OR `(section thread AND
    assignee IS NULL)` -- so the support pool reaches EVERY operator with
    no supervisor flag involved. velo has no master-facing support screen,
    so those rows were a stranger's support request in a master's own chat
    list: opener name, avatar and uuid through the peer block, plus
    `title`, which is the topic the opener typed -- and a 404 on tap.

    These are privacy assertions, not cosmetic ones: they check the
    RESPONSE BODY, not just the row list, because what matters is what
    leaves the process.
    """

    async def test_unclaimed_support_thread_is_dropped_from_a_masters_list(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        master = await _make_master(client, db_session, BAND_MIN + 28)
        mine = _comms_thread(str(uuid4()), unread=1)
        pool = _comms_thread(str(uuid4()), operator_kind="section")
        monkeypatch.setattr(
            _CHATS_SEAM,
            AsyncMock(
                return_value={"threads": [pool, mine], "next_cursor": None}
            ),
        )

        resp = await client.get(
            CHATS_URL, headers=auth_headers(master["session_token"]),
        )
        assert resp.status_code == 200
        rows = resp.json()["threads"]
        assert [r["id"] for r in rows] == [mine["id"]]

    async def test_nothing_about_a_dropped_row_reaches_the_response_body(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """The strong form: the opener's identity is never resolved and the
        topic never forwarded.

        Checked against the whole serialized body rather than the row list,
        because the leak was in what the endpoint RETURNS -- name, avatar,
        uuid via the peer block that _attach_peers_from_comms stamps on
        every row unconditionally, and `title`, which comms returns
        verbatim and which the opener wrote. If the filter ever moved to
        after the enrichment, the rows would still look right and this
        assertion would still fail.
        """
        master = await _make_master(client, db_session, BAND_MIN + 29)
        stranger = await login_user(
            client, telegram_id=BAND_MIN + 30, first_name="Zinaida",
        )
        stranger_id = stranger["user"]["id"]
        pool = _comms_thread(
            str(uuid4()),
            operator_kind="section",
            client=stranger_id,
            title="I cannot withdraw my money",
        )
        monkeypatch.setattr(
            _CHATS_SEAM,
            AsyncMock(
                return_value={
                    "threads": [pool, _comms_thread(str(uuid4()), unread=0)],
                    "next_cursor": None,
                }
            ),
        )

        resp = await client.get(
            CHATS_URL, headers=auth_headers(master["session_token"]),
        )
        body = resp.text
        assert "Zinaida" not in body
        assert stranger_id not in body
        assert "I cannot withdraw my money" not in body
        assert pool["id"] not in body

    async def test_a_masters_own_support_thread_is_dropped_too(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """A master who wrote to support is the CLIENT of a section thread,
        so comms hands it to them like any other pool row -- and it goes
        with the rest. Not a loss: their own support conversation has its
        own screen (/api/v1/support), which owns that surface. The personal
        chat list is for DMs.
        """
        master = await _make_master(client, db_session, BAND_MIN + 31)
        own_support = _comms_thread(
            str(uuid4()),
            operator_kind="section",
            client=master["user"]["id"],
            title="Where is my payout",
        )
        monkeypatch.setattr(
            _CHATS_SEAM,
            AsyncMock(
                return_value={"threads": [own_support], "next_cursor": None}
            ),
        )

        resp = await client.get(
            CHATS_URL, headers=auth_headers(master["session_token"]),
        )
        assert resp.json()["threads"] == []
        assert "Where is my payout" not in resp.text

    async def test_a_claimed_section_thread_is_dropped_by_the_same_predicate(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """THIS TESTS THE FILTER'S INPUT HANDLING, NOT A REACHABLE PRODUCT
        STATE -- and the distinction is deliberate.

        A master cannot claim a section thread today: the claim endpoint is
        admin-gated, and an admin is served by a different branch of
        list_chats entirely. So this row is not something the product can
        produce. What is being pinned is the PREDICATE: it decides on the
        thread's FORM, so a claimed section thread falls out exactly like
        an unclaimed one, with no second rule and no exception to maintain.
        A claimed section thread would be just as unopenable (no projection
        row -> 404), so keeping it would only restore half the defect.
        """
        master = await _make_master(client, db_session, BAND_MIN + 32)
        claimed = _comms_thread(
            str(uuid4()),
            operator_kind="section",
            assignee=master["user"]["id"],
            unread=7,
        )
        monkeypatch.setattr(
            _CHATS_SEAM,
            AsyncMock(
                return_value={"threads": [claimed], "next_cursor": None}
            ),
        )

        resp = await client.get(
            CHATS_URL, headers=auth_headers(master["session_token"]),
        )
        assert resp.json()["threads"] == []

    async def test_unknown_form_and_missing_key_do_not_pass(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """Allowlist, not denylist: what we did not foresee stays out.

        Neither input occurs today -- comms' OperatorKind is closed and the
        thread shape is frozen -- so this pins the DIRECTION the predicate
        fails in. A denylist would admit both of these into a personal
        list, named and avatared, and we would learn about it from outside.
        """
        master = await _make_master(client, db_session, BAND_MIN + 33)
        future_form = _comms_thread(str(uuid4()), operator_kind="team")
        keyless = _comms_thread(str(uuid4()))
        del keyless["operator_kind"]
        mine = _comms_thread(str(uuid4()), unread=2)
        monkeypatch.setattr(
            _CHATS_SEAM,
            AsyncMock(
                return_value={
                    "threads": [future_form, keyless, mine],
                    "next_cursor": None,
                }
            ),
        )

        resp = await client.get(
            CHATS_URL, headers=auth_headers(master["session_token"]),
        )
        assert [r["id"] for r in resp.json()["threads"]] == [mine["id"]]

    async def test_a_page_filtered_to_zero_keeps_next_cursor_verbatim(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """The filter must not quietly redefine pagination: an emptied page
        still advances, and the cursor comes back exactly as comms sent it.
        (The short-page consequence itself is a KNOWN CEILING on the filter
        -- harmless until the master list gains paged loading.)"""
        master = await _make_master(client, db_session, BAND_MIN + 34)
        monkeypatch.setattr(
            _CHATS_SEAM,
            AsyncMock(
                return_value={
                    "threads": [
                        _comms_thread(str(uuid4()), operator_kind="section"),
                        _comms_thread(str(uuid4()), operator_kind="section"),
                    ],
                    "next_cursor": "opaque-cursor-from-comms",
                }
            ),
        )

        resp = await client.get(
            CHATS_URL, headers=auth_headers(master["session_token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["threads"] == []
        assert body["next_cursor"] == "opaque-cursor-from-comms"

    async def test_repeated_request_filters_identically(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """The predicate is pure: asking twice answers twice the same, and
        applying it is not something that can happen 'more'."""
        master = await _make_master(client, db_session, BAND_MIN + 35)
        # Built ONCE: _comms_thread mints fresh client/operator uuids per
        # call, and rebuilding per request would compare the fixture's
        # randomness instead of the filter's determinism.
        page = {
            "threads": [
                _comms_thread(
                    "11111111-1111-4111-8111-111111111111",
                    operator_kind="section",
                ),
                _comms_thread(
                    "22222222-2222-4222-8222-222222222222", unread=1,
                ),
            ],
            "next_cursor": None,
        }
        monkeypatch.setattr(
            _CHATS_SEAM,
            AsyncMock(side_effect=lambda *a, **k: deepcopy(page)),
        )
        headers = auth_headers(master["session_token"])

        first = await client.get(CHATS_URL, headers=headers)
        second = await client.get(CHATS_URL, headers=headers)
        assert first.json() == second.json()
        assert len(first.json()["threads"]) == 1

    async def test_malformed_payloads_do_not_take_the_list_down(
        self, client: AsyncClient, db_session: AsyncSession, monkeypatch
    ) -> None:
        """Missing pieces are survived, not asserted away: the filter is as
        defensive as the enrichment it guards."""
        master = await _make_master(client, db_session, BAND_MIN + 36)
        for payload in (
            {"threads": [], "next_cursor": None},
            {"threads": "not-a-list"},
            {"threads": [None, "junk"], "next_cursor": None},
            {},
        ):
            monkeypatch.setattr(_CHATS_SEAM, AsyncMock(return_value=payload))
            resp = await client.get(
                CHATS_URL, headers=auth_headers(master["session_token"]),
            )
            assert resp.status_code == 200, payload


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
