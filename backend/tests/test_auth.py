# =============================================================================
# Test: Auth Module — Telegram validation, sessions, endpoints
# =============================================================================

import hashlib
import hmac
import json
import time
from collections.abc import AsyncGenerator
from unittest.mock import AsyncMock, MagicMock, call, patch
from urllib.parse import urlencode

import pytest
import structlog
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import AuditLog
from app.core.config import settings
from app.core.exceptions import TooManyRequestsError
from app.core.middleware import (
    _MAX_CLIENT_IP_LEN,
    TraceIdMiddleware,
    _extract_client_ip,
)
from app.core.redis import get_redis
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
            # Named explicitly: pytest labels dict/list params by position
            # (user_json0, user_json1, ...), so a failure named the case
            # without saying which shape broke -- exactly the thing a
            # failure line has to answer.
            pytest.param({"first_name": "NoId"}, id="no-id-key"),
            pytest.param({"id": "12345"}, id="id-is-a-string"),
            pytest.param({"id": None}, id="id-is-null"),
            # bool is an int subclass in Python -- excluded on purpose.
            pytest.param({"id": True}, id="id-is-a-bool"),
            # Valid JSON, but not a user object: these reached .get() and
            # raised AttributeError before T-47 closed it.
            pytest.param([1, 2, 3], id="json-list"),
            pytest.param("text", id="json-string"),
            pytest.param(42, id="json-number"),
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

    Mocks the two Redis consumers in the auth flow, each with a pipeline of
    its own (both use MULTI/EXEC since BE-44):
      1. check_auth_rate_limit   -- pipeline #1: INCR + EXPIRE NX -> [1, True]
      2. create_session          -- pipeline #2: SET/ZADD/ZREM/EXPIRE
    The source limiter does not reach Redis: the test client's 127.0.0.1 is
    not a limitable source.

    BE-44: one shared mock pipeline used to serve both, and its result
    [True, 1, 0, True] would have reached the limiter as count=True -- green
    by an accident of bool being an int. Two pipelines, each with its own
    result, and both asserted executed, so neither consumer is silently
    skipped.
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

        # -- Pipeline mock for check_auth_rate_limit (CRITICAL-4, BE-44) ----
        # count_in_window: INCR + EXPIRE NX in one MULTI/EXEC; count 1 is the
        # first request in the window, below the limit of 5.
        limit_pipe = MagicMock()
        limit_pipe.execute = AsyncMock(return_value=[1, True])

        mock_redis = MagicMock()
        mock_redis.pipeline = MagicMock(side_effect=[limit_pipe, mock_pipe])
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
    # Verify both Redis writers went through MULTI/EXEC: the limiter's
    # counter (BE-44) and the session store (CRITICAL-05). Was "pipeline
    # called once" -- true while the session was the only pipeline user.
    assert mock_redis.pipeline.call_args_list == [
        call(transaction=True),
        call(transaction=True),
    ]
    limit_pipe.execute.assert_awaited_once()
    mock_pipe.set.assert_called_once()
    mock_pipe.execute.assert_awaited_once()


def _with_hash(init_data: str, raw_hash: str) -> str:
    """initData with its hash field replaced by `raw_hash`, verbatim (it may
    carry percent-encoding)."""
    return init_data.rsplit("hash=", 1)[0] + f"hash={raw_hash}"


