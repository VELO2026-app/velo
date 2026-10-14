# =============================================================================
# VELO Backend -- Tests: BE-148 / BE-150 -- what a scope promises is what its
# tools do; the way to a missing scope; the list's screen fields
# =============================================================================
#
# telegram_id band: 74010-74039. Declared module-level below as
# _TID_MIN/_TID_MAX, ONCE. Checked free before it was claimed on ea12641:
# free_windows(space=(55000, 99999)) lists the stretch after 73459 (the
# BE-141 band) as free; the band sits inside it. Every test has its own ids.
#
# THE PAIR (BE-148): SCOPE_ACTIONS (models.py) is the one description of
# every scope -- the consent page and the "AI connections" screen read it.
# Held to the tools themselves, not to a list kept beside them:
#   - its tools are exactly the tools the MCP server registers (tools/list);
#   - each of them is refused without its scope (a real call, answered
#     scope_missing), and is not refused with it -- so no scope promises an
#     action that has no tool, and no tool hides behind another scope;
#   - each description is made of its actions' phrases, and nothing else.
# A promise without a tool (the consent page once said "и делать чек-ин")
# cannot be written without adding an action, and an action cannot name a
# tool the server does not have.
#
# Calls go through the REAL /mcp (the mcp fixture of test_mcp_server).
# Arguments are made from each tool's own input schema, so the call passes
# the SDK's validation and reaches the scope check -- which is the first
# thing every tool does (server.py, read and write paths alike).
# =============================================================================

import uuid
from collections.abc import AsyncGenerator
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.modules.mcp.models import SCOPE_ACTIONS, McpScope, scope_label
from tests.helpers import (
    delete_oauth_test_clients,
    full_cleanup_range,
    mint_oauth_access,
)
from tests.test_mcp_server import (  # noqa: F401 -- `mcp` is a fixture
    TOKENS_URL,
    _call,
    _rpc,
    _student,
    mcp,
)

_TID_MIN = 74010
_TID_MAX = 74039

pytestmark = pytest.mark.usefixtures("mcp")


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    await delete_oauth_test_clients()


def _value(schema: dict, defs: dict) -> object:
    """A valid value for a JSON-schema property -- enough to pass the SDK's
    argument validation and reach the tool body."""
    if "$ref" in schema:
        return _value(defs[schema["$ref"].split("/")[-1]], defs)
    for key in ("anyOf", "oneOf"):
        if key in schema:
            options = [s for s in schema[key] if s.get("type") != "null"]
            return _value(options[0], defs)
    if "enum" in schema:
        return schema["enum"][0]
    if "const" in schema:
        return schema["const"]
    kind = schema.get("type")
    if kind == "string":
        fmt = schema.get("format")
        if fmt == "uuid":
            return str(uuid.uuid4())
        if fmt == "date":
            return "2026-10-20"
        if fmt == "date-time":
            return "2026-10-20T10:00:00Z"
        return "x" * max(1, schema.get("minLength", 1))
    if kind == "integer":
        return max(1, schema.get("minimum", 1))
    if kind == "number":
        return 1
    if kind == "boolean":
        return False
    if kind == "array":
        return [_value(schema.get("items", {"type": "string"}), defs)]
    if kind == "object":
        return _args(schema, defs)
    return "x"


def _args(schema: dict, defs: dict | None = None) -> dict:
    defs = defs or schema.get("$defs", {})
    props = schema.get("properties", {})
    return {name: _value(props[name], defs) for name in schema.get("required", [])}


async def _tools(client: AsyncClient, token: str) -> dict[str, dict]:
    resp = await _rpc(client, "tools/list", {}, token=token)
    assert resp.status_code == 200, resp.text
    return {t["name"]: t["inputSchema"] for t in resp.json()["result"]["tools"]}


# ---------------------------------------------------------------------------
# The pair: descriptions <-> tools
# ---------------------------------------------------------------------------


async def test_the_described_tools_are_exactly_the_registered_ones(
    client: AsyncClient,
) -> None:
    _, _, token = await _student(client, 74032)
    registered = set(await _tools(client, token))
    described = [
        t for actions in SCOPE_ACTIONS.values() for a in actions for t in a.tools
    ]
    assert len(described) == len(set(described)), "a tool in two actions"
    assert set(described) == registered
    # Every scope says something.
    assert set(SCOPE_ACTIONS) == set(McpScope)
    assert all(SCOPE_ACTIONS[s] for s in McpScope)


