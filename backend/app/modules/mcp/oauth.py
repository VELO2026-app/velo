# =============================================================================
# VELO Backend -- OAuth for /mcp: claude.ai connects with a button (BE-141)
# =============================================================================
#
# claude.ai's connectors speak OAuth 2.1 only (a fixed header is a beta for
# a few organizations). This module makes the API its own authorization
# server for /mcp, and the student proves who they are with Telegram.
#
# THE FLOW, as claude.ai walks it:
#   1. POST /mcp without a token -> 401 whose WWW-Authenticate names
#      PRM_PATH (server.py, _unauthorized).
#   2. GET PRM_PATH (RFC 9728)            -> resource = <issuer>/mcp, the
#      authorization server = <issuer>.
#   3. GET AS_METADATA_PATH (RFC 8414)    -> endpoints, S256, public clients.
#   4. The client makes itself known -- preferably by CIMD: its client_id is
#      an https URL on an allowed host, and the server fetches the metadata
#      there (section "Client ID Metadata Documents" below); otherwise by
#      POST /register (RFC 7591), the fallback: a public client (no secret),
#      https redirect URIs only, rate-limited per source address.
#   5. GET /authorize                     -> the SDK checks client, redirect
#      URI and scope; VeloOAuthProvider.authorize keeps the request in Redis
#      and sends the browser to Telegram's login (oauth.telegram.org).
#   6. GET CALLBACK_PATH                  -> the Telegram code is exchanged,
#      the student found by telegram_id, and the consent page rendered.
#   7. POST CONSENT_PATH                  -> "Отказать": access_denied to the
#      client; "Разрешить": a one-time code, back to the client.
#   8. POST /token, authorization_code    -> the SDK checks client, redirect
#      URI and the PKCE verifier; the grant is created (service.py,
#      issue_oauth_grant): an mcp_tokens row the student sees in "AI
#      connections".
#   9. POST /token, refresh_token         -> both tokens rotated.
#
# WHAT THE SDK DOES AND WHAT WE DO. The handlers are the MCP SDK's
# (mcp==2.2.0, mcp/server/auth/), read in their bodies at the BE-141 gate:
# request parsing, client lookup, redirect-URI match, scope check, PKCE
# S256 comparison, the code's expiry and client binding, error shapes. The
# provider below holds storage and the decisions the SDK leaves open:
#   - public clients only: the SDK would mint a client secret and compare
#     it in plain text, which would mean storing it in plain text -- so a
#     client asking for a secret is refused, and the metadata advertises
#     "none" only (the SDK's default advertises the secret methods) and
#     client_id_metadata_document_supported -- claude.ai takes CIMD only
#     when both are there;
#   - CIMD: the SDK has no server side for it; get_client fetches and
#     caches the document;
#   - redirect URIs: https only (no loopback -- owner ruling);
#   - authorize: an explicit redirect_uri, a well-formed S256 challenge (the
#     SDK lets an empty one through), and `resource`, when sent, equal to
#     this /mcp (RFC 8707);
#   - the code is spent with GETDEL, so it is one-time across workers.
#   /revoke (RFC 7009) is off (owner ruling): a connection is revoked in the
#   app's "AI connections".
#
# WHERE STATE LIVES. Clients (CIMD documents kept, DCR registrations) and
# grants: Postgres (models.py). Requests in
# progress and codes: Redis, keyed by the sha256 of their secret, with a
# TTL. Redis is disposable; losing it loses only logins in progress.
#
# THE DOOR. Every path here sits behind OAuthDoor: MCP switched off or the
# public short-link host -> the app's plain 404 (the same door_closed as
# /mcp); OAuth not configured -> the same 404. "Configured" means the three
# optional keys are all set (config.py, MCP_OAUTH_ISSUER_URL and the two
# TELEGRAM_LOGIN_* keys).
#
# SECRETS never leave as text: codes, access and refresh tokens, Telegram's
# code and id_token, the request and consent ids are not logged, not
# audited, not put into error descriptions. They do travel in URLs where
# OAuth puts them -- the code to the client's redirect URI, Telegram's code
# and our state to CALLBACK_PATH; nginx's access log therefore records the
# latter two. Telegram's code is single-use and worthless without our
# client secret and PKCE verifier; the state alone opens nothing (the
# consent id that does is only in the page body).
#
# THE CONSENT PAGE is the API's own HTML (like the guest page of GT-21),
# and it refuses to be framed: X-Frame-Options and an ENFORCED
# frame-ancestors -- the API host's CSP is Report-Only and would not stop a
# clickjacked "Разрешить".
# =============================================================================

