# =============================================================================
# VELO Backend -- Auth Service (updated Phase 7.3, FIX 2.2 + 2.3, QW-1,
#                               HIGH-1, CRITICAL-4, NO-LITERALS)
# =============================================================================
#
# RESPONSIBILITIES:
#   1. Validate Telegram WebApp initData (HMAC-SHA256)
#   2. Create or update User on login
#   3. Manage sessions in Redis (create / get / delete / delete-all)
#
# TELEGRAM initData VALIDATION:
#   Telegram sends a query string signed with HMAC-SHA256.
#   We verify the signature using our bot token to ensure the data
#   is authentic and not forged. See:
#   https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
#
# SESSION FORMAT IN REDIS:
#   Key:   session:{token}
#   Value: JSON {"user_id": "uuid", "telegram_id": 123, "created_at": "iso"}
#   TTL:   30 days (configurable via SESSION_TTL_DAYS)
#
# SESSION INDEX (W-06, FIX 2.3):
#   Key:   user_sessions:{user_id}
#   Type:  Redis ZSET (Sorted Set), score = creation timestamp
#   TTL:   Same as session TTL
#   Purpose: Reverse index for logout-all. Sorted Set allows efficient
#            GC of expired tokens via ZREMRANGEBYSCORE on each login.
#            Prevents unbounded memory growth from dead session entries.
#
# CRITICAL-4: Rate limiting for POST /auth/telegram.
#   Max AUTH_RATE_LIMIT_MAX_REQUESTS requests per AUTH_RATE_LIMIT_WINDOW_SECONDS
#   per telegram_id.
#   Key: auth_rate:{telegram_id}, TTL = auth_rate_limit_window_seconds.
#   Prevents Redis OOM via session flooding from a replayed valid initData.
# =============================================================================

import hashlib
import hmac
import ipaddress
import json
import secrets
from datetime import UTC, datetime
from urllib.parse import parse_qs
from uuid import UUID

import structlog
from sqlalchemy import func, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.events import emit_user_upserted  # Phase 6 / T0
from app.core.exceptions import TooManyRequestsError
from app.core.redis import get_redis
from app.core.telegram_links import normalize_telegram_url
from app.core.i18n import normalize_language
from app.modules.users.models import User

logger = structlog.get_logger()

# Session key prefix in Redis.
_SESSION_PREFIX = "session:"

# Reverse index prefix: ZSET of tokens per user (W-06, FIX 2.3).
_USER_SESSIONS_PREFIX = "user_sessions:"

# HIGH-1: Maximum clock skew tolerance for auth_date (seconds).
# Sourced from settings.auth_clock_skew_seconds -- no hardcoded magic number.
# Rejects initData with auth_date more than N seconds in the future,
# which would bypass the initData expiry check.


def _get_session_ttl() -> int:
    """Session TTL in seconds, computed at call time (not import time).

    TD-021: previously this was a module-level constant computed at import.
    Tests could not override SESSION_TTL_DAYS because the value was already
    baked in. Now it reads settings.session_ttl_days on every call.
    """
    return settings.session_ttl_days * 24 * 60 * 60


# ---------------------------------------------------------------------------
# Telegram initData validation
# ---------------------------------------------------------------------------


class TelegramValidationError(Exception):
    """Raised when initData signature or content is invalid."""


