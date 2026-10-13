# =============================================================================
# VELO Backend -- "Log In With Telegram" in a browser (BE-141)
# =============================================================================
#
# Telegram's current website login is OpenID Connect (core.telegram.org/bots/
# telegram-login). The iframe widget with the SHA256(bot token) signature is
# archived there as "legacy" and is NOT used here.
#
# A SHARED BRICK, not a part of MCP (owner ruling): one interface, "a code
# from Telegram (+ PKCE) -> a verified Telegram user". Its first consumer is
# the consent page of MCP OAuth (app/modules/mcp/oauth.py); the next one is
# the browser sign-in of the Standalone app. Each consumer registers its own
# redirect URI among the bot's Allowed URLs in BotFather.
#
#   start_login()     -> where to send the browser (oauth.telegram.org/auth)
#                        and the PKCE verifier the caller keeps until the
#                        callback, together with its `state`;
#   complete_login()  -> on the callback: the code exchanged at
#                        oauth.telegram.org/token (HTTP Basic with the client
#                        secret, plus the verifier), the id_token verified
#                        against Telegram's published keys -- signature, iss,
#                        aud (= our client id), exp, iat -- and returned as a
#                        TelegramUser.
#
# It knows nothing about VELO users, sessions or MCP: the caller maps
# telegram_id to a user.
#
# CLAIMS (scope "openid profile"): `id` -- the Telegram user id, the same
# number initData carries; `given_name` / `family_name` / `name`,
# `preferred_username`, `picture`. `sub` is a different, OIDC-only
# identifier and is not used.
#
# THE BOT'S RIGHT TO WRITE. Scope telegram:bot_access lets the bot message
# the user after the login, but Telegram returns NO claim for it (its scope
# table: "Claims Returned: --"). What can be known is whether THIS login
# granted it: RFC 6749 §5.1 -- the token response names `scope` when the
# granted scopes differ from the requested ones, and may omit it when they
# are the same. So bot_access_granted is: requested, and either `scope` is
# absent or it lists telegram:bot_access. It says nothing about a right the
# user gave elsewhere (the Mini App's allows_write_to_pm).
#
# SECRETS. The client secret, the code, the verifier and the id_token are
# never logged; a failure is logged as a reason word and, for an HTTP
# answer, its status code. The bot token plays no part in this flow.
#
# HTTP. Two requests to Telegram per login (token, keys). The caller makes
# them OUTSIDE any database transaction (par0 §8). Keys are fetched per
# login, not cached: a login is rare, and a cache would be one more thing to
# be stale when Telegram rotates.
# =============================================================================

import base64
import hashlib
import secrets
from dataclasses import dataclass
from urllib.parse import urlencode

import httpx
import jwt
import structlog

from app.core.config import settings

logger = structlog.get_logger()

ISSUER = "https://oauth.telegram.org"
AUTHORIZE_URL = f"{ISSUER}/auth"
TOKEN_URL = f"{ISSUER}/token"
JWKS_URL = f"{ISSUER}/.well-known/jwks.json"
SCOPE = "openid profile"
BOT_ACCESS_SCOPE = "telegram:bot_access"
# RS256 is Telegram's default; ES256 is the other algorithm BotFather offers
# that still allows the profile scope (EdDSA and ES256K are openid-only).
ALGORITHMS = ("RS256", "ES256")