import functools
import hashlib
import html
import json
import re
import secrets
import time
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID

import httpx
import structlog
from mcp.server.auth.handlers.metadata import MetadataHandler
from mcp.server.auth.provider import (
    AuthorizationCode,
    AuthorizationParams,
    AuthorizeError,
    RefreshToken,
    RegistrationError,
    TokenError,
    construct_redirect_uri,
)
from mcp.server.auth.routes import (
    build_metadata,
    cors_middleware,
    create_auth_routes,
    create_protected_resource_routes,
)
from mcp.server.auth.settings import ClientRegistrationOptions, RevocationOptions
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken
from pydantic import AnyHttpUrl, ValidationError
from redis.exceptions import RedisError
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from starlette.routing import Route, Router

from app.core.config import settings
from app.core.database import get_session_factory
from app.core.ratelimit import over_source_limit
from app.core.redis import get_redis
from app.modules.auth import telegram_oidc
from app.modules.mcp.models import McpOAuthClient, McpScope, scope_label
from app.modules.mcp.server import MCP_PATH, door_closed, send_not_found
from app.modules.mcp.service import (
    OAuthGrantRefusedError,
    OAuthTokens,
    issue_oauth_grant,
    live_tokens_besides,
    load_oauth_refresh,
    oauth_grant_name,
    rotate_oauth_refresh,
)
from app.modules.users.models import User

logger = structlog.get_logger()

AS_METADATA_PATH = "/.well-known/oauth-authorization-server"
PRM_PATH = "/.well-known/oauth-protected-resource" + MCP_PATH
AUTHORIZE_PATH = "/authorize"
TOKEN_PATH = "/token"
REGISTER_PATH = "/register"
CALLBACK_PATH = "/oauth/telegram/callback"
CONSENT_PATH = "/oauth/consent"
# Every path the door serves; main.py routes exactly these to it.
OAUTH_PATHS = (
    PRM_PATH,
    AS_METADATA_PATH,
    AUTHORIZE_PATH,
    TOKEN_PATH,
    REGISTER_PATH,
    CALLBACK_PATH,
    CONSENT_PATH,
)

SCOPES = [s.value for s in McpScope]
# S256 output: 32 bytes, base64url without padding -- exactly 43 characters.
_S256_CHALLENGE_RE = re.compile(r"[A-Za-z0-9_-]{43}")



# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


def oauth_configured() -> bool:
    return bool(settings.mcp_oauth_issuer_url) and telegram_oidc.configured()


def issuer_url() -> str:
    return settings.mcp_oauth_issuer_url.rstrip("/")


def resource_url() -> str:
    return issuer_url() + MCP_PATH


def resource_metadata_url() -> str:
    return issuer_url() + PRM_PATH


def callback_url() -> str:
    return issuer_url() + CALLBACK_PATH


# ---------------------------------------------------------------------------
# Redis: requests in progress, consents, codes
# ---------------------------------------------------------------------------


def _key(kind: str, secret: str) -> str:
    return f"mcp:oauth:{kind}:{hashlib.sha256(secret.encode()).hexdigest()}"


async def _put(kind: str, secret: str, data: dict, ttl: int) -> None:
    await get_redis().set(_key(kind, secret), json.dumps(data), ex=ttl)


async def _take(kind: str, secret: str) -> dict | None:
    """GETDEL: the value, once. A second taker -- another worker, a double
    submit -- gets None."""
    raw = await get_redis().getdel(_key(kind, secret))
    return json.loads(raw) if raw is not None else None


def _redirect_host(redirect_uri: str) -> str:
    return urlsplit(redirect_uri).hostname or redirect_uri


def _https_redirect(uri: object) -> bool:
    parts = urlsplit(str(uri))
    return (
        parts.scheme == "https"
        and bool(parts.hostname)
        and not parts.fragment
        and parts.username is None
        and parts.password is None
    )


