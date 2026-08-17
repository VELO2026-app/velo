# =============================================================================
# Test: Auth Module — Telegram validation, sessions, endpoints
# =============================================================================

import hashlib
import hmac
import json
import time
from unittest.mock import AsyncMock, MagicMock, patch
from urllib.parse import urlencode

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import TooManyRequestsError
from app.core.middleware import _extract_client_ip
from app.modules.auth.service import (
    _SOURCE_RATE_LIMIT_MULTIPLIER,
    TelegramValidationError,
    check_source_rate_limit,
    validate_telegram_init_data,
)
from app.modules.users.models import User
from tests.helpers import BOT_TOKEN, auth_headers, build_init_data, login_user

# ---------------------------------------------------------------------------
# validate_telegram_init_data
# ---------------------------------------------------------------------------


class TestValidateTelegramInitData:
    """Tests for HMAC validation of Telegram initData."""

    def test_valid_data(self) -> None:
        """Correctly signed initData passes validation."""
        user_data = {"id": 12345, "first_name": "Test"}
        init_data = build_init_data(user_data)
        result = validate_telegram_init_data(init_data, BOT_TOKEN)
        assert result["id"] == 12345

    def test_missing_hash(self) -> None:
        """initData without hash → error."""
        with pytest.raises(TelegramValidationError, match="Missing hash"):
            validate_telegram_init_data("user=%7B%7D&auth_date=123", BOT_TOKEN)

    def test_invalid_hash(self) -> None:
        """Tampered hash → error."""
        user_data = {"id": 12345, "first_name": "Test"}
        init_data = build_init_data(user_data)
        # Replace hash with garbage.
        tampered = init_data.rsplit("hash=", 1)[0] + "hash=deadbeef"
        with pytest.raises(TelegramValidationError, match="Invalid initData signature"):
            validate_telegram_init_data(tampered, BOT_TOKEN)

    def test_wrong_bot_token(self) -> None:
        """Different bot token → signature mismatch."""
        user_data = {"id": 12345, "first_name": "Test"}
        init_data = build_init_data(user_data, bot_token=BOT_TOKEN)
        with pytest.raises(TelegramValidationError, match="Invalid initData signature"):
            validate_telegram_init_data(init_data, "999999:WRONG-TOKEN")

    def test_expired_data(self) -> None:
        """auth_date older than 5 minutes → error."""
        user_data = {"id": 12345, "first_name": "Test"}
        old_date = int(time.time()) - 600  # 10 minutes ago
        init_data = build_init_data(user_data, auth_date=old_date)
        with pytest.raises(TelegramValidationError, match="expired"):
            validate_telegram_init_data(init_data, BOT_TOKEN)

    def test_missing_auth_date(self) -> None:
        """initData without auth_date → error."""
        # Build manually without auth_date.
        params = {"user": json.dumps({"id": 1})}
        data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(params.items()))
        secret_key = hmac.new(
            b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256
        ).digest()
        h = hmac.new(
            secret_key, data_check_string.encode(), hashlib.sha256
        ).hexdigest()
        params["hash"] = h
        init_data = urlencode(params)
        with pytest.raises(TelegramValidationError, match="Missing auth_date"):
            validate_telegram_init_data(init_data, BOT_TOKEN)

    def test_missing_user(self) -> None:
        """initData without user field → error."""
        params = {"auth_date": str(int(time.time()))}
        data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(params.items()))
        secret_key = hmac.new(
            b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256
        ).digest()
        h = hmac.new(
            secret_key, data_check_string.encode(), hashlib.sha256
        ).hexdigest()
        params["hash"] = h
        init_data = urlencode(params)
        with pytest.raises(TelegramValidationError, match="Missing user"):
            validate_telegram_init_data(init_data, BOT_TOKEN)

    # -- T-47: the signed value and the parsed value are one value ---------
    #
    # These describe a CLASS of input, deliberately not a working exploit:
    # the point is that the string whose HMAC we verified is the string we
    # hand to json.loads, with no second decoding pass in between. A value
    # that would MEAN SOMETHING ELSE after another decode is the shape of
    # the class; the marker below is the cheapest member of it.

    def test_parsed_value_is_the_signed_value(self) -> None:
        """A signed value that a second decoding pass would alter is parsed
        exactly as signed.

        The marker is a percent-escape sequence inside a signed string
        field: decoding is not idempotent, so a second pass would turn it
        into different characters. If the value coming back still carries
        the marker verbatim, then nothing re-decoded it after the signature
        check -- which is the property under test. If it comes back
        transformed, some later reader is parsing something Telegram never
        signed."""
        marker = "%41%42"
        user_data = {"id": 12345, "first_name": marker}
        init_data = build_init_data(user_data)
        result = validate_telegram_init_data(init_data, BOT_TOKEN)
        assert result["first_name"] == marker

    def test_signed_value_with_reserved_characters_survives(self) -> None:
        """The same property for characters that are meaningful to a URL
        parser (&, =, +). These are the ones a decoding pass is most likely
        to mangle, and a real Telegram display name can contain them."""
        user_data = {"id": 12345, "first_name": "A&B=C+D"}
        init_data = build_init_data(user_data)
        result = validate_telegram_init_data(init_data, BOT_TOKEN)
        assert result["first_name"] == "A&B=C+D"

    def test_repeat_same_init_data_twice(self) -> None:
        """REPEAT axis: validation is pure -- the same initData validated
        twice gives the same answer. Pinned because anti-replay lived here
        once (see the note in service.py) and could be reintroduced without
        noticing that it breaks the legitimate logout -> re-login flow."""
        user_data = {"id": 12345, "first_name": "Test"}
        init_data = build_init_data(user_data)
        first = validate_telegram_init_data(init_data, BOT_TOKEN)
        second = validate_telegram_init_data(init_data, BOT_TOKEN)
        assert first == second

    def test_empty_user_value(self) -> None:
        """EMPTY axis: a signed but empty user value is rejected cleanly --
        a TelegramValidationError, not a JSONDecodeError escaping as a
        500."""
        params = {"auth_date": str(int(time.time())), "user": ""}
        data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(params.items()))
        secret_key = hmac.new(
            b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256
        ).digest()
        params["hash"] = hmac.new(
            secret_key, data_check_string.encode(), hashlib.sha256
        ).hexdigest()
        with pytest.raises(TelegramValidationError):
            validate_telegram_init_data(urlencode(params), BOT_TOKEN)

    @pytest.mark.parametrize(
        "user_json",
        [
            {"first_name": "NoId"},   # MISSING axis: no id at all
            {"id": "12345"},          # id present but not an integer
            {"id": None},
            {"id": True},             # bool is an int subclass in Python
            [1, 2, 3],                # valid JSON, not a user object
            "text",
            42,
        ],
    )
    def test_user_json_without_usable_id(self, user_json: object) -> None:
        """MISSING axis, and a defect T-47 closed while writing it: signed
        initData whose user field carries no usable integer id used to pass
        validation, and the caller's telegram_user["id"] then raised --
        KeyError for a dict without id, AttributeError for JSON that is not
        an object at all. Both surfaced as a 500 on external input. Every
        shape here must now be a clean TelegramValidationError."""
        init_data = build_init_data(user_json)
        with pytest.raises(TelegramValidationError):
            validate_telegram_init_data(init_data, BOT_TOKEN)

    def test_future_auth_date_still_rejected(self) -> None:
        """Pre-existing guard, re-pinned here because T-47 edited this
        function: an auth_date in the future must not pass just because it
        is not 'expired'."""
        future = int(time.time()) + 86400
        init_data = build_init_data({"id": 12345}, auth_date=future)
        with pytest.raises(TelegramValidationError):
            validate_telegram_init_data(init_data, BOT_TOKEN)