def validate_telegram_init_data(init_data: str, bot_token: str) -> dict:
    """Validate and parse Telegram WebApp initData.

    Args:
        init_data: Raw query string from Telegram WebApp.
        bot_token: Bot token from BotFather.

    Returns:
        Parsed user data dict from Telegram.

    Raises:
        TelegramValidationError: If signature is invalid or data expired.
    """
    # Parse the query string into key-value pairs.
    parsed = parse_qs(init_data, keep_blank_values=True)

    # Extract hash -- Telegram includes it for verification.
    received_hash = parsed.pop("hash", [None])[0]
    if not received_hash:
        raise TelegramValidationError("Missing hash in initData")

    # Build the data-check-string: sorted key=value pairs joined by \n.
    # Each value is taken as-is (first element of the list from parse_qs).
    data_check_pairs = sorted(f"{k}={v[0]}" for k, v in parsed.items())
    data_check_string = "\n".join(data_check_pairs)

    # Compute HMAC-SHA256:
    # 1. secret_key = HMAC-SHA256("WebAppData", bot_token)
    # 2. hash = HMAC-SHA256(secret_key, data_check_string)
    secret_key = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    computed_hash = hmac.new(
        secret_key, data_check_string.encode(), hashlib.sha256
    ).hexdigest()

    # Compare hashes (constant-time to prevent timing attacks).
    if not hmac.compare_digest(computed_hash, received_hash):
        raise TelegramValidationError("Invalid initData signature")

    # Check auth_date is not too old (5 minutes).
    auth_date_str = parsed.get("auth_date", [None])[0]
    if not auth_date_str:
        raise TelegramValidationError("Missing auth_date")

    try:
        auth_date = int(auth_date_str)
    except ValueError:
        raise TelegramValidationError("Invalid auth_date format") from None

    now = int(datetime.now(UTC).timestamp())
    if now - auth_date > settings.auth_init_data_ttl_seconds:
        raise TelegramValidationError("initData expired")

    # HIGH-1: Reject auth_date from the future (clock skew tolerance from config).
    # Without this, an attacker can set auth_date far in the future,
    # making the token valid indefinitely (now - future_date < 0 < ttl).
    if auth_date > now + settings.auth_clock_skew_seconds:
        raise TelegramValidationError("initData auth_date is in the future")

    # Parse user JSON from the query string.
    user_data_str = parsed.get("user", [None])[0]
    if not user_data_str:
        raise TelegramValidationError("Missing user in initData")

    # ERR-03: guard against malformed JSON in user field.
    # Without this, a corrupted or forged user value causes an
    # unhandled JSONDecodeError -> 500 instead of a clean 400.
    #
    # T-47: parsed WITHOUT a second decoding pass, and that is the whole
    # point -- do not "restore" one here.
    #
    # parse_qs (above) already percent-decodes, so `parsed` holds decoded
    # values and the data-check-string built from them is what the HMAC was
    # computed over. Applying urllib's unquote() again at this line meant the
    # string whose signature we verified and the string we actually parsed
    # could be TWO DIFFERENT STRINGS: decoding is not idempotent, so for a
    # class of inputs the second pass changes the value AFTER the signature
    # check has already passed on the first one. Everything downstream --
    # including the telegram_id used to look a user up -- then came from
    # something Telegram never signed.
    #
    # The rule this restores: the value that was signed and the value that is
    # used must be the same object, not two values that usually agree. A
    # check that the second decode "did not change anything" would not do:
    # that keeps two values and adds a rule about them, when the fix is to
    # have one value.
    #
    # Consequence, stated plainly: initData whose `user` was percent-encoded
    # a second time by some client no longer parses. Such input was never
    # signed in the form we were reading it, so refusing it is correct.
    # Genuine Telegram initData is unaffected -- it is signed exactly as it
    # arrives after one decoding pass.
    try:
        user_data = json.loads(user_data_str)
    except json.JSONDecodeError:
        raise TelegramValidationError(
            "Invalid user data in initData"
        ) from None

    # T-47: the id must exist and be an integer before this value is handed
    # back. Found while writing the MISSING-field double for this handoff:
    # signed initData whose user JSON simply had no "id" passed validation,
    # and the caller's telegram_user["id"] then raised KeyError -- an
    # unhandled 500 on external input, the same class ERR-03 above closes
    # for malformed JSON. Telegram always sends an integer id, so nothing
    # legitimate is refused here.
    #
    # The isinstance(dict) check is not redundant with ERR-03: `[1,2,3]` and
    # `"text"` are perfectly valid JSON, so json.loads accepts them, and it
    # was .get() below that then raised AttributeError -- a 500 by another
    # route. Both shapes are refused here, together.
    #
    # bool is excluded deliberately: it is a subclass of int in Python, and
    # a JSON `true` reaching a telegram_id lookup is not a user id.
    if not isinstance(user_data, dict):
        raise TelegramValidationError("Invalid user data in initData")
    user_id = user_data.get("id")
    if not isinstance(user_id, int) or isinstance(user_id, bool):
        raise TelegramValidationError("Invalid user data in initData")

    return user_data


# ---------------------------------------------------------------------------
# Auth security: rate limiting
# ---------------------------------------------------------------------------
#
# NOTE: an initData anti-replay key (SET NX on sha256(init_data)) used to live
# here. It was removed because it broke the legitimate logout -> re-login flow:
# Telegram keeps window.Telegram.WebApp.initData constant for the lifetime of
# an open Mini App, so a second login reused the same string and was rejected
# until the key expired. Replay within the validity window is already bounded
# by validate_telegram_init_data(), which rejects initData whose auth_date is
# older than auth_init_data_ttl_seconds (or set in the future), and abusive
# bursts are bounded by check_auth_rate_limit() below.


