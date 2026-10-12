# =============================================================================
# VELO Backend -- Tests: BE-140 -- MCP phase 2: save_to_diary, book_practice,
# cancel_my_booking, the prompts
# =============================================================================
#
# telegram_id band: 88600-88659. Declared module-level below as
# _TID_MIN/_TID_MAX, ONCE. Checked free on 2ba6512: free_windows() over the
# allowed space returned (88600, 88999) among others, and no test file names
# an id in 88600-88659 (grepped). Every test has its own ids.
#
# The /mcp plumbing (fresh app per test behind the real route, JSON-RPC
# helpers, users, practices) is imported from test_mcp_server.py -- one copy.
#
# Coverage:
#   - tools/list: seven tools, the write tools' annotations; prompts/list and
#     prompts/get return the PROMPTS constant;
#   - save_to_diary: the entry in the app's feed and entry API with
#     created_via=mcp (an app entry says app); REST's own refusals; the
#     request_id grid (repeat, different content, absent, another student,
#     bad keys) and its race (one row, both answers the same entry);
#   - book_practice / cancel_my_booking against REST on the same inputs:
#     same codes and messages, same outbox events by kind and recipients;
#     a paid practice -> payment_required, balance and rows untouched;
#   - budgets: actions 10/h, diary 30/h, reads untouched; scope; audit with
#     source and token id and no form of the token; one connection at a time.
#
# NOT BUILT: the quality of the summary a model writes from the prompt --
# the owner's live check in claude.ai.
# =============================================================================

import asyncio
import hashlib
from collections import Counter
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import AuditLog
from app.core.database import get_session_factory
from app.core.events.models import OutboxEvent
from app.core.redis import get_redis
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.diary import service as diary_service
from app.modules.diary.models import DiaryEntry
from app.modules.mcp.server import PROMPTS
from app.modules.payments.models import Purchase
from app.modules.practices.models import PracticeStatus
from app.modules.users.models import User
from tests.helpers import full_cleanup_range
from tests.test_be146_one_connection_per_request import _watch_pool
from tests.test_mcp_server import (  # noqa: F401 -- `mcp` is a fixture
    TOKENS_URL,
    _book,
    _call,
    _master,
    _practice,
    _rpc,
    _student,
    mcp,
)

_TID_MIN = 88600
_TID_MAX = 88659

# Every test here talks to /mcp: the fixture is on for the whole module.
pytestmark = pytest.mark.usefixtures("mcp")

WRITE_TOOLS = {"save_to_diary", "book_practice", "cancel_my_booking"}
ALL_TOOLS = WRITE_TOOLS | {
    "get_my_calendar",
    "search_practices",
    "get_practice",
    "read_my_diary",
}


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession):
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


async def _token_id(client: AsyncClient, headers: dict) -> str:
    return (await client.get(TOKENS_URL, headers=headers)).json()["items"][0]["id"]


async def _audit(event: str, target_id) -> list[AuditLog]:
    async with get_session_factory()() as s:
        return list(
            (
                await s.execute(
                    select(AuditLog).where(
                        AuditLog.event == event,
                        AuditLog.target_id == UUID(str(target_id)),
                    )
                )
            ).scalars()
        )


def _future(days: float = 2) -> datetime:
    return datetime.now(UTC) + timedelta(days=days)


async def _rest_cancel(client: AsyncClient, booking_id, headers: dict):
    """The app's cancel: DELETE /api/v1/bookings/{id}."""
    return await client.delete(f"/api/v1/bookings/{booking_id}", headers=headers)


# ---------------------------------------------------------------------------
# Listing: tools, annotations, prompts
# ---------------------------------------------------------------------------


async def test_seven_tools_three_of_them_write_with_their_annotations(
    client: AsyncClient,
) -> None:
    _, _, token = await _student(client, 88600)
    tools = {
        t["name"]: t
        for t in (await _rpc(client, "tools/list", token=token)).json()["result"][
            "tools"
        ]
    }
    assert set(tools) == ALL_TOOLS
    expected = {
        "save_to_diary": (False, False, True),
        "book_practice": (False, False, True),
        "cancel_my_booking": (False, True, True),
    }
    for name, (ro, destructive, idem) in expected.items():
        ann = tools[name]["annotations"]
        assert ann["readOnlyHint"] is ro, name
        assert ann["destructiveHint"] is destructive, name
        assert ann["idempotentHint"] is idem, name