# ---------------------------------------------------------------------------
# POST /api/v1/auth/telegram
# ---------------------------------------------------------------------------


async def test_auth_telegram_success_mocked_redis(client: AsyncClient) -> None:
    """Full auth flow with mocked Redis (unit-test style).

    Mocks the two Redis consumers in the auth flow:
      1. check_auth_rate_limit   — redis.incr()        → AsyncMock → 1
                                   redis.expire()      → AsyncMock → True
      2. create_session          — redis.pipeline()    → mock_pipe (MULTI/EXEC)
    """
    user_data = {"id": 99999, "first_name": "Tester", "username": "tester"}
    init_data = build_init_data(user_data)

    with (
        patch("app.modules.auth.router.settings") as mock_settings,
        patch("app.modules.auth.service.get_redis") as mock_get_redis,
    ):
        mock_settings.telegram_bot_token = BOT_TOKEN

        # -- Pipeline mock for create_session (CRITICAL-05) ----------------
        # redis.pipeline() is a SYNC call returning a Pipeline object.
        # Pipeline methods (.set, .zadd, etc.) are also sync (they queue).
        # Only .execute() is async (sends MULTI/EXEC to Redis).
        mock_pipe = MagicMock()
        mock_pipe.set = MagicMock(return_value=mock_pipe)
        mock_pipe.zadd = MagicMock(return_value=mock_pipe)
        mock_pipe.zremrangebyscore = MagicMock(return_value=mock_pipe)
        mock_pipe.expire = MagicMock(return_value=mock_pipe)
        # execute() returns list of results; [2] is zremrangebyscore count.
        mock_pipe.execute = AsyncMock(return_value=[True, 1, 0, True])

        # -- Direct Redis mock for check_auth_rate_limit -------------------
        # CRITICAL-4: check_auth_rate_limit calls redis.incr(key) and redis.expire(key, 60).
        #   incr returns 1 (first request in window, below rate limit of 5).
        mock_redis = MagicMock()
        mock_redis.incr = AsyncMock(return_value=1)
        mock_redis.expire = AsyncMock(return_value=True)
        mock_redis.pipeline = MagicMock(return_value=mock_pipe)
        mock_get_redis.return_value = mock_redis

        response = await client.post(
            "/api/v1/auth/telegram",
            json={"init_data": init_data},
        )

    assert response.status_code == 200
    data = response.json()
    assert "session_token" in data
    assert data["user"]["telegram_id"] == 99999
    assert data["user"]["first_name"] == "Tester"
    # Verify pipeline was used to store session atomically.
    mock_redis.pipeline.assert_called_once_with(transaction=True)
    mock_pipe.set.assert_called_once()
    mock_pipe.execute.assert_awaited_once()