# ---------------------------------------------------------------------------
# Client ID Metadata Documents (CIMD, owner ruling)
# ---------------------------------------------------------------------------
#
# A client_id that is an https URL names its own metadata: the server
# fetches that URL (draft-ietf-oauth-client-id-metadata-document; Anthropic's
# connector docs). It is a request to a URL a client chose, so it is fenced:
#   - the URL: https, port 443, a path, no query, no fragment, no userinfo,
#     at most 2048 characters, and its host on mcp_oauth_cimd_allowed_hosts
#     (claude.ai by default) -- anything else is refused unfetched;
#   - the request: no redirects followed, mcp_oauth_cimd_timeout_seconds,
#     at most mcp_oauth_cimd_max_bytes read, status 200 and an
#     application/json body, or refused;
#   - the document: a JSON object whose own client_id equals the URL, a
#     public client ("none", no secret), https redirect URIs only (no
#     loopback -- owner ruling; Claude Code's document is loopback-only and
#     is refused by this rule), scope within ours (absent -> all three), and
#     valid as the SDK's OAuthClientInformationFull.
# The document is kept in mcp_oauth_clients (fetched_at) for
# mcp_oauth_cimd_cache_seconds and fetched again after that. If that later
# fetch cannot REACH the document (network, timeout, a non-200 status), the
# copy already kept keeps serving -- a moment of claude.ai being unreachable
# must not end every student's refresh. If the document it reaches is BAD
# (not JSON, too large, wrong form), it is refused and the kept copy is not
# used either: the client's own word has changed.
# The fetch happens outside any database session (par0 §8).

_CIMD_MAX_URL = 2048
_CIMD_UNREACHABLE = frozenset({"unreachable", "status"})


class _CimdRefusedError(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _cimd_allowed_hosts() -> set[str]:
    return {
        h.strip().lower()
        for h in settings.mcp_oauth_cimd_allowed_hosts.split(",")
        if h.strip()
    }


def _cimd_url_refusal(url: str) -> str | None:
    if len(url) > _CIMD_MAX_URL:
        return "url_too_long"
    parts = urlsplit(url)
    try:
        port = parts.port
    except ValueError:
        return "bad_port"
    if parts.scheme != "https" or not parts.hostname:
        return "not_https"
    if parts.username is not None or parts.password is not None:
        return "userinfo"
    if port not in (None, 443):
        return "bad_port"
    if parts.path in ("", "/") or parts.query or parts.fragment:
        return "bad_path"
    if parts.hostname.lower() not in _cimd_allowed_hosts():
        return "host_not_allowed"
    return None


# Tests hand in a mock transport here; the client's own settings (no
# redirects, the timeout) stay the real ones under test.
_cimd_transport: httpx.AsyncBaseTransport | None = None


def _cimd_http() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=settings.mcp_oauth_cimd_timeout_seconds,
        follow_redirects=False,
        transport=_cimd_transport,
    )


async def _fetch_cimd(url: str) -> dict:
    body = bytearray()
    try:
        async with (
            _cimd_http() as http,
            http.stream("GET", url, headers={"Accept": "application/json"}) as resp,
        ):
            if resp.status_code != 200:
                raise _CimdRefusedError("status")
            ctype = resp.headers.get("content-type", "").split(";")[0].strip()
            if ctype.lower() != "application/json":
                raise _CimdRefusedError("not_json")
            async for chunk in resp.aiter_bytes():
                body += chunk
                if len(body) > settings.mcp_oauth_cimd_max_bytes:
                    raise _CimdRefusedError("too_large")
    except httpx.HTTPError:
        raise _CimdRefusedError("unreachable") from None
    try:
        doc = json.loads(bytes(body))
    except ValueError:
        raise _CimdRefusedError("not_json") from None
    if not isinstance(doc, dict):
        raise _CimdRefusedError("not_object")
    return doc