# T-47: the per-source limiter, applied BEFORE the signature is checked.
#
# The multiplier, not a new config key: config.py is a production gate this
# handoff deliberately does not touch, and a knob with no operator asking for
# it is not worth the .env.example entry, the doctor drift check and the
# compatibility burden on existing boxes. It rides the two settings that
# already exist (auth_rate_limit_max_requests / _window_seconds) so tuning
# the auth limits still moves both together.
#
# WHY SO MUCH LOOSER than the per-telegram_id limit. This key is an IP
# address, and Telegram clients sit behind carrier NAT -- one address can be
# an entire mobile network's worth of legitimate people opening the Mini App
# at once. The per-account limit stays tight because it names one account;
# this one only has to make signature grinding cost a counter instead of
# costing nothing, so it is set where a burst of real users never reaches it.
# The two limits are about different things and neither replaces the other.
_SOURCE_RATE_LIMIT_MULTIPLIER = 20


async def check_source_rate_limit(source: str | None) -> None:
    """Cheap per-source limit, checked BEFORE the HMAC verification.

    T-47: check_auth_rate_limit below keys on telegram_id, which is only
    known AFTER initData has been parsed -- so before this function existed,
    an attacker guessing signatures was bounded by nothing but the cost of a
    HMAC, and the counter they would eventually trip was one they never
    reached. This runs first, on something known at connection time.

    A missing source (no client in scope) is not rate limited here: there is
    nothing to key on, and inventing a shared key would put every such
    request into one bucket -- turning a limiter into an outage.

    THE SAME RULE, for the same reason, applies to any address that is not a
    routable public one. This is not a softening -- it is the original rule
    applied where it actually bites, and it was found the hard way: keyed on
    every address, the first version put the entire backend test suite (644
    logins from 127.0.0.1, far above the ceiling below) into ONE bucket and
    turned the whole suite red. A loopback or private address is never a
    remote attacker; it is our own infrastructure showing through -- the test
    client, a health check, or the nginx peer used as fallback when no
    X-Forwarded-For was present. Limiting on it does not bound an attacker,
    it only shares one counter between everybody it cannot tell apart.

    Named honestly, the failure mode this leaves: if nginx ever stopped
    setting X-Forwarded-For, every request would resolve to the proxy's own
    private address and this limiter would silently stop applying. That is a
    degradation to OFF. The alternative -- keying on the shared fallback --
    is a degradation to OUTAGE for every client at once, which is what the
    suite just demonstrated. Between a control that stops helping and a
    control that takes the service down, this one may only do the former.
    The per-telegram_id limiter below is unaffected either way, and it is
    the one that names a specific account.

    Args:
        source: Client address, already validated by the middleware.

    Raises:
        TooManyRequestsError: If the per-source limit is exceeded.
    """
    if not source:
        return

    try:
        if not ipaddress.ip_address(source).is_global:
            return
    except ValueError:
        # Not an address at all -- the middleware should never produce this,
        # and guessing at a key for it is exactly what the paragraph above
        # forbids.
        return

    redis = get_redis()
    rate_key = f"auth_rate_src:{source}"
    count = await redis.incr(rate_key)
    if count == 1:
        # TTL on first increment only -- otherwise every request slides the
        # window forward and the limit never triggers (same pattern as the
        # per-telegram_id limiter below).
        await redis.expire(rate_key, settings.auth_rate_limit_window_seconds)

    limit = settings.auth_rate_limit_max_requests * _SOURCE_RATE_LIMIT_MULTIPLIER
    if count > limit:
        raise TooManyRequestsError(
            "Too many auth attempts. Please try again later."
        )


async def check_auth_rate_limit(telegram_id: int) -> None:
    """Rate limit auth attempts per telegram_id.

    CRITICAL-4: Max 5 requests per 60 seconds per telegram_id.
    Uses Redis INCR + EXPIRE pattern (TTL set only on first increment
    to avoid resetting the window on each request).

    Prevents Redis OOM from session flooding via a replayed valid initData
    within its 5-minute window.

    Args:
        telegram_id: Telegram user ID (from validated initData).

    Raises:
        TelegramValidationError: If rate limit is exceeded.
    """
    redis = get_redis()
    rate_key = f"auth_rate:{telegram_id}"
    count = await redis.incr(rate_key)
    if count == 1:
        # Set TTL only on first increment to avoid resetting the window.
        await redis.expire(rate_key, settings.auth_rate_limit_window_seconds)
    if count > settings.auth_rate_limit_max_requests:
        raise TelegramValidationError(
            "Too many auth attempts. Please try again later."
        )


