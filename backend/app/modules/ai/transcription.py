# =============================================================================
# VELO Backend -- Voice transcription (GT-41)
# =============================================================================
#
# WHY THIS IS A SEPARATE PROTOCOL AND NOT A SECOND METHOD ON
# AIServiceProtocol. Three reasons, in order of how checkable they are:
#
#   1. AIServiceProtocol is a Protocol and MockAIService satisfies it
#      STRUCTURALLY, without inheriting. A second method on the protocol
#      would stop the mock from satisfying it, forcing an edit to a stub
#      this delivery is not allowed to touch.
#   2. get_ai_service() swaps the WHOLE service. One object holding real
#      transcription and a placeholder summary makes is_mock -- a field the
#      summary response carries -- meaningless as a statement about the
#      implementation.
#   3. The two capabilities fail differently, cost differently and are
#      configured differently. Sharing a protocol would put one configuration
#      surface on two unrelated external calls.
#
# WHAT MOVED HERE FROM THE BROWSER, and why it is more than transport. The
# frontend module this replaces (src/api/openrouter.ts) was about a third
# HTTP call and two thirds "how we ask the model and how we clean its
# answer": the prompt, the [NO_SPEECH] marker, the model slug, the response
# shape, and the fence/quote stripping. All of that belongs next to the key,
# so the browser is left with one request and a message table.
#
# THE KEY NEVER LEAVES THIS PROCESS. It is read from settings, sent in one
# Authorization header, and never logged, never echoed into an error, never
# included in a response -- asserted by a test, not by intent.
#
# FAILURE MODEL: every failure is a VeloError with a MACHINE CODE, never a
# bare HTTPException with a {"detail": ...} envelope. core/comms.py raises
# nine of those and the frontend cannot read a code off any of them; that is
# a known defect, not a pattern to copy.
#
# WHAT IS NOT HERE, deliberately: a per-person quota. The endpoint requires
# authentication, and that is the ONLY thing standing between this key and
# the budget. How many minutes a day one person may transcribe is a product
# decision nobody has taken.
#
# SESSION RULES: no database access at all -- this service never touches a
# session.
# =============================================================================

import base64
import binascii
import re
from typing import Any, Protocol

import httpx
import structlog

from app.core.config import settings
from app.core.exceptions import BadRequestError, VeloError

logger = structlog.get_logger()

_OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"

# 60 s of the recorder's own format -- 16 kHz mono PCM16, i.e. 32 000 bytes a
# second (frontend/src/utils/audio.ts) -- is 1 920 044 bytes. This is that,
# rounded up, and it is the DECODED size: the request carries base64, which
# is a third larger again.
#
# nginx must pass more than this or the ceiling here never fires and the real
# limit becomes an HTML 413 with no machine code. scripts/nginx-render.sh
# carries client_max_body_size on the API server blocks for exactly that
# reason, and the two numbers are meant to be read together.
MAX_AUDIO_BYTES = 2 * 1024 * 1024

# "ONLY the transcript" is load-bearing: audio models like to wrap the
# transcript in conversational dressing, which would land verbatim in the
# user's composer field. The [NO_SPEECH] marker gives the model a defined
# answer for silence -- without it, silence comes back as a 200 carrying an
# apology sentence, which used to pass as a "transcript".
_TRANSCRIBE_PROMPT = (
    "Transcribe the speech in this audio verbatim. Reply with ONLY the "
    "transcript text, no preamble, no quotes, no commentary. If there is no "
    "intelligible speech, reply with exactly [NO_SPEECH]."
)
_NO_SPEECH_MARKER = "[NO_SPEECH]"

# Short apologies to silence, in the languages the model answers in. A LONG
# message that merely begins with one of these is a real transcript -- the
# length gate below is what tells the two apart.
_APOLOGY_PREFIXES = (
    "извините",
    "простите",
    "sorry",
    "i'm sorry",
    "i am sorry",
    "вибачте",
)
_APOLOGY_MAX_LEN = 60

_FENCE = re.compile(r"^```[a-zA-Z]*\r?\n?([\s\S]*?)\r?\n?```$")
_WRAPS = (('"', '"'), ("«", "»"), ("\u201c", "\u201d"))


class TranscriptionNotConfiguredError(VeloError):
    """No key on this server -- the feature is off, and it says so (400).

    Not a 500: nothing failed. Someone did not provision a key, and the
    honest answer is a code the client can turn into one sentence.
    """

    def __init__(self) -> None:
        super().__init__(
            message="Transcription is not configured on this server",
            code="transcription_not_configured",
            status_code=400,
        )


class TranscriptionUnavailableError(VeloError):
    """The provider did not answer at all -- timeout or connection failure."""

    def __init__(self) -> None:
        super().__init__(
            message="Transcription provider did not answer",
            code="transcription_unavailable",
            status_code=502,
        )


class TranscriptionFailedError(VeloError):
    """The provider answered, and the answer was an error.

    One code for every provider-side failure, including 402 "out of credit".
    The client is told that transcription failed, NOT which vendor we use or
    what our balance is: that is our billing, and the person on the other end
    can do nothing about it either way.
    """

    def __init__(self) -> None:
        super().__init__(
            message="Transcription provider returned an error",
            code="transcription_failed",
            status_code=502,
        )


class SpeechNotRecognizedError(VeloError):
    """A successful call that produced no usable transcript (400).

    Silence, the [NO_SPEECH] marker, an empty content field, or a response
    shape without one. Separate from a provider failure because the person
    can act on it -- record again, closer to the mic.
    """

    def __init__(self) -> None:
        super().__init__(
            message="No intelligible speech in the audio",
            code="speech_not_recognized",
            status_code=400,
        )