def _cimd_info(url: str, doc: dict) -> OAuthClientInformationFull:
    if doc.get("client_id") != url:
        raise _CimdRefusedError("client_id_mismatch")
    if "client_secret" in doc or doc.get("token_endpoint_auth_method") != "none":
        raise _CimdRefusedError("not_public")
    scope = doc.get("scope")
    if scope is not None and (
        not isinstance(scope, str) or not set(scope.split()) <= set(SCOPES)
    ):
        raise _CimdRefusedError("scope")
    try:
        info = OAuthClientInformationFull.model_validate(
            doc | {"scope": scope or " ".join(SCOPES)}
        )
    except ValidationError:
        raise _CimdRefusedError("bad_metadata") from None
    if not info.redirect_uris or not all(
        _https_redirect(u) for u in info.redirect_uris
    ):
        raise _CimdRefusedError("redirect_uris")
    return info


def _cimd_fresh(row: McpOAuthClient | None) -> bool:
    if row is None or row.fetched_at is None:
        return False
    age = datetime.now(UTC) - row.fetched_at
    return age.total_seconds() < settings.mcp_oauth_cimd_cache_seconds


async def cimd_client(url: str) -> OAuthClientInformationFull | None:
    """The client a CIMD URL names, or None (refused; logged with the host
    and a reason word -- the URL is not a secret, but the host is enough)."""
    host = urlsplit(url).hostname or "?"
    reason = _cimd_url_refusal(url)
    if reason is not None:
        logger.info("mcp_oauth_cimd_refused", host=host, reason=reason)
        return None
    async with get_session_factory()() as session:
        row = await session.get(McpOAuthClient, url)
    if _cimd_fresh(row):
        return OAuthClientInformationFull.model_validate(row.client_info)
    try:
        info = _cimd_info(url, await _fetch_cimd(url))
    except _CimdRefusedError as exc:
        logger.info("mcp_oauth_cimd_refused", host=host, reason=exc.reason)
        if exc.reason in _CIMD_UNREACHABLE and row is not None:
            return OAuthClientInformationFull.model_validate(row.client_info)
        return None
    async with get_session_factory()() as session:
        await session.execute(
            pg_insert(McpOAuthClient)
            .values(
                client_id=url,
                client_info=info.model_dump(mode="json", exclude_none=True),
                fetched_at=func.now(),
            )
            .on_conflict_do_update(
                index_elements=[McpOAuthClient.client_id],
                set_={
                    "client_info": info.model_dump(mode="json", exclude_none=True),
                    "fetched_at": func.now(),
                },
            )
        )
        await session.commit()
    logger.info("mcp_oauth_cimd_fetched", host=host)
    return info


def _app_host(client_id: str, redirect_host: str) -> str:
    """Who is asking, as the consent page names it: for a CIMD client the
    host of its client_id URL -- the document is the client's own word, the
    host is what the server fetched it from; for a DCR client the redirect
    host."""
    if client_id.startswith("https://"):
        return urlsplit(client_id).hostname or redirect_host
    return redirect_host


# ---------------------------------------------------------------------------
# The provider the SDK's handlers call
# ---------------------------------------------------------------------------


class VeloAuthorizationCode(AuthorizationCode):
    """The SDK's code plus the redirect host the grant's name may need
    (service.py, oauth_grant_name). Who consented is the SDK's `subject`."""

    redirect_host: str