# ---------------------------------------------------------------------------
# User upsert (create or update on login)
# ---------------------------------------------------------------------------


async def upsert_user_on_login(
    telegram_user: dict,
    session: AsyncSession,
) -> User:
    """Find user by telegram_id or create a new one. Update profile on login.

    Uses INSERT ... ON CONFLICT DO UPDATE (P-1) to avoid race conditions
    when two requests arrive simultaneously for a new user.

    Phase 7.3: normalizes language_code from Telegram to supported set
    (en/de/es/ru). Unsupported codes fall back to "en".

    FIX 2.2: language is set only on INSERT (new users). Returning users
    keep their language preference set via PATCH /users/me.

    Args:
        telegram_user: Parsed user dict from Telegram initData.
        session: Database session (read-write).

    Returns:
        User object (new or existing, updated).
    """
    telegram_id = telegram_user["id"]
    now = datetime.now(UTC)

    # Telegram hands us photo_url on a host that may be dead (t.me was pulled
    # at the registry level on 2026-07-13). Rewrite it onto the live host ONCE,
    # here, at the only point where an avatar enters the system -- so nothing
    # downstream (schemas, views, the DB) ever sees a dead host.
    # See app/core/telegram_links.py.
    photo_url = normalize_telegram_url(
        telegram_user.get("photo_url"), settings.telegram_link_domain
    )

    credentials = {
        "telegram_username": telegram_user.get("username"),
        "telegram_photo_url": photo_url,
        "language_code": telegram_user.get("language_code"),
    }

    # Phase 7.3: Normalize language_code to supported set (en/de/es/ru).
    # Handles "en-US" -> "en", "pt-BR" -> "en" (unsupported -> fallback).
    normalized_lang = normalize_language(
        telegram_user.get("language_code"),
    )

    # Atomic upsert: INSERT or UPDATE in a single statement.
    # No race condition possible -- PostgreSQL locks the row on conflict.
    stmt = (
        pg_insert(User)
        .values(
            telegram_id=telegram_id,
            first_name=telegram_user.get("first_name"),
            last_name=telegram_user.get("last_name"),
            avatar_url=photo_url,
            language=normalized_lang,
            credentials=credentials,
            last_login_at=now,
        )
        .on_conflict_do_update(
            index_elements=["telegram_id"],
            # FIX 2.2: language removed from set_ -- preserve user edits
            # via PATCH /users/me. Language is set on INSERT (new users)
            # but not overwritten on UPDATE (returning users).
            # first_name, last_name, avatar_url sync from Telegram.
            #
            # ONBOARDING: credentials is MERGED, not overwritten, on UPDATE.
            # `coalesce(users.credentials, '{}') || fresh` (JSONB concat)
            # overlays the fresh Telegram fields on top of the existing blob
            # while preserving keys that are not part of `fresh` -- notably
            # onboarding_completed, which the welcome flow writes via
            # PATCH /users/me. A plain overwrite here would wipe that flag on
            # every login.
            # COALESCE guards the NULL edge case: in PostgreSQL
            # `NULL || x` evaluates to NULL, which would silently drop the
            # whole blob. The column has server_default '{}', so NULL should
            # never occur via the ORM, but a stray direct UPDATE could set it;
            # coalesce(..., '{}') makes the merge resilient regardless.
            # On INSERT (new users) credentials = fresh, with no flag -> the
            # UserResponse schema reads a missing flag as False.
            set_={
                "first_name": telegram_user.get("first_name"),
                "last_name": telegram_user.get("last_name"),
                "avatar_url": photo_url,
                "credentials": func.coalesce(
                    User.credentials, text("'{}'::jsonb")
                ).op("||")(credentials),
                "last_login_at": now,
            },
        )
        .returning(User)
    )

    result = await session.execute(stmt)
    user = result.scalar_one()

    # Phase 6 / T0: project the identity into comms on EVERY login
    # upsert -- creation is the mandatory point (a recipient must
    # exist before any addressing), and re-emitting the idempotent
    # snapshot on returning users self-heals any projection drift for
    # the cost of one outbox row per login. Same transaction (ID-2).
    await emit_user_upserted(session, user)

    logger.info(
        "user_upserted",
        telegram_id=telegram_id,
        user_id=str(user.id),
    )

    return user


# ---------------------------------------------------------------------------
# Session management (Redis)
# ---------------------------------------------------------------------------


