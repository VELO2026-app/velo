# =============================================================================
# VELO Backend -- Tests: BE-139 -- the /mcp door and its four read tools
# =============================================================================
#
# telegram_id band: 89068-89099. Declared module-level below as
# _TID_MIN/_TID_MAX, ONCE. Checked free before it was claimed on 5a72cda:
# free_windows() returned [(89068, 89099), (89860, 89869)]. Every test has
# its own ids.
#
# Requests go through the REAL FastAPI app and its real /mcp route; only the
# route's endpoint is swapped for a fresh build_mcp_app() per test, whose
# session manager runs for that test (run() is once per instance, and the
# test client does not run main.py's lifespan).
#
# Coverage:
#   - the gate: killswitch, public host, every bad credential -> one 401,
#     the Authorization header cut out before the SDK, the caller handed on;
#   - tools/list: four tools, readOnlyHint + idempotentHint;
#   - one pooled connection at a time per tool call (BE-146 rule, measured:
#     the BE-146 static test cannot see this app);
#   - scope_missing, rate_limited at the 61st call, rate_limit_unavailable;
#   - each tool against its REST twin: same student, same arguments -> same
#     rows; whitelisted fields; no master text in the search; texts cut with
#     a flag in get_practice; invisible -> REST's own refusal; another
#     student's data unreachable; the student's zone in the local times;
#   - the calendar window of list_user_bookings, and REST unchanged without;
#   - input value sets derived from REST's OpenAPI and compared.
#
# NOT BUILT: a live MCP client (owner's check after deploy, README in the
# report); a worker restart between calls -- the transport is stateless by
# construction (no session id is issued or required, asserted below).
# =============================================================================

import asyncio
import json
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from redis.exceptions import RedisError
from sqlalchemy import text, update
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.routing import Route

from app.core.config import settings
from app.core.redis import get_redis
from app.main import app
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.bookings.service import list_user_bookings
from app.modules.diary.models import DiaryEvent
from app.modules.masters.models import MasterProfile
from app.modules.mcp import server as mcp_server
from app.modules.mcp.server import MCP_PATH, McpGate, build_mcp_app
from app.modules.practices.models import Practice, PracticeStatus, PracticeType
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user
from tests.test_be146_one_connection_per_request import _watch_pool

_TID_MIN = 89068
_TID_MAX = 89099

TOKENS_URL = "/api/v1/users/me/mcp-tokens"
MCP_HEADERS = {
    "Accept": "application/json, text/event-stream",
    "Content-Type": "application/json",
}
MARKER = "MASTER-TEXT-MARKER-7d1f"
READ_TOOLS = {"get_my_calendar", "search_practices", "get_practice", "read_my_diary"}


# ---------------------------------------------------------------------------
# Fixtures and helpers
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


@pytest.fixture
async def mcp(monkeypatch: pytest.MonkeyPatch):
    """A fresh /mcp behind the real app's real route, running for this test.

    run() opens an anyio task group, which must be left in the task that
    entered it; pytest-asyncio sets a fixture up and tears it down in two
    different tasks. So run() lives whole inside one background task, and
    the fixture only tells it when to stop.
    """
    fresh = build_mcp_app()
    route = next(
        r for r in app.router.routes if isinstance(r, Route) and r.path == MCP_PATH
    )
    monkeypatch.setattr(route, "app", fresh.asgi)
    started, stop = asyncio.Event(), asyncio.Event()

    async def runner() -> None:
        async with fresh.session_manager.run():
            started.set()
            await stop.wait()

    task = asyncio.create_task(runner())
    await asyncio.wait_for(started.wait(), timeout=10)
    yield fresh
    stop.set()
    await task