class TestNonAsciiInitData:
    """BE-44: a non-ASCII hash answers 400 like any bad signature, never
    500. Before, parse_qs decoded hash=%C3%A9 to "é", which reached
    hmac.compare_digest as a non-ASCII str and raised TypeError."""

    @pytest.mark.parametrize(
        "raw_hash",
        [
            pytest.param("%C3%A9", id="percent-encoded-e-acute"),
            pytest.param("%D0%B0" * 64, id="64-cyrillic"),
            pytest.param("%ED%A0%80", id="percent-encoded-surrogate"),
        ],
    )
    def test_non_ascii_hash_is_a_bad_signature(self, raw_hash: str) -> None:
        init_data = _with_hash(build_init_data({"id": 12345}), raw_hash)
        with pytest.raises(TelegramValidationError, match="signature"):
            validate_telegram_init_data(init_data, BOT_TOKEN)

    @pytest.mark.parametrize(
        "raw_hash",
        [
            pytest.param("%C3%A9", id="percent-encoded-e-acute"),
            pytest.param("%D0%B0" * 64, id="64-cyrillic"),
        ],
    )
    async def test_endpoint_answers_400_not_500(
        self, client: AsyncClient, raw_hash: str
    ) -> None:
        """Through the app: the same 400 as any other bad signature."""
        init_data = build_init_data({"id": 77001, "first_name": "AuthTest"})
        with patch.object(settings, "telegram_bot_token", BOT_TOKEN):
            response = await client.post(
                "/api/v1/auth/telegram",
                json={"init_data": _with_hash(init_data, raw_hash)},
            )
        assert response.status_code == 400

    async def test_the_same_request_with_its_real_hash_still_logs_in(
        self, client: AsyncClient
    ) -> None:
        """Pair: the guard rejects the malformed hash, not the request."""
        init_data = build_init_data({"id": 77001, "first_name": "AuthTest"})
        with patch.object(settings, "telegram_bot_token", BOT_TOKEN):
            response = await client.post(
                "/api/v1/auth/telegram", json={"init_data": init_data},
            )
        assert response.status_code == 200


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


def _scope(
    peer: str | None,
    real_ip: str | None = None,
    forwarded: str | None = None,
) -> dict:
    """Minimal ASGI scope: a TCP peer and optionally X-Real-IP / XFF."""
    scope: dict = {
        "client": (peer, 12345) if peer else None,
        "headers": [],
    }
    if real_ip is not None:
        scope["headers"].append((b"x-real-ip", real_ip.encode("latin-1")))
    if forwarded is not None:
        scope["headers"].append(
            (b"x-forwarded-for", forwarded.encode("latin-1"))
        )
    return scope


# A valid IPv6 address that does not fit AuditLog.ip_address: ipaddress
# accepts a scope id of any length, so "is an address" does not bound the
# width. 8 + 100 = 108 characters.
_LONG_SCOPED_IPV6 = "fe80::1%" + "a" * 100


