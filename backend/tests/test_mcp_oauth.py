# =============================================================================
# VELO Backend -- Tests: BE-141 -- OAuth for /mcp, sign-in through Telegram
# =============================================================================
#
# telegram_id band: 73410-73459. Declared module-level below as
# _TID_MIN/_TID_MAX, ONCE. Checked free before it was claimed on 2ba6512:
# free_windows(space=(55000, 99999)) returned, among others,
# (72850, 79299); the band sits inside it, away from its edges. Every test
# has its own ids.
#
# Requests go through the REAL app: the real routes, the real OAuthDoor and
# the MCP SDK's own handlers. Only Telegram is replaced -- by an in-memory
# OpenID provider (FakeTelegram) behind telegram_oidc._client, signing real
# RS256 id_tokens with a key made here and publishing its JWKS.
#
# Coverage, by the gate's grid:
#   - discovery: 401 -> resource metadata -> authorization server metadata;
#     the door (switched off, public host, not configured) -> plain 404;
#   - registration: public https clients only, nothing secret stored,
#     per-source limit, Redis down;
#   - authorize: SDK refusals without redirect, ours with redirect (explicit
#     redirect_uri, S256 shape, resource), the Telegram leg's parameters;
#   - Telegram callback: state once, cancel, every way an id_token fails,
#     unknown and deactivated students, the consent page's headers/escaping;
#   - consent: deny, empty / repeated / foreign scopes, double submit;
#   - token: the full flow, code once, PKCE, redirect URI, client binding,
#     expiry, deactivation in between, reconnect replaces, a personal token
#     holding the name, the limit, two exchanges racing to one name (built,
#     with the users row held);
#   - refresh: rotation, old pair dead, revoked / foreign / wrong kind, two
#     refreshes with one token;
#   - the list and revoke (item 5), an expired access token;
#   - secrets: no token, code, id or Telegram credential in the app log, the
#     audit or an error body.
#
# NOT BUILT: claude.ai and Telegram themselves -- the owner's live check
# (runbook in the report).
# =============================================================================

import asyncio
import base64
import hashlib
import html
import json
import re
import secrets
import time
from collections.abc import AsyncGenerator
from urllib.parse import parse_qs, urlsplit
from uuid import UUID

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from httpx import AsyncClient
from redis.exceptions import RedisError
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import AuditLog
from app.core.config import settings
from app.core.database import get_session_factory
from app.core.redis import get_redis
from app.main import app
from app.modules.auth import telegram_oidc
from app.modules.mcp import oauth as mcp_oauth
from app.modules.mcp.models import McpOAuthClient, McpToken
from app.modules.mcp.oauth import (
    AS_METADATA_PATH,
    CALLBACK_PATH,
    CONSENT_PATH,
    OAUTH_PATHS,
    PRM_PATH,
    OAuthDoor,
)
from app.modules.users.models import User
from app.modules.users.service import lock_user_row
from tests.helpers import auth_headers, full_cleanup_range, login_user
from tests.test_mcp_server import mcp  # noqa: F401 -- the fixture, by name

_TID_MIN = 73410
_TID_MAX = 73459

ISSUER = "https://api.velo.test"
CB = "https://claude.ai/api/mcp/auth_callback"
TG_CLIENT_ID = "7700000001"
TG_SECRET = "tg-secret-for-tests-9f3c"
TOKENS_URL = "/api/v1/users/me/mcp-tokens"
ALL = ["read", "diary:write", "bookings:write"]
MCP_HEADERS = {
    "Accept": "application/json, text/event-stream",
    "Content-Type": "application/json",
}
_NAME_MARK = "BE141-test-client"


# ---------------------------------------------------------------------------
# Telegram, replaced
# ---------------------------------------------------------------------------


class FakeTelegram:
    """An OpenID provider at oauth.telegram.org, in memory.

    A code is "tg-<telegram id>". The token endpoint answers with an
    id_token for that id; `claims` / `alg` / `key` / `token_status` bend
    it. Every request is kept, to check what we sent.
    """

    def __init__(self) -> None:
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.kid = "k1"  # the published key's id
        self.token_kid = "k1"  # the id a token names
        self.sign_key = self.key
        self.alg = "RS256"
        self.claims: dict = {}
        self.token_status = 200
        self.token_scope: str | None = None  # `scope` in the token answer
        self.requests: list[httpx.Request] = []
        self.issued: list[str] = []

    def jwks(self) -> dict:
        jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(self.key.public_key()))
        return {"keys": [jwk | {"kid": self.kid, "alg": "RS256", "use": "sig"}]}

    def id_token(self, tid: int) -> str:
        now = int(time.time())
        claims = {
            "iss": telegram_oidc.ISSUER,
            "aud": TG_CLIENT_ID,
            "sub": f"oidc-{tid}",
            "iat": now,
            "exp": now + 3600,
            "id": tid,
            "given_name": "Ученик",
        } | self.claims
        claims = {k: v for k, v in claims.items() if v is not _DROP}
        token = jwt.encode(
            claims,
            self.sign_key if self.alg != "HS256" else "x" * 32,
            algorithm=self.alg,
            headers={"kid": self.token_kid},
        )
        self.issued.append(token)
        return token

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.path == "/token" and request.method == "POST":
            if self.token_status != 200:
                return httpx.Response(
                    self.token_status, json={"error": "invalid_grant"}
                )
            form = parse_qs(request.content.decode())
            tid = int(form["code"][0].removeprefix("tg-"))
            answer = {"id_token": self.id_token(tid), "token_type": "Bearer"}
            if self.token_scope is not None:
                answer["scope"] = self.token_scope
            return httpx.Response(200, json=answer)
        if request.url.path == "/.well-known/jwks.json":
            return httpx.Response(200, json=self.jwks())
        return httpx.Response(404)


_DROP = object()
_TELEGRAM = FakeTelegram()


@pytest.fixture
def telegram(monkeypatch: pytest.MonkeyPatch) -> FakeTelegram:
    fake = _TELEGRAM
    fake.sign_key, fake.alg, fake.claims, fake.token_status = fake.key, "RS256", {}, 200
    fake.token_scope = None
    fake.requests.clear()
    fake.issued.clear()
    monkeypatch.setattr(
        telegram_oidc,
        "_client",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(fake.handler)),
    )
    return fake


@pytest.fixture(autouse=True)
def configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "mcp_oauth_issuer_url", ISSUER)
    monkeypatch.setattr(settings, "telegram_login_client_id", TG_CLIENT_ID)
    monkeypatch.setattr(settings, "telegram_login_client_secret", TG_SECRET)


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    async def clean() -> None:
        await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
        await db_session.execute(
            text(
                "DELETE FROM mcp_oauth_clients WHERE client_info->>'client_name' "
                "LIKE :m AND client_id NOT IN (SELECT oauth_client_id FROM "
                "mcp_tokens WHERE oauth_client_id IS NOT NULL)"
            ),
            {"m": f"%{_NAME_MARK}%"},
        )
        await db_session.commit()

    await clean()
    yield
    await clean()


# ---------------------------------------------------------------------------
# The flow, step by step
# ---------------------------------------------------------------------------


def _s256(verifier: str) -> str:
    """RFC 7636 §4.2 written out here -- not the module's own helper, so the
    test does not grade the module with its own arithmetic."""
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def _pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(48)
    return verifier, _s256(verifier)


async def _register(client: AsyncClient, **over) -> httpx.Response:
    body = {
        "redirect_uris": [CB],
        "token_endpoint_auth_method": "none",
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "client_name": f"Claude {_NAME_MARK}",
    } | over
    body = {k: v for k, v in body.items() if v is not _DROP}
    return await client.post("/register", json=body)


async def _client_id(client: AsyncClient, **over) -> str:
    resp = await _register(client, **over)
    assert resp.status_code == 201, resp.text
    return resp.json()["client_id"]


async def _authorize(
    client: AsyncClient, cid: str, challenge: str, **over
) -> httpx.Response:
    params = {
        "client_id": cid,
        "redirect_uri": CB,
        "response_type": "code",
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": "claude-state-1",
        "resource": f"{ISSUER}/mcp",
    } | over
    params = {k: v for k, v in params.items() if v is not _DROP}
    return await client.get("/authorize", params=params)


def _query(location: str) -> dict[str, str]:
    return {k: v[0] for k, v in parse_qs(urlsplit(location).query).items()}


async def _to_consent(
    client: AsyncClient, tid: int, cid: str, challenge: str, **over
) -> httpx.Response:
    resp = await _authorize(client, cid, challenge, **over)
    assert resp.status_code == 302, resp.text
    state = _query(resp.headers["location"])["state"]
    return await client.get(CALLBACK_PATH, params={"code": f"tg-{tid}", "state": state})


def _consent_id(page: httpx.Response) -> str:
    match = re.search(r"name='consent' value='([^']+)'", page.text)
    assert match, page.text
    return match.group(1)


async def _decide(
    client: AsyncClient, consent_id: str | None, decision: str | None, scopes: list[str]
) -> httpx.Response:
    form: dict[str, str | list[str]] = {"scope": scopes}
    if consent_id is not None:
        form["consent"] = consent_id
    if decision is not None:
        form["decision"] = decision
    return await client.post(CONSENT_PATH, data=form)


async def _code(
    client: AsyncClient, tid: int, cid: str, challenge: str, scopes: list[str] = ALL
) -> str:
    page = await _to_consent(client, tid, cid, challenge)
    assert page.status_code == 200, page.text
    resp = await _decide(client, _consent_id(page), "allow", scopes)
    assert resp.status_code == 302, resp.text
    q = _query(resp.headers["location"])
    assert resp.headers["location"].startswith(CB) and q["state"] == "claude-state-1"
    return q["code"]


async def _token(client: AsyncClient, **form) -> httpx.Response:
    return await client.post(
        "/token", data={k: v for k, v in form.items() if v is not None}
    )


async def _exchange(
    client: AsyncClient,
    cid: str,
    code: str,
    verifier: str,
    redirect_uri: str | None = CB,
) -> httpx.Response:
    return await _token(
        client,
        grant_type="authorization_code",
        client_id=cid,
        code=code,
        code_verifier=verifier,
        redirect_uri=redirect_uri,
    )


async def _connect(
    client: AsyncClient, tid: int, cid: str | None = None, scopes: list[str] = ALL
) -> tuple[str, dict]:
    """The whole flow for an existing student -> (client id, token body)."""
    cid = cid or await _client_id(client)
    verifier, challenge = _pkce()
    code = await _code(client, tid, cid, challenge, scopes)
    resp = await _exchange(client, cid, code, verifier)
    assert resp.status_code == 200, resp.text
    return cid, resp.json()


