# =============================================================================
# Browser sign-in through Telegram (Standalone phase 3)
# =============================================================================
#
# POST /api/v1/auth/telegram/browser/start and /complete
# (app/modules/auth/browser_login.py, app/modules/auth/router.py).
#
# Telegram is the in-memory OpenID provider of test_mcp_oauth.py (imported,
# not copied): a code is "tg-<telegram id>", and every request it receives is
# kept -- "zero requests to Telegram" is checked on that list.
#
# telegram_id band: 74100-74149.
# =============================================================================

import asyncio
import hashlib
import json
from collections.abc import AsyncGenerator
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from httpx import AsyncClient
from redis.exceptions import RedisError
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_engine
from app.core.redis import get_redis
from app.modules.auth import browser_login, telegram_oidc
from app.modules.users.models import User
from tests.helpers import auth_headers, full_cleanup_range, login_user
from tests.test_mcp_oauth import _DROP, TG_CLIENT_ID, TG_SECRET, FakeTelegram

_TID_MIN = 74100
_TID_MAX = 74149

FRONT = "https://app.velo.test"
RETURN = f"{FRONT}/auth/telegram/return"
START = "/api/v1/auth/telegram/browser/start"
COMPLETE = "/api/v1/auth/telegram/browser/complete"

# A mark as the frontend makes it: 43 base64url characters.
MARK = "m" * 43
OTHER_MARK = "o" * 43


@pytest.fixture
def telegram(monkeypatch: pytest.MonkeyPatch) -> FakeTelegram:
    fake = FakeTelegram()
    monkeypatch.setattr(
        telegram_oidc,
        "_client",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(fake.handler)),
    )
    return fake


@pytest.fixture(autouse=True)
def configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "cors_origins", FRONT)
    monkeypatch.setattr(settings, "telegram_login_client_id", TG_CLIENT_ID)
    monkeypatch.setattr(settings, "telegram_login_client_secret", TG_SECRET)


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    async def clean() -> None:
        await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
        await db_session.commit()
        redis = get_redis()
        async for key in redis.scan_iter(match="auth:browser_login:*"):
            await redis.delete(key)
        for tid in range(_TID_MIN, _TID_MAX + 1):
            await redis.delete(f"auth_rate:{tid}")

    await clean()
    yield
    await clean()


async def _start(client: AsyncClient, mark: str = MARK) -> dict:
    resp = await client.post(START, json={"mark": mark})
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _complete(
    client: AsyncClient,
    state: str,
    tid: int,
    mark: str = MARK,
    language: str | None = None,
) -> httpx.Response:
    body = {"code": f"tg-{tid}", "state": state, "mark": mark}
    if language is not None:
        body["language"] = language
    return await client.post(COMPLETE, json=body)


async def _user(db_session: AsyncSession, tid: int) -> User | None:
    db_session.expire_all()
    return (
        await db_session.execute(select(User).where(User.telegram_id == tid))
    ).scalar_one_or_none()


# ---------------------------------------------------------------------------
# The return address: the ONE https origin in CORS_ORIGINS
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("cors", "expected"),
    [
        (FRONT, RETURN),
        (f"{FRONT}, ", RETURN),  # an empty entry is not an address
        (
            "https://app.velo.test:8443",
            "https://app.velo.test:8443/auth/telegram/return",
        ),
        ("", None),  # emptiness
        ("https://a.velo.test,https://b.velo.test", None),  # two addresses
        ("http://app.velo.test", None),  # not https
        ("*", None),  # the development wildcard
        (f"{FRONT}/", None),  # a path -- not an origin
        (f"{FRONT}?x=1", None),
        ("https://user:pw@app.velo.test", None),
    ],
)
def test_the_return_address_is_the_single_https_origin(
    monkeypatch: pytest.MonkeyPatch, cors: str, expected: str | None
) -> None:
    monkeypatch.setattr(settings, "cors_origins", cors)
    assert browser_login.return_url() == expected