class TestClientIpExtraction:
    """X-Real-IP is honoured only from our own proxy, and only when it is
    really an address that fits the audit column. X-Forwarded-For is never
    read (BE-40)."""

    @pytest.mark.parametrize("peer", ["127.0.0.1", "172.18.0.1", "10.0.0.5"])
    def test_header_honoured_from_proxy_peer(self, peer: str) -> None:
        """Trusted branch: the request came through nginx on the docker
        network, and nginx overwrites X-Real-IP with the address of the
        connection it accepted -- so that is the real client address."""
        assert _extract_client_ip(_scope(peer, "8.8.8.8")) == "8.8.8.8"

    def test_first_hop_of_a_chain_is_ignored(self) -> None:
        """Formerly test_first_hop_taken_from_a_chain, which asserted that
        'client, proxy1, proxy2' in X-Forwarded-For resolved to its first
        hop. It was right about the header's shape -- nginx does send a
        chain there, $proxy_add_x_forwarded_for appends to what arrived --
        and that is exactly what cancelled it (BE-40): the first hop is
        whatever the sender wrote. Now the chain is ignored whole: with
        X-Real-IP present the address is X-Real-IP, without it the peer."""
        chain = "8.8.8.8, 10.0.0.1"
        assert _extract_client_ip(
            _scope("172.18.0.1", "9.9.9.9", forwarded=chain)
        ) == "9.9.9.9"
        assert _extract_client_ip(
            _scope("172.18.0.1", forwarded=chain)
        ) == "172.18.0.1"

    def test_ipv6_real_ip_address(self) -> None:
        scope = _scope("172.18.0.1", "2001:4860:4860::8888")
        assert _extract_client_ip(scope) == "2001:4860:4860::8888"

    def test_header_ignored_from_public_peer(self) -> None:
        """Untrusted branch, the integrity half of finding 2: a request that
        did NOT come through our proxy cannot choose what the audit log
        records. Its own peer address is already the truthful answer."""
        assert _extract_client_ip(_scope("8.8.8.8", "1.1.1.1")) == "8.8.8.8"

    @pytest.mark.parametrize(
        "real_ip",
        [
            # Explicit ids: pytest derives a case name from the VALUE, and
            # these values are hostile to that. The 5000-character one alone
            # produced a 5085-character test id -- every -v line, every CI
            # log and every failure report carried five thousand letter As,
            # burying the tests around it. The empty string produced a
            # nameless "[]" case, and the injection/SQL-shaped ones read as
            # an incident rather than a fixture to anyone scanning a log.
            # The values under test are unchanged; only the labels are.
            pytest.param("not-an-ip", id="not-an-ip"),
            pytest.param("", id="empty"),
            pytest.param("1.2.3.4\nX-Injected: 1", id="header-injection"),
            pytest.param("'; DROP TABLE audit_logs; --", id="sql-shaped"),
            pytest.param("A" * 5000, id="5000-chars"),
            # X-Real-IP is ONE address; nginx never writes a list into it.
            pytest.param("8.8.8.8, 10.0.0.1", id="a-list"),
            pytest.param(" 8.8.8.8", id="padded"),
        ],
    )
    def test_unusable_header_falls_back_to_peer(self, real_ip: str) -> None:
        """A header that is not an address never reaches the audit column --
        the peer is used instead."""
        scope = _scope("172.18.0.1", real_ip)
        assert _extract_client_ip(scope) == "172.18.0.1"

    def test_over_long_header_cannot_exceed_the_column(self) -> None:
        """The availability half of finding 2, and the sharper one.
        AuditLog.ip_address is String(45) and record_audit writes into the
        caller's session with the commit deferred, so an over-long value did
        not spoil one audit row -- it raised on flush and rolled back the
        whole operation, financial ones included. Whatever comes back here
        must always fit the column -- and must be the peer, not nothing.

        The last value is the case the pre-BE-40 test missed: "1" * N is not
        an address, but a long-scoped IPv6 IS one, so it passed the address
        check and only the old 256-character cap stood in front of the
        column. It is rejected before parsing now, not truncated."""
        for value in ("1" * 46, "1" * 100, "1" * 5000, _LONG_SCOPED_IPV6):
            got = _extract_client_ip(_scope("172.18.0.1", value))
            assert got == "172.18.0.1"
            assert len(got) <= 45

    def test_no_header_and_no_client(self) -> None:
        """Nothing to report is reported as nothing, not as a guess."""
        assert _extract_client_ip(_scope("172.18.0.1")) == "172.18.0.1"
        assert _extract_client_ip(_scope(None)) is None

    def test_cap_is_the_audit_column_width(self) -> None:
        """The cap is the column, not a looser bound: if one moves without
        the other, a valid address can again be wider than what stores it.
        Boundary pair: a valid 45-character address is taken, a valid
        46-character one is rejected for the peer."""
        assert AuditLog.__table__.c.ip_address.type.length == _MAX_CLIENT_IP_LEN
        widest_v6 = "ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255"
        assert len(widest_v6) == _MAX_CLIENT_IP_LEN
        assert _extract_client_ip(_scope("172.18.0.1", widest_v6)) == widest_v6
        one_over = "fe80::1%" + "a" * (_MAX_CLIENT_IP_LEN + 1 - 8)
        assert len(one_over) == _MAX_CLIENT_IP_LEN + 1
        assert _extract_client_ip(_scope("172.18.0.1", one_over)) == "172.18.0.1"

    def test_same_request_twice_same_address(self) -> None:
        """REPEAT axis: resolution is a pure function of the scope -- the
        same request resolves to the same address (hence the same limiter
        bucket) every time, and the scope is not modified on the way."""
        scope = _scope("172.18.0.1", "9.9.9.9", forwarded="1.1.1.1")
        before = repr(scope)
        assert _extract_client_ip(scope) == _extract_client_ip(scope) == "9.9.9.9"
        assert repr(scope) == before


