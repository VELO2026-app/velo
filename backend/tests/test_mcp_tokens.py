# =============================================================================
# VELO Backend -- Tests: BE-138 -- MCP phase 0, personal access tokens
# =============================================================================
#
# telegram_id band: 89033-89067. Declared module-level below as
# _TID_MIN/_TID_MAX, ONCE. Checked free when repacked on cd420a1:
# free_windows() without this file returned [(89033, 89099), (89860, 89869)]
# -- BE-146 had claimed 89023-89032 meanwhile, so this band moved up by 3 --
# and no test file names an id in 89033-89099 (grepped: the declared map does
# not see undeclared files). Every test has its own ids.
#
# Coverage:
#   - the schema, read from pg_constraint / pg_indexes, and the CASCADE;
#   - the name is unique among live tokens, case-insensitive (BE-139), and
#     its race;
#   - create: the token once, only its hash stored (every table scanned for
#     the secret), canonical scopes, the refused bodies, the limit on live
#     tokens and its race (curator_race_harness);
#   - list: own only, revoked included, newest first, never the secret;
#   - revoke: own, repeated (idempotent, one audit row), someone else's and a
#     missing one (the same 404), the race of two revokes;
#   - auth and the killswitch, over operations derived from the router;
#   - audit and log: the event is there, no form of the token is;
#   - account reset (DELETE /users/me) revokes every live token, once; its
#     race against an /mcp-shaped request (built to deadlock in the wrong
#     ROW ORDER) and against a second reset;
#   - verify_mcp_token: the input -> outcome grid of the gate, the
#     once-per-interval refresh, its race, revocation on the next call.
#
# NOT BUILT, deliberately: the constant-time property of the hash comparison
# (hmac.compare_digest) -- no test can measure it; it is held by the choice
# of the function. A future last_used_at is unreachable (only the database's
# now() writes it), so it has no case.
# =============================================================================

import hashlib
import re
from collections.abc import AsyncGenerator
from uuid import UUID, uuid4

import pytest
from fastapi.routing import APIRoute
from httpx import AsyncClient
from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession
from structlog.testing import capture_logs

from app.core.audit import AuditLog
from app.core.config import settings
from app.core.database import get_session_factory
from app.core.exceptions import ConflictError, UnauthorizedError
from app.main import app
from app.modules.mcp import service as mcp_service
from app.modules.mcp.models import McpScope, McpToken
from app.modules.mcp.router import router as mcp_router
from app.modules.mcp.schemas import McpTokenCreate
from app.modules.users import service as users_service
from app.modules.users.models import User
from tests.curator_race_harness import assert_no_deadlock, race
from tests.helpers import auth_headers, full_cleanup_range, login_user

_TID_MIN = 89033
_TID_MAX = 89067

TOKENS_URL = "/api/v1/users/me/mcp-tokens"
REVOKE_URL = "/api/v1/users/me/mcp-tokens/{token_id}/revoke"

_TOKEN_SHAPE = re.compile(r"velo_pat_([0-9a-f]{16})_([A-Za-z0-9_-]{43})")
_ALL_SCOPES = ["read", "diary:write", "bookings:write"]


# ---------------------------------------------------------------------------
# Fixtures and local helpers
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """Clean this file's band before and after each test. Users are DELETED,
    not kept: their tokens go with them (CASCADE), so no live token survives
    into a rerun and nothing creeps towards the limit between runs."""
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


async def _user(client: AsyncClient, telegram_id: int) -> tuple[UUID, dict]:
    """A signed-in user: (user id, auth headers)."""
    auth = await login_user(client, telegram_id=telegram_id, first_name="Ученик")
    return UUID(auth["user"]["id"]), auth_headers(auth["session_token"])


async def _mint(
    client: AsyncClient,
    headers: dict,
    name: str = "Claude дома",
    **extra,
) -> dict:
    """Create a token through the API; asserts 201, returns the body."""
    resp = await client.post(TOKENS_URL, json={"name": name, **extra}, headers=headers)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _sql(stmt, params=None):
    """A statement in its own session, committed (reads and writes)."""
    async with get_session_factory()() as s:
        result = await s.execute(stmt, params)
        # ORM selects return a result without returns_rows; plain
        # UPDATE/DELETE return a CursorResult with returns_rows False.
        rows = result.all() if getattr(result, "returns_rows", True) else None
        await s.commit()
        return rows


async def _verify(raw):
    """verify_mcp_token in its own session, shaped like get_db_session:
    commit on success, roll back on the refusal."""
    async with get_session_factory()() as s:
        try:
            auth = await mcp_service.verify_mcp_token(raw, s)
        except Exception:
            await s.rollback()
            raise
        await s.commit()
        return auth