async def create_session(user: User) -> str:
    """Create a new session in Redis and return the token.

    Token is a cryptographically random 64-char string.
    Also registers the token in the user's session index (W-06)
    so logout-all can find and invalidate all sessions.

    FIX 2.3: Session index uses Sorted Set (ZSET) with creation
    timestamp as score instead of plain SET. On each login, expired
    tokens are garbage-collected via ZREMRANGEBYSCORE to prevent
    unbounded memory growth.

    CRITICAL-05: All Redis writes (SET + ZADD + ZREMRANGEBYSCORE + EXPIRE)
    are executed in a single MULTI/EXEC pipeline for atomicity.
    Without this, a crash between SET and ZADD could create an
    orphan session not tracked by the index.
    """
    token = secrets.token_urlsafe(48)
    redis = get_redis()
    ttl = _get_session_ttl()
    now = datetime.now(UTC)
    now_ts = now.timestamp()

    session_data = json.dumps(
        {
            "user_id": str(user.id),
            "telegram_id": user.telegram_id,
            "created_at": now.isoformat(),
        }
    )

    session_key = f"{_SESSION_PREFIX}{token}"
    index_key = f"{_USER_SESSIONS_PREFIX}{user.id}"

    # GC cutoff: remove tokens whose creation time is older than TTL.
    # These sessions have expired by Redis TTL but their entries
    # remain in the Sorted Set.
    cutoff = now_ts - ttl

    # CRITICAL-05: MULTI/EXEC pipeline for atomic session creation.
    # All four operations execute as a single atomic unit.
    pipe = redis.pipeline(transaction=True)
    pipe.set(session_key, session_data, ex=ttl)
    pipe.zadd(index_key, {token: now_ts})
    pipe.zremrangebyscore(index_key, "-inf", cutoff)
    pipe.expire(index_key, ttl)
    results = await pipe.execute()

    # results[2] is the count of removed expired tokens from GC.
    removed = results[2]
    if removed:
        logger.debug(
            "session_index_gc",
            user_id=str(user.id),
            removed=removed,
        )

    logger.info("session_created", user_id=str(user.id))
    return token


async def get_session(token: str) -> dict | None:
    """Retrieve session data from Redis by token.

    Returns parsed dict or None if session expired/doesn't exist.
    """
    redis = get_redis()
    data = await redis.get(f"{_SESSION_PREFIX}{token}")
    if data is None:
        return None
    return json.loads(data)


async def delete_session(token: str, user_id: UUID | None = None) -> None:
    """Delete a single session from Redis.

    FIX 2.3: Also removes token from user's Sorted Set index
    if user_id is provided. Prevents stale entries in the index.
    """
    redis = get_redis()
    await redis.delete(f"{_SESSION_PREFIX}{token}")

    # Clean up index entry if we know the user.
    if user_id is not None:
        index_key = f"{_USER_SESSIONS_PREFIX}{user_id}"
        await redis.zrem(index_key, token)

    logger.info("session_deleted")


async def delete_all_sessions(user_id: UUID) -> int:
    """Delete all sessions for a user (W-06: logout-all).

    FIX 2.3: Uses ZRANGE on Sorted Set index to find all tokens,
    then deletes session keys + index atomically via pipeline.

    QW-1 (CORRECTED): The original pipeline(transaction=True) approach
    had a race condition -- ZRANGE ran outside the pipeline, so a
    concurrent create_session could insert a new token between the
    ZRANGE read and the pipeline DELETE, losing that token from the
    index forever.

    Fix: Lua script executes ZRANGE + DEL atomically on the Redis
    server side. Redis is single-threaded in command execution, so
    no other command can interleave between ZRANGE and DEL within
    the Lua script.

    Returns:
        Number of sessions deleted.
    """
    redis = get_redis()
    index_key = f"{_USER_SESSIONS_PREFIX}{user_id}"
    session_prefix = _SESSION_PREFIX

    # Lua script: atomically read all tokens and delete index + sessions.
    # KEYS[1] = index_key (the ZSET)
    # ARGV[1] = session key prefix
    # Returns the number of sessions deleted.
    lua_script = """
local index_key = KEYS[1]
local session_prefix = ARGV[1]
local tokens = redis.call('ZRANGE', index_key, 0, -1)
if #tokens == 0 then
    return 0
end
local keys_to_delete = {index_key}
for _, token in ipairs(tokens) do
    table.insert(keys_to_delete, session_prefix .. token)
end
redis.call('DEL', unpack(keys_to_delete))
return #tokens
"""

    count = await redis.eval(lua_script, 1, index_key, session_prefix)

    if count:
        logger.info(
            "all_sessions_deleted",
            user_id=str(user_id),
            count=count,
        )

    return int(count)