async def _student(client: AsyncClient, tid: int) -> tuple[UUID, dict]:
    auth = await login_user(client, telegram_id=tid, first_name="Ученик")
    return UUID(auth["user"]["id"]), auth_headers(auth["session_token"])


async def _mcp_status(client: AsyncClient, token: str) -> int:
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
    resp = await client.post(
        "/mcp", json=body, headers=MCP_HEADERS | {"Authorization": f"Bearer {token}"}
    )
    return resp.status_code


_LOCK_WAITERS = text(
    "SELECT count(*) FROM pg_stat_activity "
    "WHERE wait_event_type = 'Lock' AND datname = current_database()"
)


async def _wait_for_lock_waiters(n: int) -> None:
    """Until n sessions wait on a lock (par0 §8: the race harness waits on
    the lock itself, not on a sleep). pg_stat_activity is a snapshot held for
    the whole transaction, so each poll ends its own -- otherwise every poll
    would see the first one, taken before anybody arrived."""
    async with get_session_factory()() as probe:
        for _ in range(200):
            waiting = await probe.scalar(_LOCK_WAITERS)
            await probe.rollback()
            if waiting >= n:
                return
            await asyncio.sleep(0.05)
    raise AssertionError(f"the race was not built: {waiting} of {n} waiting")


async def _rows(user_id: UUID) -> list[McpToken]:
    async with get_session_factory()() as s:
        return list(
            (
                await s.execute(
                    select(McpToken)
                    .where(McpToken.user_id == user_id)
                    .order_by(McpToken.created_at)
                )
            ).scalars()
        )


# ---------------------------------------------------------------------------
# Discovery and the door
# ---------------------------------------------------------------------------


async def test_a_401_leads_to_the_authorization_server(client: AsyncClient) -> None:
    resp = await client.post("/mcp", json={}, headers=MCP_HEADERS)
    assert resp.status_code == 401
    prm_url = f"{ISSUER}{PRM_PATH}"
    assert f'resource_metadata="{prm_url}"' in resp.headers["www-authenticate"]

    prm = (await client.get(PRM_PATH)).json()
    assert prm["resource"] == f"{ISSUER}/mcp"
    assert prm["authorization_servers"][0].rstrip("/") == ISSUER
    assert prm["scopes_supported"] == ALL

    meta = (await client.get(AS_METADATA_PATH)).json()
    assert meta["authorization_endpoint"] == f"{ISSUER}/authorize"
    assert meta["token_endpoint"] == f"{ISSUER}/token"
    assert meta["registration_endpoint"] == f"{ISSUER}/register"
    # Public clients only -- the SDK's default advertises the secret methods.
    assert meta["token_endpoint_auth_methods_supported"] == ["none"]
    assert meta["code_challenge_methods_supported"] == ["S256"]
    assert meta["scopes_supported"] == ALL
    assert "revocation_endpoint" not in meta  # owner ruling: off


async def test_without_oauth_configured_the_401_is_the_old_one(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "telegram_login_client_secret", "")
    resp = await client.post("/mcp", json={}, headers=MCP_HEADERS)
    assert resp.status_code == 401
    assert resp.headers["www-authenticate"] == 'Bearer realm="velo-mcp"'


@pytest.mark.parametrize(
    "setting",
    [
        "mcp_enabled",
        "mcp_oauth_issuer_url",
        "telegram_login_client_id",
        "telegram_login_client_secret",
        "public_host",
    ],
)
async def test_the_door_answers_the_plain_404(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, setting: str
) -> None:
    """MCP off, any of the three keys unset, or the public host: every OAuth
    path is the app's plain 404. Pair: configured, the same paths answer."""
    host = {}
    if setting == "mcp_enabled":
        monkeypatch.setattr(settings, "mcp_enabled", False)
    elif setting == "public_host":
        monkeypatch.setattr(settings, "public_link_base", "https://go.velo.test")
        host = {"Host": "go.velo.test"}
    else:
        monkeypatch.setattr(settings, setting, "")
    for path in OAUTH_PATHS:
        for method in ("GET", "POST"):
            resp = await client.request(method, path, headers=host)
            assert resp.status_code == 404, (path, method)
            assert resp.json() == {"error": "not_found", "message": "Not found"}
    # Pair: back to configured (undo drops the autouse `configured` too,
    # so it is re-applied), the same door answers.
    monkeypatch.undo()
    monkeypatch.setattr(settings, "mcp_oauth_issuer_url", ISSUER)
    monkeypatch.setattr(settings, "telegram_login_client_id", TG_CLIENT_ID)
    monkeypatch.setattr(settings, "telegram_login_client_secret", TG_SECRET)
    assert (await client.get(AS_METADATA_PATH)).status_code == 200
    assert (await client.get(PRM_PATH)).status_code == 200


def test_main_routes_exactly_the_paths_the_door_serves() -> None:
    routed = {
        r.path
        for r in app.router.routes
        if isinstance(getattr(r, "app", None), OAuthDoor)
    }
    served = {r.path for r in mcp_oauth._router(ISSUER).routes}
    assert routed == set(OAUTH_PATHS) == served


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------


async def test_a_public_https_client_registers_and_nothing_secret_is_kept(
    client: AsyncClient,
) -> None:
    resp = await _register(client)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body.get("client_secret") is None
    async with get_session_factory()() as s:
        row = await s.get(McpOAuthClient, body["client_id"])
    assert row is not None and row.client_info["redirect_uris"] == [CB]
    assert "client_secret" not in row.client_info


@pytest.mark.parametrize(
    ("over", "error"),
    [
        ({"redirect_uris": ["http://claude.ai/cb"]}, "invalid_redirect_uri"),
        ({"redirect_uris": ["http://localhost:3118/callback"]}, "invalid_redirect_uri"),
        ({"redirect_uris": [CB, "https://claude.ai/cb#frag"]}, "invalid_redirect_uri"),
        ({"redirect_uris": []}, "invalid_client_metadata"),
        ({"redirect_uris": _DROP}, "invalid_client_metadata"),
        (
            {"token_endpoint_auth_method": "client_secret_post"},
            "invalid_client_metadata",
        ),
        ({"token_endpoint_auth_method": _DROP}, "invalid_client_metadata"),
        ({"scope": "read admin"}, "invalid_client_metadata"),
    ],
)
async def test_registration_refusals_write_nothing(
    client: AsyncClient, over: dict, error: str
) -> None:
    marker = f"refused {secrets.token_hex(4)} {_NAME_MARK}"
    resp = await _register(client, client_name=marker, **over)
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"] == error
    async with get_session_factory()() as s:
        n = await s.scalar(
            select(text("count(*)"))
            .select_from(McpOAuthClient)
            .where(McpOAuthClient.client_info["client_name"].astext == marker)
        )
    assert n == 0


async def test_registration_is_limited_per_source(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "mcp_oauth_register_per_source", 2)
    redis = get_redis()
    await redis.delete(
        "mcp_oauth_register_src:8.8.4.4", "mcp_oauth_register_src:8.8.8.8"
    )
    try:
        one = {"X-Real-IP": "8.8.4.4"}
        for _ in range(2):
            assert (
                await client.post("/register", json={}, headers=one)
            ).status_code == 400
        third = await client.post("/register", json={}, headers=one)
        assert third.status_code == 429
        assert third.json()["error"] == "rate_limited"
        # Pair: another source is unaffected.
        other = await _register(client)
        assert other.status_code == 201
        other = await client.post(
            "/register", json={}, headers={"X-Real-IP": "8.8.8.8"}
        )
        assert other.status_code == 400
    finally:
        await redis.delete(
            "mcp_oauth_register_src:8.8.4.4", "mcp_oauth_register_src:8.8.8.8"
        )


