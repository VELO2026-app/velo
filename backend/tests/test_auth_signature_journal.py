# =============================================================================
# BE-187 -- one log event per Mini App sign-in: did initData carry `signature`
# =============================================================================
#
# The measurement for BE-183 (moving the Mini App login onto Telegram's
# public-key check, which old clients without `signature` cannot pass).
# The event is temporary and goes away with BE-183.
#
# What is pinned here:
#   - every successful POST /api/v1/auth/telegram writes exactly one
#     `telegram_auth_signature` event, with signature_present true/false;
#   - an empty `signature=` is absent; a repeated key is read by its first
#     value, the one the hash check used;
#   - no refusal writes the event: bad hash, appended (unsigned) signature,
#     source and per-account limits, deactivated account, failed session;
#   - the event carries the internal user id and the flag, and nothing
#     about the person.
#
# Not pinned, by agreement: a commit that fails after the handler returned
# (KNOWN CEILING at the event in auth/router.py).
#
# telegram_id band: 74200-74219.
# =============================================================================

from collections.abc import AsyncGenerator
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient
from redis.exceptions import RedisError
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession
from structlog.testing import capture_logs

from app.core.config import settings
from app.core.exceptions import TooManyRequestsError
from app.core.redis import get_redis
from app.main import app
from app.modules.auth import router as auth_router
from app.modules.users.models import User
from tests.helpers import BOT_TOKEN, build_init_data, full_cleanup_range

_TID_MIN = 74200
_TID_MAX = 74219

URL = "/api/v1/auth/telegram"
EVENT = "telegram_auth_signature"
# A shape like Telegram's (base64url Ed25519); the value itself must never
# reach the log, so it is distinctive enough to search for.
SIGNATURE = "Zm9vYmFyU2lnbmF0dXJlVmFsdWVfQkUxODc-aGVyZV9pc19zb21l"


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    async def clean() -> None:
        await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
        await db_session.commit()
        for tid in range(_TID_MIN, _TID_MAX + 1):
            await get_redis().delete(f"auth_rate:{tid}")

    await clean()
    yield
    await clean()


def _init_data(tid: int, extra: dict[str, str] | None = None) -> str:
    return build_init_data(
        {"id": tid, "first_name": "Sig", "username": f"siguser{tid}"},
        extra=extra,
    )


async def _post(client: AsyncClient, init_data: str):
    with patch.object(settings, "telegram_bot_token", BOT_TOKEN):
        return await client.post(URL, json={"init_data": init_data})


def _events(logs: list[dict]) -> list[dict]:
    return [e for e in logs if e["event"] == EVENT]


# -- successful sign-ins: exactly one event, the right flag ------------------


@pytest.mark.parametrize(
    ("tid", "extra", "expected"),
    [
        pytest.param(74200, {"signature": SIGNATURE}, True, id="present"),
        pytest.param(74201, None, False, id="missing"),
        pytest.param(74202, {"signature": ""}, False, id="empty-is-absent"),
    ],
)
async def test_a_sign_in_writes_one_event_with_the_flag(
    client: AsyncClient, tid: int, extra: dict[str, str] | None, expected: bool
) -> None:
    with capture_logs() as logs:
        resp = await _post(client, _init_data(tid, extra))

    assert resp.status_code == 200
    events = _events(logs)
    assert len(events) == 1
    assert events[0]["signature_present"] is expected
    assert events[0]["user_id"] == resp.json()["user"]["id"]


@pytest.mark.parametrize(
    ("tid", "signed", "appended", "expected"),
    [
        pytest.param(74203, "", SIGNATURE, False, id="empty-first"),
        pytest.param(74204, SIGNATURE, "", True, id="value-first"),
    ],
)
async def test_a_repeated_key_is_read_by_its_first_value(
    client: AsyncClient, tid: int, signed: str, appended: str, expected: bool
) -> None:
    """REPEAT: the flag reads the same first value the hash check signed.

    The hash covers only the first value of a repeated key, so the init
    data is signed with that first value and the second one is appended
    unsigned -- validation still passes, and the flag must follow the first.
    """
    init_data = _init_data(tid, {"signature": signed}) + f"&signature={appended}"

    with capture_logs() as logs:
        resp = await _post(client, init_data)

    assert resp.status_code == 200
    events = _events(logs)
    assert len(events) == 1
    assert events[0]["signature_present"] is expected