async def _student(
    client: AsyncClient, tid: int, *, scopes: list[str] | None = None
) -> tuple[UUID, dict, str]:
    """A signed-in user with one MCP token: (user id, session headers, token)."""
    auth = await login_user(client, telegram_id=tid, first_name="Ученик")
    headers = auth_headers(auth["session_token"])
    body = {"name": f"t{tid}"} | ({"scopes": scopes} if scopes else {})
    resp = await client.post(TOKENS_URL, json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    return UUID(auth["user"]["id"]), headers, resp.json()["token"]


async def _rpc(client: AsyncClient, method: str, params: dict | None = None, **kw):
    """One JSON-RPC request to /mcp. kw: token=..., headers=..., host=..."""
    headers = dict(MCP_HEADERS)
    if kw.get("token"):
        headers["Authorization"] = f"Bearer {kw['token']}"
    headers.update(kw.get("headers") or {})
    if kw.get("host"):
        headers["Host"] = kw["host"]
    body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
    return await client.post(kw.get("path", MCP_PATH), json=body, headers=headers)


async def _call(client: AsyncClient, token: str, tool: str, args: dict | None = None):
    """tools/call -> (is_error, structured content); the text is the same JSON."""
    resp = await _rpc(
        client, "tools/call", {"name": tool, "arguments": args or {}}, token=token
    )
    assert resp.status_code == 200, resp.text
    result = resp.json()["result"]
    structured = result.get("structuredContent")
    if structured is not None:
        assert json.loads(result["content"][0]["text"]) == structured
    return result.get(
        "isError", False
    ), structured if structured is not None else result


async def _master(client: AsyncClient, db: AsyncSession, tid: int) -> UUID:
    auth = await login_user(client, telegram_id=tid, first_name="Мастер")
    user_id = UUID(auth["user"]["id"])
    user = await db.get(User, user_id)
    user.role = UserRole.MASTER
    db.add(
        MasterProfile(
            user_id=user_id,
            data={"account": {"status": "verified"}, "profile": {"bio": "b"}},
        )
    )
    await db.flush()
    return user_id


async def _practice(db: AsyncSession, master_id: UUID, **kw) -> Practice:
    p = Practice(
        master_id=master_id,
        title=kw.get("title", "Практика"),
        description=kw.get("description", f"{MARKER} описание"),
        what_to_prepare=kw.get("what_to_prepare"),
        contraindications=kw.get("contraindications"),
        practice_type=PracticeType.LIVE.value,
        status=kw.get("status", PracticeStatus.SCHEDULED.value),
        scheduled_at=kw["scheduled_at"],
        duration_minutes=60,
        timezone="UTC",
        max_participants=kw.get("max_participants", 10),
        current_participants=kw.get("current_participants", 0),
        is_free=True,
        price_cents=0,
        currency="eur",
        audience_kind=kw.get("audience_kind", "public"),
    )
    db.add(p)
    await db.flush()
    return p


async def _book(
    db: AsyncSession, user_id: UUID, practice: Practice, status: str
) -> Booking:
    b = Booking(practice_id=practice.id, user_id=user_id, status=status)
    db.add(b)
    await db.flush()
    return b


async def _note(
    db: AsyncSession, user_id: UUID, text_: str, ago: timedelta
) -> DiaryEvent:
    e = DiaryEvent(
        user_id=user_id,
        kind="note",
        occurred_at=datetime.now(UTC) - ago,
        source_type="diary_entry",
        source_id=uuid4(),
        snapshot={"title": text_, "content_preview": text_},
        text_search=text_,
    )
    db.add(e)
    await db.flush()
    return e


def _rest_path(fragment: str) -> str:
    return next(p for p in app.openapi()["paths"] if p.endswith(fragment))


# ---------------------------------------------------------------------------
# The gate
# ---------------------------------------------------------------------------


async def test_switched_off_mcp_is_the_apps_plain_404(
    client: AsyncClient, mcp, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, _, token = await _student(client, 89068)
    monkeypatch.setattr(settings, "mcp_enabled", False)
    for kw in ({}, {"token": token}):
        resp = await _rpc(client, "tools/list", **kw)
        assert resp.status_code == 404
        assert resp.json() == {"error": "not_found", "message": "Not found"}
    monkeypatch.setattr(settings, "mcp_enabled", True)
    assert (await _rpc(client, "tools/list", token=token)).status_code == 200


async def test_the_public_link_host_never_serves_mcp(
    client: AsyncClient, mcp, monkeypatch: pytest.MonkeyPatch
) -> None:
    """tz-mcp §3. Pair: the same request on the API host goes through."""
    _, _, token = await _student(client, 89069)
    monkeypatch.setattr(settings, "public_link_base", "https://go.velo.test")
    for host in ("go.velo.test", "GO.velo.test:443"):
        resp = await _rpc(client, "tools/list", token=token, host=host)
        assert resp.status_code == 404, host
    assert (
        await _rpc(client, "tools/list", token=token, host="api.velo.test")
    ).status_code == 200


async def test_every_bad_credential_gets_the_same_401(
    client: AsyncClient, mcp, db_session: AsyncSession
) -> None:
    user_id, headers, token = await _student(client, 89070)
    revoked_id = (await client.get(TOKENS_URL, headers=headers)).json()["items"][0][
        "id"
    ]

    async def raw(hdrs: list[tuple[str, str]], path: str = MCP_PATH):
        body = {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
        return await client.post(
            path, content=json.dumps(body), headers=[*MCP_HEADERS.items(), *hdrs]
        )

    cases = {
        "no header": [],
        "basic": [("Authorization", f"Basic {token}")],
        "scheme only": [("Authorization", "Bearer")],
        "empty token": [("Authorization", "Bearer ")],
        "two headers": [("Authorization", f"Bearer {token}")] * 2,
        "malformed": [("Authorization", "Bearer velo_pat_nope")],
        "session token": [
            ("Authorization", f"Bearer {headers['Authorization'].split()[1]}")
        ],
    }
    answers = []
    for label, hdrs in cases.items():
        resp = await raw(hdrs)
        assert resp.status_code == 401, label
        assert resp.headers["www-authenticate"].startswith("Bearer"), label
        assert token not in resp.text, label
        answers.append(resp.json())
    # Never from the URL.
    resp = await raw([], path=f"{MCP_PATH}?token={token}")
    assert resp.status_code == 401
    answers.append(resp.json())

    # Revoked, then a deactivated owner (a fresh token for that).
    await client.post(f"{TOKENS_URL}/{revoked_id}/revoke", headers=headers)
    answers.append((await raw([("Authorization", f"Bearer {token}")])).json())
    second = (
        await client.post(TOKENS_URL, json={"name": "second"}, headers=headers)
    ).json()
    await db_session.execute(
        update(User).where(User.id == user_id).values(is_active=False)
    )
    await db_session.commit()
    resp = await raw([("Authorization", f"Bearer {second['token']}")])
    assert resp.status_code == 401
    answers.append(resp.json())

    assert all(a == answers[0] for a in answers), answers


async def test_the_scheme_is_case_insensitive(client: AsyncClient, mcp) -> None:
    _, _, token = await _student(client, 89071)
    resp = await _rpc(
        client, "tools/list", headers={"Authorization": f"bearer {token}"}
    )
    assert resp.status_code == 200


async def test_the_gate_cuts_the_token_out_and_hands_the_caller_on(
    client: AsyncClient,
) -> None:
    """What the SDK receives: no Authorization header at all, and the caller
    the gate established."""
    user_id, _, token = await _student(client, 89072)
    seen: dict = {}

    async def inner(scope, receive, send):
        seen.update(scope)
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    gate = McpGate(inner)
    scope = {
        "type": "http",
        "method": "POST",
        "path": MCP_PATH,
        "headers": [
            (b"host", b"api.velo.test"),
            (b"authorization", f"Bearer {token}".encode()),
            (b"x-other", b"kept"),
        ],
    }
    sent = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        sent.append(message)

    await gate(scope, receive, send)
    assert sent[0]["status"] == 204
    assert all(k != b"authorization" for k, _ in seen["headers"])
    assert (b"x-other", b"kept") in seen["headers"]
    # Not repr(seen): User.__repr__ raises on a user loaded from the
    # database (role arrives as a str) -- see the report's observations.
    assert all(token not in v.decode("latin-1") for _, v in seen["headers"])
    assert set(seen["state"]) == {"mcp_caller"}
    caller = seen["state"]["mcp_caller"]
    assert caller.user.id == user_id and caller.scopes and caller.token_id


# ---------------------------------------------------------------------------
# Listing, statelessness, the connection rule
# ---------------------------------------------------------------------------


async def test_four_read_tools_carry_their_annotations_and_no_session_is_kept(
    client: AsyncClient, mcp
) -> None:
    _, _, token = await _student(client, 89073)
    resp = await _rpc(client, "tools/list", token=token)
    assert resp.status_code == 200
    assert "mcp-session-id" not in {k.lower() for k in resp.headers}
    tools = {t["name"]: t for t in resp.json()["result"]["tools"]}
    # Was `set(tools) == READ_TOOLS`: true for phase 1, which had only the
    # four. BE-140 added the write tools (their own test, test_mcp_actions);
    # what this test owns is that the four READ tools are there and marked
    # read-only.
    assert set(tools) >= READ_TOOLS
    for name in READ_TOOLS:
        tool = tools[name]
        ann = tool["annotations"]
        assert ann["readOnlyHint"] is True and ann["idempotentHint"] is True, name
        assert not ann.get("destructiveHint"), name


async def test_a_tool_call_holds_one_pooled_connection_at_a_time(
    client: AsyncClient, mcp
) -> None:
    """Verification (a write: last_used_at) in its own session, closed, then
    the tool's own session: two checkouts, never both at once."""
    _, _, token = await _student(client, 89074)
    with _watch_pool() as watch:
        is_error, _ = await _call(client, token, "get_my_calendar")
    assert not is_error
    assert watch.checkouts >= 2, "verification and the tool should each check out"
    assert watch.peak_extra == 1
    assert watch.held_after == 0


# ---------------------------------------------------------------------------
# Scope and rate limit
# ---------------------------------------------------------------------------


async def test_a_token_without_read_gets_scope_missing_and_spends_nothing(
    client: AsyncClient, mcp
) -> None:
    _, headers, token = await _student(client, 89075, scopes=["diary:write"])
    token_id = (await client.get(TOKENS_URL, headers=headers)).json()["items"][0]["id"]
    for tool in sorted(READ_TOOLS):
        args = {"practice_id": str(uuid4())} if tool == "get_practice" else {}
        is_error, body = await _call(client, token, tool, args)
        assert is_error and body["error"] == "scope_missing", tool
    assert await get_redis().get(f"mcp:read:{token_id}") is None


async def test_the_61st_call_in_a_window_is_rate_limited(
    client: AsyncClient, mcp
) -> None:
    """The 60th call passes, the 61st does not; listing does not count."""
    assert settings.mcp_read_calls_per_minute == 60
    _, headers, token = await _student(client, 89076)
    token_id = (await client.get(TOKENS_URL, headers=headers)).json()["items"][0]["id"]
    key = f"mcp:read:{token_id}"
    redis = get_redis()
    await redis.set(key, 59, ex=60)

    await _rpc(client, "tools/list", token=token)
    assert int(await redis.get(key)) == 59

    is_error, _ = await _call(client, token, "get_my_calendar")  # the 60th
    assert not is_error
    is_error, body = await _call(client, token, "get_my_calendar")  # the 61st
    assert is_error and body["error"] == "rate_limited"
    assert 0 < body["retry_after_seconds"] <= 60
    await redis.delete(key)


async def test_redis_down_refuses_the_read(
    client: AsyncClient, mcp, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, _, token = await _student(client, 89077)

    async def broken(*_a, **_k):
        raise RedisError("down")

    monkeypatch.setattr(mcp_server, "count_in_window", broken)
    is_error, body = await _call(client, token, "get_my_calendar")
    assert is_error and body["error"] == "rate_limit_unavailable"


# ---------------------------------------------------------------------------
# get_my_calendar and the window of list_user_bookings
# ---------------------------------------------------------------------------


async def test_the_calendar_reads_the_window_in_the_students_zone(
    client: AsyncClient, mcp, db_session: AsyncSession
) -> None:
    master_id = await _master(client, db_session, 89078)
    user_id, headers, token = await _student(client, 89079)
    await db_session.execute(
        update(User).where(User.id == user_id).values(timezone="Asia/Tokyo")
    )
    now = datetime.now(UTC)
    soon = await _practice(
        db_session, master_id, title="Скоро", scheduled_at=now + timedelta(days=2)
    )
    far = await _practice(
        db_session, master_id, title="Далеко", scheduled_at=now + timedelta(days=20)
    )
    past = await _practice(
        db_session,
        master_id,
        title="Было",
        status=PracticeStatus.COMPLETED.value,
        scheduled_at=now - timedelta(days=2),
    )
    b_soon = await _book(db_session, user_id, soon, BookingStatus.CONFIRMED.value)
    await _book(db_session, user_id, far, BookingStatus.CONFIRMED.value)
    b_past = await _book(db_session, user_id, past, BookingStatus.ATTENDED.value)
    await db_session.commit()

    is_error, body = await _call(client, token, "get_my_calendar")
    assert not is_error
    assert body["timezone"] == "Asia/Tokyo"
    assert [i["booking_id"] for i in body["items"]] == [str(b_soon.id)]
    item = body["items"][0]
    assert item["practice"]["scheduled_at"]["local"].endswith("+09:00")
    assert item["practice"]["scheduled_at"]["utc"].endswith("+00:00")
    assert set(item) == {
        "booking_id",
        "booking_status",
        "has_checkin",
        "has_feedback",
        "has_reflection",
        "practice",
    }
    assert "zoom" not in json.dumps(body)

    # Against REST: same booking, same status and master name.
    rest = (await client.get("/api/v1/bookings/me", headers=headers)).json()["items"]
    twin = next(r for r in rest if r["id"] == str(b_soon.id))
    assert item["booking_status"] == twin["status"]
    assert item["practice"]["master_name"] == twin["practice"]["master_name"]
    assert item["practice"]["title"] == twin["practice"]["title"]

    # include_past with a date in the past, earliest first.
    first_day = (now - timedelta(days=3)).date().isoformat()
    _, body = await _call(
        client, token, "get_my_calendar", {"date_from": first_day, "include_past": True}
    )
    assert [i["booking_id"] for i in body["items"]] == [str(b_past.id), str(b_soon.id)]

    is_error, body = await _call(
        client,
        token,
        "get_my_calendar",
        {"date_from": "2026-12-10", "date_to": "2026-12-01"},
    )
    assert is_error and body["error"] == "invalid_window"


async def test_list_user_bookings_without_a_window_is_what_rest_always_had(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """The pair for the new window: REST passes none, and gets every booking,
    newest booking first -- the order of creation, not of the practice."""
    master_id = await _master(client, db_session, 89080)
    auth = await login_user(client, telegram_id=89081, first_name="Ученик")
    user_id = UUID(auth["user"]["id"])
    now = datetime.now(UTC)
    late = await _practice(db_session, master_id, scheduled_at=now + timedelta(days=30))
    early = await _practice(db_session, master_id, scheduled_at=now + timedelta(days=1))
    b1 = await _book(db_session, user_id, late, BookingStatus.CONFIRMED.value)
    await db_session.commit()
    b2 = await _book(db_session, user_id, early, BookingStatus.CONFIRMED.value)
    await db_session.execute(
        text(
            "UPDATE bookings SET created_at = created_at + interval '1 second' "
            "WHERE id = :b"
        ),
        {"b": b2.id},
    )
    await db_session.commit()

    rest = (
        await client.get(
            "/api/v1/bookings/me", headers=auth_headers(auth["session_token"])
        )
    ).json()
    assert [i["id"] for i in rest["items"]] == [str(b2.id), str(b1.id)]
    assert rest["total"] == 2

    user = await db_session.get(User, user_id)
    rows, total = await list_user_bookings(
        user, db_session, scheduled_from=now, scheduled_to=now + timedelta(days=60)
    )
    assert [r[0].id for r in rows] == [b2.id, b1.id] and total == 2
    rows, total = await list_user_bookings(
        user, db_session, scheduled_from=now + timedelta(days=10)
    )
    assert [r[0].id for r in rows] == [b1.id] and total == 1


# ---------------------------------------------------------------------------
# search_practices and get_practice
# ---------------------------------------------------------------------------

_CORE_KEYS = {
    "id",
    "title",
    "scheduled_at",
    "duration_minutes",
    "status",
    "practice_type",
    "direction",
    "style",
    "difficulty",
    "master_id",
    "master_name",
    "max_participants",
    "current_participants",
    "free_places",
    "waitlist_only",
    "is_free",
    "price_cents",
    "currency",
    "is_booked",
    "is_paid",
}


async def test_the_search_is_the_apps_feed_without_master_texts(
    client: AsyncClient, mcp, db_session: AsyncSession
) -> None:
    master_id = await _master(client, db_session, 89082)
    _, headers, token = await _student(client, 89083)
    now = datetime.now(UTC)
    open_ = await _practice(
        db_session,
        master_id,
        scheduled_at=now + timedelta(days=1),
        what_to_prepare=f"{MARKER} коврик",
        contraindications=f"{MARKER} травмы",
    )
    full = await _practice(
        db_session,
        master_id,
        scheduled_at=now + timedelta(days=2),
        max_participants=2,
        current_participants=2,
    )
    hidden = await _practice(
        db_session,
        master_id,
        scheduled_at=now + timedelta(days=3),
        audience_kind="students",
    )
    await db_session.commit()

    args = {
        "date_from": now.isoformat(),
        "date_to": (now + timedelta(days=7)).isoformat(),
    }
    is_error, body = await _call(client, token, "search_practices", args)
    assert not is_error
    rest = (await client.get("/api/v1/practices", params=args, headers=headers)).json()
    rest_ids = [i["id"] for i in rest["items"]]
    tool_ids = [i["id"] for i in body["items"]]
    assert tool_ids == rest_ids
    assert body["total"] == rest["total"]
    assert str(open_.id) in tool_ids and str(full.id) in tool_ids
    assert str(hidden.id) not in tool_ids  # «для учеников» -- this student is not one

    assert MARKER not in json.dumps(body, ensure_ascii=False)
    for item in body["items"]:
        assert set(item) == _CORE_KEYS
    by_id = {i["id"]: i for i in body["items"]}
    assert (
        by_id[str(full.id)]["free_places"] == 0 and by_id[str(full.id)]["waitlist_only"]
    )
    assert (
        by_id[str(open_.id)]["free_places"] == 10
        and not by_id[str(open_.id)]["waitlist_only"]
    )
    twin = next(i for i in rest["items"] if i["id"] == str(open_.id))
    for key in ("title", "master_name", "duration_minutes", "is_booked", "status"):
        assert by_id[str(open_.id)][key] == twin[key], key


async def test_get_practice_gives_master_texts_apart_and_cut(
    client: AsyncClient, mcp, db_session: AsyncSession
) -> None:
    master_id = await _master(client, db_session, 89084)
    _, headers, token = await _student(client, 89085)
    limit = settings.mcp_master_text_max_chars
    assert limit == 2000
    p = await _practice(
        db_session,
        master_id,
        scheduled_at=datetime.now(UTC) + timedelta(days=1),
        description=MARKER + "x" * (limit + 1 - len(MARKER)),
        what_to_prepare="y" * limit,
        contraindications=None,
    )
    await db_session.commit()

    is_error, body = await _call(
        client, token, "get_practice", {"practice_id": str(p.id)}
    )
    assert not is_error
    assert set(body) == {
        "timezone",
        "practice",
        "master_description",
        "what_to_prepare",
        "contraindications",
    }
    assert set(body["practice"]) == _CORE_KEYS
    assert MARKER not in json.dumps(body["practice"], ensure_ascii=False)
    assert body["master_description"]["truncated"] is True
    assert len(body["master_description"]["text"]) == limit
    assert body["master_description"]["text"].startswith(MARKER)
    assert body["what_to_prepare"] == {"text": "y" * limit, "truncated": False}
    assert body["contraindications"] == {"text": None, "truncated": False}

    rest = (await client.get(f"/api/v1/practices/{p.id}", headers=headers)).json()
    for key in ("title", "master_name", "status", "max_participants", "is_booked"):
        assert body["practice"][key] == rest[key], key


async def test_a_practice_the_student_cannot_see_is_rests_own_refusal(
    client: AsyncClient, mcp, db_session: AsyncSession
) -> None:
    master_id = await _master(client, db_session, 89086)
    _, headers, token = await _student(client, 89087)
    hidden = await _practice(
        db_session,
        master_id,
        audience_kind="students",
        scheduled_at=datetime.now(UTC) + timedelta(days=1),
    )
    draft = await _practice(
        db_session,
        master_id,
        status=PracticeStatus.DRAFT.value,
        scheduled_at=datetime.now(UTC) + timedelta(days=1),
    )
    await db_session.commit()
    for pid in (hidden.id, draft.id, uuid4()):
        rest = await client.get(f"/api/v1/practices/{pid}", headers=headers)
        is_error, body = await _call(
            client, token, "get_practice", {"practice_id": str(pid)}
        )
        assert is_error, pid
        assert body["error"] == rest.json()["error"], pid
        assert MARKER not in json.dumps(body, ensure_ascii=False)


# ---------------------------------------------------------------------------
# read_my_diary
# ---------------------------------------------------------------------------


async def test_the_diary_is_the_students_own_feed(
    client: AsyncClient, mcp, db_session: AsyncSession
) -> None:
    user_id, headers, token = await _student(client, 89088)
    other_id, _, _ = await _student(client, 89089)
    await db_session.execute(
        update(User).where(User.id == user_id).values(timezone="Asia/Tokyo")
    )
    mine_old = await _note(db_session, user_id, "моя запись раньше", timedelta(hours=5))
    mine_new = await _note(db_session, user_id, "моя запись позже", timedelta(hours=1))
    hidden = await _note(db_session, user_id, "скрытая", timedelta(hours=2))
    hidden.is_hidden = True
    theirs = await _note(db_session, other_id, "чужая запись", timedelta(hours=3))
    await db_session.commit()

    is_error, body = await _call(client, token, "read_my_diary")
    assert not is_error
    ids = [i["id"] for i in body["items"]]
    assert ids[:2] == [str(mine_new.id), str(mine_old.id)]
    assert str(hidden.id) not in ids and str(theirs.id) not in ids
    assert body["items"][0]["occurred_at"]["local"].endswith("+09:00")

    rest = (await client.get(_rest_path("/diary/feed"), headers=headers)).json()
    assert ids == [i["id"] for i in rest["items"]]
    for mine, twin in zip(body["items"], rest["items"], strict=True):
        assert mine["snapshot"] == twin["snapshot"] and mine["kind"] == twin["kind"]

    _, found = await _call(client, token, "read_my_diary", {"search": "позже"})
    assert [i["id"] for i in found["items"]] == [str(mine_new.id)]


# ---------------------------------------------------------------------------
# Input: REST's value sets, derived from its OpenAPI
# ---------------------------------------------------------------------------


def _rest_param(path: str, name: str) -> dict:
    op = app.openapi()["paths"][path]["get"]
    return next(p for p in op["parameters"] if p["name"] == name)["schema"]


def _enum(schema: dict) -> set[str]:
    found: set[str] = set()
    stack = [schema]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            found.update(node.get("enum", []))
            if "const" in node:
                found.add(node["const"])
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)
    return found


async def test_tool_inputs_take_the_value_sets_rest_takes(
    client: AsyncClient, mcp
) -> None:
    _, _, token = await _student(client, 89090)
    tools = {
        t["name"]: t["inputSchema"]["properties"]
        for t in (await _rpc(client, "tools/list", token=token)).json()["result"][
            "tools"
        ]
    }
    search = tools["search_practices"]
    for name in ("duration_bucket", "time_of_day", "sort_by", "sort_order"):
        assert _enum(search[name]) == _enum(_rest_param("/api/v1/practices", name)), (
            name
        )
    diary_path = _rest_path("/diary/feed")
    assert _enum(tools["read_my_diary"]["category"]) == _enum(
        _rest_param(diary_path, "category")
    )

    # Ceilings: never above REST's; the tool's own is the accepted 50 (tz-mcp §6.3).
    for tool, path in (
        ("search_practices", "/api/v1/practices"),
        ("read_my_diary", diary_path),
    ):
        rest_limit = _rest_param(path, "limit")
        assert tools[tool]["limit"]["minimum"] == rest_limit["minimum"]
        assert tools[tool]["limit"]["maximum"] == 50 <= rest_limit["maximum"]

    # A value REST refuses is refused here too (validated against settings).
    is_error, _ = await _call(
        client, token, "search_practices", {"practice_type": ["nope"]}
    )
    assert is_error
    is_error, _ = await _call(
        client, token, "search_practices", {"difficulty": ["nope"]}
    )
    assert is_error