class VeloOAuthProvider:
    """OAuthAuthorizationServerProvider for the SDK's handlers. See the
    module header for what is decided here."""

    # -- clients ------------------------------------------------------------

    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        """By client_id: an https URL -> CIMD (fetched, cached); anything
        else -> a DCR registration. None -> the SDK answers "unknown client"
        (400 at /authorize, 401 invalid_client at /token)."""
        if not client_id:
            return None
        if client_id.startswith("https://"):
            return await cimd_client(client_id)
        if len(client_id) > 64:
            return None
        async with get_session_factory()() as session:
            row = await session.get(McpOAuthClient, client_id)
        if row is None:
            return None
        return OAuthClientInformationFull.model_validate(row.client_info)

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        if client_info.token_endpoint_auth_method != "none":
            raise RegistrationError(
                "invalid_client_metadata",
                "Only public clients are accepted: "
                "token_endpoint_auth_method must be 'none'",
            )
        if not all(_https_redirect(u) for u in client_info.redirect_uris or []):
            raise RegistrationError(
                "invalid_redirect_uri", "redirect_uris must be https URLs"
            )
        async with get_session_factory()() as session:
            session.add(
                McpOAuthClient(
                    client_id=client_info.client_id,
                    client_info=client_info.model_dump(mode="json", exclude_none=True),
                )
            )
            await session.commit()
        logger.info("mcp_oauth_client_registered", client_id=client_info.client_id)

    # -- authorize ----------------------------------------------------------

    async def authorize(
        self, client: OAuthClientInformationFull, params: AuthorizationParams
    ) -> str:
        if not params.redirect_uri_provided_explicitly:
            raise AuthorizeError("invalid_request", "redirect_uri is required")
        if not _S256_CHALLENGE_RE.fullmatch(params.code_challenge):
            raise AuthorizeError(
                "invalid_request", "code_challenge must be an S256 challenge"
            )
        if params.resource is not None and params.resource != resource_url():
            raise AuthorizeError("invalid_target", "unknown resource")

        requested = set(params.scopes) if params.scopes is not None else set(SCOPES)
        request_id = secrets.token_urlsafe(32)
        # The bot's right to write is not MCP's business: not asked for.
        login = telegram_oidc.start_login(
            redirect_uri=callback_url(), state=request_id, bot_access=False
        )
        await _put(
            "req",
            request_id,
            {
                "client_id": client.client_id,
                "client_name": client.client_name,
                "redirect_uri": str(params.redirect_uri),
                "state": params.state,
                "code_challenge": params.code_challenge,
                "scopes": [s for s in SCOPES if s in requested],
                "resource": params.resource,
                "tg_verifier": login.code_verifier,
                "tg_bot_access": login.bot_access,
            },
            settings.mcp_oauth_request_ttl_seconds,
        )
        return login.url

    # -- the code -----------------------------------------------------------

    async def load_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: str
    ) -> VeloAuthorizationCode | None:
        raw = await get_redis().get(_key("code", authorization_code))
        if raw is None:
            return None
        data = json.loads(raw)
        return VeloAuthorizationCode(
            code=authorization_code,
            scopes=data["scopes"],
            expires_at=data["expires_at"],
            client_id=data["client_id"],
            code_challenge=data["code_challenge"],
            redirect_uri=data["redirect_uri"],
            redirect_uri_provided_explicitly=True,
            resource=data["resource"],
            subject=data["user_id"],
            redirect_host=_redirect_host(data["redirect_uri"]),
        )

    async def exchange_authorization_code(
        self,
        client: OAuthClientInformationFull,
        authorization_code: VeloAuthorizationCode,
    ) -> OAuthToken:
        # The SDK has checked client, redirect URI and PKCE against what
        # load_authorization_code read; this is the one-time spend.
        if await _take("code", authorization_code.code) is None:
            raise TokenError("invalid_grant", "authorization code does not exist")
        async with get_session_factory()() as session:
            try:
                tokens = await issue_oauth_grant(
                    session,
                    user_id=UUID(authorization_code.subject),
                    client_id=client.client_id,
                    client_name=client.client_name,
                    redirect_host=authorization_code.redirect_host,
                    scopes=authorization_code.scopes,
                )
            except OAuthGrantRefusedError as exc:
                # Leaving the block without a commit rolls back -- the
                # revocation of a same-name grant included.
                logger.info("mcp_oauth_exchange_refused", reason=exc.reason)
                raise TokenError(
                    "invalid_grant", "the authorization can no longer be granted"
                ) from None
            await session.commit()
        return _token_response(tokens)

    # -- refresh ------------------------------------------------------------

    async def load_refresh_token(
        self, client: OAuthClientInformationFull, refresh_token: str
    ) -> RefreshToken | None:
        async with get_session_factory()() as session:
            row = await load_oauth_refresh(session, refresh_token, client.client_id)
        if row is None:
            return None
        return RefreshToken(
            token=refresh_token, client_id=client.client_id, scopes=list(row.scopes)
        )

    async def exchange_refresh_token(
        self,
        client: OAuthClientInformationFull,
        refresh_token: RefreshToken,
        scopes: list[str],
    ) -> OAuthToken:
        # `scopes` may only narrow (the SDK refuses wider); a grant's scopes
        # never change, so the response states the grant's own -- RFC 6749
        # §5.1 allows an answer that differs from the request when it says
        # so in `scope`.
        async with get_session_factory()() as session:
            tokens = await rotate_oauth_refresh(
                session, refresh_token.token, client.client_id
            )
            if tokens is None:
                raise TokenError("invalid_grant", "refresh token is no longer valid")
            await session.commit()
        return _token_response(tokens)


