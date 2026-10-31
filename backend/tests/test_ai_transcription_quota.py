# =============================================================================
# VELO Backend -- Tests: daily transcription quota (BE-67) and the OpenAPI
# dump that replaces the served schema for type generation (BE-114 item 2)
# =============================================================================
#
# telegram_id ranges:
#   74171  -- the first caller
#   74172  -- the second caller (the two-people test)
#
# The band 74170-74199 was taken from free_windows() over the whole allowed
# space and checked against every file's cleanup sweep: none covers it, and
# no test file uses a number in it.
#
# THE PROVIDER IS NEVER CALLED. Endpoint tests stub our own service method,
# for the reason test_ai_transcription.py's header gives (patching httpx
# hijacks the test client's own request). "The provider was not reached" is
# asserted on that stub: it is the line between our code and the bill.
#
# THE LIMIT IS PATCHED to small numbers rather than driven to 60 with sixty
# requests, except where 60 itself is the point -- there the counter is
# seeded to 59 through the module's own key function, so the test sends two
# requests, not sixty. The default being 60 is asserted on the field, not on
# settings: a stand where the owner set the limit to 2 for a live check must
# not turn this file red.
# =============================================================================

import asyncio
import base64
import json
import subprocess
import sys
import types
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch
from uuid import UUID, uuid4

import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError
from redis.exceptions import RedisError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, settings
from app.core.redis import get_redis
from app.main import app
from app.modules.ai import quota
from app.modules.ai.quota import (
    QUOTA_KEY_TTL_SECONDS,
    TranscriptionQuotaExceededError,
    consume_transcription_quota,
    quota_key,
)
from app.modules.ai.transcription import (
    MAX_AUDIO_BYTES,
    SpeechNotRecognizedError,
    TranscriptionFailedError,
    TranscriptionUnavailableError,
)
from tests.helpers import auth_headers, full_cleanup_range, login_user

TRANSCRIBE_URL = "/api/v1/ai/transcribe"

_TID_MIN = 74170
_TID_MAX = 74199

_TRANSCRIBE_SEAM = (
    "app.modules.ai.transcription.OpenRouterTranscriptionService.transcribe"
)
# The route's own reference to the quota function -- the race test's seam.
_QUOTA_SEAM = "app.modules.ai.transcription_router.consume_transcription_quota"

_AUDIO = base64.b64encode(b"wav-bytes").decode()

_DUMP_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "dump_openapi.py"


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """Clean all test data for this band before/after each test (ORM only)."""
    await _do_cleanup(db_session)
    yield
    await _do_cleanup(db_session)


async def _do_cleanup(session: AsyncSession) -> None:
    # full_cleanup_range does not commit on its own.
    await full_cleanup_range(session, _TID_MIN, _TID_MAX, delete_users=True)
    await session.commit()


async def _login(client: AsyncClient, telegram_id: int = 74171) -> tuple[str, UUID]:
    login = await login_user(client, telegram_id=telegram_id, first_name="Caller")
    return login["session_token"], UUID(login["user"]["id"])


async def _transcribe(client: AsyncClient, token: str, audio: str = _AUDIO):
    return await client.post(
        TRANSCRIBE_URL,
        headers=auth_headers(token),
        json={"audio_base64": audio},
    )


def _today_key(user_id: UUID) -> str:
    return quota_key(user_id, datetime.now(UTC).date())


# ===================================================================
# The limit
# ===================================================================


def test_the_default_limit_is_sixty() -> None:
    """The owner's number lives on the field, where a stand's own .env
    cannot hide it from this test."""
    assert Settings.model_fields["transcription_daily_limit"].default == 60


async def test_up_to_the_limit_passes_and_the_next_never_reaches_the_provider(
    client: AsyncClient,
) -> None:
    """Three of three pass; the fourth is a coded 429 and the provider is
    not called for it -- the stub stays at three awaits."""
    token, _ = await _login(client)
    transcribe = AsyncMock(return_value="привет")

    with patch.object(settings, "transcription_daily_limit", 3), \
         patch(_TRANSCRIBE_SEAM, transcribe):
        passed = [await _transcribe(client, token) for _ in range(3)]
        refused = await _transcribe(client, token)

    assert [r.status_code for r in passed] == [200, 200, 200]
    assert all(r.json() == {"text": "привет"} for r in passed)
    assert refused.status_code == 429
    assert refused.json()["error"] == "transcription_quota_exceeded"
    assert refused.json()["message"]
    assert transcribe.await_count == 3