# The grid from the BE-40 gate: peer x X-Real-IP x X-Forwarded-For. The
# expected value depends on the first two only; every row is run with all
# three XFF forms, which is the whole of done-when 1 at this layer.
_GRID_PEERS = {
    "loopback-proxy": "127.0.0.1",
    "docker-proxy": "172.18.0.1",
    "public": "8.8.8.8",
    "none": None,
}
_GRID_REAL_IP = {
    "valid-public": "9.9.9.9",
    "valid-private": "10.1.2.3",
    "garbage": "not-an-ip",
    "too-long": _LONG_SCOPED_IPV6,
    "empty": "",
    "absent": None,
}
_GRID_XFF = {
    "no-xff": None,
    "forged": "1.1.1.1",
    "chain": "1.1.1.1, 10.0.0.1",
}


def _grid_expected(peer: str | None, real_ip: str | None) -> str | None:
    trusted = peer in ("127.0.0.1", "172.18.0.1")
    usable = real_ip in ("9.9.9.9", "10.1.2.3")
    return real_ip if trusted and usable else peer


@pytest.mark.parametrize("xff_case", list(_GRID_XFF))
@pytest.mark.parametrize("real_ip_case", list(_GRID_REAL_IP))
@pytest.mark.parametrize("peer_case", list(_GRID_PEERS))
def test_client_ip_grid(peer_case: str, real_ip_case: str, xff_case: str) -> None:
    """Every cell of the gate grid. X-Forwarded-For never changes the
    answer: it is asserted against an expectation that does not take it as
    an input."""
    peer = _GRID_PEERS[peer_case]
    real_ip = _GRID_REAL_IP[real_ip_case]
    scope = _scope(peer, real_ip, forwarded=_GRID_XFF[xff_case])
    assert _extract_client_ip(scope) == _grid_expected(peer, real_ip)


async def test_middleware_binds_real_ip_not_forwarded_for() -> None:
    """The layer the consumers read. record_audit (core/audit.py), the
    pre-HMAC login limiter (auth/router.py) and the guest limiter
    (practices/router.py) all take the address from the structlog binding
    TraceIdMiddleware makes -- so the binding is what is asserted here, not
    the helper. A forged X-Forwarded-For alongside a real X-Real-IP from our
    proxy: the binding is X-Real-IP, and the forged value is nowhere."""
    seen: dict = {}

    async def inner(scope, receive, send) -> None:
        seen.update(structlog.contextvars.get_contextvars())

    async def send(message) -> None:
        pass

    scope = {
        "type": "http",
        **_scope("172.18.0.1", "9.9.9.9", forwarded="1.1.1.1, 10.0.0.1"),
    }
    await TraceIdMiddleware(inner)(scope, None, send)
    assert seen["ip_address"] == "9.9.9.9"
    assert "1.1.1.1" not in repr(seen)


async def test_forged_forwarded_for_does_not_pick_the_login_bucket(
    client: AsyncClient,
) -> None:
    """End to end through the app (done-when 1, limiter half): a login whose
    X-Forwarded-For names another address is counted under X-Real-IP. The
    test client's peer is 127.0.0.1, i.e. a trusted proxy. Pair: the
    X-Real-IP bucket exists AND the forged one does not."""
    redis = get_redis()
    real, forged = "9.9.9.9", "1.0.0.1"
    await redis.delete(f"auth_rate_src:{real}", f"auth_rate_src:{forged}")

    init_data = build_init_data(
        {"id": 77001, "first_name": "AuthTest", "username": "testuser"}
    )
    with patch.object(settings, "telegram_bot_token", BOT_TOKEN):
        response = await client.post(
            "/api/v1/auth/telegram",
            json={"init_data": init_data},
            headers={"X-Real-IP": real, "X-Forwarded-For": forged},
        )
    assert response.status_code == 200

    assert int(await redis.get(f"auth_rate_src:{real}") or 0) >= 1
    assert await redis.exists(f"auth_rate_src:{forged}") == 0


# ---------------------------------------------------------------------------
# T-47 finding 4: the per-source limiter runs before any signature check
# ---------------------------------------------------------------------------


