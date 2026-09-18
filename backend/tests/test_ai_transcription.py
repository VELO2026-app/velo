# =============================================================================
# VELO Backend -- Tests: voice transcription (GT-41)
# =============================================================================
#
# telegram_id ranges:
#   69201  -- the authenticated caller
#
# The band 69200-69299 was checked against the registry before it was claimed
# (tests/telegram_id_bands.py): no declared band overlaps it and no other
# file's cleanup sweep covers it.
#
# WHAT THIS FILE INHERITS. Five properties used to live in the deleted
# frontend test (src/api/openrouter.test.ts) and moved here with the code
# that owns them: fence/quote cleaning with inner quotes kept, the
# [NO_SPEECH] marker, the apology-to-silence rule and its length gate, an
# empty content field, and a response shape without choices. Deleting a test
# is allowed when the PROPERTY survives somewhere; each of those has a test
# below, named so the pair is findable.
#
# THE KEY IS THE POINT. Every failure path is asserted not to leak it -- into
# the response body, into the message, or into the logs. That is a done-when,
# not a nicety: the whole delivery exists because the key used to be readable
# by anyone who opened the page.
#
# NO PROVIDER IS EVER CALLED. httpx is stubbed at the client seam in every
# test; a test that reached openrouter.ai would be billing us to run the
# suite.
# =============================================================================

import base64
from collections.abc import AsyncGenerator
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import VeloError
from app.modules.ai.transcription import (
    MAX_AUDIO_BYTES,
    OpenRouterTranscriptionService,
    clean_transcript,
    decode_audio,
    is_no_speech,
)
from tests.helpers import auth_headers, full_cleanup_range, login_user

TRANSCRIBE_URL = "/api/v1/ai/transcribe"

_TID_MIN = 69200
_TID_MAX = 69299

_KEY = "sk-or-secret-value-do-not-leak"


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """Clean all test data for this band before/after each test (ORM only)."""
    await _do_cleanup(db_session)
    yield
    await _do_cleanup(db_session)


async def _do_cleanup(session: AsyncSession) -> None:
    await full_cleanup_range(session, _TID_MIN, _TID_MAX, delete_users=True)
    await session.commit()


def _chat_response(content: str, status: int = 200) -> httpx.Response:
    """A provider reply in the chat-completions shape."""
    return httpx.Response(
        status_code=status,
        json={"choices": [{"message": {"content": content}}]},
    )


def _patch_provider(response_or_error: object) -> object:
    """Stub httpx.AsyncClient.post with one reply or one raised error."""
    if isinstance(response_or_error, Exception):
        return patch(
            "httpx.AsyncClient.post", AsyncMock(side_effect=response_or_error),
        )
    return patch(
        "httpx.AsyncClient.post", AsyncMock(return_value=response_or_error),
    )


# ===================================================================
# Transcript cleaning -- inherited from the deleted frontend tests
# ===================================================================


def test_clean_transcript_leaves_plain_text_untouched() -> None:
    """Nothing to strip means nothing stripped."""
    assert clean_transcript("  привет мир  ") == "привет мир"


def test_clean_transcript_strips_markdown_fences() -> None:
    """Audio models like to fence their answer; the fence is not speech."""
    assert clean_transcript("```\nпривет\n```") == "привет"
    assert clean_transcript("```text\nпривет\n```") == "привет"


def test_clean_transcript_strips_one_layer_of_wrapping_quotes() -> None:
    """One layer, in each of the three quote styles the models use."""
    assert clean_transcript('"привет"') == "привет"
    assert clean_transcript("«привет»") == "привет"
    assert clean_transcript("\u201cпривет\u201d") == "привет"


def test_clean_transcript_keeps_meaningful_inner_quotes() -> None:
    """Quotes INSIDE the sentence are the person's words, not dressing.

    The paired half of the test above: a stripper that took every quote
    would pass that one and destroy this.
    """
    assert clean_transcript('он сказал "да" и ушёл') == 'он сказал "да" и ушёл'


# ===================================================================
# Silence detection -- inherited, including the length gate
# ===================================================================


def test_no_speech_marker_is_silence() -> None:
    """The marker we asked the model for, in the answer we asked for it in."""
    assert is_no_speech("[NO_SPEECH]")
    assert is_no_speech("")


def test_short_apology_is_silence() -> None:
    """Models apologise at silence instead of using the marker."""
    assert is_no_speech("Извините, я не расслышал.")
    assert is_no_speech("Sorry, I can't hear anything.")


def test_a_long_message_starting_with_an_apology_is_speech() -> None:
    """The length gate, and the reason it exists.

    Somebody who actually starts a voice note with «извините» is speaking,
    and pasting their sentence into the composer is correct. Without the gate
    the prefix alone would throw away a real transcript.
    """
    long_message = (
        "Извините за задержку, я подготовлю материалы к завтрашней встрече "
        "и пришлю их вечером, как договаривались."
    )
    assert not is_no_speech(long_message)


# ===================================================================
# Payload validation -- size and shape, before any provider call
# ===================================================================