async def test_the_sixtieth_passes_and_the_sixty_first_is_refused(
    client: AsyncClient,
) -> None:
    """The owner's number itself, at its edge: 59 already spent today."""
    token, user_id = await _login(client)
    await get_redis().set(_today_key(user_id), 59, ex=QUOTA_KEY_TTL_SECONDS)
    transcribe = AsyncMock(return_value="шестидесятая")

    with patch.object(settings, "transcription_daily_limit", 60), \
         patch(_TRANSCRIBE_SEAM, transcribe):
        sixtieth = await _transcribe(client, token)
        sixty_first = await _transcribe(client, token)

    assert sixtieth.status_code == 200
    assert sixty_first.status_code == 429
    assert sixty_first.json()["error"] == "transcription_quota_exceeded"
    assert transcribe.await_count == 1


async def test_a_zero_limit_refuses_the_first_take(client: AsyncClient) -> None:
    """0 is "voice input off", without a branch of its own."""
    token, _ = await _login(client)
    transcribe = AsyncMock(return_value="никогда")

    with patch.object(settings, "transcription_daily_limit", 0), \
         patch(_TRANSCRIBE_SEAM, transcribe):
        response = await _transcribe(client, token)

    assert response.status_code == 429
    transcribe.assert_not_awaited()


async def test_two_people_do_not_share_a_counter(client: AsyncClient) -> None:
    """One person's used-up day leaves the next person's untouched."""
    first, _ = await _login(client, 74171)
    second, _ = await _login(client, 74172)
    transcribe = AsyncMock(return_value="текст")

    with patch.object(settings, "transcription_daily_limit", 1), \
         patch(_TRANSCRIBE_SEAM, transcribe):
        assert (await _transcribe(client, first)).status_code == 200
        assert (await _transcribe(client, first)).status_code == 429
        other = await _transcribe(client, second)

    assert other.status_code == 200
    assert transcribe.await_count == 2


# ===================================================================
# The day
# ===================================================================


async def test_a_new_utc_day_gives_a_fresh_count() -> None:
    """The date is in the key: the last second of a day is still that day,
    the first second of the next one is a new key."""
    user_id = uuid4()
    late = datetime(2026, 10, 31, 23, 59, 58, tzinfo=UTC)

    with patch.object(settings, "transcription_daily_limit", 1):
        await consume_transcription_quota(user_id, now=late)
        with pytest.raises(TranscriptionQuotaExceededError):
            await consume_transcription_quota(
                user_id, now=late + timedelta(seconds=1),
            )
        await consume_transcription_quota(
            user_id, now=late + timedelta(seconds=2),
        )

    redis = get_redis()
    assert await redis.get(quota_key(user_id, late.date())) == "2"
    assert await redis.get(quota_key(user_id, (late + timedelta(days=1)).date())) == "1"


async def test_the_day_is_the_utc_day_not_the_callers() -> None:
    """01:00 in Moscow on 1 November is still 31 October in UTC."""
    user_id = uuid4()
    moscow_early = datetime(2026, 11, 1, 1, 0, tzinfo=timezone(timedelta(hours=3)))

    await consume_transcription_quota(user_id, now=moscow_early)

    redis = get_redis()
    assert await redis.get(quota_key(user_id, datetime(2026, 10, 31).date())) == "1"
    assert await redis.get(quota_key(user_id, datetime(2026, 11, 1).date())) is None


async def test_the_key_expires_but_never_inside_its_own_day() -> None:
    """A TTL exists (no eternal counter) and outlasts any day it counts."""
    user_id = uuid4()
    now = datetime(2026, 10, 31, 0, 0, 1, tzinfo=UTC)

    await consume_transcription_quota(user_id, now=now)

    ttl = await get_redis().ttl(quota_key(user_id, now.date()))
    assert 24 * 60 * 60 < ttl <= QUOTA_KEY_TTL_SECONDS


# ===================================================================
# The order of refusals -- what spends a unit and what does not
# ===================================================================


