# =============================================================================
# VELO Backend — Auth Router (updated W-06: logout-all, FIX 2.3,
#                              CRITICAL-4: rate limiting)
# =============================================================================
#
# ENDPOINTS:
#   POST /api/v1/auth/telegram     — Login via Telegram WebApp initData
#   POST /api/v1/auth/telegram/browser/start    — Browser sign-in: Telegram URL
#   POST /api/v1/auth/telegram/browser/complete — Browser sign-in: the return
#   POST /api/v1/auth/logout       — Logout current session
#   POST /api/v1/auth/logout-all   — Logout all sessions (W-06)
#
# CRITICAL-4: Rate limiting on POST /auth/telegram.
#   Max 5 requests per 60 seconds per telegram_id.
#   Prevents Redis OOM via session flooding from a replayed valid initData.
# =============================================================================

import structlog
from fastapi import APIRouter, Depends, Request
from redis.exceptions import RedisError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db_session
from app.core.exceptions import (
    BadRequestError,
    ForbiddenError,
    NotFoundError,
    TooManyRequestsError,
    VeloError,
)
from app.core.i18n import normalize_language
from app.modules.auth import browser_login, telegram_oidc
from app.modules.auth.dependencies import get_current_user
from app.modules.auth.schemas import (
    AuthResponse,
    BrowserLoginCompleteRequest,
    BrowserLoginResponse,
    BrowserLoginStartRequest,
    BrowserLoginStartResponse,
    TelegramAuthRequest,
)
from app.modules.auth.service import (
    TelegramValidationError,
    check_auth_rate_limit,
    check_source_rate_limit,
    create_session,
    delete_all_sessions,
    delete_session,
    upsert_user_on_login,
    validate_telegram_init_data,
)
from app.modules.users.models import User

logger = structlog.get_logger()

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


@router.post("/telegram", response_model=AuthResponse)
async def auth_telegram(
    body: TelegramAuthRequest,
    session: AsyncSession = Depends(get_db_session),
) -> AuthResponse:
    """Authenticate via Telegram WebApp.

    Flow:
      0. T-47: Rate limit per SOURCE, before any crypto is done
      1. Validate initData signature (HMAC-SHA256) + auth_date freshness
      2. CRITICAL-4: Rate limit per telegram_id (5 req / 60s)
      3. Find or create User by telegram_id
      3a. Refuse a deactivated account -- no session for it (403)
      4. Flush DB (get user.id) -- commit deferred to get_db_session
      5. Create session in Redis (token, TTL 30 days)
      6. Return user + session_token
    """
    # Step 0: T-47 -- the cheap limiter, BEFORE the signature check.
    # Step 2's limiter keys on telegram_id, which does not exist until the
    # initData has been verified and parsed; on its own it left signature
    # guessing bounded only by the cost of a HMAC. This one keys on the
    # client address the middleware already validated, so it applies to
    # attempts that never get as far as naming an account.
    # The address comes from the middleware's contextvars, not from the
    # request here: TraceIdMiddleware already resolved it once, applying the
    # trust and form checks (T-47 finding 2), and record_audit reads the same
    # binding. One resolution, one value -- re-deriving it here would be a
    # second place that could disagree with the audit trail about who this is.
    source = structlog.contextvars.get_contextvars().get("ip_address")
    await check_source_rate_limit(source)

    # Step 1: Validate initData from Telegram. This also rejects initData
    # whose auth_date is older than the validity window (or in the future),
    # which is the real defence against stale/intercepted initData.
    try:
        telegram_user = validate_telegram_init_data(
            body.init_data,
            settings.telegram_bot_token,
        )
    except TelegramValidationError as e:
        logger.warning("telegram_auth_failed", reason=str(e))
        raise BadRequestError(str(e)) from e

    # Step 2: CRITICAL-4 -- Rate limit per telegram_id.
    # Kept alongside step 0, not replaced by it: this one names a specific
    # account (an account under attack, or one flooding sessions), while
    # step 0 only knows about a source address that may be a whole carrier
    # NAT. T-47: answers 429 now, not 400 -- nothing was wrong with the
    # request except its rate, and 429 is the code a client can back off on.
    try:
        await check_auth_rate_limit(telegram_user["id"])
    except TelegramValidationError as e:
        logger.warning(
            "telegram_auth_rate_limited",
            telegram_id=telegram_user["id"],
        )
        raise TooManyRequestsError(str(e)) from e

    # Step 3: Create or update user.
    user = await upsert_user_on_login(telegram_user, session)

    # Step 3a: a deactivated account gets no session. Before this check a
    # session was created and every request then answered 403 from
    # get_current_user; now the door itself refuses, the same refusal the
    # browser sign-in gives (browser_login_complete). The upsert above is
    # undone by get_db_session, which rolls the request's transaction back
    # when the endpoint raises (par0 §8) -- a dependency, not a property of
    # this function.
    if not user.is_active:
        logger.warning("telegram_auth_deactivated", user_id=str(user.id))
        raise ForbiddenError("Account is deactivated", code="account_deactivated")

    # Step 4: M-02 fix: flush (not commit) to get user.id for Redis.
    # get_db_session will commit after return. If Redis fails,
    # the entire transaction rolls back -- no orphan DB records.
    await session.flush()

    # Step 5: Create session in Redis.
    token = await create_session(user)

    return AuthResponse(
        user=user,  # type: ignore[arg-type]  # from_attributes handles ORM
        session_token=token,
    )