def _token_response(tokens: OAuthTokens) -> OAuthToken:
    return OAuthToken(
        access_token=tokens.access_token,
        token_type="Bearer",
        expires_in=tokens.expires_in,
        refresh_token=tokens.refresh_token,
        scope=" ".join(tokens.scopes),
    )


# ---------------------------------------------------------------------------
# Pages: Telegram callback and consent
# ---------------------------------------------------------------------------

_PAGE_HEADERS = {
    "X-Frame-Options": "DENY",
    # Enforced, unlike the host's Report-Only policy. No form-action: some
    # browsers apply it to the redirect after the form, which goes to the
    # client's own host.
    "Content-Security-Policy": (
        "default-src 'none'; style-src 'unsafe-inline'; "
        "frame-ancestors 'none'; base-uri 'none'"
    ),
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
}

_STYLE = (
    "body{font-family:sans-serif;max-width:480px;margin:40px auto;"
    "padding:0 20px;line-height:1.45;color:#1d2b3a}"
    "label{display:block;margin:10px 0}"
    "button{font-size:16px;padding:10px 18px;margin:16px 8px 0 0}"
    ".hint{color:#5b6b7b;font-size:14px}"
)

PHRASE_EXPIRED = "Ссылка устарела. Начните подключение заново в своём ИИ-клиенте."
PHRASE_TELEGRAM_FAILED = (
    "Не удалось подтвердить вход через Telegram. Попробуйте подключиться заново."
)
PHRASE_UNKNOWN_USER = (
    "Сначала откройте VELO в Telegram — после этого подключение заработает."
)
PHRASE_INACTIVE = "Ваш аккаунт VELO отключён — подключение невозможно."
PHRASE_LIMIT = (
    "Слишком много подключений. Отзовите лишнее в VELO: "
    "Профиль → Подключения ИИ, и подключитесь заново."
)
PHRASE_NAME_TAKEN = (
    "Имя этого подключения занято вашим токеном в VELO. Отзовите токен в "
    "VELO: Профиль → Подключения ИИ, и подключитесь заново."
)
PHRASE_NO_SCOPE = "Выберите хотя бы одну область доступа."
PHRASE_BAD_REQUEST = "Некорректный запрос. Начните подключение заново."
PHRASE_UNAVAILABLE = "Сервис временно недоступен. Попробуйте через минуту."


def _page(body: str, status: int = 200) -> HTMLResponse:
    return HTMLResponse(
        "<!doctype html><html lang='ru'><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        f"<title>VELO</title><style>{_STYLE}</style></head><body>{body}"
        "</body></html>",
        status_code=status,
        headers=_PAGE_HEADERS,
    )


def _message_page(phrase: str, status: int) -> HTMLResponse:
    return _page(f"<h1>Подключение к VELO</h1><p>{html.escape(phrase)}</p>", status)


def _consent_page(
    consent_id: str, data: dict, error: str | None = None
) -> HTMLResponse:
    client = html.escape(data["client_name"] or data["app_host"])
    app_host = html.escape(data["app_host"])
    host = html.escape(data["redirect_host"])
    who = html.escape(data["first_name"] or "ученик VELO")
    boxes = "".join(
        f"<label><input type='checkbox' name='scope' value='{html.escape(s)}' "
        f"checked> {html.escape(scope_label(McpScope(s)))}</label>"
        for s in data["scopes"]
    )
    warn = f"<p><b>{html.escape(error)}</b></p>" if error else ""
    return _page(
        "<h1>Подключение к VELO</h1>"
        f"<p>Вы вошли как <b>{who}</b>.</p>"
        f"<p><b>{client}</b> ({app_host}) просит доступ к вашему VELO.</p>"
        f"<p class='hint'>Ответ уйдёт на: {host}</p>"
        f"{warn}"
        f"<form method='post' action='{CONSENT_PATH}'>"
        f"<input type='hidden' name='consent' value='{html.escape(consent_id)}'>"
        f"{boxes}"
        "<button type='submit' name='decision' value='allow'>Разрешить</button>"
        "<button type='submit' name='decision' value='deny'>Отказать</button>"
        "</form>"
        "<p class='hint'>Доступ можно отозвать в любой момент: "
        "VELO → Профиль → Подключения ИИ.</p>",
        400 if error else 200,
    )