class TelegramLoginError(Exception):
    """The login did not prove a Telegram user. `reason` is a word for the
    log; the user-facing phrase is the caller's."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class TelegramLoginStart:
    """What start_login hands the caller: the URL to send the browser to, and
    what to keep (next to its own `state`) until the callback."""

    url: str
    code_verifier: str
    bot_access: bool


@dataclass(frozen=True)
class TelegramUser:
    """A Telegram user the id_token proved."""

    telegram_id: int
    first_name: str | None
    last_name: str | None
    username: str | None
    photo_url: str | None
    # This login granted the bot the right to write to the user (module
    # header: THE BOT'S RIGHT TO WRITE).
    bot_access_granted: bool


def configured() -> bool:
    return bool(
        settings.telegram_login_client_id and settings.telegram_login_client_secret
    )


def _pkce_challenge(verifier: str) -> str:
    """S256 challenge of a verifier (RFC 7636 §4.2)."""
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def start_login(
    *, redirect_uri: str, state: str, bot_access: bool = False
) -> TelegramLoginStart:
    """The browser's way to Telegram. `state` is the caller's (it finds its
    own request by it on the callback); the verifier is made here and must
    come back to complete_login."""
    verifier = secrets.token_urlsafe(48)
    scope = f"{SCOPE} {BOT_ACCESS_SCOPE}" if bot_access else SCOPE
    url = f"{AUTHORIZE_URL}?" + urlencode(
        {
            "client_id": settings.telegram_login_client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": scope,
            "state": state,
            "code_challenge": _pkce_challenge(verifier),
            "code_challenge_method": "S256",
        }
    )
    return TelegramLoginStart(url=url, code_verifier=verifier, bot_access=bot_access)


def _client() -> httpx.AsyncClient:
    """The HTTP client for both calls. A function so tests can hand in a
    mock transport; production gets a plain client with the timeout."""
    return httpx.AsyncClient(timeout=settings.telegram_login_http_timeout_seconds)


async def complete_login(
    *, code: str, redirect_uri: str, code_verifier: str, bot_access_requested: bool
) -> TelegramUser:
    """Exchange the code and verify the id_token. Raises TelegramLoginError.
    `code_verifier` and `bot_access_requested` are what start_login gave."""
    client_id = settings.telegram_login_client_id
    try:
        async with _client() as http:
            resp = await http.post(
                TOKEN_URL,
                data={
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": redirect_uri,
                    "client_id": client_id,
                    "code_verifier": code_verifier,
                },
                auth=(client_id, settings.telegram_login_client_secret),
            )
            if resp.status_code != 200:
                logger.warning("telegram_login_token_refused", status=resp.status_code)
                raise TelegramLoginError("token_refused")
            body = resp.json()
            id_token = _id_token(body)
            granted = _bot_access_granted(body, bot_access_requested)

            keys = await http.get(JWKS_URL)
            if keys.status_code != 200:
                logger.warning(
                    "telegram_login_keys_unavailable", status=keys.status_code
                )
                raise TelegramLoginError("keys_unavailable")
            jwks = keys.json()
    except httpx.HTTPError as exc:
        logger.warning("telegram_login_unreachable", error=type(exc).__name__)
        raise TelegramLoginError("unreachable") from None
    except ValueError:
        # resp.json() / keys.json() on a body that is not JSON.
        raise TelegramLoginError("bad_response") from None
    return verify_id_token(id_token, jwks, bot_access_granted=granted)


def _id_token(body: object) -> str:
    value = body.get("id_token") if isinstance(body, dict) else None
    if not isinstance(value, str) or not value:
        raise TelegramLoginError("no_id_token")
    return value


def _bot_access_granted(body: object, requested: bool) -> bool:
    """RFC 6749 §5.1: no `scope` in the answer -> granted as requested."""
    if not requested:
        return False
    scope = body.get("scope") if isinstance(body, dict) else None
    if scope is None:
        return True
    return isinstance(scope, str) and BOT_ACCESS_SCOPE in scope.split()


def verify_id_token(
    id_token: str, jwks: object, *, bot_access_granted: bool = False
) -> TelegramUser:
    """Signature against the published key named by the token's kid, then
    iss, aud, exp and iat (required), then the Telegram user id. Raises
    TelegramLoginError."""
    try:
        header = jwt.get_unverified_header(id_token)
        alg = header.get("alg")
        if alg not in ALGORITHMS:
            raise TelegramLoginError("bad_algorithm")
        key_set = jwt.PyJWKSet.from_dict(jwks)
        kid = header.get("kid")
        candidates = [k for k in key_set.keys if kid is None or k.key_id == kid]
        if len(candidates) != 1:
            raise TelegramLoginError("unknown_key")
        claims = jwt.decode(
            id_token,
            candidates[0].key,
            algorithms=[alg],
            audience=settings.telegram_login_client_id,
            issuer=ISSUER,
            options={"require": ["exp", "iat", "iss", "aud"]},
        )
    except TelegramLoginError:
        raise
    except (jwt.PyJWTError, TypeError, KeyError, ValueError, AttributeError) as exc:
        logger.info("telegram_login_id_token_rejected", error=type(exc).__name__)
        raise TelegramLoginError("bad_id_token") from None

    telegram_id = claims.get("id")
    # bool is an int in Python; a JSON true is not a user id.
    if (
        not isinstance(telegram_id, int)
        or isinstance(telegram_id, bool)
        or telegram_id <= 0
    ):
        raise TelegramLoginError("no_telegram_id")
    return TelegramUser(
        telegram_id=telegram_id,
        first_name=_text(claims.get("given_name")) or _text(claims.get("name")),
        last_name=_text(claims.get("family_name")),
        username=_text(claims.get("preferred_username")),
        photo_url=_https(claims.get("picture")),
        bot_access_granted=bot_access_granted,
    )


def _text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _https(value: object) -> str | None:
    """A photo URL is shown in an <img>: https only, anything else dropped."""
    text = _text(value)
    return text if text is not None and text.startswith("https://") else None