@pytest.mark.parametrize(
    "cors",
    ["", "https://a.velo.test,https://b.velo.test", "http://app.velo.test"],
    ids=["empty", "two-addresses", "http"],
)
async def test_not_exactly_one_https_origin_is_not_configured(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    telegram: FakeTelegram,
    cors: str,
) -> None:
    started = await _start(client)  # while configured
    monkeypatch.setattr(settings, "cors_origins", cors)

    start = await client.post(START, json={"mark": MARK})
    assert start.status_code == 404
    assert start.json()["error"] == "login_not_configured"

    complete = await _complete(client, started["state"], 74100)
    assert complete.status_code == 404
    assert complete.json()["error"] == "login_not_configured"

    # The 404 took nothing: configured again, the sign-in still completes.
    monkeypatch.setattr(settings, "cors_origins", FRONT)
    ok = await _complete(client, started["state"], 74100)
    assert ok.status_code == 200, ok.text


async def test_no_telegram_login_keys_is_not_configured(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "telegram_login_client_secret", "")
    resp = await client.post(START, json={"mark": MARK})
    assert resp.status_code == 404
    assert resp.json()["error"] == "login_not_configured"


# ---------------------------------------------------------------------------
# start
# ---------------------------------------------------------------------------


async def test_start_hands_out_telegram_url_with_our_return_and_bot_access(
    client: AsyncClient,
) -> None:
    started = await _start(client)
    url = urlsplit(started["url"])
    query = parse_qs(url.query)

    assert f"{url.scheme}://{url.netloc}" == telegram_oidc.ISSUER
    assert query["redirect_uri"] == [RETURN]
    assert query["state"] == [started["state"]]
    assert telegram_oidc.BOT_ACCESS_SCOPE in query["scope"][0].split()


async def test_redis_keeps_the_mark_hash_never_the_mark(client: AsyncClient) -> None:
    started = await _start(client)
    key = "auth:browser_login:" + hashlib.sha256(started["state"].encode()).hexdigest()
    raw = await get_redis().get(key)
    assert raw is not None
    assert MARK not in raw
    stored = json.loads(raw)
    assert stored["mark_hash"] == hashlib.sha256(MARK.encode()).hexdigest()
    assert stored["redirect_uri"] == RETURN
    # Not kept forever.
    assert 0 < await get_redis().ttl(key) <= browser_login.LOGIN_TTL_SECONDS


@pytest.mark.parametrize(
    "mark",
    ["", "short", "x" * 129, "m" * 42 + "!"],
    ids=["empty", "too-short", "too-long", "bad-alphabet"],
)
async def test_start_refuses_a_malformed_mark(client: AsyncClient, mark: str) -> None:
    resp = await client.post(START, json={"mark": mark})
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# complete -- the happy paths
# ---------------------------------------------------------------------------


async def test_first_sign_in_creates_the_account_and_a_working_session(
    client: AsyncClient, db_session: AsyncSession, telegram: FakeTelegram
) -> None:
    started = await _start(client)
    resp = await _complete(client, started["state"], 74101, language="ru-RU")
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["user"]["telegram_id"] == 74101
    assert body["bot_access_granted"] is True  # no `scope` in the answer
    user = await _user(db_session, 74101)
    assert user is not None
    assert user.language == "ru"

    me = await client.get(
        "/api/v1/users/me", headers=auth_headers(body["session_token"])
    )
    assert me.status_code == 200
    assert me.json()["id"] == str(user.id)


async def test_the_same_account_as_the_mini_app(
    client: AsyncClient, db_session: AsyncSession, telegram: FakeTelegram
) -> None:
    mini_app = await login_user(client, 74102)
    started = await _start(client)
    resp = await _complete(client, started["state"], 74102)
    assert resp.status_code == 200, resp.text
    assert resp.json()["user"]["id"] == mini_app["user"]["id"]


async def test_bot_access_not_granted_still_signs_in(
    client: AsyncClient, telegram: FakeTelegram
) -> None:
    telegram.token_scope = "openid profile"
    started = await _start(client)
    resp = await _complete(client, started["state"], 74103)
    assert resp.status_code == 200
    assert resp.json()["bot_access_granted"] is False


# ---------------------------------------------------------------------------
# The state: one-time
# ---------------------------------------------------------------------------


async def test_a_state_is_taken_once(
    client: AsyncClient, telegram: FakeTelegram
) -> None:
    started = await _start(client)
    first = await _complete(client, started["state"], 74104)
    assert first.status_code == 200

    again = await _complete(client, started["state"], 74104)
    assert again.status_code == 400
    assert again.json()["error"] == "login_expired"