async def test_auth_telegram_invalid_data(client: AsyncClient) -> None:
    """Invalid initData → 400."""
    response = await client.post(
        "/api/v1/auth/telegram",
        json={"init_data": "garbage=data&hash=fake"},
    )
    assert response.status_code == 400


# ---------------------------------------------------------------------------
# POST /api/v1/auth/logout (TD-020)
# ---------------------------------------------------------------------------


async def test_logout_success(client: AsyncClient) -> None:
    """Logout deletes session; same token becomes invalid afterward."""
    data = await login_user(client, telegram_id=77001, first_name="AuthTest")
    token = data["session_token"]

    response = await client.post(
        "/api/v1/auth/logout",
        headers=auth_headers(token),
    )
    assert response.status_code == 204

    # Same token should now be rejected (session deleted from Redis).
    response = await client.post(
        "/api/v1/auth/logout",
        headers=auth_headers(token),
    )
    assert response.status_code == 401


async def test_logout_no_token(client: AsyncClient) -> None:
    """Logout without Authorization header → 401."""
    response = await client.post("/api/v1/auth/logout")
    assert response.status_code == 401


async def test_logout_invalid_token(client: AsyncClient) -> None:
    """Logout with garbage token → 401 (session not found in Redis)."""
    response = await client.post(
        "/api/v1/auth/logout",
        headers=auth_headers("garbage-token-that-does-not-exist"),
    )
    assert response.status_code == 401