@pytest.mark.parametrize(
    ("audio", "status", "code"),
    [
        ("not base64 !!", 400, "audio_invalid"),
        ("", 400, "audio_invalid"),
        (base64.b64encode(b"\x00" * (MAX_AUDIO_BYTES + 1)).decode(), 400,
         "audio_too_large"),
    ],
    ids=["undecodable", "empty", "oversized"],
)
async def test_a_broken_payload_spends_nothing(
    client: AsyncClient, audio: str, status: int, code: str,
) -> None:
    """The payload is judged before the quota. With a limit of one, a broken
    take followed by a good one must still let the good one through -- and
    the one after that is refused, so the counter is shown to be live."""
    token, _ = await _login(client)
    transcribe = AsyncMock(return_value="текст")

    with patch.object(settings, "transcription_daily_limit", 1), \
         patch(_TRANSCRIBE_SEAM, transcribe):
        broken = await _transcribe(client, token, audio)
        good = await _transcribe(client, token)
        after = await _transcribe(client, token)

    assert broken.status_code == status
    assert broken.json()["error"] == code
    assert good.status_code == 200
    assert after.status_code == 429


async def test_a_body_without_audio_spends_nothing(client: AsyncClient) -> None:
    """A 422 from the schema never reaches the route, let alone the quota."""
    token, user_id = await _login(client)

    response = await client.post(
        TRANSCRIBE_URL, headers=auth_headers(token), json={},
    )

    assert response.status_code == 422
    assert await get_redis().get(_today_key(user_id)) is None


async def test_an_anonymous_caller_spends_nothing(client: AsyncClient) -> None:
    """No identity, no counter: no quota key appears at all."""
    redis = get_redis()
    before = {k async for k in redis.scan_iter("transcribe_quota:*")}

    response = await client.post(TRANSCRIBE_URL, json={"audio_base64": _AUDIO})

    assert response.status_code == 401
    assert {k async for k in redis.scan_iter("transcribe_quota:*")} == before


@pytest.mark.parametrize(
    ("failure", "status", "code"),
    [
        (TranscriptionUnavailableError(), 502, "transcription_unavailable"),
        (TranscriptionFailedError(), 502, "transcription_failed"),
        (SpeechNotRecognizedError(), 400, "speech_not_recognized"),
    ],
    ids=["unavailable", "provider_error", "no_speech"],
)
async def test_a_failed_provider_call_still_spends_a_unit(
    client: AsyncClient, failure: Exception, status: int, code: str,
) -> None:
    """A call that reached the provider is paid for, whatever it returned
    (owner decision): with a limit of one, the next take is refused."""
    token, _ = await _login(client)
    transcribe = AsyncMock(side_effect=failure)

    with patch.object(settings, "transcription_daily_limit", 1), \
         patch(_TRANSCRIBE_SEAM, transcribe):
        failed = await _transcribe(client, token)
        next_take = await _transcribe(client, token)

    assert failed.status_code == status
    assert failed.json()["error"] == code
    assert next_take.status_code == 429
    assert transcribe.await_count == 1


async def test_a_server_without_a_key_spends_the_quota_first(
    client: AsyncClient,
) -> None:
    """The quota sits before the key -- the price named in the route's
    docstring: a keyless server answers not_configured while the quota
    lasts, and quota_exceeded after."""
    token, _ = await _login(client)

    with patch.object(settings, "transcription_daily_limit", 1), \
         patch.object(settings, "openrouter_api_key", ""):
        first = await _transcribe(client, token)
        second = await _transcribe(client, token)

    assert first.status_code == 400
    assert first.json()["error"] == "transcription_not_configured"
    assert second.status_code == 429
    assert second.json()["error"] == "transcription_quota_exceeded"


class _BrokenRedis:
    def __getattr__(self, name: str):
        def broken(*args, **kwargs):
            raise RedisError("down")

        return broken