_PAIRS = [(s, t) for s in McpScope for a in SCOPE_ACTIONS[s] for t in a.tools]


def _pair_ids(index: int) -> tuple[int, int]:
    """Two own ids per (scope, tool) pair from 74010..74031 -- room for
    eleven pairs; the other tests live in 74032..74037. Checked in the test
    body, not at import: a module that fails to import would hide the very
    pair test that is meant to go red."""
    without, full = 74010 + 2 * index, 74011 + 2 * index
    assert full <= 74031, "the band is full -- widen it in the registry"
    return without, full


@pytest.mark.parametrize(
    ("index", "scope", "tool"), [(i, s, t) for i, (s, t) in enumerate(_PAIRS)]
)
async def test_each_described_tool_needs_exactly_its_scope(
    client: AsyncClient, index: int, scope: McpScope, tool: str
) -> None:
    """Without the scope: scope_missing naming it. With every scope: not
    scope_missing (whatever else the dummy arguments earn)."""
    others = [s.value for s in McpScope if s is not scope]
    without_id, full_id = _pair_ids(index)
    _, _, without = await _student(client, without_id, scopes=others)
    schema = (await _tools(client, without))[tool]
    args = _args(schema)

    is_error, body = await _call(client, without, tool, args)
    assert is_error and body["error"] == "scope_missing", (tool, body)
    assert f"'{scope.value}'" in body["message"]

    _, _, full = await _student(client, full_id)
    _, body = await _call(client, full, tool, args)
    assert body.get("error") != "scope_missing", (tool, body)


def test_each_description_is_its_actions_and_nothing_else() -> None:
    for scope in McpScope:
        label = scope_label(scope)
        phrases = [a.phrase for a in SCOPE_ACTIONS[scope]]
        for phrase in phrases:
            assert phrase.lower() in label.lower(), (scope, phrase)
        rest = label.lower()
        for phrase in phrases:
            rest = rest.replace(phrase.lower(), "", 1)
        assert set(rest) <= set(", и"), (scope, rest)
    # The one promise that once had no tool.
    for scope in McpScope:
        assert "чек" not in scope_label(scope).lower()


# ---------------------------------------------------------------------------
# scope_missing: the way out depends on the kind of access (BE-148 ruling)
# ---------------------------------------------------------------------------


async def test_a_personal_token_is_told_to_make_a_token(client: AsyncClient) -> None:
    _, _, token = await _student(client, 74033, scopes=["read"])
    args = _args((await _tools(client, token))["save_to_diary"])
    is_error, body = await _call(client, token, "save_to_diary", args)
    assert is_error and body["error"] == "scope_missing"
    assert "Create a token" in body["message"]
    assert "Reconnect" not in body["message"]


async def test_access_given_with_the_button_is_told_to_reconnect(
    client: AsyncClient,
) -> None:
    from tests.helpers import login_user

    auth = await login_user(client, telegram_id=74034, first_name="Ученик")
    access, _, _ = await mint_oauth_access(UUID(auth["user"]["id"]), scopes=["read"])
    args = _args((await _tools(client, access))["save_to_diary"])
    is_error, body = await _call(client, access, "save_to_diary", args)
    assert is_error and body["error"] == "scope_missing"
    assert "Reconnect VELO in your AI client" in body["message"]
    assert "'diary:write'" in body["message"]
    assert "Create a token" not in body["message"]


# ---------------------------------------------------------------------------
# The list's screen fields (BE-150)
# ---------------------------------------------------------------------------


async def test_the_list_carries_the_labels_in_canonical_order(
    client: AsyncClient,
) -> None:
    _, headers, _ = await _student(client, 74035)
    body = (await client.get(TOKENS_URL, headers=headers)).json()
    assert body["scope_labels"] == [
        {"scope": s.value, "label": scope_label(s)} for s in McpScope
    ]


@pytest.mark.parametrize("configured", [True, False])
async def test_the_list_says_whether_the_button_works_here(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, configured: bool
) -> None:
    monkeypatch.setattr(
        settings, "mcp_oauth_issuer_url", "https://api.velo.test" if configured else ""
    )
    monkeypatch.setattr(settings, "telegram_login_client_id", "7700000001")
    monkeypatch.setattr(settings, "telegram_login_client_secret", "s")
    _, headers, _ = await _student(client, 74036 + int(configured))
    body = (await client.get(TOKENS_URL, headers=headers)).json()
    assert body["oauth_connect_available"] is configured