def _back_to_client(data: dict, **params: str | None) -> RedirectResponse:
    return RedirectResponse(
        construct_redirect_uri(data["redirect_uri"], state=data["state"], **params),
        status_code=302,
        headers={"Cache-Control": "no-store"},
    )


async def telegram_callback(request: Request) -> Response:
    """Telegram sends the browser back here: state = our request id."""
    state = request.query_params.get("state")
    if not state:
        return _message_page(PHRASE_EXPIRED, 400)
    try:
        data = await _take("req", state)
    except RedisError:
        return _message_page(PHRASE_UNAVAILABLE, 503)
    if data is None:
        return _message_page(PHRASE_EXPIRED, 400)
    if request.query_params.get("error"):
        # The student cancelled on Telegram's side: the client hears no.
        return _back_to_client(data, error="access_denied")
    code = request.query_params.get("code")
    if not code:
        return _message_page(PHRASE_TELEGRAM_FAILED, 400)

    try:
        identity = await telegram_oidc.complete_login(
            code=code,
            redirect_uri=callback_url(),
            code_verifier=data["tg_verifier"],
            bot_access_requested=data["tg_bot_access"],
        )
    except telegram_oidc.TelegramLoginError as exc:
        logger.info("mcp_oauth_telegram_failed", reason=exc.reason)
        return _message_page(PHRASE_TELEGRAM_FAILED, 400)

    host = _redirect_host(data["redirect_uri"])
    async with get_session_factory()() as session:
        user = (
            await session.execute(
                select(User).where(User.telegram_id == identity.telegram_id)
            )
        ).scalar_one_or_none()
        if user is None:
            # Not created here: creating users is the Standalone's job.
            return _message_page(PHRASE_UNKNOWN_USER, 403)
        if not user.is_active:
            return _message_page(PHRASE_INACTIVE, 403)
        # Early warnings only; the exchange decides again (service.py).
        name = await oauth_grant_name(session, user.id, data["client_name"], host)
        if name is None:
            return _message_page(PHRASE_NAME_TAKEN, 409)
        if (
            await live_tokens_besides(session, user.id, name)
            >= settings.mcp_tokens_max_active_per_user
        ):
            return _message_page(PHRASE_LIMIT, 409)

    consent_id = secrets.token_urlsafe(32)
    consent = {
        key: data[key]
        for key in (
            "client_id",
            "client_name",
            "redirect_uri",
            "state",
            "code_challenge",
            "scopes",
            "resource",
        )
    } | {
        "user_id": str(user.id),
        "first_name": identity.first_name or user.first_name,
        "redirect_host": host,
        "app_host": _app_host(data["client_id"], host),
    }
    try:
        await _put(
            "consent", consent_id, consent, settings.mcp_oauth_request_ttl_seconds
        )
    except RedisError:
        return _message_page(PHRASE_UNAVAILABLE, 503)
    return _consent_page(consent_id, consent)


