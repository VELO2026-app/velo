# =============================================================================
# VELO Backend — Auth Router (updated W-06: logout-all, FIX 2.3,
#                              CRITICAL-4: rate limiting)
# =============================================================================
#
# ENDPOINTS:
#   POST /api/v1/auth/telegram     — Login via Telegram WebApp initData
#   POST /api/v1/auth/logout       — Logout current session
#   POST /api/v1/auth/logout-all   — Logout all sessions (W-06)
#
# CRITICAL-4: Rate limiting on POST /auth/telegram.
#   Max 5 requests per 60 seconds per telegram_id.
#   Prevents Redis OOM via session flooding from a replayed valid initData.
# =============================================================================

import structlog
from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db_session
from app.core.exceptions import BadRequestError, TooManyRequestsError
from app.modules.auth.dependencies import get_current_user
from app.modules.auth.schemas import AuthResponse, TelegramAuthRequest
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