# ---------------------------------------------------------------------------
# Browser sign-in through Telegram (Standalone phase 3, browser_login.py)
# ---------------------------------------------------------------------------
#
# Every refusal is a code the login screen turns into a phrase:
#   404 login_not_configured  -- no Telegram login keys, or CORS_ORIGINS is
#                                not exactly one https origin (return_url);
#   400 login_expired         -- the state is unknown, expired or taken;
#   400 login_foreign         -- the return came to a browser that did not
#                                start this sign-in (the mark does not match);
#   400 telegram_failed       -- Telegram did not prove a user;
#   403 account_deactivated   -- the account exists and is switched off;
#   429                       -- the per-source or per-account limit;
#   503 service_unavailable   -- Redis did not answer.


def _unavailable() -> VeloError:
    return VeloError(
        message="Service temporarily unavailable. Try again in a minute.",
        code="service_unavailable",
        status_code=503,
    )


def _not_configured() -> NotFoundError:
    return NotFoundError(
        "Browser sign-in is not configured on this server",
        code="login_not_configured",
    )


async def _source_limit() -> None:
    """The /auth/telegram per-source limiter (T-47), on the same counter --
    a source spends one budget on both doors. Redis down -> 503."""
    source = structlog.contextvars.get_contextvars().get("ip_address")
    try:
        await check_source_rate_limit(source)
    except RedisError:
        raise _unavailable() from None


@router.post("/telegram/browser/start", response_model=BrowserLoginStartResponse)
async def browser_login_start(
    body: BrowserLoginStartRequest,
) -> BrowserLoginStartResponse:
    """Begin a browser sign-in: the Telegram URL to send the browser to.

    The state is kept in Redis with the hash of the browser's mark; nothing
    touches the database.
    """
    await _source_limit()
    redirect_uri = browser_login.return_url()
    if redirect_uri is None or not telegram_oidc.configured():
        raise _not_configured()
    try:
        url, state = await browser_login.start(
            redirect_uri=redirect_uri, mark=body.mark
        )
    except RedisError:
        raise _unavailable() from None
    return BrowserLoginStartResponse(url=url, state=state)


