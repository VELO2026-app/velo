# =============================================================================
# VELO Backend -- browser sign-in through Telegram (Standalone phase 3)
# =============================================================================
#
# The app opened in a browser or from the home screen has no initData. It
# signs in with "Log In With Telegram" (OpenID Connect, telegram_oidc.py):
#
#   1. start    -- the frontend asks for Telegram's URL. A fresh `state` is
#                  made here; what the callback will need (the PKCE verifier,
#                  the redirect URI, whether bot access was asked) is kept in
#                  Redis under that state, together with the sha256 of the
#                  browser's MARK -- a random string the frontend made and
#                  kept in its own storage;
#   2. Telegram  -- the person confirms; Telegram sends the browser back to
#                  the frontend's RETURN_PATH with `code` and `state`;
#   3. complete -- the frontend posts code, state and its mark. The state is
#                  TAKEN (GETDEL, once), the mark is compared with the stored
#                  hash BEFORE the code is exchanged, and only then Telegram
#                  is asked who this is.
#
# WHY THE MARK (login CSRF). Without it, someone could start a login with
# their own Telegram account, stop at the return, and hand the return link to
# a victim: the victim's browser would sign into the attacker's account and
# write their Diary there. The mark lives only in the browser that started
# the login, so a return opened anywhere else is refused -- here, and before
# any request to Telegram (the frontend refuses it too, without calling us).
#
# THE RETURN ADDRESS is the frontend's own origin, read from CORS_ORIGINS
# (see return_url). It is never taken from the client.
#
# SECRETS. The state, the mark, the code and the verifier are never logged.
# Redis keys hold the sha256 of the state; the value holds the sha256 of the
# mark, never the mark itself.
# =============================================================================

import hashlib
import hmac
import json
import secrets
from urllib.parse import urlsplit

from app.core.config import settings
from app.core.redis import get_redis
from app.modules.auth import telegram_oidc

# The frontend path Telegram sends the browser back to. The same literal is
# RETURN_PATH in frontend/src/platform/browser-login.ts; both must match the
# Redirect URI registered in BotFather (bot -> Login Widget -> Redirect URIs).
RETURN_PATH = "/auth/telegram/return"

# How long a started login waits for its return. Telegram's own page is the
# slow part (the person confirms in the Telegram app); ten minutes is the
# lifetime MCP OAuth gives the same leg.
LOGIN_TTL_SECONDS = 600

_KEY_PREFIX = "auth:browser_login:"


def return_url() -> str | None:
    """The redirect URI of the browser sign-in, or None when not configured.

    The frontend's origin is the ONE https address in CORS_ORIGINS -- the
    installer writes it there from the frontend domain it asked for, and the
    sign-in's own first request is a cross-origin call from that frontend,
    so it cannot work without being listed there anyway.

    KNOWN CEILING -- one frontend per backend.
      1. Mechanics: the return address is derived from CORS_ORIGINS only when
         it lists exactly one https origin (bare scheme://host[:port], no
         path, query, fragment or credentials). With two addresses there, or
         one http:// address, or the development wildcard, there is no single
         answer: browser sign-in reports "not configured" (start answers 404).
      2. Status: acknowledged by design.
      3. Task: none -- the Standalone phase 3 gate (dispatcher's answer, item
         1) fixed one frontend per server; no server has two today.
      4. Unfreeze trigger: a second address in CORS_ORIGINS -- the login
         screen of every frontend then says sign-in is not configured.
      5. Agreed fix: take the address from the Origin of the start request,
         check it against CORS_ORIGINS, and keep it under the state.
      6. Rejected: a separate key for the frontend address -- a second copy
         of the fact the installer already wrote into CORS_ORIGINS; two
         copies drift apart.
    """
    origin, _reason = _frontend_origin()
    return f"{origin}{RETURN_PATH}" if origin is not None else None


def _frontend_origin() -> tuple[str | None, str]:
    """The frontend origin from CORS_ORIGINS, or None and why not.

    The ONE implementation of the rule return_url() states; state() (velo
    doctor) reads the same reason instead of re-deriving it. Reasons:
    "ok", "empty", "several", "wildcard", "not_https" (another scheme),
    "not_origin" (a path, query, fragment, credentials or no host).
    """
    origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
    if not origins:
        return None, "empty"
    if len(origins) > 1:
        return None, "several"
    if origins[0] == "*":
        return None, "wildcard"
    parts = urlsplit(origins[0])
    if parts.scheme != "https":
        return None, "not_https"
    if (
        not parts.hostname
        or parts.path
        or parts.query
        or parts.fragment
        or parts.username
        or parts.password
    ):
        return None, "not_origin"
    return f"https://{parts.netloc}", "ok"


def state() -> tuple[list[str], str]:
    """Why browser sign-in is or is not configured, for velo doctor:
    (missing Telegram login key NAMES, CORS_ORIGINS reason). Configured
    exactly when the list is empty and the reason is "ok" -- the same two
    facts the endpoints check (telegram_oidc.configured, return_url). No
    value of any key is returned."""
    _origin, reason = _frontend_origin()
    return telegram_oidc.missing_keys(), reason


def _key(state: str) -> str:
    return _KEY_PREFIX + hashlib.sha256(state.encode()).hexdigest()


def _mark_hash(mark: str) -> str:
    return hashlib.sha256(mark.encode()).hexdigest()


async def start(*, redirect_uri: str, mark: str) -> tuple[str, str]:
    """Begin a sign-in for the browser holding `mark`, returning to
    `redirect_uri` (return_url(), checked by the caller).

    Returns (Telegram URL, state). Bot access is always asked (owner ruling,
    Standalone §1 item 15.3): Telegram shows that consent on its own page.
    Raises RedisError.
    """
    state = secrets.token_urlsafe(32)
    login = telegram_oidc.start_login(
        redirect_uri=redirect_uri, state=state, bot_access=True
    )
    await get_redis().set(
        _key(state),
        json.dumps(
            {
                "redirect_uri": redirect_uri,
                "verifier": login.code_verifier,
                "bot_access": login.bot_access,
                "mark_hash": _mark_hash(mark),
            }
        ),
        ex=LOGIN_TTL_SECONDS,
    )
    return login.url, state


async def take(state: str) -> dict | None:
    """The started sign-in under `state`, ONCE (GETDEL): a second taker --
    a reload, a double submit, another worker -- gets None. Raises
    RedisError."""
    raw = await get_redis().getdel(_key(state))
    return json.loads(raw) if raw is not None else None


def mark_matches(started: dict, mark: str) -> bool:
    """The browser presenting `mark` is the one that started the sign-in.
    Constant-time on the hashes."""
    return hmac.compare_digest(_mark_hash(mark), str(started.get("mark_hash", "")))