def test_oversized_audio_is_refused_with_its_own_code() -> None:
    """One byte over the named ceiling, and the pair one byte under it.

    The ceiling is a constant rather than a literal precisely so that this
    test and scripts/nginx-render.sh can be read against the same number.
    """
    over = base64.b64encode(b"\x00" * (MAX_AUDIO_BYTES + 1)).decode()
    with pytest.raises(VeloError) as exc:
        decode_audio(over)
    assert exc.value.code == "audio_too_large"

    under = base64.b64encode(b"\x00" * MAX_AUDIO_BYTES).decode()
    assert len(decode_audio(under)) == MAX_AUDIO_BYTES


def test_undecodable_and_empty_audio_are_a_different_code() -> None:
    """A broken client and a talkative one are not the same failure."""
    for payload in ("not base64 at all!!", ""):
        with pytest.raises(VeloError) as exc:
            decode_audio(payload)
        assert exc.value.code == "audio_invalid"


# ===================================================================
# The service against a stubbed provider
# ===================================================================


async def test_no_key_refuses_without_calling_the_provider() -> None:
    """An unprovisioned server answers a code and opens no connection.

    Asserted as a pair: the code, and the fact that nothing was sent. A
    refusal that still made the request would cost us money for a feature
    that is switched off.
    """
    post = AsyncMock()
    with patch.object(settings, "openrouter_api_key", ""), \
         patch("httpx.AsyncClient.post", post), \
         pytest.raises(VeloError) as exc:
        await OpenRouterTranscriptionService().transcribe(b"wav")
    assert exc.value.code == "transcription_not_configured"
    post.assert_not_awaited()


async def test_a_whitespace_key_counts_as_no_key() -> None:
    """A key of spaces is an unset key, not a key that will fail at 401."""
    with patch.object(settings, "openrouter_api_key", "   "), \
         pytest.raises(VeloError) as exc:
        await OpenRouterTranscriptionService().transcribe(b"wav")
    assert exc.value.code == "transcription_not_configured"


async def test_the_audio_is_sent_as_wav_with_the_bearer_key() -> None:
    """The request shape the provider needs, built from settings."""
    post = AsyncMock(return_value=_chat_response("привет"))
    with patch.object(settings, "openrouter_api_key", _KEY), \
         patch.object(
             settings, "openrouter_transcribe_model", "openai/gpt-audio-mini",
         ), \
         patch("httpx.AsyncClient.post", post):
        text = await OpenRouterTranscriptionService().transcribe(b"wav-bytes")

    assert text == "привет"
    body = post.await_args.kwargs["json"]
    assert body["model"] == "openai/gpt-audio-mini"
    audio_part = body["messages"][0]["content"][1]
    assert audio_part["input_audio"]["format"] == "wav"
    assert base64.b64decode(audio_part["input_audio"]["data"]) == b"wav-bytes"
    headers = post.await_args.kwargs["headers"]
    assert headers["Authorization"] == f"Bearer {_KEY}"


async def test_the_configured_model_is_used() -> None:
    """The slug is configurable because the provider renamed it once already."""
    post = AsyncMock(return_value=_chat_response("привет"))
    with patch.object(settings, "openrouter_api_key", _KEY), \
         patch.object(settings, "openrouter_transcribe_model", "other/model"), \
         patch("httpx.AsyncClient.post", post):
        await OpenRouterTranscriptionService().transcribe(b"wav")

    assert post.await_args.kwargs["json"]["model"] == "other/model"


@pytest.mark.parametrize(
    ("raised", "expected_code"),
    [
        (httpx.TimeoutException("slow"), "transcription_unavailable"),
        (httpx.ConnectError("down"), "transcription_unavailable"),
    ],
)
async def test_no_answer_from_the_provider_is_unavailable(
    raised: Exception, expected_code: str,
) -> None:
    """Timeout and connection failure are the same thing to the caller."""
    with patch.object(settings, "openrouter_api_key", _KEY), \
         _patch_provider(raised), \
         pytest.raises(VeloError) as exc:
        await OpenRouterTranscriptionService().transcribe(b"wav")
    assert exc.value.code == expected_code


@pytest.mark.parametrize("status", [401, 402, 429, 500])
async def test_every_provider_error_collapses_into_one_code(
    status: int,
) -> None:
    """One code for 401, 402, 429 and 500 -- deliberately, not lazily.

    The status is logged, where an operator can tell a bad key from an empty
    balance. The caller gets none of it: our credential, our credit and our
    rate limit are not the person's business and not something they can act
    on. The old browser module said «Закончился баланс OpenRouter» to every
    visitor.
    """
    with patch.object(settings, "openrouter_api_key", _KEY), \
         _patch_provider(httpx.Response(status_code=status, json={})), \
         pytest.raises(VeloError) as exc:
        await OpenRouterTranscriptionService().transcribe(b"wav")
    assert exc.value.code == "transcription_failed"