async def test_two_completions_of_one_state_at_once_one_wins(
    client: AsyncClient, telegram: FakeTelegram
) -> None:
    started = await _start(client)
    results = await asyncio.gather(
        _complete(client, started["state"], 74105),
        _complete(client, started["state"], 74105),
    )
    assert sorted(r.status_code for r in results) == [200, 400]


async def test_an_unknown_state_asks_telegram_nothing(
    client: AsyncClient, telegram: FakeTelegram
) -> None:
    resp = await _complete(client, "never-issued-state", 74106)
    assert resp.status_code == 400
    assert resp.json()["error"] == "login_expired"
    assert telegram.requests == []


@pytest.mark.parametrize(
    "body",
    [
        {"code": "", "state": "S", "mark": MARK},
        {"state": "S", "mark": MARK},
        {"code": "tg-1", "state": "", "mark": MARK},
        {"code": "tg-1", "state": "S", "mark": ""},
        {"code": "tg-1", "state": "S", "mark": MARK, "language": "x" * 36},
    ],
    ids=["empty-code", "no-code", "empty-state", "empty-mark", "language-too-long"],
)
async def test_a_malformed_return_is_refused_before_the_state_is_taken(
    client: AsyncClient, telegram: FakeTelegram, body: dict
) -> None:
    started = await _start(client)
    body = dict(body)
    if body.get("state") == "S":
        body["state"] = started["state"]
    resp = await client.post(COMPLETE, json=body)
    assert resp.status_code == 422

    # The state survived the refusal.
    ok = await _complete(client, started["state"], 74107)
    assert ok.status_code == 200, ok.text


# ---------------------------------------------------------------------------
# The mark: login CSRF
# ---------------------------------------------------------------------------


async def test_a_return_in_another_browser_never_reaches_telegram(
    client: AsyncClient, db_session: AsyncSession, telegram: FakeTelegram
) -> None:
    """The attacker's own sign-in, stopped at the return, opened by a victim:
    the victim's browser holds a different mark. Refused before the code is
    exchanged -- zero requests to Telegram, no account, no session."""
    started = await _start(client, mark=MARK)
    resp = await _complete(client, started["state"], 74108, mark=OTHER_MARK)

    assert resp.status_code == 400
    assert resp.json()["error"] == "login_foreign"
    assert telegram.requests == []
    assert await _user(db_session, 74108) is None

    # And the state is spent: the attacker cannot replay it either.
    replay = await _complete(client, started["state"], 74108, mark=MARK)
    assert replay.json()["error"] == "login_expired"


# ---------------------------------------------------------------------------
# Telegram's answer
# ---------------------------------------------------------------------------


async def test_telegram_refusing_the_code_is_a_failed_sign_in(
    client: AsyncClient, db_session: AsyncSession, telegram: FakeTelegram
) -> None:
    telegram.token_status = 400
    started = await _start(client)
    resp = await _complete(client, started["state"], 74109)
    assert resp.status_code == 400
    assert resp.json()["error"] == "telegram_failed"
    assert await _user(db_session, 74109) is None


async def test_no_database_connection_is_held_while_telegram_is_asked(
    client: AsyncClient, telegram: FakeTelegram
) -> None:
    """par0 §8: the two HTTP requests to Telegram run before the endpoint's
    first SQL statement, so the request holds no pooled connection then."""
    pool = get_engine().sync_engine.pool
    seen: list[int] = []
    handler = telegram.handler

    def watching(request: httpx.Request) -> httpx.Response:
        seen.append(pool.checkedout())
        return handler(request)

    telegram.handler = watching  # type: ignore[method-assign]
    started = await _start(client)
    baseline = pool.checkedout()
    resp = await _complete(client, started["state"], 74110)
    assert resp.status_code == 200, resp.text
    assert seen  # Telegram was asked
    assert all(n == baseline for n in seen), (baseline, seen)


# ---------------------------------------------------------------------------
# The account
# ---------------------------------------------------------------------------


async def test_a_deactivated_account_gets_no_session_and_no_profile_write(
    client: AsyncClient, db_session: AsyncSession, telegram: FakeTelegram
) -> None:
    await login_user(client, 74111, first_name="Before")
    await db_session.execute(
        update(User).where(User.telegram_id == 74111).values(is_active=False)
    )
    await db_session.commit()
    user = await _user(db_session, 74111)
    assert user is not None
    sessions_before = await get_redis().zcard(f"user_sessions:{user.id}")

    started = await _start(client)
    resp = await _complete(client, started["state"], 74111)

    assert resp.status_code == 403
    assert resp.json()["error"] == "account_deactivated"
    assert await get_redis().zcard(f"user_sessions:{user.id}") == sessions_before
    # The upsert ("Ученик" from the id_token) was rolled back with the request.
    user = await _user(db_session, 74111)
    assert user is not None
    assert user.first_name == "Before"