@router.post("/telegram/browser/complete", response_model=BrowserLoginResponse)
async def browser_login_complete(
    body: BrowserLoginCompleteRequest,
    session: AsyncSession = Depends(get_db_session),
) -> BrowserLoginResponse:
    """Finish a browser sign-in: Telegram's code -> the same account as in
    the Mini App (created on the first sign-in) -> a session.

    ORDER, and why:
      1. the source limit, before anything else (as /auth/telegram);
      2. the state is TAKEN, once -- a reload or a second tab gets 400;
      3. the mark is checked BEFORE Telegram is asked: a return opened in a
         browser that did not start the sign-in never exchanges the code;
      4. Telegram (two HTTP requests) -- with NO database connection held:
         `session` has run no statement yet, and an AsyncSession takes its
         connection on the first one (par0 §8: no external HTTP inside a
         transaction);
      5. the per-account limit, now that the account is known;
      6. upsert -> refuse a deactivated account -> session in Redis.
    """
    await _source_limit()
    if browser_login.return_url() is None or not telegram_oidc.configured():
        raise _not_configured()

    try:
        started = await browser_login.take(body.state)
    except RedisError:
        raise _unavailable() from None
    if started is None:
        raise BadRequestError(
            "The sign-in link has expired. Start again.", code="login_expired"
        )
    if not browser_login.mark_matches(started, body.mark):
        logger.warning("browser_login_foreign_return")
        raise BadRequestError(
            "This sign-in was started in another browser.", code="login_foreign"
        )

    try:
        identity = await telegram_oidc.complete_login(
            code=body.code,
            redirect_uri=started["redirect_uri"],
            code_verifier=started["verifier"],
            bot_access_requested=started["bot_access"],
        )
    except telegram_oidc.TelegramLoginError as exc:
        logger.info("browser_login_telegram_failed", reason=exc.reason)
        raise BadRequestError(
            "Telegram did not confirm the sign-in.", code="telegram_failed"
        ) from None

    try:
        await check_auth_rate_limit(identity.telegram_id)
    except TelegramValidationError as e:
        logger.warning("telegram_auth_rate_limited", telegram_id=identity.telegram_id)
        raise TooManyRequestsError(str(e)) from e
    except RedisError:
        raise _unavailable() from None

    # The same dict shape initData gives upsert_user_on_login. A claim
    # Telegram did not send is None, and the upsert writes it as such -- the
    # same as a field initData leaves out. The browser's language tag is
    # untrusted: only its normalized form goes in, and the upsert applies the
    # language column on INSERT only.
    user = await upsert_user_on_login(
        {
            "id": identity.telegram_id,
            "first_name": identity.first_name,
            "last_name": identity.last_name,
            "username": identity.username,
            "photo_url": identity.photo_url,
            "language_code": (
                normalize_language(body.language) if body.language else None
            ),
        },
        session,
    )
    if not user.is_active:
        # Refused BEFORE a session exists. The upsert above is undone by
        # get_db_session, which rolls the request's transaction back when the
        # endpoint raises (par0 §8) -- a dependency, not a property of this
        # function.
        raise ForbiddenError("Account is deactivated", code="account_deactivated")

    await session.flush()
    try:
        token = await create_session(user)
    except RedisError:
        # Raised inside the endpoint: get_db_session rolls the upsert back.
        raise _unavailable() from None

    logger.info(
        "browser_login_completed",
        user_id=str(user.id),
        bot_access_granted=identity.bot_access_granted,
    )
    return BrowserLoginResponse(
        user=user,  # type: ignore[arg-type]  # from_attributes handles ORM
        session_token=token,
        bot_access_granted=identity.bot_access_granted,
    )


@router.post("/logout", status_code=204)
async def logout(
    request: Request,
    user: User = Depends(get_current_user),
) -> None:
    """Logout -- delete session from Redis. (P-3)"""
    auth_header = request.headers.get("Authorization", "")
    token = auth_header[7:] if auth_header.startswith("Bearer ") else ""
    if token:
        # FIX 2.3: pass user_id to clean up Sorted Set index entry.
        await delete_session(token, user_id=user.id)
    logger.info("user_logout", user_id=str(user.id))


@router.post("/logout-all", status_code=204)
async def logout_all(
    user: User = Depends(get_current_user),
) -> None:
    """Logout all sessions for the current user (W-06).

    Invalidates every active session token. The current request
    succeeds (user is already authenticated), but all subsequent
    requests with any of the user's tokens will fail with 401.
    """
    count = await delete_all_sessions(user.id)
    logger.info(
        "user_logout_all",
        user_id=str(user.id),
        sessions_invalidated=count,
    )