async def test_registration_refuses_while_the_limiter_is_down(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def down(*a, **kw):
        raise RedisError("down")

    monkeypatch.setattr(mcp_oauth, "over_source_limit", down)
    resp = await _register(client)
    assert resp.status_code == 503
    # Pair: only registration is limited -- discovery still answers.
    assert (await client.get(AS_METADATA_PATH)).status_code == 200


# ---------------------------------------------------------------------------
# Authorize
# ---------------------------------------------------------------------------


async def test_authorize_sends_the_browser_to_telegram(client: AsyncClient) -> None:
    cid = await _client_id(client)
    _, challenge = _pkce()
    resp = await _authorize(client, cid, challenge)
    assert resp.status_code == 302
    loc = resp.headers["location"]
    assert loc.startswith(telegram_oidc.AUTHORIZE_URL + "?")
    q = _query(loc)
    assert q["client_id"] == TG_CLIENT_ID
    assert q["redirect_uri"] == f"{ISSUER}{CALLBACK_PATH}"
    assert q["scope"] == "openid profile"
    assert q["response_type"] == "code" and q["code_challenge_method"] == "S256"
    # Our own PKCE pair for the Telegram leg, not the client's.
    assert q["code_challenge"] != challenge and len(q["code_challenge"]) == 43
    assert q["state"] and q["state"] != "claude-state-1"
    assert TG_SECRET not in loc


async def test_authorize_refusals_the_sdk_makes_never_redirect(
    client: AsyncClient,
) -> None:
    cid = await _client_id(client)
    _, challenge = _pkce()
    for over in (
        {"client_id": "no-such-client"},
        {"redirect_uri": "https://evil.example/cb"},
    ):
        resp = await _authorize(client, cid, challenge, **over)
        assert resp.status_code == 400, over
        assert "location" not in resp.headers
    # A repeated redirect_uri, ours and a foreign one: never to the foreign.
    resp = await client.get(
        f"/authorize?client_id={cid}&response_type=code&code_challenge={challenge}"
        f"&redirect_uri={CB}&redirect_uri=https://evil.example/cb"
    )
    assert "evil.example" not in resp.headers.get("location", "")


@pytest.mark.parametrize(
    ("over", "error"),
    [
        ({"redirect_uri": _DROP}, "invalid_request"),
        ({"code_challenge": ""}, "invalid_request"),
        ({"code_challenge": "a" * 42}, "invalid_request"),
        ({"code_challenge": "a" * 43 + "="}, "invalid_request"),
        ({"code_challenge": _DROP}, "invalid_request"),
        ({"code_challenge_method": "plain"}, "invalid_request"),
        ({"scope": "read admin"}, "invalid_scope"),
        ({"scope": ""}, "invalid_scope"),
        ({"resource": "https://other.example/mcp"}, "invalid_target"),
        ({"resource": f"{ISSUER}/mcp/"}, "invalid_target"),
    ],
)
async def test_authorize_refusals_go_back_to_the_client(
    client: AsyncClient, over: dict, error: str
) -> None:
    cid = await _client_id(client)
    _, challenge = _pkce()
    resp = await _authorize(client, cid, challenge, **over)
    assert resp.status_code == 302, resp.text
    loc = resp.headers["location"]
    assert loc.startswith(CB)
    assert _query(loc)["error"] == error
    assert _query(loc)["state"] == "claude-state-1"


async def test_authorize_without_resource_or_scope_is_fine(client: AsyncClient) -> None:
    cid = await _client_id(client)
    _, challenge = _pkce()
    resp = await _authorize(client, cid, challenge, resource=_DROP)
    assert resp.status_code == 302
    assert resp.headers["location"].startswith(telegram_oidc.AUTHORIZE_URL)


# ---------------------------------------------------------------------------
# Telegram callback
# ---------------------------------------------------------------------------


async def test_the_callback_takes_its_state_once(
    client: AsyncClient, telegram: FakeTelegram
) -> None:
    await _student(client, 73410)
    cid = await _client_id(client)
    _, challenge = _pkce()
    resp = await _authorize(client, cid, challenge)
    state = _query(resp.headers["location"])["state"]

    first = await client.get(CALLBACK_PATH, params={"code": "tg-73410", "state": state})
    assert first.status_code == 200
    again = await client.get(CALLBACK_PATH, params={"code": "tg-73410", "state": state})
    assert again.status_code == 400
    assert mcp_oauth.PHRASE_EXPIRED in again.text
    for params in (
        {"code": "tg-73410"},
        {"code": "tg-73410", "state": ""},
        {"code": "tg-73410", "state": "unknown"},
    ):
        resp = await client.get(CALLBACK_PATH, params=params)
        assert resp.status_code == 400 and mcp_oauth.PHRASE_EXPIRED in resp.text


async def test_cancelled_on_telegram_means_access_denied_to_the_client(
    client: AsyncClient, telegram: FakeTelegram
) -> None:
    cid = await _client_id(client)
    _, challenge = _pkce()
    state = _query((await _authorize(client, cid, challenge)).headers["location"])[
        "state"
    ]
    resp = await client.get(
        CALLBACK_PATH, params={"error": "access_denied", "state": state}
    )
    assert resp.status_code == 302
    q = _query(resp.headers["location"])
    assert resp.headers["location"].startswith(CB)
    assert q == {"error": "access_denied", "state": "claude-state-1"}
    assert not telegram.requests  # nothing was exchanged


async def test_the_telegram_leg_carries_our_verifier_and_secret(
    client: AsyncClient, telegram: FakeTelegram
) -> None:
    await _student(client, 73411)
    cid = await _client_id(client)
    _, challenge = _pkce()
    auth = await _authorize(client, cid, challenge)
    q = _query(auth.headers["location"])
    page = await client.get(
        CALLBACK_PATH, params={"code": "tg-73411", "state": q["state"]}
    )
    assert page.status_code == 200

    token_req = next(r for r in telegram.requests if r.url.path == "/token")
    form = {k: v[0] for k, v in parse_qs(token_req.content.decode()).items()}
    assert _s256(form["code_verifier"]) == q["code_challenge"]
    assert form["redirect_uri"] == f"{ISSUER}{CALLBACK_PATH}"
    assert form["code"] == "tg-73411" and form["client_id"] == TG_CLIENT_ID
    basic = base64.b64encode(f"{TG_CLIENT_ID}:{TG_SECRET}".encode()).decode()
    assert token_req.headers["authorization"] == f"Basic {basic}"


@pytest.mark.parametrize(
    "bend",
    [
        "status",
        "foreign_key",
        "aud",
        "iss",
        "expired",
        "no_exp",
        "no_id",
        "id_bool",
        "id_letters",
        "id_zero",
        "hs256",
        "kid",
    ],
)
async def test_every_way_the_telegram_login_fails_is_one_page(
    client: AsyncClient, telegram: FakeTelegram, bend: str
) -> None:
    """Every refused login ends on the same page. The `id` bend was a digit
    string ("73412") and rightly refused while Telegram's example showed a
    JSON number; the live token (BE-141 FIX) carried a string, and digit
    strings are now accepted (owner ruling), so the bend is a string with a
    letter -- still refused. Accepted forms: test_the_id_claim_forms."""
    await _student(client, 73412)
    if bend == "status":
        telegram.token_status = 400
    elif bend == "foreign_key":
        telegram.sign_key = rsa.generate_private_key(
            public_exponent=65537, key_size=2048
        )
    elif bend == "aud":
        telegram.claims = {"aud": "999"}
    elif bend == "iss":
        telegram.claims = {"iss": "https://evil.example"}
    elif bend == "expired":
        telegram.claims = {"exp": int(time.time()) - 60}
    elif bend == "no_exp":
        telegram.claims = {"exp": _DROP}
    elif bend == "no_id":
        telegram.claims = {"id": _DROP}
    elif bend == "id_bool":
        telegram.claims = {"id": True}
    elif bend == "id_letters":
        telegram.claims = {"id": "7341a2"}
    elif bend == "id_zero":
        telegram.claims = {"id": 0}
    elif bend == "hs256":
        telegram.alg = "HS256"
    elif bend == "kid":
        telegram.token_kid = "other"
    try:
        cid = await _client_id(client)
        _, challenge = _pkce()
        page = await _to_consent(client, 73412, cid, challenge)
    finally:
        telegram.token_kid = "k1"
    assert page.status_code == 400, page.text
    assert mcp_oauth.PHRASE_TELEGRAM_FAILED in page.text
    assert "name='consent'" not in page.text


async def test_a_telegram_user_unknown_to_velo_is_not_created(
    client: AsyncClient, telegram: FakeTelegram, db_session: AsyncSession
) -> None:
    cid = await _client_id(client)
    _, challenge = _pkce()
    page = await _to_consent(client, 73413, cid, challenge)
    assert page.status_code == 403
    assert mcp_oauth.PHRASE_UNKNOWN_USER in page.text
    n = await db_session.scalar(
        select(text("count(*)")).select_from(User).where(User.telegram_id == 73413)
    )
    assert n == 0
    # Pair: once the student has opened VELO, the same login goes through.
    await _student(client, 73413)
    page = await _to_consent(client, 73413, cid, challenge)
    assert page.status_code == 200


async def test_a_deactivated_student_cannot_connect(
    client: AsyncClient, telegram: FakeTelegram, db_session: AsyncSession
) -> None:
    user_id, _ = await _student(client, 73414)
    await db_session.execute(
        update(User).where(User.id == user_id).values(is_active=False)
    )
    await db_session.commit()
    cid = await _client_id(client)
    _, challenge = _pkce()
    page = await _to_consent(client, 73414, cid, challenge)
    assert page.status_code == 403
    assert mcp_oauth.PHRASE_INACTIVE in page.text


async def test_the_consent_page_refuses_frames_and_escapes_the_client(
    client: AsyncClient, telegram: FakeTelegram
) -> None:
    await _student(client, 73415)
    cid = await _client_id(client, client_name=f"<script>x</script> {_NAME_MARK}")
    _, challenge = _pkce()
    page = await _to_consent(client, 73415, cid, challenge, scope="read diary:write")
    assert page.status_code == 200
    assert page.headers["x-frame-options"] == "DENY"
    assert "frame-ancestors 'none'" in page.headers["content-security-policy"]
    assert page.headers["cache-control"] == "no-store"
    assert "<script>" not in page.text and "&lt;script&gt;" in page.text
    assert "claude.ai" in page.text  # the redirect host, shown
    assert "Ученик" in page.text  # who is signed in
    # Only the requested scopes are offered.
    offered = re.findall(r"name='scope' value='([^']+)'", page.text)
    assert offered == ["read", "diary:write"]


# ---------------------------------------------------------------------------
# Consent
# ---------------------------------------------------------------------------


async def test_deny_goes_back_with_access_denied_and_no_code(
    client: AsyncClient, telegram: FakeTelegram
) -> None:
    await _student(client, 73416)
    cid = await _client_id(client)
    _, challenge = _pkce()
    page = await _to_consent(client, 73416, cid, challenge)
    resp = await _decide(client, _consent_id(page), "deny", ALL)
    assert resp.status_code == 302
    assert _query(resp.headers["location"]) == {
        "error": "access_denied",
        "state": "claude-state-1",
    }


@pytest.mark.parametrize(
    "scopes", [[], ["read", "read"], ["read", "admin"], ["bookings:write"]]
)
async def test_bad_scope_choices_keep_the_page_usable(
    client: AsyncClient, telegram: FakeTelegram, scopes: list[str]
) -> None:
    """Empty, repeated, unknown, or not offered (only read was requested):
    the page again, with the phrase -- and the same consent still works."""
    await _student(client, 73417)
    cid = await _client_id(client)
    _, challenge = _pkce()
    page = await _to_consent(client, 73417, cid, challenge, scope="read")
    consent_id = _consent_id(page)
    resp = await _decide(client, consent_id, "allow", scopes)
    assert resp.status_code == 400
    assert mcp_oauth.PHRASE_NO_SCOPE in resp.text
    assert _consent_id(resp) == consent_id
    ok = await _decide(client, consent_id, "allow", ["read"])
    assert ok.status_code == 302 and "code" in _query(ok.headers["location"])


async def test_a_consent_is_decided_once(
    client: AsyncClient, telegram: FakeTelegram
) -> None:
    await _student(client, 73418)
    cid = await _client_id(client)
    _, challenge = _pkce()
    consent_id = _consent_id(await _to_consent(client, 73418, cid, challenge))
    first = await _decide(client, consent_id, "allow", ALL)
    assert first.status_code == 302
    second = await _decide(client, consent_id, "allow", ALL)
    assert second.status_code == 400 and mcp_oauth.PHRASE_EXPIRED in second.text


@pytest.mark.parametrize("missing", ["consent", "decision", "both_bad"])
async def test_a_malformed_consent_is_refused(
    client: AsyncClient, telegram: FakeTelegram, missing: str
) -> None:
    await _student(client, 73419)
    cid = await _client_id(client)
    _, challenge = _pkce()
    consent_id = _consent_id(await _to_consent(client, 73419, cid, challenge))
    if missing == "consent":
        resp = await _decide(client, None, "allow", ALL)
    elif missing == "decision":
        resp = await _decide(client, consent_id, None, ALL)
    else:
        resp = await _decide(client, consent_id, "maybe", ALL)
    assert resp.status_code == 400
    assert mcp_oauth.PHRASE_BAD_REQUEST in resp.text
    assert "location" not in resp.headers


# ---------------------------------------------------------------------------
# Token: the code
# ---------------------------------------------------------------------------


@pytest.mark.usefixtures("mcp")
async def test_the_full_flow_gives_a_listed_grant_that_opens_mcp(
    client: AsyncClient, telegram: FakeTelegram
) -> None:
    user_id, headers = await _student(client, 73420)
    cid, tokens = await _connect(client, 73420, scopes=["read", "diary:write"])
    assert tokens["token_type"] == "Bearer"
    assert tokens["expires_in"] == settings.mcp_oauth_access_ttl_seconds
    assert tokens["scope"] == "read diary:write"
    assert tokens["access_token"].startswith("velo_oat_")
    assert tokens["refresh_token"].startswith("velo_ort_")

    assert await _mcp_status(client, tokens["access_token"]) == 200
    # The refresh token never opens /mcp.
    assert await _mcp_status(client, tokens["refresh_token"]) == 401

    items = (await client.get(TOKENS_URL, headers=headers)).json()["items"]
    assert len(items) == 1
    assert items[0]["kind"] == "oauth"
    assert items[0]["name"] == f"Claude {_NAME_MARK}"
    assert items[0]["scopes"] == ["read", "diary:write"]
    assert items[0]["last_used_at"] is not None  # /mcp above used it

    async with get_session_factory()() as s:
        audit = (
            (
                await s.execute(
                    select(AuditLog).where(
                        AuditLog.event == "mcp_oauth_granted",
                        AuditLog.actor_id == user_id,
                    )
                )
            )
            .scalars()
            .all()
        )
    assert len(audit) == 1 and audit[0].data["client_id"] == cid


async def test_a_code_is_spent_once(
    client: AsyncClient, telegram: FakeTelegram
) -> None:
    await _student(client, 73421)
    cid = await _client_id(client)
    verifier, challenge = _pkce()
    code = await _code(client, 73421, cid, challenge)
    assert (await _exchange(client, cid, code, verifier)).status_code == 200
    again = await _exchange(client, cid, code, verifier)
    assert again.status_code == 400 and again.json()["error"] == "invalid_grant"


@pytest.mark.parametrize(
    ("bend", "error"),
    [
        ("verifier", "invalid_grant"),
        ("empty_verifier", "invalid_grant"),
        ("no_verifier", "invalid_request"),
        ("redirect", "invalid_request"),
        ("no_redirect", "invalid_request"),
        ("other_client", "invalid_grant"),
        ("empty_code", "invalid_grant"),
        ("expired", "invalid_grant"),
    ],
)
async def test_a_code_is_bound_to_its_verifier_redirect_and_client(
    client: AsyncClient, telegram: FakeTelegram, bend: str, error: str
) -> None:
    user_id, _ = await _student(client, 73422)
    cid = await _client_id(client)
    verifier, challenge = _pkce()
    code = await _code(client, 73422, cid, challenge)
    kw: dict = {
        "client_id": cid,
        "code": code,
        "code_verifier": verifier,
        "redirect_uri": CB,
    }
    if bend == "verifier":
        kw["code_verifier"] = _pkce()[0]
    elif bend == "empty_verifier":
        kw["code_verifier"] = ""
    elif bend == "no_verifier":
        kw["code_verifier"] = None
    elif bend == "redirect":
        kw["redirect_uri"] = "https://claude.ai/other"
    elif bend == "no_redirect":
        kw["redirect_uri"] = None
    elif bend == "other_client":
        kw["client_id"] = await _client_id(client)
    elif bend == "empty_code":
        kw["code"] = ""
    elif bend == "expired":
        key = mcp_oauth._key("code", code)
        data = json.loads(await get_redis().get(key))
        data["expires_at"] = time.time() - 1
        await get_redis().set(key, json.dumps(data), ex=60)
    resp = await _token(client, grant_type="authorization_code", **kw)
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"] == error
    assert code not in resp.text
    assert await _rows(user_id) == []
    # Pair: the untouched code still works (a failed check does not spend it)
    # -- except where the bend itself was the expiry.
    if bend != "expired":
        ok = await _exchange(client, cid, code, verifier)
        assert ok.status_code == 200


async def test_deactivated_between_consent_and_exchange(
    client: AsyncClient, telegram: FakeTelegram, db_session: AsyncSession
) -> None:
    user_id, _ = await _student(client, 73423)
    cid = await _client_id(client)
    verifier, challenge = _pkce()
    code = await _code(client, 73423, cid, challenge)
    await db_session.execute(
        update(User).where(User.id == user_id).values(is_active=False)
    )
    await db_session.commit()
    resp = await _exchange(client, cid, code, verifier)
    assert resp.status_code == 400 and resp.json()["error"] == "invalid_grant"
    assert await _rows(user_id) == []


@pytest.mark.usefixtures("mcp")
async def test_reconnecting_replaces_the_grant(
    client: AsyncClient, telegram: FakeTelegram
) -> None:
    user_id, headers = await _student(client, 73424)
    _, first = await _connect(client, 73424)
    _, second = await _connect(client, 73424)  # a new client, as claude.ai does
    rows = await _rows(user_id)
    assert len(rows) == 2
    assert rows[0].revoked_at is not None and rows[1].revoked_at is None
    assert await _mcp_status(client, first["access_token"]) == 401
    assert await _mcp_status(client, second["access_token"]) == 200
    live = [
        i
        for i in (await client.get(TOKENS_URL, headers=headers)).json()["items"]
        if i["revoked_at"] is None
    ]
    assert len(live) == 1


async def test_a_personal_token_keeps_its_name_and_the_grant_takes_the_host(
    client: AsyncClient, telegram: FakeTelegram
) -> None:
    user_id, headers = await _student(client, 73425)
    name = f"claude {_NAME_MARK}"  # case-insensitive clash with the client's
    resp = await client.post(TOKENS_URL, json={"name": name}, headers=headers)
    assert resp.status_code == 201
    await _connect(client, 73425)
    rows = {r.name: r for r in await _rows(user_id)}
    assert rows[name].revoked_at is None and rows[name].oauth_client_id is None
    grant = rows[f"Claude {_NAME_MARK} · claude.ai"]
    assert grant.oauth_client_id is not None and grant.revoked_at is None


async def test_when_both_names_are_personal_tokens_the_connection_is_refused(
    client: AsyncClient, telegram: FakeTelegram
) -> None:
    user_id, headers = await _student(client, 73426)
    cid = await _client_id(client)
    verifier, challenge = _pkce()
    code = await _code(client, 73426, cid, challenge)  # names still free here
    for name in (f"Claude {_NAME_MARK}", f"Claude {_NAME_MARK} · claude.ai"):
        resp = await client.post(TOKENS_URL, json={"name": name}, headers=headers)
        assert resp.status_code == 201
    # The exchange refuses ...
    resp = await _exchange(client, cid, code, verifier)
    assert resp.status_code == 400 and resp.json()["error"] == "invalid_grant"
    assert all(r.oauth_client_id is None for r in await _rows(user_id))
    # ... and a new attempt is told why on the page.
    _, challenge = _pkce()
    page = await _to_consent(client, 73426, cid, challenge)
    assert (
        page.status_code == 409
        and html.escape(mcp_oauth.PHRASE_NAME_TAKEN) in page.text
    )


async def test_the_limit_of_live_tokens_counts_grants_but_not_a_replaced_one(
    client: AsyncClient, telegram: FakeTelegram, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "mcp_tokens_max_active_per_user", 2)
    user_id, headers = await _student(client, 73427)
    assert (
        await client.post(TOKENS_URL, json={"name": "p1"}, headers=headers)
    ).status_code == 201
    await _connect(client, 73427)  # 2 of 2
    # Reconnecting replaces the grant: still 2 of 2, allowed.
    await _connect(client, 73427)
    # A second personal token would be the third.
    resp = await client.post(TOKENS_URL, json={"name": "p2"}, headers=headers)
    assert resp.status_code == 409
    # With the grant revoked, the personal slot is free, and a full table
    # of personal tokens stops the connection on the page.
    grant = next(
        r for r in await _rows(user_id) if r.oauth_client_id and not r.revoked_at
    )
    await client.post(f"{TOKENS_URL}/{grant.id}/revoke", headers=headers)
    assert (
        await client.post(TOKENS_URL, json={"name": "p2"}, headers=headers)
    ).status_code == 201
    cid = await _client_id(client)
    _, challenge = _pkce()
    page = await _to_consent(client, 73427, cid, challenge)
    assert page.status_code == 409 and html.escape(mcp_oauth.PHRASE_LIMIT) in page.text


async def test_the_limit_is_checked_again_at_the_exchange(
    client: AsyncClient, telegram: FakeTelegram, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The page's limit check is an early warning; the exchange decides.
    Filled between consent and exchange -> invalid_grant, nothing issued."""
    monkeypatch.setattr(settings, "mcp_tokens_max_active_per_user", 1)
    user_id, headers = await _student(client, 73437)
    cid = await _client_id(client)
    verifier, challenge = _pkce()
    code = await _code(client, 73437, cid, challenge)
    assert (
        await client.post(TOKENS_URL, json={"name": "p1"}, headers=headers)
    ).status_code == 201
    resp = await _exchange(client, cid, code, verifier)
    assert resp.status_code == 400 and resp.json()["error"] == "invalid_grant"
    assert all(r.oauth_client_id is None for r in await _rows(user_id))


async def test_the_live_name_index_is_in_the_schema(db_session: AsyncSession) -> None:
    """The guard of the race below lives in the database -- read from
    pg_indexes, not from the model."""
    indexdef = await db_session.scalar(
        text(
            "SELECT indexdef FROM pg_indexes WHERE tablename = 'mcp_tokens' "
            "AND indexname = 'uq_mcp_tokens_live_name'"
        )
    )
    assert indexdef is not None
    assert "UNIQUE" in indexdef and "lower((name)::text)" in indexdef
    assert "WHERE (revoked_at IS NULL)" in indexdef


async def test_two_exchanges_racing_to_one_name_leave_one_live_grant(
    client: AsyncClient, telegram: FakeTelegram
) -> None:
    """Built, not hoped for: the users row is held while both exchanges
    start, so both have done their revocation (nothing yet) and wait on
    lock_user_row; released, one inserts, the other meets
    uq_mcp_tokens_live_name. The invariant: one live grant of that name,
    and only its access token works."""
    user_id, _ = await _student(client, 73428)
    cid = await _client_id(client)
    v1, c1 = _pkce()
    v2, c2 = _pkce()
    code1 = await _code(client, 73428, cid, c1)
    code2 = await _code(client, 73428, cid, c2)

    holder = get_session_factory()()
    await lock_user_row(holder, user_id)
    tasks = [
        asyncio.create_task(_exchange(client, cid, code1, v1)),
        asyncio.create_task(_exchange(client, cid, code2, v2)),
    ]
    try:
        await _wait_for_lock_waiters(2)
    finally:
        await holder.rollback()
        await holder.close()
    results = await asyncio.gather(*tasks)

    statuses = sorted(r.status_code for r in results)
    assert statuses == [200, 400], [r.text for r in results]
    loser = next(r for r in results if r.status_code == 400)
    assert loser.json()["error"] == "invalid_grant"
    live = [r for r in await _rows(user_id) if r.revoked_at is None]
    assert len(live) == 1


# ---------------------------------------------------------------------------
# Token: refresh
# ---------------------------------------------------------------------------


async def _refresh(client: AsyncClient, cid: str, refresh: str, **kw) -> httpx.Response:
    return await _token(
        client, grant_type="refresh_token", client_id=cid, refresh_token=refresh, **kw
    )


@pytest.mark.usefixtures("mcp")
async def test_refresh_rotates_both_and_kills_the_old_pair(
    client: AsyncClient, telegram: FakeTelegram
) -> None:
    user_id, _ = await _student(client, 73429)
    cid, first = await _connect(client, 73429)
    resp = await _refresh(client, cid, first["refresh_token"])
    assert resp.status_code == 200, resp.text
    second = resp.json()
    assert second["access_token"] != first["access_token"]
    assert second["refresh_token"] != first["refresh_token"]
    assert second["scope"] == " ".join(ALL)
    assert await _mcp_status(client, second["access_token"]) == 200
    assert await _mcp_status(client, first["access_token"]) == 401
    again = await _refresh(client, cid, first["refresh_token"])
    assert again.status_code == 400 and again.json()["error"] == "invalid_grant"
    # One grant throughout -- a refresh is not a new connection.
    assert len(await _rows(user_id)) == 1


async def test_refresh_refusals(client: AsyncClient, telegram: FakeTelegram) -> None:
    _, headers = await _student(client, 73430)
    cid, tokens = await _connect(client, 73430)
    other = await _client_id(client)
    for kw, error in (
        ({"cid": other}, "invalid_grant"),
        ({"refresh": tokens["access_token"]}, "invalid_grant"),
        ({"refresh": ""}, "invalid_grant"),
        ({"refresh": tokens["refresh_token"][:-1] + "x"}, "invalid_grant"),
        # A forged secret with a live prefix and a scope: still invalid_grant,
        # never invalid_scope -- the answer must not tell the prefix is live.
        (
            {"refresh": tokens["refresh_token"][:-1] + "x", "scope": "admin"},
            "invalid_grant",
        ),
        ({"scope": "read admin"}, "invalid_scope"),
    ):
        resp = await _refresh(
            client,
            kw.get("cid", cid),
            kw.get("refresh", tokens["refresh_token"]),
            **({"scope": kw["scope"]} if "scope" in kw else {}),
        )
        assert resp.status_code == 400, kw
        assert resp.json()["error"] == error, kw
    # Pair: the real token still refreshes; then, revoked in the app, not.
    # (Deactivation is its own test below.)
    resp = await _refresh(client, cid, tokens["refresh_token"])
    assert resp.status_code == 200
    item = (await client.get(TOKENS_URL, headers=headers)).json()["items"][0]
    await client.post(f"{TOKENS_URL}/{item['id']}/revoke", headers=headers)
    resp = await _refresh(client, cid, resp.json()["refresh_token"])
    assert resp.status_code == 400 and resp.json()["error"] == "invalid_grant"


async def test_a_deactivated_student_cannot_refresh(
    client: AsyncClient, telegram: FakeTelegram, db_session: AsyncSession
) -> None:
    user_id, _ = await _student(client, 73438)
    cid, tokens = await _connect(client, 73438)
    await db_session.execute(
        update(User).where(User.id == user_id).values(is_active=False)
    )
    await db_session.commit()
    resp = await _refresh(client, cid, tokens["refresh_token"])
    assert resp.status_code == 400 and resp.json()["error"] == "invalid_grant"
    # Pair: reactivated, the same token refreshes -- the refusal was the flag.
    await db_session.execute(
        update(User).where(User.id == user_id).values(is_active=True)
    )
    await db_session.commit()
    assert (await _refresh(client, cid, tokens["refresh_token"])).status_code == 200


async def test_two_refreshes_with_one_token_succeed_once(
    client: AsyncClient, telegram: FakeTelegram
) -> None:
    """Built, not hoped for: the grant's row is held while both refreshes
    start, so both pass load_oauth_refresh (a plain read) and wait on the
    rotating UPDATE; released, one rotates, the other re-evaluates its WHERE
    against the committed new prefix and hash and matches nothing. The
    invariant: one success, and the row holds that success's refresh."""
    user_id, _ = await _student(client, 73431)
    cid, tokens = await _connect(client, 73431)

    holder = get_session_factory()()
    await holder.execute(
        select(McpToken.id).where(McpToken.user_id == user_id).with_for_update()
    )
    tasks = [
        asyncio.create_task(_refresh(client, cid, tokens["refresh_token"])),
        asyncio.create_task(_refresh(client, cid, tokens["refresh_token"])),
    ]
    try:
        await _wait_for_lock_waiters(2)
    finally:
        await holder.rollback()
        await holder.close()
    results = await asyncio.gather(*tasks)

    ok = [r for r in results if r.status_code == 200]
    assert len(ok) == 1, [r.text for r in results]
    loser = next(r for r in results if r.status_code != 200)
    assert loser.status_code == 400 and loser.json()["error"] == "invalid_grant"
    rows = await _rows(user_id)
    assert len(rows) == 1
    assert rows[0].prefix == ok[0].json()["refresh_token"].split("_")[2]


async def test_rotate_on_its_own_checks_the_secret(
    client: AsyncClient, telegram: FakeTelegram
) -> None:
    """rotate_oauth_refresh is callable without load_oauth_refresh: its own
    WHERE must refuse a string that carries the grant's prefix but not its
    secret. Pair: the real token rotates."""
    from app.modules.mcp.service import rotate_oauth_refresh

    await _student(client, 73439)
    cid, tokens = await _connect(client, 73439)
    real = tokens["refresh_token"]
    forged = real[: -len(real.split("_", 3)[3])] + "A" * 43
    async with get_session_factory()() as s:
        assert await rotate_oauth_refresh(s, forged, cid) is None
        assert await rotate_oauth_refresh(s, real, cid) is not None
        await s.rollback()


# ---------------------------------------------------------------------------
# Revoke and expiry (item 5)
# ---------------------------------------------------------------------------


@pytest.mark.usefixtures("mcp")
async def test_revoked_in_the_app_the_next_call_is_401(
    client: AsyncClient, telegram: FakeTelegram
) -> None:
    _, headers = await _student(client, 73432)
    _, tokens = await _connect(client, 73432)
    assert await _mcp_status(client, tokens["access_token"]) == 200
    item = (await client.get(TOKENS_URL, headers=headers)).json()["items"][0]
    resp = await client.post(f"{TOKENS_URL}/{item['id']}/revoke", headers=headers)
    assert resp.status_code == 200 and resp.json()["revoked_at"]
    assert await _mcp_status(client, tokens["access_token"]) == 401


@pytest.mark.usefixtures("mcp")
async def test_an_expired_access_token_is_401_until_refreshed(
    client: AsyncClient, telegram: FakeTelegram, db_session: AsyncSession
) -> None:
    user_id, _ = await _student(client, 73433)
    cid, tokens = await _connect(client, 73433)
    await db_session.execute(
        update(McpToken)
        .where(McpToken.user_id == user_id)
        .values(access_expires_at=text("now() - interval '1 second'"))
    )
    await db_session.commit()
    assert await _mcp_status(client, tokens["access_token"]) == 401
    fresh = (await _refresh(client, cid, tokens["refresh_token"])).json()
    assert await _mcp_status(client, fresh["access_token"]) == 200


# ---------------------------------------------------------------------------
# Secrets (item 8)
# ---------------------------------------------------------------------------


async def test_no_secret_reaches_the_log_the_audit_or_an_error(
    client: AsyncClient, telegram: FakeTelegram, capsys: pytest.CaptureFixture
) -> None:
    """Every secret of one connection, in every form it could be written
    in -- whole, its secret part, its prefix, its stored hash -- is absent
    from what the app printed and from the audit rows. Pair: the log and
    the audit are not empty (they did record the connection)."""
    import hashlib

    user_id, _ = await _student(client, 73434)
    cid = await _client_id(client)
    verifier, challenge = _pkce()
    auth = await _authorize(client, cid, challenge)
    state = _query(auth.headers["location"])["state"]
    page = await client.get(CALLBACK_PATH, params={"code": "tg-73434", "state": state})
    consent_id = _consent_id(page)
    redirect = await _decide(client, consent_id, "allow", ALL)
    code = _query(redirect.headers["location"])["code"]
    tokens = (await _exchange(client, cid, code, verifier)).json()
    refreshed = (await _refresh(client, cid, tokens["refresh_token"])).json()
    bad = await _exchange(client, cid, code, verifier)  # an error body too

    secrets_: list[str] = [
        state,
        consent_id,
        code,
        verifier,
        TG_SECRET,
        *telegram.issued,
    ]
    for tok in (
        tokens["access_token"],
        tokens["refresh_token"],
        refreshed["access_token"],
        refreshed["refresh_token"],
    ):
        _, _, prefix, secret = tok.split("_", 3)
        secrets_ += [tok, secret, prefix, hashlib.sha256(tok.encode()).hexdigest()]

    out = capsys.readouterr()
    printed = out.out + out.err
    assert "mcp_oauth_granted" in printed and "mcp_oauth_refreshed" in printed
    async with get_session_factory()() as s:
        audit = json.dumps(
            [
                a.data
                for a in (
                    await s.execute(
                        select(AuditLog).where(AuditLog.actor_id == user_id)
                    )
                ).scalars()
            ]
        )
    assert cid in audit  # the grant's audit row is there
    for value in secrets_:
        assert value not in printed, value[:6]
        assert value not in audit, value[:6]
        assert value not in bad.text, value[:6]


# ---------------------------------------------------------------------------
# The Telegram module on its own
# ---------------------------------------------------------------------------


def test_verify_id_token_returns_the_documented_user(telegram: FakeTelegram) -> None:
    """The claims of Telegram's documented example, mapped field by field."""
    telegram.claims = {
        "name": "John Doe",
        "given_name": "John",
        "family_name": "Doe",
        "preferred_username": "johndoe",
        "picture": "https://cdn4.telesco.pe/file/x.jpg",
    }
    user = telegram_oidc.verify_id_token(telegram.id_token(73435), telegram.jwks())
    assert user == telegram_oidc.TelegramUser(
        telegram_id=73435,
        first_name="John",
        last_name="Doe",
        username="johndoe",
        photo_url="https://cdn4.telesco.pe/file/x.jpg",
        bot_access_granted=False,
    )


@pytest.mark.parametrize(
    ("claims", "first", "photo"),
    [
        ({"given_name": _DROP, "name": "Only Name"}, "Only Name", None),
        ({"given_name": _DROP, "name": _DROP}, None, None),
        ({"picture": "http://cdn.example/x.jpg"}, "Ученик", None),
        ({"picture": "javascript:alert(1)"}, "Ученик", None),
        ({"picture": 5}, "Ученик", None),
        ({"given_name": ""}, None, None),
    ],
)
def test_profile_fields_degrade_to_none(
    telegram: FakeTelegram, claims: dict, first, photo
) -> None:
    """A missing or unusable claim is None, never a wrong value; a photo
    that is not https never reaches an <img>."""
    telegram.claims = claims
    user = telegram_oidc.verify_id_token(telegram.id_token(73440), telegram.jwks())
    assert user.telegram_id == 73440
    assert user.first_name == first and user.photo_url == photo


def test_start_login_makes_its_own_pkce_and_asks_bot_access_only_when_told() -> None:
    plain = telegram_oidc.start_login(redirect_uri="https://x.test/cb", state="s1")
    q = _query(plain.url)
    assert plain.url.startswith(telegram_oidc.AUTHORIZE_URL + "?")
    assert q["scope"] == "openid profile" and q["state"] == "s1"
    assert q["code_challenge"] == _s256(plain.code_verifier)
    assert q["code_challenge_method"] == "S256" and plain.bot_access is False

    asking = telegram_oidc.start_login(
        redirect_uri="https://x.test/cb", state="s2", bot_access=True
    )
    assert _query(asking.url)["scope"] == "openid profile telegram:bot_access"
    assert asking.bot_access is True
    # Pair: every start has its own verifier.
    assert asking.code_verifier != plain.code_verifier


@pytest.mark.parametrize(
    ("requested", "answer_scope", "granted"),
    [
        (False, None, False),
        (False, "openid profile telegram:bot_access", False),
        (True, None, True),  # RFC 6749 §5.1: absent -> as requested
        (True, "openid profile telegram:bot_access", True),
        (True, "openid profile", False),  # narrowed by the user
        (True, "", False),
    ],
)
async def test_bot_access_granted_follows_the_token_answer(
    telegram: FakeTelegram, requested: bool, answer_scope, granted: bool
) -> None:
    telegram.token_scope = answer_scope
    user = await telegram_oidc.complete_login(
        code="tg-73441",
        redirect_uri="https://x.test/cb",
        code_verifier="v" * 43,
        bot_access_requested=requested,
    )
    assert user.telegram_id == 73441
    assert user.bot_access_granted is granted


@pytest.mark.parametrize("jwks", [{}, {"keys": []}, {"keys": "x"}, "x", None])
def test_verify_id_token_refuses_a_broken_key_set(telegram: FakeTelegram, jwks) -> None:
    with pytest.raises(telegram_oidc.TelegramLoginError):
        telegram_oidc.verify_id_token(telegram.id_token(73436), jwks)


async def test_telegram_unreachable_is_a_login_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    monkeypatch.setattr(
        telegram_oidc,
        "_client",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(boom)),
    )
    with pytest.raises(telegram_oidc.TelegramLoginError) as exc:
        await telegram_oidc.complete_login(
            code="c", redirect_uri="r", code_verifier="v", bot_access_requested=False
        )
    assert exc.value.reason == "unreachable"


# ---------------------------------------------------------------------------
# CIMD: Client ID Metadata Documents (owner ruling)
# ---------------------------------------------------------------------------

CIMD_PREFIX = "https://claude.ai/oauth/be141-test-"


class FakeCimd:
    """The documents claude.ai would serve, behind the real fetch code: only
    the transport is replaced (oauth._cimd_transport), so the client's own
    settings -- no redirects, the timeout -- are the real ones."""

    def __init__(self) -> None:
        self.answers: dict[str, object] = {}
        self.fetches: list[str] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.fetches.append(str(request.url))
        answer = self.answers.get(str(request.url))
        if answer is None:
            return httpx.Response(404)
        if isinstance(answer, Exception):
            raise answer
        return answer  # type: ignore[return-value]


def _cimd_doc(url: str, **over) -> dict:
    doc = {
        "client_id": url,
        "client_name": f"Claude {_NAME_MARK}",
        "client_uri": "https://claude.ai",
        "redirect_uris": [CB],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    } | over
    return {k: v for k, v in doc.items() if v is not _DROP}


@pytest.fixture
def cimd(monkeypatch: pytest.MonkeyPatch) -> FakeCimd:
    fake = FakeCimd()
    monkeypatch.setattr(mcp_oauth, "_cimd_transport", httpx.MockTransport(fake.handler))
    return fake


def _cimd_url() -> str:
    return CIMD_PREFIX + secrets.token_hex(4)


async def _cimd_row(url: str) -> McpOAuthClient | None:
    async with get_session_factory()() as s:
        return await s.get(McpOAuthClient, url)


async def test_the_metadata_offers_cimd_with_none(client: AsyncClient) -> None:
    """claude.ai takes CIMD only when both are advertised."""
    meta = (await client.get(AS_METADATA_PATH)).json()
    assert meta["client_id_metadata_document_supported"] is True
    assert meta["token_endpoint_auth_methods_supported"] == ["none"]
    assert meta["registration_endpoint"] == f"{ISSUER}/register"  # DCR fallback


async def test_a_cimd_client_connects_and_its_document_is_fetched_once(
    client: AsyncClient, telegram: FakeTelegram, cimd: FakeCimd
) -> None:
    user_id, headers = await _student(client, 73442)
    url = _cimd_url()
    cimd.answers[url] = httpx.Response(200, json=_cimd_doc(url))

    # claude.ai sends the scopes the resource metadata lists; the document
    # names none, so the server must give the client ours.
    page = await _to_consent(client, 73442, url, _pkce()[1], scope=" ".join(ALL))
    assert page.status_code == 200
    assert "(claude.ai)" in page.text  # the client_id URL's host

    cid, tokens = await _connect(client, 73442, cid=url)
    resp = await _refresh(client, cid, tokens["refresh_token"])
    assert resp.status_code == 200
    # authorize x2, token, refresh: one fetch, the rest from what was kept.
    assert cimd.fetches == [url]
    row = await _cimd_row(url)
    assert row is not None and row.fetched_at is not None
    grant = next(r for r in await _rows(user_id) if r.revoked_at is None)
    assert grant.oauth_client_id == url
    items = (await client.get(TOKENS_URL, headers=headers)).json()["items"]
    assert any(i["kind"] == "oauth" and i["revoked_at"] is None for i in items)


async def test_the_consent_names_the_host_whatever_the_document_says(
    client: AsyncClient, telegram: FakeTelegram, cimd: FakeCimd
) -> None:
    """The app is named by the host the document was fetched from, not by
    the document's own words; the answer's destination is named too. The
    redirect is on another host here, so the two cannot be confused."""
    await _student(client, 73443)
    url = _cimd_url()
    cb = "https://cb.example/oauth/callback"
    doc = _cimd_doc(url, client_name=f"<b>Bank</b> {_NAME_MARK}", redirect_uris=[cb])
    cimd.answers[url] = httpx.Response(200, json=doc)
    page = await _to_consent(client, 73443, url, _pkce()[1], redirect_uri=cb)
    assert page.status_code == 200
    assert "(claude.ai)" in page.text
    assert "Ответ уйдёт на: cb.example" in page.text
    assert "<b>Bank</b>" not in page.text  # escaped, never markup


@pytest.mark.parametrize(
    "url",
    [
        "https://evil.example/oauth/client",
        "https://claude.ai.evil.example/oauth/client",
        "https://claude.ai:8443/oauth/client",
        "https://claude.ai",
        "https://claude.ai/",
        "https://claude.ai/oauth/client?x=1",
        "https://claude.ai/oauth/client#frag",
        "https://user:pw@claude.ai/oauth/client",
        "https://claude.ai/" + "a" * 2050,
        "https://claude.ai:bad/oauth/client",
    ],
)
async def test_a_cimd_url_off_the_fence_is_never_fetched(
    client: AsyncClient, cimd: FakeCimd, url: str
) -> None:
    resp = await _authorize(client, url, _pkce()[1])
    assert resp.status_code == 400
    assert "location" not in resp.headers
    assert cimd.fetches == []


@pytest.mark.parametrize(
    "bend",
    [
        "404",
        "redirect",
        "html",
        "not_json",
        "array",
        "too_large",
        "client_id_mismatch",
        "secret",
        "secret_method",
        "no_method",
        "loopback",
        "http_redirect_uri",
        "no_redirect_uris",
        "scope",
        "bad_metadata",
    ],
)
async def test_a_bad_cimd_answer_is_refused_and_not_kept(
    client: AsyncClient, cimd: FakeCimd, monkeypatch: pytest.MonkeyPatch, bend: str
) -> None:
    url = _cimd_url()
    doc = _cimd_doc(url)
    answer: httpx.Response
    if bend == "404":
        answer = httpx.Response(404)
    elif bend == "redirect":
        # Never followed: the target is not even asked.
        other = _cimd_url()
        cimd.answers[other] = httpx.Response(200, json=_cimd_doc(other))
        answer = httpx.Response(302, headers={"location": other})
    elif bend == "html":
        answer = httpx.Response(
            200, text=json.dumps(doc), headers={"content-type": "text/html"}
        )
    elif bend == "not_json":
        answer = httpx.Response(
            200, text="{nope", headers={"content-type": "application/json"}
        )
    elif bend == "array":
        answer = httpx.Response(200, json=[doc])
    elif bend == "too_large":
        monkeypatch.setattr(settings, "mcp_oauth_cimd_max_bytes", 200)
        answer = httpx.Response(
            200, json=doc | {"client_uri": "https://claude.ai/" + "x" * 300}
        )
    elif bend == "client_id_mismatch":
        answer = httpx.Response(200, json=doc | {"client_id": _cimd_url()})
    elif bend == "secret":
        answer = httpx.Response(200, json=doc | {"client_secret": "s"})
    elif bend == "secret_method":
        answer = httpx.Response(
            200, json=doc | {"token_endpoint_auth_method": "client_secret_post"}
        )
    elif bend == "no_method":
        answer = httpx.Response(
            200, json=_cimd_doc(url, token_endpoint_auth_method=_DROP)
        )
    elif bend == "loopback":  # Claude Code's own document is like this
        answer = httpx.Response(
            200,
            json=doc
            | {
                "redirect_uris": [
                    "http://localhost/callback",
                    "http://127.0.0.1/callback",
                ]
            },
        )
    elif bend == "http_redirect_uri":
        answer = httpx.Response(
            200, json=doc | {"redirect_uris": [CB, "http://claude.ai/cb"]}
        )
    elif bend == "no_redirect_uris":
        answer = httpx.Response(200, json=doc | {"redirect_uris": []})
    elif bend == "scope":
        answer = httpx.Response(200, json=doc | {"scope": "read admin"})
    else:  # bad_metadata
        answer = httpx.Response(200, json=doc | {"redirect_uris": "not-a-list"})
    cimd.answers[url] = answer

    resp = await _authorize(client, url, _pkce()[1])
    assert resp.status_code == 400, resp.text
    assert "location" not in resp.headers
    assert cimd.fetches == [url]  # one request, nothing followed
    assert await _cimd_row(url) is None


async def _age(url: str) -> None:
    async with get_session_factory()() as s:
        await s.execute(
            update(McpOAuthClient)
            .where(McpOAuthClient.client_id == url)
            .values(fetched_at=text("now() - make_interval(secs => :age)")),
            {"age": settings.mcp_oauth_cimd_cache_seconds + 1},
        )
        await s.commit()


@pytest.mark.parametrize("outage", ["connect_error", "status_503"])
async def test_an_unreachable_document_keeps_the_copy_serving(
    client: AsyncClient, telegram: FakeTelegram, cimd: FakeCimd, outage: str
) -> None:
    """Past its time the copy is fetched again; if the document cannot be
    REACHED, the copy kept keeps serving -- refreshes do not die with a
    moment of claude.ai being away."""
    await _student(client, 73444)
    url = _cimd_url()
    cimd.answers[url] = httpx.Response(200, json=_cimd_doc(url))
    cid, tokens = await _connect(client, 73444, cid=url)
    await _age(url)
    cimd.answers[url] = (
        httpx.ConnectError("down") if outage == "connect_error" else httpx.Response(503)
    )
    resp = await _refresh(client, cid, tokens["refresh_token"])
    assert resp.status_code == 200, resp.text
    assert len(cimd.fetches) == 2  # it did try again


async def test_a_bad_document_on_refetch_is_refused_and_the_copy_is_not_used(
    client: AsyncClient, telegram: FakeTelegram, cimd: FakeCimd
) -> None:
    await _student(client, 73445)
    url = _cimd_url()
    cimd.answers[url] = httpx.Response(200, json=_cimd_doc(url))
    cid, tokens = await _connect(client, 73445, cid=url)
    await _age(url)
    cimd.answers[url] = httpx.Response(200, json=_cimd_doc(_cimd_url()))  # mismatch
    resp = await _refresh(client, cid, tokens["refresh_token"])
    assert resp.status_code == 401 and resp.json()["error"] == "invalid_client"
    # Pair: the document fixed, the same refresh token works again.
    cimd.answers[url] = httpx.Response(200, json=_cimd_doc(url))
    assert (await _refresh(client, cid, tokens["refresh_token"])).status_code == 200


async def test_a_fresh_document_changes_what_is_kept(
    client: AsyncClient, telegram: FakeTelegram, cimd: FakeCimd
) -> None:
    await _student(client, 73446)
    url = _cimd_url()
    cimd.answers[url] = httpx.Response(200, json=_cimd_doc(url))
    await _connect(client, 73446, cid=url)
    await _age(url)
    new_name = f"Claude renamed {_NAME_MARK}"
    cimd.answers[url] = httpx.Response(200, json=_cimd_doc(url, client_name=new_name))
    page = await _to_consent(client, 73446, url, _pkce()[1])
    assert page.status_code == 200 and new_name in page.text
    row = await _cimd_row(url)
    assert row.client_info["client_name"] == new_name


async def test_the_allowed_hosts_are_a_setting(
    client: AsyncClient, cimd: FakeCimd, monkeypatch: pytest.MonkeyPatch
) -> None:
    url = "https://claude.com/oauth/be141-test-" + secrets.token_hex(4)
    cimd.answers[url] = httpx.Response(200, json=_cimd_doc(url))
    assert (await _authorize(client, url, _pkce()[1])).status_code == 400
    assert cimd.fetches == []
    # Exact host, case and spaces ignored.
    monkeypatch.setattr(
        settings, "mcp_oauth_cimd_allowed_hosts", "claude.ai, Claude.COM "
    )
    resp = await _authorize(client, url, _pkce()[1])
    assert resp.status_code == 302 and resp.headers["location"].startswith(
        telegram_oidc.AUTHORIZE_URL
    )
    async with get_session_factory()() as s:
        await s.execute(
            text("DELETE FROM mcp_oauth_clients WHERE client_id = :u"), {"u": url}
        )
        await s.commit()


# ---------------------------------------------------------------------------
# BE-141 FIX: the `id` claim -- a number or a string of digits
# ---------------------------------------------------------------------------

_BIGINT_MAX = 2**63 - 1


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (73450, 73450),
        ("73450", 73450),  # the live token's shape
        ("0073450", 73450),  # leading zeros: owner ruling
        (str(_BIGINT_MAX), _BIGINT_MAX),
        ("0" * 30 + "5", 5),  # zeros past 19 digits are still zeros
    ],
)
def test_the_id_claim_forms_accepted(telegram: FakeTelegram, value, expected) -> None:
    telegram.claims = {"id": value}
    user = telegram_oidc.verify_id_token(telegram.id_token(1), telegram.jwks())
    assert user.telegram_id == expected and isinstance(user.telegram_id, int)