async def test_absent_claims_are_written_as_null_like_initdata(
    client: AsyncClient, db_session: AsyncSession, telegram: FakeTelegram
) -> None:
    """The same rule as a field initData leaves out: the upsert writes None."""
    await login_user(client, 74112, first_name="Old", username="old_nick")
    telegram.claims = {
        "given_name": "New",
        "family_name": _DROP,
        "preferred_username": _DROP,
        "picture": _DROP,
    }
    started = await _start(client)
    resp = await _complete(client, started["state"], 74112)
    assert resp.status_code == 200

    user = await _user(db_session, 74112)
    assert user is not None
    assert user.first_name == "New"
    assert user.last_name is None
    assert user.avatar_url is None
    assert (user.credentials or {}).get("telegram_username") is None


async def test_name_claim_stands_in_for_a_missing_given_name(
    client: AsyncClient, db_session: AsyncSession, telegram: FakeTelegram
) -> None:
    telegram.claims = {"given_name": _DROP, "name": "Only Name"}
    started = await _start(client)
    resp = await _complete(client, started["state"], 74113)
    assert resp.status_code == 200
    user = await _user(db_session, 74113)
    assert user is not None
    assert user.first_name == "Only Name"


@pytest.mark.parametrize(
    ("language", "expected"),
    [(None, "en"), ("xx-YY", "en"), ("de-AT", "de"), ("ES", "es"), ("<b>ru</b>", "en")],
    ids=["absent", "unsupported", "regional", "upper-case", "markup"],
)
async def test_the_browser_language_is_normalized_on_insert(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram: FakeTelegram,
    language: str | None,
    expected: str,
) -> None:
    started = await _start(client)
    resp = await _complete(client, started["state"], 74114, language=language)
    assert resp.status_code == 200, resp.text
    user = await _user(db_session, 74114)
    assert user is not None
    assert user.language == expected
    # The raw tag is untrusted: it is not stored anywhere, the credentials
    # sandbox included -- only its normalized form, and nothing when absent.
    stored = (user.credentials or {}).get("language_code")
    assert stored == (expected if language is not None else None)


async def test_the_browser_language_never_changes_an_existing_account(
    client: AsyncClient, db_session: AsyncSession, telegram: FakeTelegram
) -> None:
    await login_user(client, 74115)
    await db_session.execute(
        update(User).where(User.telegram_id == 74115).values(language="de")
    )
    await db_session.commit()

    started = await _start(client)
    resp = await _complete(client, started["state"], 74115, language="ru")
    assert resp.status_code == 200
    user = await _user(db_session, 74115)
    assert user is not None
    assert user.language == "de"


# ---------------------------------------------------------------------------
# Limits and Redis
# ---------------------------------------------------------------------------


async def test_the_per_account_limit_applies_after_telegram_named_the_account(
    client: AsyncClient, db_session: AsyncSession, telegram: FakeTelegram
) -> None:
    await get_redis().set(
        "auth_rate:74116", settings.auth_rate_limit_max_requests, ex=60
    )
    started = await _start(client)
    resp = await _complete(client, started["state"], 74116)
    assert resp.status_code == 429
    assert await _user(db_session, 74116) is None


class _BrokenRedis:
    def __getattr__(self, name: str):
        async def fail(*args, **kwargs):
            raise RedisError("down")

        return fail


async def test_redis_down_on_start_is_503(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(browser_login, "get_redis", lambda: _BrokenRedis())
    resp = await client.post(START, json={"mark": MARK})
    assert resp.status_code == 503
    assert resp.json()["error"] == "service_unavailable"


async def test_redis_down_on_complete_is_503_and_telegram_is_not_asked(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, telegram: FakeTelegram
) -> None:
    started = await _start(client)
    monkeypatch.setattr(browser_login, "get_redis", lambda: _BrokenRedis())
    resp = await _complete(client, started["state"], 74117)
    assert resp.status_code == 503
    assert resp.json()["error"] == "service_unavailable"
    assert telegram.requests == []