async def consent_decision(request: Request) -> Response:
    """The consent form: "Разрешить" -> a one-time code to the client,
    "Отказать" -> access_denied to the client."""
    form = await request.form()
    consent_id = form.get("consent")
    if not isinstance(consent_id, str) or not consent_id:
        return _message_page(PHRASE_BAD_REQUEST, 400)
    try:
        data = await _take("consent", consent_id)
    except RedisError:
        return _message_page(PHRASE_UNAVAILABLE, 503)
    if data is None:
        return _message_page(PHRASE_EXPIRED, 400)

    decision = form.get("decision")
    if decision == "deny":
        return _back_to_client(data, error="access_denied")
    if decision != "allow":
        return _message_page(PHRASE_BAD_REQUEST, 400)

    chosen = [v for v in form.getlist("scope") if isinstance(v, str)]
    if (
        not chosen
        or len(set(chosen)) != len(chosen)
        or not set(chosen) <= set(data["scopes"])
    ):
        # The page stays usable: the consent goes back for another try.
        try:
            await _put(
                "consent", consent_id, data, settings.mcp_oauth_request_ttl_seconds
            )
        except RedisError:
            return _message_page(PHRASE_UNAVAILABLE, 503)
        return _consent_page(consent_id, data, error=PHRASE_NO_SCOPE)

    code = secrets.token_urlsafe(32)
    try:
        await _put(
            "code",
            code,
            {
                "client_id": data["client_id"],
                "redirect_uri": data["redirect_uri"],
                "code_challenge": data["code_challenge"],
                "scopes": [s for s in SCOPES if s in chosen],
                "resource": data["resource"],
                "user_id": data["user_id"],
                "expires_at": time.time() + settings.mcp_oauth_code_ttl_seconds,
            },
            settings.mcp_oauth_code_ttl_seconds,
        )
    except RedisError:
        return _message_page(PHRASE_UNAVAILABLE, 503)
    logger.info(
        "mcp_oauth_consented", user_id=data["user_id"], client_id=data["client_id"]
    )
    return _back_to_client(data, code=code)


# ---------------------------------------------------------------------------
# The door
# ---------------------------------------------------------------------------


@functools.lru_cache(maxsize=4)
def _router(issuer: str) -> Router:
    """The routes for one issuer. Cached: built once per process (tests that
    change the issuer get their own)."""
    provider = VeloOAuthProvider()
    issuer_any = AnyHttpUrl(issuer)
    registration = ClientRegistrationOptions(
        enabled=True, valid_scopes=SCOPES, default_scopes=SCOPES
    )
    revocation = RevocationOptions(enabled=False)

    metadata = build_metadata(issuer_any, None, registration, revocation)
    metadata.token_endpoint_auth_methods_supported = ["none"]
    # claude.ai uses CIMD only when BOTH this and "none" above are there,
    # otherwise it falls back to /register (Anthropic's connector docs).
    metadata.client_id_metadata_document_supported = True
    routes: list[Any] = [
        Route(
            AS_METADATA_PATH,
            endpoint=cors_middleware(
                MetadataHandler(metadata).handle, ["GET", "OPTIONS"]
            ),
            methods=["GET", "OPTIONS"],
        )
    ]
    routes += [
        r
        for r in create_auth_routes(
            provider,
            issuer_any,
            client_registration_options=registration,
            revocation_options=revocation,
        )
        if r.path != AS_METADATA_PATH
    ]
    routes += create_protected_resource_routes(
        AnyHttpUrl(issuer + MCP_PATH),
        [issuer_any],
        scopes_supported=SCOPES,
        resource_name="VELO",
    )
    routes += [
        Route(CALLBACK_PATH, telegram_callback, methods=["GET"]),
        Route(CONSENT_PATH, consent_decision, methods=["POST"]),
    ]
    return Router(routes=routes)


class OAuthDoor:
    """ASGI endpoint main.py routes every OAUTH_PATHS entry to."""

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http" or door_closed(scope) or not oauth_configured():
            await send_not_found(send)
            return
        if scope["path"] == REGISTER_PATH and scope["method"] == "POST":
            refusal = await _registration_limit()
            if refusal is not None:
                await refusal(scope, receive, send)
                return
        await _router(issuer_url())(scope, receive, send)


async def _registration_limit() -> Response | None:
    """Anonymous registration, limited per source address -- the pattern of
    check_source_rate_limit (auth/service.py): the address the middleware
    resolved, non-routable sources not counted, Redis down -> refuse."""
    source = structlog.contextvars.get_contextvars().get("ip_address")
    try:
        over, _ = await over_source_limit(
            "mcp_oauth_register_src",
            source,
            limit=settings.mcp_oauth_register_per_source,
            window_seconds=settings.mcp_oauth_register_window_seconds,
        )
    except RedisError:
        return JSONResponse(
            {"error": "temporarily_unavailable", "message": "Try again later"},
            status_code=503,
        )
    if over:
        return JSONResponse(
            {"error": "rate_limited", "message": "Too many registrations"},
            status_code=429,
        )
    return None