@pytest.mark.parametrize(
    "value",
    [
        "7345a0",
        "+73450",
        "-73450",
        " 73450",
        "73450 ",
        "73450\n",
        "",
        "1_000",  # int() would take it
        "\uff17\uff13\uff14",  # fullwidth digits: str.isdigit() would take them
        "\u0667\u0663\u0664",  # Arabic-Indic digits: likewise
        "0",
        "000",
        str(_BIGINT_MAX + 1),
        "9" * 5000,  # int() would raise past 4300 digits
        0,
        -1,
        _BIGINT_MAX + 1,
        True,
        False,
        73450.0,
        None,
        [73450],
        {"id": 73450},
    ],
)
def test_the_id_claim_forms_refused_with_a_diagnostic_line(
    telegram: FakeTelegram, capsys: pytest.CaptureFixture, value
) -> None:
    telegram.claims = {"id": value}
    with pytest.raises(telegram_oidc.TelegramLoginError) as exc:
        telegram_oidc.verify_id_token(telegram.id_token(1), telegram.jwks())
    assert exc.value.reason == "no_telegram_id"
    line = next(
        ln
        for ln in capsys.readouterr().out.splitlines()
        if "telegram_login_id_rejected" in ln
    )
    assert "has_id=True" in line
    assert f"id_type={type(value).__name__}" in line
    assert "'aud'" in line and "'id'" in line and "'iss'" in line  # the names
    # Never the value: a distinctive one must not appear.
    if isinstance(value, str) and len(value) > 3 and value.strip():
        assert value.strip() not in line