async def test_two_sign_ins_are_two_events_for_one_person(
    client: AsyncClient,
) -> None:
    """REPEAT: one event per sign-in, the same internal id each time -- the
    id is what lets the measurement count people, not sign-ins."""
    with capture_logs() as logs:
        first = await _post(client, _init_data(74205, {"signature": SIGNATURE}))
        second = await _post(client, _init_data(74205))

    assert first.status_code == 200
    assert second.status_code == 200
    events = _events(logs)
    assert [e["signature_present"] for e in events] == [True, False]
    assert events[0]["user_id"] == events[1]["user_id"] == first.json()["user"]["id"]


# -- nothing about the person -------------------------------------------------


async def test_the_event_carries_the_internal_id_and_nothing_about_the_person(
    client: AsyncClient,
) -> None:
    tid = 74206
    init_data = _init_data(tid, {"signature": SIGNATURE})

    with capture_logs() as logs:
        resp = await _post(client, init_data)

    assert resp.status_code == 200
    events = _events(logs)
    assert len(events) == 1
    event = events[0]
    # Y is there and not empty: the internal id of the person who signed in.
    assert event["user_id"] == resp.json()["user"]["id"]
    assert event["user_id"]
    # X is not: the exact key set leaves no room for anything else.
    assert set(event) == {"event", "log_level", "user_id", "signature_present"}
    rendered = repr(event)
    for leaked in (str(tid), "Sig", f"siguser{tid}", SIGNATURE, init_data):
        assert leaked not in rendered


# -- refusals: no event --------------------------------------------------------


async def test_a_bad_hash_writes_no_event(client: AsyncClient) -> None:
    init_data = _init_data(74207, {"signature": SIGNATURE})
    tampered = init_data.replace("first_name%22%3A+%22Sig", "first_name%22%3A+%22Xig")
    assert tampered != init_data

    with capture_logs() as logs:
        resp = await _post(client, tampered)

    assert resp.status_code == 400
    assert _events(logs) == []
    assert [e for e in logs if e["event"] == "telegram_auth_failed"]


async def test_a_signature_appended_to_signed_init_data_is_refused(
    client: AsyncClient,
) -> None:
    """The `signature` field is inside the hash: adding one to init data
    that was signed without it breaks the hash, so a client cannot fake
    being a new one, and no event is written."""
    init_data = _init_data(74208) + f"&signature={SIGNATURE}"

    with capture_logs() as logs:
        resp = await _post(client, init_data)

    assert resp.status_code == 400
    assert _events(logs) == []


async def test_a_signed_signature_passes_the_unchanged_hash_check(
    client: AsyncClient,
) -> None:
    """The other half of the pair above: signature signed WITH the rest is
    accepted -- the hash check still covers every field except `hash`."""
    with capture_logs() as logs:
        resp = await _post(client, _init_data(74209, {"signature": SIGNATURE}))

    assert resp.status_code == 200
    assert len(_events(logs)) == 1


async def test_the_per_account_limit_writes_no_event(client: AsyncClient) -> None:
    tid = 74210
    await get_redis().set(
        f"auth_rate:{tid}", settings.auth_rate_limit_max_requests, ex=60
    )

    with capture_logs() as logs:
        resp = await _post(client, _init_data(tid, {"signature": SIGNATURE}))

    assert resp.status_code == 429
    assert _events(logs) == []
    assert [e for e in logs if e["event"] == "telegram_auth_rate_limited"]


async def test_the_source_limit_writes_no_event(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        auth_router,
        "check_source_rate_limit",
        AsyncMock(side_effect=TooManyRequestsError("Too many auth attempts.")),
    )

    with capture_logs() as logs:
        resp = await _post(client, _init_data(74211, {"signature": SIGNATURE}))

    assert resp.status_code == 429
    assert _events(logs) == []


async def test_a_deactivated_account_writes_no_event(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    tid = 74212
    assert (await _post(client, _init_data(tid))).status_code == 200
    await db_session.execute(
        update(User).where(User.telegram_id == tid).values(is_active=False)
    )
    await db_session.commit()

    with capture_logs() as logs:
        resp = await _post(client, _init_data(tid, {"signature": SIGNATURE}))

    assert resp.status_code == 403
    assert _events(logs) == []
    assert [e for e in logs if e["event"] == "telegram_auth_deactivated"]


async def test_a_failed_session_writes_no_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """create_session failing (Redis down) answers 500 and the sign-in did
    not happen -- the event sits after it, so it is not written."""
    failing = AsyncMock(side_effect=RedisError("down"))
    monkeypatch.setattr(auth_router, "create_session", failing)
    transport = ASGITransport(app=app, raise_app_exceptions=False)

    async with AsyncClient(transport=transport, base_url="http://test") as raw:
        with capture_logs() as logs:
            resp = await _post(raw, _init_data(74213, {"signature": SIGNATURE}))

    assert resp.status_code == 500
    assert failing.await_count == 1
    assert _events(logs) == []