async def test_logout_inactive_user(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Deactivated user cannot access protected endpoints → 403."""
    data = await login_user(client, telegram_id=77002, first_name="Inactive")
    token = data["session_token"]
    user_id = data["user"]["id"]

    # Deactivate user directly in DB.
    stmt = update(User).where(User.id == user_id).values(is_active=False)
    await db_session.execute(stmt)
    await db_session.commit()

    # Token is valid in Redis, but user is inactive → 403.
    response = await client.post(
        "/api/v1/auth/logout",
        headers=auth_headers(token),
    )
    assert response.status_code == 403


# ---------------------------------------------------------------------------
# POST /api/v1/auth/logout-all (W-06)
# ---------------------------------------------------------------------------


async def test_logout_all_invalidates_all_sessions(
    client: AsyncClient,
) -> None:
    """logout-all invalidates every session for the user."""
    # Create two sessions for the same user.
    data1 = await login_user(client, telegram_id=77010, first_name="Multi")
    data2 = await login_user(client, telegram_id=77010, first_name="Multi")
    token1 = data1["session_token"]
    token2 = data2["session_token"]

    # Both tokens work.
    r1 = await client.get("/api/v1/users/me", headers=auth_headers(token1))
    r2 = await client.get("/api/v1/users/me", headers=auth_headers(token2))
    assert r1.status_code == 200
    assert r2.status_code == 200

    # Logout-all using token1.
    response = await client.post(
        "/api/v1/auth/logout-all",
        headers=auth_headers(token1),
    )
    assert response.status_code == 204

    # Both tokens should now be invalid.
    r1 = await client.get("/api/v1/users/me", headers=auth_headers(token1))
    r2 = await client.get("/api/v1/users/me", headers=auth_headers(token2))
    assert r1.status_code == 401
    assert r2.status_code == 401


async def test_logout_all_other_user_unaffected(
    client: AsyncClient,
) -> None:
    """logout-all for user A does not affect user B."""
    data_a = await login_user(client, telegram_id=77020, first_name="UserA")
    data_b = await login_user(client, telegram_id=77021, first_name="UserB")
    token_a = data_a["session_token"]
    token_b = data_b["session_token"]

    # Logout-all for user A.
    response = await client.post(
        "/api/v1/auth/logout-all",
        headers=auth_headers(token_a),
    )
    assert response.status_code == 204

    # User A is logged out.
    r_a = await client.get("/api/v1/users/me", headers=auth_headers(token_a))
    assert r_a.status_code == 401

    # User B is unaffected.
    r_b = await client.get("/api/v1/users/me", headers=auth_headers(token_b))
    assert r_b.status_code == 200


# ---------------------------------------------------------------------------
# T-47 finding 2: the audited client IP is the one nginx reported
# ---------------------------------------------------------------------------
#
# Pure-function tests against the middleware helper. No users, no band: the
# helper takes an ASGI scope and returns a string, and driving it directly
# covers both branches far more precisely than a request could.


def _scope(peer: str | None, forwarded: str | None = None) -> dict:
    """Minimal ASGI scope: a TCP peer and optionally an XFF header."""
    scope: dict = {
        "client": (peer, 12345) if peer else None,
        "headers": [],
    }
    if forwarded is not None:
        scope["headers"].append(
            (b"x-forwarded-for", forwarded.encode("latin-1"))
        )
    return scope


class TestClientIpExtraction:
    """X-Forwarded-For is honoured only from our own proxy, and only when
    it is really an address."""

    @pytest.mark.parametrize("peer", ["127.0.0.1", "172.18.0.1", "10.0.0.5"])
    def test_header_honoured_from_proxy_peer(self, peer: str) -> None:
        """Trusted branch: the request came through nginx on the docker
        network, so the forwarded client address is the real one."""
        assert _extract_client_ip(_scope(peer, "8.8.8.8")) == "8.8.8.8"

    def test_first_hop_taken_from_a_chain(self) -> None:
        """X-Forwarded-For may be 'client, proxy1, proxy2'."""
        scope = _scope("172.18.0.1", "8.8.8.8, 10.0.0.1")
        assert _extract_client_ip(scope) == "8.8.8.8"

    def test_ipv6_forwarded_address(self) -> None:
        scope = _scope("172.18.0.1", "2001:4860:4860::8888")
        assert _extract_client_ip(scope) == "2001:4860:4860::8888"

    def test_header_ignored_from_public_peer(self) -> None:
        """Untrusted branch, the integrity half of finding 2: a request that
        did NOT come through our proxy cannot choose what the audit log
        records. Its own peer address is already the truthful answer."""
        assert _extract_client_ip(_scope("8.8.8.8", "1.1.1.1")) == "8.8.8.8"

    @pytest.mark.parametrize(
        "forwarded",
        [
            "not-an-ip",
            "",
            "1.2.3.4\nX-Injected: 1",
            "'; DROP TABLE audit_logs; --",
            "A" * 5000,
        ],
    )
    def test_unusable_header_falls_back_to_peer(self, forwarded: str) -> None:
        """A header that is not an address never reaches the audit column --
        the peer is used instead."""
        scope = _scope("172.18.0.1", forwarded)
        assert _extract_client_ip(scope) == "172.18.0.1"

    def test_over_long_header_cannot_exceed_the_column(self) -> None:
        """The availability half of finding 2, and the sharper one.
        AuditLog.ip_address is String(45) and record_audit writes into the
        caller's session with the commit deferred, so an over-long value did
        not spoil one audit row -- it raised on flush and rolled back the
        whole operation, financial ones included. Whatever comes back here
        must always fit the column."""
        for length in (46, 100, 5000):
            got = _extract_client_ip(_scope("172.18.0.1", "1" * length))
            assert got is not None
            assert len(got) <= 45

    def test_no_header_and_no_client(self) -> None:
        """Nothing to report is reported as nothing, not as a guess."""
        assert _extract_client_ip(_scope("172.18.0.1")) == "172.18.0.1"
        assert _extract_client_ip(_scope(None)) is None


# ---------------------------------------------------------------------------
# T-47 finding 4: the per-source limiter runs before any signature check
# ---------------------------------------------------------------------------


class TestSourceRateLimit:
    """check_source_rate_limit is keyed on the client address and applies
    before the HMAC verification, so signature guessing costs a counter."""

    async def test_under_limit_passes(self) -> None:
        redis = MagicMock()
        redis.incr = AsyncMock(return_value=1)
        redis.expire = AsyncMock()
        with patch(
            "app.modules.auth.service.get_redis", return_value=redis
        ):
            await check_source_rate_limit("8.8.8.8")
        # TTL is set on the first increment only -- otherwise every request
        # slides the window and the limit never fires.
        redis.expire.assert_awaited_once()

    async def test_over_limit_raises_429(self) -> None:
        limit = (
            settings.auth_rate_limit_max_requests
            * _SOURCE_RATE_LIMIT_MULTIPLIER
        )
        redis = MagicMock()
        redis.incr = AsyncMock(return_value=limit + 1)
        redis.expire = AsyncMock()
        with patch(
            "app.modules.auth.service.get_redis", return_value=redis
        ), pytest.raises(TooManyRequestsError) as exc:
            await check_source_rate_limit("8.8.8.8")
        # 429, not 400: nothing was wrong with the request except its rate,
        # and 429 is the only code a client knows how to back off on.
        assert exc.value.status_code == 429

    async def test_limit_is_looser_than_the_per_account_one(self) -> None:
        """NAT is the reason. One address can be an entire mobile carrier's
        worth of legitimate people opening the Mini App, so this limit must
        sit well above the per-telegram_id one rather than replace it."""
        assert _SOURCE_RATE_LIMIT_MULTIPLIER > 1

    async def test_missing_source_is_not_limited(self) -> None:
        """No address to key on: skipped rather than funnelled into one
        shared bucket, which would turn a limiter into an outage."""
        redis = MagicMock()
        redis.incr = AsyncMock()
        with patch(
            "app.modules.auth.service.get_redis", return_value=redis
        ):
            await check_source_rate_limit(None)
        redis.incr.assert_not_awaited()