def test_a_missing_id_claim_names_what_was_there(
    telegram: FakeTelegram, capsys: pytest.CaptureFixture
) -> None:
    telegram.claims = {"id": _DROP, "given_name": "Секретное Имя"}
    with pytest.raises(telegram_oidc.TelegramLoginError):
        telegram_oidc.verify_id_token(telegram.id_token(1), telegram.jwks())
    line = next(
        ln
        for ln in capsys.readouterr().out.splitlines()
        if "telegram_login_id_rejected" in ln
    )
    assert "has_id=False" in line and "id_type=NoneType" in line
    assert "'given_name'" in line and "'sub'" in line and "'id'" not in line
    assert "Секретное Имя" not in line  # names of claims, never values


async def test_a_login_whose_id_is_a_string_reaches_the_consent_page(
    client: AsyncClient, telegram: FakeTelegram
) -> None:
    """The live failure, end to end: the same flow that refused with
    no_telegram_id now reaches the consent page."""
    await _student(client, 73447)
    telegram.claims = {"id": "73447"}
    cid = await _client_id(client)
    page = await _to_consent(client, 73447, cid, _pkce()[1])
    assert page.status_code == 200 and "name='consent'" in page.text


# ---------------------------------------------------------------------------
# BE-148: the consent page promises what the tools do, in the product's type
# ---------------------------------------------------------------------------