_SOURCE_LIMIT = (
    settings.auth_rate_limit_max_requests * _SOURCE_RATE_LIMIT_MULTIPLIER
)
# Public addresses only these tests key on. The suite's per-test flush
# (conftest flush_auth_redis_keys) covers auth_rate:* but not
# auth_rate_src:*, so the fixture below clears them itself.
_SRC_PROBES = ("8.8.8.8", "2001:4860:4860::8888")


@pytest.fixture
async def src_keys() -> AsyncGenerator[None, None]:
    redis = get_redis()
    keys = [f"auth_rate_src:{a}" for a in _SRC_PROBES]
    await redis.delete(*keys)
    yield
    await redis.delete(*keys)


class TestSourceRateLimit:
    """check_source_rate_limit is keyed on the client address and applies
    before the HMAC verification, so signature guessing costs a counter.

    BE-44: these ran on a MagicMock and asserted which methods were awaited
    (incr, then expire). That was right about the rule -- TTL on the first
    increment -- but it asserted the shape of the old two-command form, and
    that form was the defect: a connection lost between the commands left a
    counter with no TTL. The counter is one MULTI/EXEC now, so the tests run
    on the suite's real Redis (database 15) and assert the RESULT: the key
    and its TTL, not the calls that produced them."""

    @pytest.mark.usefixtures("src_keys")
    async def test_under_limit_passes(self) -> None:
        await check_source_rate_limit("8.8.8.8")
        redis = get_redis()
        assert await redis.get("auth_rate_src:8.8.8.8") == "1"
        # TTL is set on the first increment -- a counter without one would
        # never reset and limit this source for ever.
        ttl = await redis.ttl("auth_rate_src:8.8.8.8")
        assert 0 < ttl <= settings.auth_rate_limit_window_seconds

    @pytest.mark.usefixtures("src_keys")
    async def test_over_limit_raises_429(self) -> None:
        await get_redis().set("auth_rate_src:8.8.8.8", _SOURCE_LIMIT, ex=60)
        with pytest.raises(TooManyRequestsError) as exc:
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
        shared bucket, which would turn a limiter into an outage. Asserted
        by refusing to hand out a Redis client at all: any Redis access, by
        any command form, fails the test (BE-44: asserting on incr alone
        stopped meaning anything once the counter went through a pipeline)."""
        with patch(
            "app.modules.auth.service.get_redis",
            side_effect=AssertionError("Redis was touched"),
        ):
            await check_source_rate_limit(None)

    @pytest.mark.parametrize(
        "source",
        ["127.0.0.1", "::1", "172.18.0.1", "10.0.0.5", "192.168.1.7"],
    )
    async def test_non_routable_source_is_not_limited(
        self, source: str
    ) -> None:
        """REGRESSION, and the reason this test exists at all: the first
        version of this limiter keyed on every address, so the whole backend
        suite -- 644 logins, all from 127.0.0.1, far above the ceiling --
        landed in ONE counter and went red from the hundredth login on.

        A loopback or private address is not a remote attacker; it is our own
        infrastructure showing through (the test client, a health check, or
        the nginx peer used as fallback when no usable X-Real-IP was present).
        Keying on it bounds nobody and shares one counter between everybody
        it cannot tell apart. The address must be rejected BEFORE the
        counter, not merely forgiven after it -- so Redis may not be reached
        at all (same refusal as test_missing_source_is_not_limited)."""
        with patch(
            "app.modules.auth.service.get_redis",
            side_effect=AssertionError("Redis was touched"),
        ):
            await check_source_rate_limit(source)

    @pytest.mark.usefixtures("src_keys")
    @pytest.mark.parametrize("source", _SRC_PROBES)
    async def test_routable_source_is_still_limited(
        self, source: str
    ) -> None:
        """The other half of the same rule: a real remote client, v4 or v6,
        is still counted. The exemption above must not have turned the
        limiter off for the traffic it exists to bound. Pair: the hit was
        counted on that address's own key."""
        await get_redis().set(f"auth_rate_src:{source}", _SOURCE_LIMIT, ex=60)
        with pytest.raises(TooManyRequestsError):
            await check_source_rate_limit(source)
        assert await get_redis().get(f"auth_rate_src:{source}") == str(
            _SOURCE_LIMIT + 1
        )