async def test_a_response_without_content_is_a_recognition_failure() -> None:
    """A shape we did not expect is "no transcript", never a stack trace."""
    for payload in ({}, {"choices": []}, {"choices": [{"message": {}}]}):
        with patch.object(settings, "openrouter_api_key", _KEY), \
             _patch_provider(httpx.Response(status_code=200, json=payload)), \
             pytest.raises(VeloError) as exc:
            await OpenRouterTranscriptionService().transcribe(b"wav")
        assert exc.value.code == "speech_not_recognized"


async def test_silence_answers_are_never_returned_as_a_transcript() -> None:
    """The marker and the apology both end as a refusal, not as text.

    Paired with a real transcript on the same path, so a service that refused
    everything could not pass.
    """
    for content in ("[NO_SPEECH]", "Извините, ничего не слышно.", "  "):
        with patch.object(settings, "openrouter_api_key", _KEY), \
             _patch_provider(_chat_response(content)), \
             pytest.raises(VeloError) as exc:
            await OpenRouterTranscriptionService().transcribe(b"wav")
        assert exc.value.code == "speech_not_recognized"

    with patch.object(settings, "openrouter_api_key", _KEY), \
         _patch_provider(_chat_response("```\n«реальный текст»\n```")):
        assert (
            await OpenRouterTranscriptionService().transcribe(b"wav")
            == "реальный текст"
        )


# ===================================================================
# The key never leaves the process
# ===================================================================


async def test_no_failure_path_leaks_the_key(caplog) -> None:
    """The done-when, asserted on every failure the provider can cause.

    Checked in both places a secret escapes: the error the caller receives
    and the lines we write to the log. The transport error case is the one
    that nearly leaked -- httpx puts the request, and therefore the
    Authorization header, into an exception's repr, so the handler logs an
    event name rather than the exception.
    """
    failures: list[object] = [
        httpx.TimeoutException("slow"),
        httpx.ConnectError(f"connecting with {_KEY}"),
        httpx.Response(status_code=401, json={"error": "bad key"}),
        _chat_response("[NO_SPEECH]"),
    ]

    for failure in failures:
        caplog.clear()
        with patch.object(settings, "openrouter_api_key", _KEY), \
             _patch_provider(failure), \
             pytest.raises(VeloError) as exc:
            await OpenRouterTranscriptionService().transcribe(b"wav")
        assert _KEY not in exc.value.message
        assert _KEY not in str(exc.value.code)
        assert _KEY not in caplog.text


# ===================================================================
# The endpoint
# ===================================================================


async def test_endpoint_returns_the_transcript(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The whole path, from base64 in to text out."""
    login = await login_user(client, telegram_id=69201, first_name="Caller")
    audio = base64.b64encode(b"wav-bytes").decode()

    with patch.object(settings, "openrouter_api_key", _KEY), \
         _patch_provider(_chat_response("привет")):
        response = await client.post(
            TRANSCRIBE_URL,
            headers=auth_headers(login["session_token"]),
            json={"audio_base64": audio},
        )

    assert response.status_code == 200
    assert response.json() == {"text": "привет"}


async def test_endpoint_refuses_an_anonymous_caller_before_any_provider_call(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A stranger never reaches our provider, and never spends our credit.

    The un-awaited stub is the load-bearing half: a 401 that still made the
    outbound call would be exactly the hole this delivery closes.
    """
    post = AsyncMock()
    with patch.object(settings, "openrouter_api_key", _KEY), \
         patch("httpx.AsyncClient.post", post):
        response = await client.post(
            TRANSCRIBE_URL,
            json={"audio_base64": base64.b64encode(b"wav").decode()},
        )

    assert response.status_code == 401
    post.assert_not_awaited()


async def test_endpoint_answers_a_machine_code_when_the_key_is_missing(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Not configured is a 400 with a code, never a 500.

    The envelope is asserted too: our errors carry {"error", "message"}, and
    a client that cannot read a code off the body is the defect core/comms.py
    still has in nine places.
    """
    login = await login_user(client, telegram_id=69201, first_name="Caller")

    with patch.object(settings, "openrouter_api_key", ""):
        response = await client.post(
            TRANSCRIBE_URL,
            headers=auth_headers(login["session_token"]),
            json={"audio_base64": base64.b64encode(b"wav").decode()},
        )

    assert response.status_code == 400
    assert response.json()["error"] == "transcription_not_configured"


async def test_endpoint_refuses_oversized_audio_before_the_key_is_consulted(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Order of refusals, pinned: the payload is judged before the key.

    A person who recorded too much is told exactly that, even on a server
    with no key -- that is the failure they can act on. The reverse order
    would answer "voice input is unavailable" to someone whose only problem
    was talking for too long.
    """
    login = await login_user(client, telegram_id=69201, first_name="Caller")
    oversized = base64.b64encode(b"\x00" * (MAX_AUDIO_BYTES + 1)).decode()

    post = AsyncMock()
    with patch.object(settings, "openrouter_api_key", ""), \
         patch("httpx.AsyncClient.post", post):
        response = await client.post(
            TRANSCRIBE_URL,
            headers=auth_headers(login["session_token"]),
            json={"audio_base64": oversized},
        )

    assert response.status_code == 400
    assert response.json()["error"] == "audio_too_large"
    post.assert_not_awaited()