async def test_redis_down_refuses_without_reaching_the_provider(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Fail closed: a 500 internal_error, the auth and sdk-join posture, and
    the paid call is never made. A client that does not re-raise app errors
    is used so the answer the person gets is what is asserted."""
    token, _ = await _login(client)
    monkeypatch.setattr(quota, "get_redis", lambda: _BrokenRedis())
    transcribe = AsyncMock(return_value="никогда")

    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://test") as raw:
        with patch(_TRANSCRIBE_SEAM, transcribe):
            response = await _transcribe(raw, token)

    assert response.status_code == 500
    assert response.json()["error"] == "internal_error"
    transcribe.assert_not_awaited()


# ===================================================================
# The race at the limit
# ===================================================================


async def test_two_takes_racing_at_the_limit_let_exactly_one_through(
    client: AsyncClient,
) -> None:
    """59 spent, two takes at once. The invariant, not a winner: exactly one
    200 and one 429, the counter at 61, and one paid call.

    Symmetric race, so asyncio.gather is the harness (§0 §8) -- but gather
    alone lets the first take finish counting before the second reaches the
    counter, and then the test is green over a read-then-write counter too
    (measured: that mutant passed it). So both takes are held at a barrier
    at the entry of the quota and released into the counter together. The
    barrier is outside the counter: it widens the window for any counter,
    and only an atomic one survives it."""
    token, user_id = await _login(client)
    await get_redis().set(_today_key(user_id), 59, ex=QUOTA_KEY_TTL_SECONDS)

    barrier = asyncio.Barrier(2)

    async def both_at_once(user: UUID) -> None:
        await barrier.wait()
        await consume_transcription_quota(user)

    transcribe = AsyncMock(return_value="один")
    with patch.object(settings, "transcription_daily_limit", 60), \
         patch(_TRANSCRIBE_SEAM, transcribe), \
         patch(_QUOTA_SEAM, both_at_once):
        responses = await asyncio.wait_for(
            asyncio.gather(_transcribe(client, token), _transcribe(client, token)),
            timeout=30,
        )

    assert sorted(r.status_code for r in responses) == [200, 429]
    assert await get_redis().get(_today_key(user_id)) == "61"
    assert transcribe.await_count == 1


# ===================================================================
# The setting
# ===================================================================


@pytest.mark.parametrize("raw", ["", "   "])
def test_an_empty_limit_means_sixty(
    monkeypatch: pytest.MonkeyPatch, raw: str,
) -> None:
    """`velo env set TRANSCRIPTION_DAILY_LIMIT` with an empty value writes
    the key empty. Unvalidated, that is int_parsing at import and a backend
    that does not start; here it is the owner's 60."""
    monkeypatch.setenv("TRANSCRIPTION_DAILY_LIMIT", raw)
    assert Settings(_env_file=None).transcription_daily_limit == 60


def test_a_set_limit_is_read_and_a_negative_one_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The pair of the empty case: a real value is taken as given, and a
    nonsense one stops the load instead of meaning something by accident."""
    monkeypatch.setenv("TRANSCRIPTION_DAILY_LIMIT", "2")
    assert Settings(_env_file=None).transcription_daily_limit == 2

    monkeypatch.setenv("TRANSCRIPTION_DAILY_LIMIT", "-1")
    with pytest.raises(ValidationError):
        Settings(_env_file=None)


# ===================================================================
# The OpenAPI dump (BE-114 item 2) -- what the deploy now reads
# ===================================================================


def test_the_dump_prints_the_apps_schema_and_nothing_else() -> None:
    """Run as the deploy runs it: a separate process, stdout redirected
    into what the generator parses. stdout must be exactly the schema the
    app builds in-process -- and that schema must not be empty."""
    result = subprocess.run(
        [sys.executable, str(_DUMP_SCRIPT)],
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
    )

    assert result.returncode == 0, result.stderr
    dumped = json.loads(result.stdout)
    assert dumped == json.loads(json.dumps(app.openapi()))
    assert dumped["paths"], "the dumped schema lists no path"
    assert TRANSCRIBE_URL in dumped["paths"]


def test_whatever_the_import_prints_goes_to_stderr(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    """The guard that keeps stdout parseable. app.main is replaced by a
    stand-in that prints while the schema is built -- the way an
    unconfigured structlog prints during the real import -- and stdout must
    still be one JSON document."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("dump_openapi", _DUMP_SCRIPT)
    assert spec is not None and spec.loader is not None
    dump = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(dump)

    class _NoisyApp:
        def openapi(self) -> dict:
            print("import-time log line")
            return {"paths": {"/x": {}}}

    fake_main = types.ModuleType("app.main")
    fake_main.app = _NoisyApp()  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "app.main", fake_main)

    assert dump.main() == 0
    out, err = capsys.readouterr()

    assert json.loads(out) == {"paths": {"/x": {}}}
    assert "import-time log line" in err