async def test_the_consent_page_describes_scopes_from_the_one_table(
    client: AsyncClient, telegram: FakeTelegram
) -> None:
    from app.modules.mcp.models import McpScope, scope_label

    await _student(client, 73448)
    cid = await _client_id(client)
    page = await _to_consent(client, 73448, cid, _pkce()[1])
    assert page.status_code == 200
    for scope in McpScope:
        assert html.escape(scope_label(scope)) in page.text, scope
    assert "чек" not in page.text.lower()


def _phrases() -> dict[str, str]:
    return {
        name: value
        for name, value in vars(mcp_oauth).items()
        if name.startswith("PHRASE_") and isinstance(value, str)
    }


def test_every_consent_phrase_is_in_the_products_type() -> None:
    """Dashes and arrows as the product writes them: "—" and "→", never the
    "--" / "->" of code and chat (owner ruling, BE-148)."""
    phrases = _phrases()
    assert len(phrases) >= 9  # the page's whole vocabulary, not a sample
    for name, phrase in phrases.items():
        assert "--" not in phrase and "->" not in phrase, name
    assert "—" in phrases["PHRASE_UNKNOWN_USER"]
    assert "→" in phrases["PHRASE_LIMIT"]


async def test_the_rendered_consent_page_has_no_ascii_dashes_or_arrows(
    client: AsyncClient, telegram: FakeTelegram
) -> None:
    await _student(client, 73449)
    cid = await _client_id(client)
    page = await _to_consent(client, 73449, cid, _pkce()[1])
    assert page.status_code == 200
    body = page.text
    assert "--" not in body and "-&gt;" not in body and "->" not in body
    assert "→" in body  # the revoke hint: VELO → Профиль → Подключения ИИ