async def test_the_prompts_are_listed_and_are_the_constant(client: AsyncClient) -> None:
    _, _, token = await _student(client, 88601)
    listed = (await _rpc(client, "prompts/list", token=token)).json()["result"][
        "prompts"
    ]
    assert (
        {p["name"] for p in listed}
        == set(PROMPTS)
        == {
            "save_conversation_summary",
            "plan_my_week",
        }
    )
    for name, prompt in PROMPTS.items():
        got = (await _rpc(client, "prompts/get", {"name": name}, token=token)).json()
        messages = got["result"]["messages"]
        assert messages[0]["content"]["text"] == prompt["text"], name
        assert "--" not in prompt["text"] and "—" in prompt["text"], name
    assert "save_to_diary" in PROMPTS["save_conversation_summary"]["text"]
    assert "request_id" in PROMPTS["save_conversation_summary"]["text"]
    assert "подтвержу" in PROMPTS["plan_my_week"]["text"]


# ---------------------------------------------------------------------------
# save_to_diary
# ---------------------------------------------------------------------------


async def test_a_saved_summary_is_in_the_apps_feed_marked_mcp(
    client: AsyncClient,
) -> None:
    _, headers, token = await _student(client, 88602)
    is_error, body = await _call(
        client,
        token,
        "save_to_diary",
        {
            "content": "Думал о дыхании. Вывод: начать утром.",
            "title": "Итог",
            "mood": 7,
        },
    )
    assert not is_error, body
    entry = body["entry"]
    assert body["replayed"] is False
    assert entry["created_via"] == "mcp" and entry["title"] == "Итог"
    assert entry["content_preview"].startswith("Думал о дыхании")
    assert entry["created_at"]["local"] and entry["created_at"]["utc"]

    feed = (await client.get("/api/v1/diary/feed", headers=headers)).json()["items"]
    item = next(i for i in feed if i["source_id"] == entry["id"])
    assert item["kind"] == "note" and item["snapshot"]["created_via"] == "mcp"
    rest = (await client.get(f"/api/v1/diary/{entry['id']}", headers=headers)).json()
    assert rest["created_via"] == "mcp"

    # Pair: an entry written in the app says app, in both places.
    app_entry = (
        await client.post(
            "/api/v1/diary", json={"content": "из приложения"}, headers=headers
        )
    ).json()
    assert app_entry["created_via"] == "app"
    feed = (await client.get("/api/v1/diary/feed", headers=headers)).json()["items"]
    assert (
        next(i for i in feed if i["source_id"] == app_entry["id"])["snapshot"][
            "created_via"
        ]
        == "app"
    )