async def _last_used(token_id: str):
    rows = await _sql(
        select(McpToken.last_used_at).where(McpToken.id == UUID(token_id))
    )
    return rows[0][0]


async def _age_last_used(token_id: str, seconds: int) -> None:
    """Backdate last_used_at by `seconds` on the database clock."""
    await _sql(
        text(
            "UPDATE mcp_tokens "
            "SET last_used_at = now() - make_interval(secs => :s) WHERE id = :t"
        ),
        {"s": seconds, "t": UUID(token_id)},
    )


async def _audit_rows(token_id: str, event: str) -> list[AuditLog]:
    async with get_session_factory()() as s:
        return list(
            (
                await s.execute(
                    select(AuditLog).where(
                        AuditLog.target_id == UUID(token_id),
                        AuditLog.event == event,
                    )
                )
            ).scalars()
        )


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------


async def test_the_schema_holds_the_constraints_the_model_names() -> None:
    """Names and definitions read from the database, not from the model."""
    cons = dict(
        await _sql(
            text(
                "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint "
                "WHERE conrelid = 'mcp_tokens'::regclass"
            )
        )
    )
    assert cons["mcp_tokens_pkey"] == "PRIMARY KEY (id)"
    assert cons["mcp_tokens_prefix_key"] == "UNIQUE (prefix)"
    assert cons["mcp_tokens_user_id_fkey"] == (
        "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE"
    )
    for name in (
        "ck_mcp_tokens_name_not_blank",
        "ck_mcp_tokens_scopes_not_empty",
        "ck_mcp_tokens_scopes_known",
    ):
        assert cons[name].startswith("CHECK"), name

    indexes = {
        name
        for (name,) in await _sql(
            text("SELECT indexname FROM pg_indexes WHERE tablename = 'mcp_tokens'")
        )
    }
    assert {
        "mcp_tokens_pkey",
        "mcp_tokens_prefix_key",
        "ix_mcp_tokens_user_id",
    } <= indexes


async def test_the_checks_refuse_what_the_schema_layer_would_let_through(
    client: AsyncClient,
) -> None:
    """Defence in depth below Pydantic: an empty scope list, an unknown scope
    and a blank name are refused by Postgres itself."""
    user_id, _ = await _user(client, 89033)
    bad = [
        {"scopes": []},
        {"scopes": ["read", "admin"]},
        {"name": "   "},
    ]
    for override in bad:
        values = {
            "id": uuid4(),
            "user_id": user_id,
            "name": "n",
            "prefix": uuid4().hex[:16],
            "token_hash": "0" * 64,
            "scopes": ["read"],
            **override,
        }
        async with get_session_factory()() as s:
            with pytest.raises(Exception, match="ck_mcp_tokens_"):
                await s.execute(McpToken.__table__.insert().values(**values))
            await s.rollback()


async def test_deleting_the_user_deletes_their_tokens(client: AsyncClient) -> None:
    user_id, headers = await _user(client, 89034)
    await _mint(client, headers)
    await _mint(client, headers, name="Cursor")
    count = (
        select(func.count()).select_from(McpToken).where(McpToken.user_id == user_id)
    )
    assert (await _sql(count))[0][0] == 2

    await _sql(text("DELETE FROM users WHERE id = :u"), {"u": user_id})
    assert (await _sql(count))[0][0] == 0


# ---------------------------------------------------------------------------
# Create
# ---------------------------------------------------------------------------