# ---------------------------------------------------------------------------
# BE-170: ChatGPT connects through CIMD, as a public client
# ---------------------------------------------------------------------------
#
# ChatGPT's document (the form OpenAI publishes, MCP SEP-3149) prefers
# private_key_jwt and lists ["none", "private_key_jwt"]; it is accepted
# through the list and kept as "none" (oauth.py, _offers_none). The tests
# run on the setting's CODE default, not on whatever the environment sets:
# what is checked is the default this delivery ships, so the color is the
# code's, not the box's.

GPT_CB = "https://chatgpt.com/connector/oauth/be170-cb"
_GPT_DEFAULT = type(settings).model_fields["mcp_oauth_cimd_allowed_hosts"].default


@pytest.fixture
def gpt_hosts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "mcp_oauth_cimd_allowed_hosts", _GPT_DEFAULT)


def _gpt_url() -> str:
    return f"https://chatgpt.com/oauth/be170-test-{secrets.token_hex(4)}/client.json"


def _gpt_doc(url: str, **over) -> dict:
    """The shape of ChatGPT's published document (BE-170 handoff, §2)."""
    doc = {
        "client_id": url,
        "client_uri": "https://chatgpt.com/",
        "redirect_uris": [GPT_CB],
        "token_endpoint_auth_method": "private_key_jwt",
        "token_endpoint_auth_methods_supported": ["none", "private_key_jwt"],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "client_name": f"ChatGPT {_NAME_MARK}",
        "logo_uri": "https://persistent.oaistatic.com/sonic/misc/openai-logo.png",
        "token_endpoint_auth_signing_alg": "RS256",
        "jwks_uri": "https://chatgpt.com/oauth/jwks.json",
    } | over
    return {k: v for k, v in doc.items() if v is not _DROP}