def clean_transcript(raw: str) -> str:
    """Trim model dressing: markdown fences and one layer of wrapping quotes.

    Moved verbatim in behaviour from the deleted frontend module, where it
    was covered by its own tests. Inner quotes are kept: «он сказал "да"»
    loses the outer pair and nothing else.
    """
    text = raw.strip()
    fenced = _FENCE.match(text)
    if fenced:
        text = (fenced.group(1) or "").strip()
    for open_q, close_q in _WRAPS:
        if len(text) >= 2 and text.startswith(open_q) and text.endswith(close_q):
            text = text[1:-1].strip()
    return text


def is_no_speech(text: str) -> bool:
    """True when the model answered silence rather than speech.

    Two forms: the marker we asked for, and the apology we did not. The
    length gate is the whole point of the second -- a long message that
    merely STARTS with "извините" is somebody actually speaking, and pasting
    it into the composer is correct.
    """
    stripped = text.strip()
    if not stripped:
        return True
    if _NO_SPEECH_MARKER in stripped.upper():
        return True
    lowered = stripped.lower()
    return len(stripped) <= _APOLOGY_MAX_LEN and any(
        lowered.startswith(prefix) for prefix in _APOLOGY_PREFIXES
    )


def _extract_content(payload: Any) -> str | None:
    """Pull choices[0].message.content out of a chat-completions body.

    Every step is checked because the body is a third party's: a shape we did
    not expect must become "no transcript", never a stack trace.
    """
    if not isinstance(payload, dict):
        return None
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return None
    first = choices[0]
    if not isinstance(first, dict):
        return None
    message = first.get("message")
    if not isinstance(message, dict):
        return None
    content = message.get("content")
    return content if isinstance(content, str) else None


def decode_audio(audio_base64: str) -> bytes:
    """Decode the request's base64 payload, or refuse it with a code.

    The size ceiling is checked on the DECODED bytes, which is what the
    provider is actually sent and what the recorder actually produced. An
    undecodable payload and an oversized one are different codes because the
    first is a broken client and the second is a person who talked too long.
    """
    try:
        audio = base64.b64decode(audio_base64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise BadRequestError(
            "Audio payload is not valid base64", code="audio_invalid",
        ) from exc
    if not audio:
        raise BadRequestError(
            "Audio payload is empty", code="audio_invalid",
        )
    if len(audio) > MAX_AUDIO_BYTES:
        raise BadRequestError(
            f"Audio exceeds {MAX_AUDIO_BYTES} bytes", code="audio_too_large",
        )
    return audio


class TranscriptionServiceProtocol(Protocol):
    """Interface for the voice transcription service."""

    async def transcribe(self, audio: bytes) -> str:
        """Return the transcript of one WAV recording.

        Raises a VeloError subclass from this module for every failure; never
        returns an empty string.
        """
        ...


class OpenRouterTranscriptionService:
    """Transcription through OpenRouter's chat-completions endpoint."""

    async def transcribe(self, audio: bytes) -> str:
        """One request to the provider, one transcript or one coded failure.

        The key is checked before the request is built, so an unprovisioned
        server never opens a connection. The payload was already validated by
        the caller: a malformed or oversized recording is refused before this
        is reached, because that is the failure the person can act on.
        """
        api_key = settings.openrouter_api_key.strip()
        if not api_key:
            raise TranscriptionNotConfiguredError()

        body = {
            "model": settings.openrouter_transcribe_model,
            "temperature": 0,
            "max_tokens": 1000,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": _TRANSCRIBE_PROMPT},
                        {
                            "type": "input_audio",
                            "input_audio": {
                                "data": base64.b64encode(audio).decode(),
                                "format": "wav",
                            },
                        },
                    ],
                },
            ],
        }

        try:
            async with httpx.AsyncClient(
                timeout=settings.openrouter_http_timeout_seconds,
            ) as client:
                response = await client.post(
                    _OPENROUTER_CHAT_URL,
                    json=body,
                    headers={"Authorization": f"Bearer {api_key}"},
                )
        except httpx.TimeoutException as exc:
            logger.warning("transcription_timeout")
            raise TranscriptionUnavailableError() from exc
        except httpx.HTTPError as exc:
            # Deliberately NOT logging the exception object: httpx puts the
            # request into its repr, and the request carries the key.
            logger.warning("transcription_transport_error")
            raise TranscriptionUnavailableError() from exc

        if response.status_code >= 400:
            # The status goes to the log, where an operator can tell 401
            # (bad key) from 402 (no credit) from 429 (too fast). The client
            # gets one code: none of those are its business or its fault.
            logger.warning(
                "transcription_provider_error",
                status_code=response.status_code,
            )
            raise TranscriptionFailedError()

        try:
            payload = response.json()
        except ValueError as exc:
            logger.warning("transcription_response_not_json")
            raise TranscriptionFailedError() from exc

        content = _extract_content(payload)
        if content is None:
            logger.warning("transcription_response_without_content")
            raise SpeechNotRecognizedError()

        text = clean_transcript(content)
        if is_no_speech(text):
            raise SpeechNotRecognizedError()
        return text


def get_transcription_service() -> TranscriptionServiceProtocol:
    """FastAPI dependency -- the active transcription implementation.

    A separate seam from get_ai_service(): the two capabilities are swapped
    independently, and today one of them is real while the other is still a
    stub. See this module's header for why they do not share a protocol.
    """
    return OpenRouterTranscriptionService()