async def test_create_returns_the_token_once_and_stores_only_its_hash(
    client: AsyncClient,
) -> None:
    """The item's key set was exactly seven fields, and rightly: an exact
    set is what catches a stray field -- a secret above all. BE-141 added
    `kind` (a personal token vs a connection obtained through OAuth), so the
    set is eight; it stays exact, and a token minted here is personal."""
    _, headers = await _user(client, 89035)
    body = await _mint(client, headers)

    token = body["token"]
    shape = _TOKEN_SHAPE.fullmatch(token)
    assert shape, token
    prefix, secret = shape.group(1), shape.group(2)
    item = body["item"]
    assert item["prefix"] == prefix
    assert item["scopes"] == _ALL_SCOPES  # omitted -> all three
    assert item["last_used_at"] is None and item["revoked_at"] is None
    assert item["kind"] == "personal"
    assert set(item) == {
        "id",
        "kind",
        "name",
        "prefix",
        "scopes",
        "created_at",
        "last_used_at",
        "revoked_at",
    }

    # The row: the hash is there and is the hash of the full string.
    (stored,) = (
        await _sql(select(McpToken.token_hash).where(McpToken.id == UUID(item["id"])))
    )[0]
    assert stored and stored == hashlib.sha256(token.encode()).hexdigest()

    # NOWHERE else: every table of the schema scanned for the secret part
    # (which the full token contains) -- zero rows; the hash, as the pair,
    # is found in exactly one.
    tables = [
        t
        for (t,) in await _sql(
            text("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
        )
    ]
    assert "mcp_tokens" in tables
    hits_secret, hits_hash = [], []
    for table in tables:
        n = (
            await _sql(
                text(f'SELECT count(*) FROM "{table}" t WHERE t::text LIKE :p'),
                {"p": f"%{secret}%"},
            )
        )[0][0]
        if n:
            hits_secret.append(table)
        m = (
            await _sql(
                text(f'SELECT count(*) FROM "{table}" t WHERE t::text LIKE :p'),
                {"p": f"%{stored}%"},
            )
        )[0][0]
        if m:
            hits_hash.append(table)
    assert hits_secret == []
    assert hits_hash == ["mcp_tokens"]

    # Any later read: the list, twice, and a revoke response.
    for _ in range(2):
        listed = await client.get(TOKENS_URL, headers=headers)
        assert listed.status_code == 200
        assert secret not in listed.text and stored not in listed.text
        assert listed.json()["items"][0]["prefix"] == prefix
    revoked = await client.post(REVOKE_URL.format(token_id=item["id"]), headers=headers)
    assert revoked.status_code == 200
    assert secret not in revoked.text and stored not in revoked.text


async def test_a_subset_of_scopes_is_stored_in_canonical_order(
    client: AsyncClient,
) -> None:
    _, headers = await _user(client, 89036)
    body = await _mint(client, headers, scopes=["bookings:write", "read"])
    assert body["item"]["scopes"] == ["read", "bookings:write"]
    one = await _mint(client, headers, name="only diary", scopes=["diary:write"])
    assert one["item"]["scopes"] == ["diary:write"]


async def test_bad_bodies_are_422_and_create_nothing(client: AsyncClient) -> None:
    """The three axes on the body: emptiness (name, scopes), shortage (no
    name), repetition (a scope twice), plus an unknown scope and a long
    name. Nothing is written for any of them."""
    user_id, headers = await _user(client, 89037)
    bodies = [
        {},
        {"scopes": ["read"]},
        {"name": ""},
        {"name": "   "},
        {"name": "x" * 101},
        {"name": "n", "scopes": []},
        {"name": "n", "scopes": ["read", "read"]},
        {"name": "n", "scopes": ["admin"]},
        {"name": "n", "scopes": "read"},
    ]
    for body in bodies:
        resp = await client.post(TOKENS_URL, json=body, headers=headers)
        assert resp.status_code == 422, (body, resp.text)

    count = (
        select(func.count()).select_from(McpToken).where(McpToken.user_id == user_id)
    )
    assert (await _sql(count))[0][0] == 0
    # ...and the same user can still mint: the refusals were about the body.
    ok = await _mint(client, headers, name="  обрезано  ")
    assert ok["item"]["name"] == "обрезано"
    longest = await _mint(client, headers, name="x" * 100)
    assert longest["item"]["name"] == "x" * 100


async def test_a_live_name_cannot_be_repeated_but_a_revoked_one_can(
    client: AsyncClient,
) -> None:
    """Was test_the_same_name_twice_gives_two_distinct_tokens. It asserted
    BE-138's gate ruling R8 -- repeats allowed, tokens told apart by prefix --
    and was right about it then. The owner's ruling of BE-139 (item 10)
    revoked R8: two "TEST" rows in the list could not be told apart on the
    screen. The name is now unique among LIVE tokens, case-insensitive after
    strip; a revoked token's name is free. Two tokens still never share a
    prefix or a secret -- asserted on the pair that is allowed."""
    _, headers = await _user(client, 89038)
    a = await _mint(client, headers, name="Claude")

    for repeat in ("Claude", "  claude  ", "CLAUDE"):
        resp = await client.post(TOKENS_URL, json={"name": repeat}, headers=headers)
        assert resp.status_code == 409, (repeat, resp.text)
        assert resp.json()["error"] == "mcp_token_name_taken"

    revoked = await client.post(
        REVOKE_URL.format(token_id=a["item"]["id"]), headers=headers
    )
    assert revoked.status_code == 200
    b = await _mint(client, headers, name="claude")
    assert a["token"] != b["token"]
    assert a["item"]["prefix"] != b["item"]["prefix"]
    assert a["item"]["id"] != b["item"]["id"]


async def test_the_limit_counts_live_tokens_only(client: AsyncClient) -> None:
    limit = settings.mcp_tokens_max_active_per_user
    assert limit == 10
    _, headers = await _user(client, 89039)
    minted = [await _mint(client, headers, name=f"t{i}") for i in range(limit)]

    refused = await client.post(TOKENS_URL, json={"name": "eleventh"}, headers=headers)
    assert refused.status_code == 409
    assert refused.json()["error"] == "mcp_token_limit_reached"

    # A revoked token frees a place; the revoked one stays in the list.
    gone = minted[0]["item"]["id"]
    assert (
        await client.post(REVOKE_URL.format(token_id=gone), headers=headers)
    ).status_code == 200
    await _mint(client, headers, name="replacement")
    again = await client.post(TOKENS_URL, json={"name": "twelfth"}, headers=headers)
    assert again.status_code == 409

    listed = (await client.get(TOKENS_URL, headers=headers)).json()["items"]
    assert len(listed) == limit + 1
    assert sum(1 for t in listed if t["revoked_at"] is None) == limit


async def test_two_creates_at_the_limit_minus_one_mint_exactly_one(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The check-then-insert race. The holder is paused inside its window
    (after its insert, before its audit row) holding the users row; the
    rival must wait on that row and, once let through, count ten."""
    limit = settings.mcp_tokens_max_active_per_user
    user_id, headers = await _user(client, 89040)
    for i in range(limit - 1):
        await _mint(client, headers, name=f"t{i}")

    async def create(session: AsyncSession):
        user = await session.get(User, user_id)
        return await mcp_service.create_mcp_token(
            user,
            McpTokenCreate(name="race"),
            session,
        )

    result = await race(
        monkeypatch,
        holder=create,
        pause_in=(mcp_service, "record_audit"),
        rival=create,
    )

    assert_no_deadlock(result)
    assert result.rival_waited, "the rival never met the holder's lock"
    assert result.holder.committed, result.holder.error
    assert not result.rival.committed
    assert isinstance(result.rival.error, ConflictError), repr(result.rival.error)
    assert result.rival.error.code == "mcp_token_limit_reached"
    live = (
        select(func.count())
        .select_from(McpToken)
        .where(
            McpToken.user_id == user_id,
            McpToken.revoked_at.is_(None),
        )
    )
    assert (await _sql(live))[0][0] == limit


# ---------------------------------------------------------------------------
# List
# ---------------------------------------------------------------------------


_LIST_KEYS = {"items", "oauth_connect_available", "scope_labels"}


def _empty_list(body: dict) -> bool:
    """An empty list response: no items, and exactly the response's keys.
    Until BE-150 the whole body was asserted equal to {"items": []}; the
    list now also carries the screen's oauth_connect_available and
    scope_labels, so the emptiness is asserted on `items` and the key set
    stays exact -- a stray field still fails."""
    return body["items"] == [] and set(body) == _LIST_KEYS


async def test_the_list_is_own_only_newest_first_revoked_included(
    client: AsyncClient,
) -> None:
    _, headers_a = await _user(client, 89041)
    _, headers_b = await _user(client, 89042)
    _, headers_c = await _user(client, 89043)
    first = await _mint(client, headers_a, name="first")
    second = await _mint(client, headers_a, name="second")
    other = await _mint(client, headers_b, name="b's")
    await client.post(
        REVOKE_URL.format(token_id=first["item"]["id"]), headers=headers_a
    )

    items = (await client.get(TOKENS_URL, headers=headers_a)).json()["items"]
    assert [t["id"] for t in items] == [second["item"]["id"], first["item"]["id"]]
    assert items[1]["revoked_at"] is not None and items[0]["revoked_at"] is None
    assert other["item"]["id"] not in {t["id"] for t in items}

    assert _empty_list((await client.get(TOKENS_URL, headers=headers_c)).json())


# ---------------------------------------------------------------------------
# Revoke
# ---------------------------------------------------------------------------


async def test_revoking_twice_is_one_revocation(client: AsyncClient) -> None:
    _, headers = await _user(client, 89044)
    item = (await _mint(client, headers))["item"]
    url = REVOKE_URL.format(token_id=item["id"])

    first = await client.post(url, headers=headers)
    assert first.status_code == 200
    assert first.json()["revoked_at"] is not None
    second = await client.post(url, headers=headers)
    assert second.status_code == 200
    assert second.json()["revoked_at"] == first.json()["revoked_at"]

    assert len(await _audit_rows(item["id"], "mcp_token_revoked")) == 1


async def test_someone_elses_token_and_no_token_are_the_same_404(
    client: AsyncClient,
) -> None:
    _, headers_a = await _user(client, 89045)
    _, headers_b = await _user(client, 89046)
    item = (await _mint(client, headers_a))["item"]

    foreign = await client.post(
        REVOKE_URL.format(token_id=item["id"]), headers=headers_b
    )
    missing = await client.post(REVOKE_URL.format(token_id=uuid4()), headers=headers_b)
    assert foreign.status_code == missing.status_code == 404
    assert foreign.json() == missing.json()
    assert foreign.json()["error"] == "mcp_token_not_found"

    # Untouched: still live, and nobody's list shows it to B.
    listed = (await client.get(TOKENS_URL, headers=headers_a)).json()["items"]
    assert listed[0]["revoked_at"] is None
    assert _empty_list((await client.get(TOKENS_URL, headers=headers_b)).json())
    assert await _audit_rows(item["id"], "mcp_token_revoked") == []


async def test_a_malformed_token_id_is_422(client: AsyncClient) -> None:
    _, headers = await _user(client, 89047)
    resp = await client.post(REVOKE_URL.format(token_id="not-a-uuid"), headers=headers)
    assert resp.status_code == 422


async def test_two_concurrent_revokes_write_one_audit_row(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The holder has revoked (row locked) and is paused before its audit
    row; the rival's revoking UPDATE waits on the row, re-reads it revoked,
    matches nothing and returns the row as it stands."""
    user_id, headers = await _user(client, 89048)
    token_id = UUID((await _mint(client, headers))["item"]["id"])

    async def revoke(session: AsyncSession):
        user = await session.get(User, user_id)
        return await mcp_service.revoke_mcp_token(user, token_id, session)

    result = await race(
        monkeypatch,
        holder=revoke,
        pause_in=(mcp_service, "record_audit"),
        rival=revoke,
    )

    assert_no_deadlock(result)
    assert result.rival_waited, "the rival never met the holder's row"
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    assert result.rival.result.revoked_at == result.holder.result.revoked_at
    assert len(await _audit_rows(str(token_id), "mcp_token_revoked")) == 1


# ---------------------------------------------------------------------------
# Auth and the killswitch
# ---------------------------------------------------------------------------


def _operations() -> list[tuple[str, str]]:
    """(method, full path) of every endpoint on the token router, derived
    rather than written, so a new endpoint joins the checks below."""
    ops = []
    for route in mcp_router.routes:
        assert isinstance(route, APIRoute)
        for method in route.methods:
            ops.append((method, route.path.replace("{token_id}", str(uuid4()))))
    return sorted(ops)


def test_the_derived_operations_are_the_served_ones() -> None:
    derived = {(m, re.sub(r"[0-9a-f-]{36}", "{token_id}", p)) for m, p in _operations()}
    assert len(derived) == 3
    served = {
        (method.upper(), path)
        for path, operations in app.openapi()["paths"].items()
        for method in operations
    }
    assert derived <= served


async def test_every_operation_is_404_when_the_flag_is_off_and_401_when_on(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Unauthenticated on purpose: with the flag off the router dependency
    answers before authentication (404 with no code), with it on the same
    request reaches authentication (401)."""
    monkeypatch.setattr(settings, "mcp_enabled", False)
    for method, path in _operations():
        resp = await client.request(method, path, json={"name": "n"})
        assert resp.status_code == 404, (method, path)
        assert resp.json()["error"] == "not_found"

    monkeypatch.setattr(settings, "mcp_enabled", True)
    for method, path in _operations():
        resp = await client.request(method, path, json={"name": "n"})
        assert resp.status_code == 401, (method, path)


async def test_the_flag_off_also_hides_the_feature_from_a_signed_in_user(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, headers = await _user(client, 89049)
    monkeypatch.setattr(settings, "mcp_enabled", False)
    assert (await client.get(TOKENS_URL, headers=headers)).status_code == 404
    assert (
        await client.post(TOKENS_URL, json={"name": "n"}, headers=headers)
    ).status_code == 404


async def test_a_deactivated_user_is_403_on_every_operation(
    client: AsyncClient,
) -> None:
    user_id, headers = await _user(client, 89050)
    await _sql(update(User).where(User.id == user_id).values(is_active=False))
    for method, path in _operations():
        resp = await client.request(method, path, json={"name": "n"}, headers=headers)
        assert resp.status_code == 403, (method, path)


# ---------------------------------------------------------------------------
# Audit and log
# ---------------------------------------------------------------------------


async def test_audit_and_log_carry_the_events_and_no_form_of_the_token(
    client: AsyncClient,
) -> None:
    """Pair: the events ARE there (audit rows, log lines), and the token is
    not -- in no form: the full string, the secret part, the prefix, the
    hash. Searched in every column of the audit rows and in every value of
    every captured log entry."""
    user_id, headers = await _user(client, 89051)
    with capture_logs() as logs:
        body = await _mint(client, headers, scopes=["read"])
        token = body["token"]
        item = body["item"]
        await _verify(token)
        with pytest.raises(UnauthorizedError):
            await _verify(token[:-1] + ("A" if token[-1] != "A" else "B"))
        await client.post(REVOKE_URL.format(token_id=item["id"]), headers=headers)
        with pytest.raises(UnauthorizedError):
            await _verify(token)

    shape = _TOKEN_SHAPE.fullmatch(token)
    forms = {
        "token": token,
        "secret": shape.group(2),
        "prefix": shape.group(1),
        "hash": hashlib.sha256(token.encode()).hexdigest(),
    }

    created = await _audit_rows(item["id"], "mcp_token_created")
    revoked = await _audit_rows(item["id"], "mcp_token_revoked")
    assert len(created) == len(revoked) == 1
    for row in created + revoked:
        assert row.actor_id == user_id and row.actor_type == "user"
        assert row.target_type == "mcp_token"
        assert row.data == {
            "token_id": item["id"],
            "name": "Claude дома",
            "scopes": ["read"],
        }
    audit_text = (
        await _sql(
            text(
                "SELECT string_agg(a::text, ' ') FROM audit_logs a "
                "WHERE a.target_id = :t"
            ),
            {"t": UUID(item["id"])},
        )
    )[0][0]
    assert audit_text and item["id"] in audit_text
    for label, form in forms.items():
        assert form not in audit_text, label

    events = [e.get("event") for e in logs]
    assert "mcp_token_created" in events and "mcp_token_revoked" in events
    rejected = [e for e in logs if e.get("event") == "mcp_token_rejected"]
    assert [e["reason"] for e in rejected] == ["hash_mismatch", "revoked"]
    log_text = " ".join(repr(e) for e in logs)
    assert item["id"] in log_text
    for label, form in forms.items():
        assert form not in log_text, label


# ---------------------------------------------------------------------------
# verify_mcp_token
# ---------------------------------------------------------------------------


async def test_malformed_inputs_are_refused_and_write_nothing(
    client: AsyncClient,
) -> None:
    """Emptiness, shortage, excess and foreign shapes of the raw string --
    each one built from a REAL token, so the refusal is the format's doing,
    not a missing row's."""
    auth = await login_user(client, telegram_id=89052, first_name="Ученик")
    headers = auth_headers(auth["session_token"])
    body = await _mint(client, headers)
    token = body["token"]
    prefix, secret = _TOKEN_SHAPE.fullmatch(token).groups()

    inputs = [
        None,
        "",
        auth["session_token"],  # a session token, not a PAT
        "Bearer " + token,  # the header, not the token
        token.replace("velo_pat_", "velo_pak_", 1),
        token.replace(prefix, prefix.upper(), 1),
        token[:-1],  # one secret char short
        token + "x",  # one char too many
        f"velo_pat_{prefix}_",  # no secret
        f"velo_pat__{secret}",  # no prefix
        " " + token,
        token + "\n",
        token[:-1] + "й",  # non-ASCII in the secret
        token * 200,  # a long string
    ]
    for raw in inputs:
        with pytest.raises(UnauthorizedError) as refused:
            await _verify(raw)
        assert refused.value.message == "Invalid token"
        assert token not in str(refused.value)
    assert await _last_used(body["item"]["id"]) is None


async def test_an_unknown_prefix_and_a_wrong_secret_are_refused(
    client: AsyncClient,
) -> None:
    _, headers = await _user(client, 89053)
    body = await _mint(client, headers)
    token = body["token"]
    prefix, secret = _TOKEN_SHAPE.fullmatch(token).groups()

    unknown = f"velo_pat_{'0' * 16}_{secret}"
    other_secret = secret[:-1] + ("A" if secret[-1] != "A" else "B")
    wrong = f"velo_pat_{prefix}_{other_secret}"
    for raw in (unknown, wrong):
        with pytest.raises(UnauthorizedError) as refused:
            await _verify(raw)
        assert refused.value.message == "Invalid token"
    assert await _last_used(body["item"]["id"]) is None


async def test_a_revoked_token_is_refused_and_write_nothing(
    client: AsyncClient,
) -> None:
    _, headers = await _user(client, 89054)
    body = await _mint(client, headers)
    token, token_id = body["token"], body["item"]["id"]
    await client.post(REVOKE_URL.format(token_id=token_id), headers=headers)

    with pytest.raises(UnauthorizedError):
        await _verify(token)
    # Revoked AND a wrong secret: still the same refusal.
    with pytest.raises(UnauthorizedError):
        await _verify(token[:-1] + ("A" if token[-1] != "A" else "B"))
    assert await _last_used(token_id) is None


async def test_a_deactivated_user_is_refused_and_nothing_is_stamped(
    client: AsyncClient,
) -> None:
    user_id, headers = await _user(client, 89055)
    body = await _mint(client, headers)
    token_id = body["item"]["id"]
    # Stale on purpose: a success would stamp it.
    await _age_last_used(token_id, 86400)
    before = await _last_used(token_id)
    await _sql(update(User).where(User.id == user_id).values(is_active=False))

    with pytest.raises(UnauthorizedError):
        await _verify(body["token"])
    assert await _last_used(token_id) == before

    await _sql(update(User).where(User.id == user_id).values(is_active=True))
    await _verify(body["token"])
    assert await _last_used(token_id) > before


async def test_success_returns_the_owner_and_stamps_at_most_once_per_interval(
    client: AsyncClient,
) -> None:
    assert settings.mcp_token_last_used_interval_seconds == 60
    user_id, headers = await _user(client, 89056)
    body = await _mint(client, headers, scopes=["read", "diary:write"])
    token, token_id = body["token"], body["item"]["id"]

    auth = await _verify(token)
    assert auth.user.id == user_id
    assert str(auth.token.id) == token_id
    assert auth.scopes == frozenset({McpScope.READ, McpScope.DIARY_WRITE})
    stamped = await _last_used(token_id)
    assert stamped is not None
    assert auth.token.last_used_at == stamped

    # Inside the interval: no write.
    await _verify(token)
    assert await _last_used(token_id) == stamped

    # 30 s old: still inside -- unchanged.
    await _age_last_used(token_id, 30)
    young = await _last_used(token_id)
    await _verify(token)
    assert await _last_used(token_id) == young

    # 61 s old: past it -- refreshed.
    await _age_last_used(token_id, 61)
    old = await _last_used(token_id)
    await _verify(token)
    assert await _last_used(token_id) > old

    listed = (await client.get(TOKENS_URL, headers=headers)).json()["items"][0]
    assert listed["last_used_at"] is not None


async def test_two_concurrent_verifications_stamp_once(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Both read a NULL last_used_at; the holder stamps and pauses holding
    the row; the rival's UPDATE waits on it and, re-evaluating its WHERE
    against the holder's stamp, matches nothing. The row ends with the
    holder's value -- the rival's transaction started later, so its own
    now() would differ."""
    _, headers = await _user(client, 89057)
    body = await _mint(client, headers)
    token, token_id = body["token"], body["item"]["id"]

    async def verify(session: AsyncSession):
        return await mcp_service.verify_mcp_token(token, session)

    result = await race(
        monkeypatch,
        holder=verify,
        pause_in=(mcp_service, "_touch_last_used"),
        pause="after",
        rival=verify,
    )

    assert_no_deadlock(result)
    assert result.rival_waited, "the rival never met the holder's row"
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    holder_stamp = result.holder.result.token.last_used_at
    assert holder_stamp is not None
    assert await _last_used(token_id) == holder_stamp


async def test_a_revocation_refuses_the_very_next_call(client: AsyncClient) -> None:
    _, headers = await _user(client, 89058)
    body = await _mint(client, headers)
    token = body["token"]

    await _verify(token)
    await client.post(REVOKE_URL.format(token_id=body["item"]["id"]), headers=headers)
    with pytest.raises(UnauthorizedError):
        await _verify(token)


# ---------------------------------------------------------------------------
# Account reset revokes the tokens (owner ruling, BE-138 P1)
# ---------------------------------------------------------------------------


async def test_account_reset_revokes_every_live_token_once(client: AsyncClient) -> None:
    """DELETE /users/me revokes all live tokens through the manual path: one
    audit row per token; the token revoked before keeps its single row and
    its revoked_at. A second reset (repetition) adds nothing. Another
    student's tokens are untouched; a student without tokens resets fine."""
    _, headers = await _user(client, 89059)
    _, headers_other = await _user(client, 89060)
    minted = [await _mint(client, headers, name=f"t{i}") for i in range(3)]
    other = await _mint(client, headers_other)
    earlier = (
        await client.post(
            REVOKE_URL.format(token_id=minted[0]["item"]["id"]), headers=headers
        )
    ).json()["revoked_at"]

    assert (await client.delete("/api/v1/users/me", headers=headers)).status_code == 204

    items = {
        t["id"]: t
        for t in (await client.get(TOKENS_URL, headers=headers)).json()["items"]
    }
    assert len(items) == 3
    assert all(t["revoked_at"] is not None for t in items.values())
    assert items[minted[0]["item"]["id"]]["revoked_at"] == earlier
    for body in minted:
        assert len(await _audit_rows(body["item"]["id"], "mcp_token_revoked")) == 1
        with pytest.raises(UnauthorizedError):
            await _verify(body["token"])

    # Repeated reset: nothing more to revoke, no new rows.
    assert (await client.delete("/api/v1/users/me", headers=headers)).status_code == 204
    for body in minted:
        assert len(await _audit_rows(body["item"]["id"], "mcp_token_revoked")) == 1

    # The other student: untouched, still verifies; and resets with none left
    # after revoking their own -- the empty case.
    await _verify(other["token"])
    await client.post(
        REVOKE_URL.format(token_id=other["item"]["id"]), headers=headers_other
    )
    assert (
        await client.delete("/api/v1/users/me", headers=headers_other)
    ).status_code == 204


async def test_a_reset_meeting_an_mcp_request_does_not_deadlock(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ROW ORDER mcp_tokens -> users (mcp/service.py header), measured.

    The holder has the shape of a phase-2 /mcp request: verification stamps
    the token row (and holds it), then the action locks the users row. It is
    paused right after the stamp. The rival is the account reset. In the
    shipped order the reset asks for the token rows first and waits; the
    holder then takes users unopposed and commits; the reset follows. Taking
    users first in the reset (the mutation) makes the reset hold users while
    waiting for the token row the holder holds, and the holder then asks for
    users: a real deadlock."""
    user_id, headers = await _user(client, 89061)
    token = (await _mint(client, headers))["token"]

    async def mcp_request(session: AsyncSession):
        auth = await mcp_service.verify_mcp_token(token, session)
        await users_service.lock_user_row(session, auth.user.id)
        return auth

    async def reset(session: AsyncSession):
        user = await session.get(User, user_id)
        return await users_service.reset_user_to_onboarding(user, session)

    result = await race(
        monkeypatch,
        holder=mcp_request,
        pause_in=(mcp_service, "_touch_last_used"),
        pause="after",
        rival=reset,
    )

    assert_no_deadlock(result)
    assert result.rival_waited, "the reset never met the request's token row"
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    with pytest.raises(UnauthorizedError):
        await _verify(token)


async def test_two_concurrent_resets_audit_each_token_once(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A double tap on "delete account": the holder has revoked the rows
    (locked) and pauses before its first audit row; the rival's locking
    subquery waits on them, re-checks them revoked once let through and
    revokes nothing."""
    user_id, headers = await _user(client, 89062)
    minted = [await _mint(client, headers, name=f"t{i}") for i in range(2)]

    async def reset(session: AsyncSession):
        user = await session.get(User, user_id)
        return await users_service.reset_user_to_onboarding(user, session)

    result = await race(
        monkeypatch,
        holder=reset,
        pause_in=(mcp_service, "record_audit"),
        rival=reset,
    )

    assert_no_deadlock(result)
    assert result.rival_waited, "the second reset never met the first one's rows"
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    for body in minted:
        assert len(await _audit_rows(body["item"]["id"], "mcp_token_revoked")) == 1


async def test_a_revocation_during_a_call_is_not_stamped_as_use(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The call has read the live token and is paused before the stamp; the
    revocation commits meanwhile (it waits for nothing: the call holds no
    lock yet). The call completes -- it was already past the read -- but the
    `revoked_at IS NULL` in the stamp's WHERE keeps a revoked token from
    being marked used after its revocation."""
    user_id, headers = await _user(client, 89063)
    body = await _mint(client, headers)
    token_id = UUID(body["item"]["id"])

    async def verify(session: AsyncSession):
        return await mcp_service.verify_mcp_token(body["token"], session)

    async def revoke(session: AsyncSession):
        user = await session.get(User, user_id)
        return await mcp_service.revoke_mcp_token(user, token_id, session)

    result = await race(
        monkeypatch,
        holder=verify,
        pause_in=(mcp_service, "_touch_last_used"),
        pause="before",
        rival=revoke,
    )

    assert_no_deadlock(result)
    assert not result.rival_waited
    assert result.rival.committed, result.rival.error
    assert result.holder.committed, result.holder.error
    assert await _last_used(str(token_id)) is None
    rows = await _sql(select(McpToken.revoked_at).where(McpToken.id == token_id))
    assert rows[0][0] is not None


async def test_two_creates_with_one_name_mint_exactly_one(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """BE-139 item 10, the race: the name check runs under the same users-row
    lock as the limit. The holder is paused after its insert, before its
    audit row; the rival -- the same name in another case -- must wait on
    the lock and then see the holder's row: 409 mcp_token_name_taken."""
    user_id, _ = await _user(client, 89064)

    async def create(name: str):
        async def go(session: AsyncSession):
            user = await session.get(User, user_id)
            return await mcp_service.create_mcp_token(
                user,
                McpTokenCreate(name=name),
                session,
            )

        return go

    result = await race(
        monkeypatch,
        holder=await create("Claude"),
        pause_in=(mcp_service, "record_audit"),
        rival=await create("CLAUDE"),
    )

    assert_no_deadlock(result)
    assert result.rival_waited, "the rival never met the holder's lock"
    assert result.holder.committed, result.holder.error
    assert isinstance(result.rival.error, ConflictError), repr(result.rival.error)
    assert result.rival.error.code == "mcp_token_name_taken"
    live = (
        select(func.count())
        .select_from(McpToken)
        .where(
            McpToken.user_id == user_id,
            McpToken.revoked_at.is_(None),
        )
    )
    assert (await _sql(live))[0][0] == 1