async def _gpt_code(
    client: AsyncClient, tid: int, url: str, challenge: str
) -> tuple[httpx.Response, str]:
    """/authorize -> Telegram -> consent page -> "Разрешить": (page, code)."""
    page = await _to_consent(
        client, tid, url, challenge, redirect_uri=GPT_CB, scope=" ".join(ALL)
    )
    assert page.status_code == 200, page.text
    resp = await _decide(client, _consent_id(page), "allow", ALL)
    assert resp.status_code == 302, resp.text
    assert resp.headers["location"].startswith(GPT_CB)
    return page, _query(resp.headers["location"])["code"]


def _refusals(out: str) -> list[str]:
    return [ln for ln in out.splitlines() if "mcp_oauth_cimd_refused" in ln]


def test_the_default_hosts_are_claude_and_chatgpt(gpt_hosts: None) -> None:
    """Both, and nothing else: chatgpt.com added, claude.ai still there."""
    assert mcp_oauth._cimd_allowed_hosts() == {"claude.ai", "chatgpt.com"}


async def test_chatgpt_connects_through_cimd_as_a_public_client(
    client: AsyncClient, telegram: FakeTelegram, cimd: FakeCimd, gpt_hosts: None
) -> None:
    """The whole path of ChatGPT's form: /authorize -> consent naming
    chatgpt.com -> code exchanged on /token with "none" and PKCE -> tokens
    -> refresh. The kept client says "none", whatever the document prefers."""
    user_id, _ = await _student(client, 73451)
    url = _gpt_url()
    cimd.answers[url] = httpx.Response(200, json=_gpt_doc(url))

    verifier, challenge = _pkce()
    page, code = await _gpt_code(client, 73451, url, challenge)
    assert "(chatgpt.com)" in page.text  # the client_id URL's host
    assert f"ChatGPT {_NAME_MARK}" in page.text
    assert "Ответ уйдёт на: chatgpt.com" in page.text

    resp = await _exchange(client, url, code, verifier, redirect_uri=GPT_CB)
    assert resp.status_code == 200, resp.text
    tokens = resp.json()
    assert tokens["access_token"] and tokens["refresh_token"]

    row = await _cimd_row(url)
    assert row is not None and row.fetched_at is not None
    assert row.client_info["token_endpoint_auth_method"] == "none"
    assert "client_secret" not in row.client_info
    grant = next(r for r in await _rows(user_id) if r.revoked_at is None)
    assert grant.oauth_client_id == url

    resp = await _refresh(client, url, tokens["refresh_token"])
    assert resp.status_code == 200, resp.text
    assert cimd.fetches == [url]  # authorize, token, refresh: one fetch


@pytest.mark.parametrize(
    "over",
    [
        pytest.param({}, id="chatgpt_form"),
        pytest.param(
            {"token_endpoint_auth_methods_supported": ["private_key_jwt", "none"]},
            id="none_second",
        ),
        pytest.param(
            {"token_endpoint_auth_methods_supported": ["none", "none"]}, id="repeat"
        ),
        pytest.param(
            {"token_endpoint_auth_methods_supported": [5, None, {"x": 1}, "none"]},
            id="junk_beside_none",
        ),
        pytest.param({"token_endpoint_auth_method": _DROP}, id="no_own_method"),
        pytest.param({"token_endpoint_auth_method": None}, id="own_method_null"),
        pytest.param({"token_endpoint_auth_method": ""}, id="own_method_empty"),
        pytest.param(
            {"token_endpoint_auth_method": "client_secret_post"},
            id="own_method_secret_post",
        ),
        # The one cell looser than SEP-3149 (oauth.py, section header):
        # an own "none" passes whatever the list says.
        pytest.param(
            {
                "token_endpoint_auth_method": "none",
                "token_endpoint_auth_methods_supported": ["private_key_jwt"],
            },
            id="own_none_list_without_none",
        ),
    ],
)
async def test_a_document_offering_none_is_kept_as_none(
    client: AsyncClient, cimd: FakeCimd, gpt_hosts: None, over: dict
) -> None:
    url = _gpt_url()
    cimd.answers[url] = httpx.Response(200, json=_gpt_doc(url, **over))
    resp = await _authorize(client, url, _pkce()[1], redirect_uri=GPT_CB)
    assert resp.status_code == 302, resp.text
    assert resp.headers["location"].startswith(telegram_oidc.AUTHORIZE_URL)
    row = await _cimd_row(url)
    assert row is not None
    assert row.client_info["token_endpoint_auth_method"] == "none"


@pytest.mark.parametrize(
    "over",
    [
        pytest.param({"token_endpoint_auth_methods_supported": _DROP}, id="no_list"),
        pytest.param({"token_endpoint_auth_methods_supported": None}, id="null"),
        pytest.param({"token_endpoint_auth_methods_supported": []}, id="empty"),
        pytest.param({"token_endpoint_auth_methods_supported": "none"}, id="string"),
        pytest.param(
            {"token_endpoint_auth_methods_supported": "xnonex"}, id="substring"
        ),
        pytest.param({"token_endpoint_auth_methods_supported": ["NONE"]}, id="case"),
        pytest.param({"token_endpoint_auth_methods_supported": [" none"]}, id="space"),
        pytest.param(
            {"token_endpoint_auth_methods_supported": {"none": True}}, id="object"
        ),
        pytest.param(
            {"token_endpoint_auth_methods_supported": [["none"]]}, id="nested"
        ),
        pytest.param(
            {"token_endpoint_auth_methods_supported": ["private_key_jwt"]},
            id="without_none",
        ),
        pytest.param({"client_secret": "s"}, id="secret_with_none_listed"),
        pytest.param({"client_secret": None}, id="secret_key_null"),
        pytest.param(
            {"client_secret": "s", "token_endpoint_auth_method": "none"},
            id="secret_with_own_none",
        ),
    ],
)
async def test_a_document_not_offering_none_is_refused_and_not_kept(
    client: AsyncClient,
    cimd: FakeCimd,
    gpt_hosts: None,
    capsys: pytest.CaptureFixture,
    over: dict,
) -> None:
    url = _gpt_url()
    cimd.answers[url] = httpx.Response(200, json=_gpt_doc(url, **over))
    resp = await _authorize(client, url, _pkce()[1], redirect_uri=GPT_CB)
    assert resp.status_code == 400, resp.text
    assert "location" not in resp.headers
    assert cimd.fetches == [url]  # fetched, then refused for what it says
    assert await _cimd_row(url) is None
    lines = _refusals(capsys.readouterr().out)
    assert lines and all(
        "host=chatgpt.com" in ln and "reason=not_public" in ln for ln in lines
    )


@pytest.mark.parametrize(
    "url",
    [
        "https://chatgpt.com.evil.example/oauth/x/client.json",
        "https://www.chatgpt.com/oauth/x/client.json",  # exact host only
        "https://chatgpt.com:8443/oauth/x/client.json",
        "http://chatgpt.com/oauth/x/client.json",
    ],
)
async def test_a_chatgpt_lookalike_url_is_never_fetched(
    client: AsyncClient, cimd: FakeCimd, gpt_hosts: None, url: str
) -> None:
    resp = await _authorize(client, url, _pkce()[1], redirect_uri=GPT_CB)
    assert resp.status_code == 400
    assert "location" not in resp.headers
    assert cimd.fetches == []


async def test_chatgpt_losing_none_on_refetch_is_refused_until_it_returns(
    client: AsyncClient,
    telegram: FakeTelegram,
    cimd: FakeCimd,
    gpt_hosts: None,
    capsys: pytest.CaptureFixture,
) -> None:
    """The KNOWN CEILING's trigger, built: the kept copy past its time, the
    document no longer listing "none" -> refused, logged with host and
    reason; the kept row is not used. Pair: "none" back, the same refresh
    token works again."""
    await _student(client, 73452)
    url = _gpt_url()
    cimd.answers[url] = httpx.Response(200, json=_gpt_doc(url))
    verifier, challenge = _pkce()
    _, code = await _gpt_code(client, 73452, url, challenge)
    resp = await _exchange(client, url, code, verifier, redirect_uri=GPT_CB)
    assert resp.status_code == 200, resp.text
    refresh = resp.json()["refresh_token"]

    await _age(url)
    capsys.readouterr()
    cimd.answers[url] = httpx.Response(
        200,
        json=_gpt_doc(url, token_endpoint_auth_methods_supported=["private_key_jwt"]),
    )
    resp = await _refresh(client, url, refresh)
    assert resp.status_code == 401 and resp.json()["error"] == "invalid_client"
    lines = _refusals(capsys.readouterr().out)
    assert any("host=chatgpt.com" in ln and "reason=not_public" in ln for ln in lines)
    assert await _cimd_row(url) is not None  # kept, not used, not deleted

    cimd.answers[url] = httpx.Response(200, json=_gpt_doc(url))
    resp = await _refresh(client, url, refresh)
    assert resp.status_code == 200, resp.text


async def test_chatgpt_token_request_with_a_client_assertion(
    client: AsyncClient, telegram: FakeTelegram, cimd: FakeCimd, gpt_hosts: None
) -> None:
    """What the SDK does with private_key_jwt's fields once the client is
    kept as "none": with client_id they are ignored (PKCE carries the
    exchange); without client_id the request is refused 401 invalid_client
    before the code is even looked at -- the other half of the KNOWN
    CEILING's trigger. Pair: the same code, then sent with client_id, is
    still good."""
    await _student(client, 73453)
    url = _gpt_url()
    cimd.answers[url] = httpx.Response(200, json=_gpt_doc(url))
    assertion = {
        "client_assertion_type": (
            "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
        ),
        "client_assertion": "eyJhbGciOiJSUzI1NiJ9.e30.not-a-signature",
    }

    verifier, challenge = _pkce()
    _, code = await _gpt_code(client, 73453, url, challenge)
    resp = await _token(
        client,
        grant_type="authorization_code",
        code=code,
        code_verifier=verifier,
        redirect_uri=GPT_CB,
        **assertion,
    )
    assert resp.status_code == 401, resp.text
    assert resp.json() == {
        "error": "invalid_client",
        "error_description": "Missing client_id",
    }
    resp = await _token(
        client,
        grant_type="authorization_code",
        client_id=url,
        code=code,
        code_verifier=verifier,
        redirect_uri=GPT_CB,
        **assertion,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["access_token"]