async def test_save_refuses_exactly_what_rest_refuses(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    master_id = await _master(client, db_session, 88603)
    user_id, headers, token = await _student(client, 88604)
    unbooked = await _practice(db_session, master_id, scheduled_at=_future())
    await db_session.commit()

    schema_cases = [
        {"content": ""},
        {"content": "x" * 10001},
        {"content": "ok", "title": "t" * 201},
        {"content": "ok", "mood": 11},
        {"content": "ok", "mood": 0},
    ]
    for args in schema_cases:
        rest = await client.post("/api/v1/diary", json=args, headers=headers)
        assert rest.status_code == 422, args
        is_error, body = await _call(client, token, "save_to_diary", args)
        assert is_error and body["error"] == "validation_error", args
        assert (
            args.get("content", "")[:20] not in body["message"] or not args["content"]
        )

    for pid in (str(unbooked.id), str(uuid4())):
        args = {"content": "ok", "practice_id": pid}
        rest = (await client.post("/api/v1/diary", json=args, headers=headers)).json()
        is_error, body = await _call(client, token, "save_to_diary", args)
        assert is_error and (body["error"], body["message"]) == (
            rest["error"],
            rest["message"],
        ), pid

    count = (
        select(func.count())
        .select_from(DiaryEntry)
        .where(DiaryEntry.user_id == user_id)
    )
    assert (await db_session.execute(count)).scalar_one() == 0


async def test_request_id_makes_a_retry_the_same_entry(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, _, token = await _student(client, 88605)
    _, _, other_token = await _student(client, 88606)
    key = str(uuid4())
    args = {"content": "итог", "title": "t", "request_id": key}

    _, first = await _call(client, token, "save_to_diary", args)
    _, again = await _call(client, token, "save_to_diary", args)
    assert again["replayed"] is True
    assert again["entry"]["id"] == first["entry"]["id"]
    assert len(await _audit("mcp_diary_entry_saved", first["entry"]["id"])) == 1

    is_error, body = await _call(
        client, token, "save_to_diary", {**args, "content": "другой текст"}
    )
    assert is_error and body["error"] == "request_id_reused"

    # The same key is another student's own.
    _, theirs = await _call(client, other_token, "save_to_diary", args)
    assert theirs["replayed"] is False and theirs["entry"]["id"] != first["entry"]["id"]

    # No key: a new entry every time.
    _, a = await _call(client, token, "save_to_diary", {"content": "без ключа"})
    _, b = await _call(client, token, "save_to_diary", {"content": "без ключа"})
    assert a["entry"]["id"] != b["entry"]["id"]

    # Bad keys never reach the index ("" would be a value there, not "none").
    for bad in ("", "with space", "x" * 129, "ключ"):
        is_error, _ = await _call(
            client, token, "save_to_diary", {"content": "c", "request_id": bad}
        )
        assert is_error, bad

    mine = (
        select(func.count())
        .select_from(DiaryEntry)
        .where(DiaryEntry.user_id == user_id)
    )
    assert (await db_session.execute(mine)).scalar_one() == 3


async def test_two_racing_saves_with_one_request_id_make_one_entry(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The first save is paused inside its transaction after its INSERT (in
    the service's own audit call); the second's INSERT must wait on the
    unique index, then fail on the first's commit and read its entry."""
    user_id, _, token = await _student(client, 88607)
    key = str(uuid4())
    args = {"content": "гонка", "request_id": key}
    paused, release = asyncio.Event(), asyncio.Event()
    original = diary_service.record_audit
    calls = 0

    async def pausing(*a, **k):
        nonlocal calls
        calls += 1
        if calls == 1:
            paused.set()
            await release.wait()
        return await original(*a, **k)

    monkeypatch.setattr(diary_service, "record_audit", pausing)
    first = asyncio.create_task(_call(client, token, "save_to_diary", args))
    await asyncio.wait_for(paused.wait(), timeout=10)
    second = asyncio.create_task(_call(client, token, "save_to_diary", args))

    waited = False
    for _ in range(200):
        async with get_session_factory()() as s:
            n = (
                await s.execute(
                    text(
                        "SELECT count(*) FROM pg_stat_activity "
                        "WHERE wait_event_type = 'Lock' "
                        "AND query ILIKE 'INSERT INTO diary_entries%'"
                    )
                )
            ).scalar_one()
        if n:
            waited = True
            break
        await asyncio.sleep(0.05)
    release.set()
    (e1, r1), (e2, r2) = await asyncio.gather(first, second)

    assert waited, "the second save never met the first one's index entry"
    assert not e1 and not e2, (r1, r2)
    assert r1["entry"]["id"] == r2["entry"]["id"]
    assert {r1["replayed"], r2["replayed"]} == {False, True}
    async with get_session_factory()() as s:
        rows = (
            await s.execute(
                select(func.count())
                .select_from(DiaryEntry)
                .where(DiaryEntry.user_id == user_id, DiaryEntry.request_id == key)
            )
        ).scalar_one()
    assert rows == 1


# ---------------------------------------------------------------------------
# book_practice / cancel_my_booking against REST
# ---------------------------------------------------------------------------


async def _outbox_since(mark: datetime, roles: dict[str, str]) -> Counter:
    """Outbox events since `mark`, as (kind, recipient roles): a role is any
    of the given ids found anywhere in the payload -- no key is assumed."""
    async with get_session_factory()() as s:
        rows = (
            await s.execute(select(OutboxEvent).where(OutboxEvent.created_at >= mark))
        ).scalars()
        found = Counter()
        for row in rows:
            blob = str(row.payload)
            who = tuple(sorted(role for uid, role in roles.items() if uid in blob))
            if who:
                found[(row.event_type, who)] += 1
        return found


async def test_booking_and_cancelling_notify_exactly_as_the_app(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    master_id = await _master(client, db_session, 88608)
    rest_user, rest_headers, _ = await _student(client, 88609)
    mcp_user, mcp_headers, token = await _student(client, 88610)
    p_rest = await _practice(db_session, master_id, scheduled_at=_future())
    p_mcp = await _practice(db_session, master_id, scheduled_at=_future())
    await db_session.commit()

    mark = datetime.now(UTC)
    rest = await client.post(
        f"/api/v1/practices/{p_rest.id}/purchase", headers=rest_headers
    )
    assert rest.status_code == 201, rest.text
    rest_events = await _outbox_since(
        mark, {str(rest_user): "student", str(master_id): "master"}
    )
    mark = datetime.now(UTC)
    is_error, booked = await _call(
        client, token, "book_practice", {"practice_id": str(p_mcp.id)}
    )
    assert not is_error, booked
    mcp_events = await _outbox_since(
        mark, {str(mcp_user): "student", str(master_id): "master"}
    )
    assert mcp_events == rest_events and mcp_events

    assert booked["status"] == "confirmed" and booked["practice"]["id"] == str(p_mcp.id)
    mine = (await client.get("/api/v1/bookings/me", headers=mcp_headers)).json()[
        "items"
    ]
    assert [b["id"] for b in mine] == [booked["booking_id"]]
    [audit] = await _audit("mcp_booking_created", booked["booking_id"])
    assert audit.data["source"] == "mcp" and audit.data["tool"] == "book_practice"

    rest_booking = (
        await client.get("/api/v1/bookings/me", headers=rest_headers)
    ).json()["items"][0]["id"]
    mark = datetime.now(UTC)
    assert (await _rest_cancel(client, rest_booking, rest_headers)).status_code == 200
    rest_events = await _outbox_since(
        mark, {str(rest_user): "student", str(master_id): "master"}
    )
    mark = datetime.now(UTC)
    is_error, cancelled = await _call(
        client, token, "cancel_my_booking", {"booking_id": booked["booking_id"]}
    )
    assert not is_error and cancelled["status"] == "cancelled", cancelled
    mcp_events = await _outbox_since(
        mark, {str(mcp_user): "student", str(master_id): "master"}
    )
    assert mcp_events == rest_events
    assert len(await _audit("mcp_booking_cancelled", booked["booking_id"])) == 1


async def test_booking_refuses_exactly_what_the_app_refuses(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """One input, three doors: POST /bookings, POST .../purchase, the tool.
    Each case is run on fresh rows for each door so no door changes the
    next one's state."""
    master_id = await _master(client, db_session, 88611)
    # «Students» audience = anyone with a live booking on THIS master's
    # practices; the "already" case makes our student one. The hidden case
    # therefore uses a master the student has never booked.
    stranger_id = await _master(client, db_session, 88625)
    user_id, headers, token = await _student(client, 88612)
    other_id, _, _ = await _student(client, 88613)

    async def case(kind: str):
        if kind == "full":
            p = await _practice(
                db_session, master_id, scheduled_at=_future(), max_participants=1
            )
            await _book(db_session, other_id, p, BookingStatus.CONFIRMED.value)
        elif kind == "already":
            p = await _practice(db_session, master_id, scheduled_at=_future())
            await _book(db_session, user_id, p, BookingStatus.CONFIRMED.value)
        elif kind == "started":
            p = await _practice(db_session, master_id, scheduled_at=_future(-0.01))
        elif kind == "draft":
            p = await _practice(
                db_session,
                master_id,
                scheduled_at=_future(),
                status=PracticeStatus.DRAFT.value,
            )
        elif kind == "hidden":
            p = await _practice(
                db_session,
                stranger_id,
                scheduled_at=_future(),
                audience_kind="students",
            )
        await db_session.commit()
        return str(p.id)

    for kind in ("full", "already", "started", "draft", "hidden", "missing"):
        answers = []
        for door in ("bookings", "purchase", "tool"):
            pid = str(uuid4()) if kind == "missing" else await case(kind)
            if door == "bookings":
                r = await client.post(
                    "/api/v1/bookings", json={"practice_id": pid}, headers=headers
                )
                answers.append((r.json()["error"], r.json()["message"]))
            elif door == "purchase":
                r = await client.post(
                    f"/api/v1/practices/{pid}/purchase", headers=headers
                )
                answers.append((r.json()["error"], r.json()["message"]))
            else:
                is_error, body = await _call(
                    client, token, "book_practice", {"practice_id": pid}
                )
                assert is_error, kind
                answers.append((body["error"], body["message"]))
                if kind == "full":
                    assert "waitlist" in body["hint"]
        assert len(set(answers)) == 1, (kind, answers)


async def test_a_paid_practice_is_refused_and_nothing_moves(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    master_id = await _master(client, db_session, 88614)
    user_id, _, token = await _student(client, 88615)
    paid = await _practice(db_session, master_id, scheduled_at=_future())
    paid.is_free, paid.price_cents = False, 500
    hidden_paid = await _practice(
        db_session, master_id, scheduled_at=_future(), audience_kind="students"
    )
    hidden_paid.is_free, hidden_paid.price_cents = False, 500
    await db_session.execute(
        update(User).where(User.id == user_id).values(balance_cents=10_000)
    )
    await db_session.commit()

    is_error, body = await _call(
        client, token, "book_practice", {"practice_id": str(paid.id)}
    )
    assert is_error and body["error"] == "payment_required"
    async with get_session_factory()() as s:
        assert (await s.get(User, user_id)).balance_cents == 10_000
        assert (
            await s.execute(
                select(func.count())
                .select_from(Booking)
                .where(Booking.user_id == user_id)
            )
        ).scalar_one() == 0
        assert (
            await s.execute(
                select(func.count())
                .select_from(Purchase)
                .where(Purchase.user_id == user_id)
            )
        ).scalar_one() == 0

    # Hidden AND paid: the app's own refusal, not a hint that it is paid.
    _, body = await _call(
        client, token, "book_practice", {"practice_id": str(hidden_paid.id)}
    )
    assert body["error"] != "payment_required"


async def test_cancel_reaches_only_own_bookings_and_repeats_like_rest(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    master_id = await _master(client, db_session, 88616)
    _, headers, token = await _student(client, 88617)
    other_id, _, _ = await _student(client, 88618)
    p = await _practice(db_session, master_id, scheduled_at=_future())
    theirs = await _book(db_session, other_id, p, BookingStatus.CONFIRMED.value)
    await db_session.commit()

    _, missing = await _call(
        client, token, "cancel_my_booking", {"booking_id": str(uuid4())}
    )
    _, foreign = await _call(
        client, token, "cancel_my_booking", {"booking_id": str(theirs.id)}
    )
    assert (missing["error"], missing["message"]) == (
        foreign["error"],
        foreign["message"],
    )
    async with get_session_factory()() as s:
        assert (await s.get(Booking, theirs.id)).status == BookingStatus.CONFIRMED.value

    _, booked = await _call(client, token, "book_practice", {"practice_id": str(p.id)})
    await _call(
        client, token, "cancel_my_booking", {"booking_id": booked["booking_id"]}
    )
    rest = (await _rest_cancel(client, booked["booking_id"], headers)).json()
    is_error, again = await _call(
        client, token, "cancel_my_booking", {"booking_id": booked["booking_id"]}
    )
    assert is_error and (again["error"], again["message"]) == (
        rest["error"],
        rest["message"],
    )


# ---------------------------------------------------------------------------
# Budgets, scope, audit, connections
# ---------------------------------------------------------------------------


async def test_action_and_diary_budgets_are_separate_from_reads(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    _, headers, token = await _student(client, 88619)
    token_id = await _token_id(client, headers)
    redis = get_redis()
    await redis.set(f"mcp:act:{token_id}", 10, ex=3600)
    await redis.set(f"mcp:diary:{token_id}", 29, ex=3600)

    is_error, body = await _call(
        client, token, "book_practice", {"practice_id": str(uuid4())}
    )
    assert is_error and body["error"] == "rate_limited"
    assert 0 < body["retry_after_seconds"] <= 3600
    is_error, body = await _call(
        client, token, "cancel_my_booking", {"booking_id": str(uuid4())}
    )
    assert body["error"] == "rate_limited"  # one budget for both

    is_error, _ = await _call(client, token, "save_to_diary", {"content": "30-я"})
    assert not is_error
    is_error, body = await _call(client, token, "save_to_diary", {"content": "31-я"})
    assert is_error and body["error"] == "rate_limited"

    is_error, _ = await _call(client, token, "get_my_calendar")
    assert not is_error  # reads keep their own budget
    for key in ("act", "diary", "read"):
        await redis.delete(f"mcp:{key}:{token_id}")


async def test_write_scopes_are_checked_and_spend_nothing(client: AsyncClient) -> None:
    _, headers, token = await _student(client, 88620, scopes=["read"])
    token_id = await _token_id(client, headers)
    for tool, args, scope in (
        ("save_to_diary", {"content": "c"}, "diary:write"),
        ("book_practice", {"practice_id": str(uuid4())}, "bookings:write"),
        ("cancel_my_booking", {"booking_id": str(uuid4())}, "bookings:write"),
    ):
        is_error, body = await _call(client, token, tool, args)
        assert (
            is_error and body["error"] == "scope_missing" and scope in body["message"]
        )
    redis = get_redis()
    assert await redis.get(f"mcp:act:{token_id}") is None
    assert await redis.get(f"mcp:diary:{token_id}") is None


async def test_every_action_is_audited_with_source_and_no_form_of_the_token(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    master_id = await _master(client, db_session, 88621)
    user_id, headers, token = await _student(client, 88622)
    token_id = await _token_id(client, headers)
    p = await _practice(db_session, master_id, scheduled_at=_future())
    await db_session.commit()

    _, saved = await _call(
        client, token, "save_to_diary", {"content": "c", "request_id": "k1"}
    )
    _, booked = await _call(client, token, "book_practice", {"practice_id": str(p.id)})
    await _call(
        client, token, "cancel_my_booking", {"booking_id": booked["booking_id"]}
    )

    rows = (
        await _audit("mcp_diary_entry_saved", saved["entry"]["id"])
        + await _audit("mcp_booking_created", booked["booking_id"])
        + await _audit("mcp_booking_cancelled", booked["booking_id"])
    )
    assert len(rows) == 3
    for row in rows:
        assert row.actor_id == user_id and row.data["source"] == "mcp"
        assert row.data["token_id"] == token_id
    prefix, secret = token.split("_", 3)[2], token.split("_", 3)[3]
    forms = (token, secret, prefix, hashlib.sha256(token.encode()).hexdigest())
    async with get_session_factory()() as s:
        blob = (
            await s.execute(
                text(
                    "SELECT string_agg(a::text, ' ') FROM audit_logs a "
                    "WHERE a.actor_id = :u"
                ),
                {"u": user_id},
            )
        ).scalar_one()
    assert token_id in blob
    for form in forms:
        assert form not in blob


async def test_a_write_call_holds_one_pooled_connection_at_a_time(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """book_practice uses three sessions -- verification, the paid precheck,
    the write -- one after another, never two at once."""
    master_id = await _master(client, db_session, 88623)
    _, _, token = await _student(client, 88624)
    p = await _practice(db_session, master_id, scheduled_at=_future())
    await db_session.commit()
    with _watch_pool() as watch:
        is_error, body = await _call(
            client, token, "book_practice", {"practice_id": str(p.id)}
        )
    assert not is_error, body
    assert watch.checkouts >= 3
    assert watch.peak_extra == 1
    assert watch.held_after == 0


async def test_paid_is_refused_before_the_balance_is_even_looked_at(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Zero balance: without the precheck the service would answer
    insufficient_balance -- the refusal is about paying, not about money."""
    master_id = await _master(client, db_session, 88626)
    _, _, token = await _student(client, 88627)
    paid = await _practice(db_session, master_id, scheduled_at=_future())
    paid.is_free, paid.price_cents = False, 500
    await db_session.commit()
    _, body = await _call(client, token, "book_practice", {"practice_id": str(paid.id)})
    assert body["error"] == "payment_required"


async def test_a_practice_turned_paid_after_the_precheck_is_still_refused(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The guard inside the transaction. The precheck sees a free practice;
    it turns paid before create_booking takes its lock (simulated in the
    write session itself). The purchase charges -- the guard refuses and the
    whole booking rolls back: balance, booking, purchase, outbox."""
    from app.modules.bookings import service as bookings_service
    from app.modules.practices.models import Practice

    master_id = await _master(client, db_session, 88628)
    user_id, _, token = await _student(client, 88629)
    p = await _practice(db_session, master_id, scheduled_at=_future())
    await db_session.execute(
        update(User).where(User.id == user_id).values(balance_cents=10_000)
    )
    await db_session.commit()

    original = bookings_service.create_booking

    async def turned_paid(user, practice_id, session, *a, **k):
        await session.execute(
            update(Practice)
            .where(Practice.id == practice_id)
            .values(is_free=False, price_cents=500)
        )
        return await original(user, practice_id, session, *a, **k)

    monkeypatch.setattr(bookings_service, "create_booking", turned_paid)
    mark = datetime.now(UTC)
    _, body = await _call(client, token, "book_practice", {"practice_id": str(p.id)})
    assert body["error"] == "payment_required"
    async with get_session_factory()() as s:
        assert (await s.get(User, user_id)).balance_cents == 10_000
        assert (await s.get(Practice, p.id)).is_free is True  # rolled back too
        n = (
            await s.execute(
                select(func.count())
                .select_from(Booking)
                .where(Booking.user_id == user_id)
            )
        ).scalar_one()
        assert n == 0
    assert (
        await _outbox_since(mark, {str(user_id): "student", str(master_id): "master"})
        == Counter()
    )
