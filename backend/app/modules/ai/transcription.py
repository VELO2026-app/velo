# =============================================================================
# VELO Backend -- Voice transcription through an llm job of comms (GT-41,
# BE-184)
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
# HOW A TAKE TRAVELS (BE-184). The product has no way out to the internet on
# the deploy machine (protocol 4.1), so the model is asked by comms, over its
# llm channel (comms deploy/INTEGRATION.md section 11):
#
#   1. the recording goes into the `voice` bucket of velo-storage under
#      <person>/<take>, and is signed for LINK_TTL_SECONDS (core/storage.py);
#   2. an llm job of type VOICE_TYPE is queued through the OUTBOX, in a
#      transaction of this service's own that commits before anything waits:
#      the letter is the prompt, the envelope carries the signed link as
#      `llm_audio` (core/llm.py). comms fetches the body and appends it, as
#      the LAST message, to the letter;
#   3. the job is read back by its key (section 8) every POLL_SECONDS until
#      it has an outcome, and the answer is cleaned as it always was;
#   4. the recording is deleted whatever happened (_discard).
#
# The endpoint stays synchronous -- the frontend sends a recording and waits
# for the text -- and the whole of it is bounded by WAIT_SECONDS.
#
# THE TIME LADDER. Whoever gives up first must not be the one holding the
# bill, and every number below is read together with the type's record in
# comms-profile/types.yaml:
#
#   browser 30 s (frontend/src/api/transcription.ts)
#     > WAIT_SECONDS 25: this service, the storage write and the queueing
#       included
#     < JOB_EXPIRES_SECONDS 30 (`expires_after: 30s`): a job comms has not
#       started by then is never started, and `retry_max_attempts: 1` never
#       starts a second attempt -- a model answer after the person has been
#       told "no" is paid for and read by nobody;
#     <= the job's longest life: JOB_EXPIRES_SECONDS + one call of comms'
#       LLM_DELIVER_TIMEOUT_SECONDS (120 by default) + 35 s to fetch the body;
#     < LINK_TTL_SECONDS 600, the signed link's life.
#
# Pinned by tests/test_comms_protocol_3.py (the record against these
# constants) and tests/test_ai_transcription.py (the ladder itself).
#
# KNOWN CEILING -- a backlog in the outbox outlasts the wait:
#   1. Mechanics: the job reaches comms through the outbox relay, which ships
#      comms_relay_batch_size rows (100) per comms_relay_interval_seconds
#      (2 s), in id order (core/events/relay.py). Behind a backlog of more
#      than about a thousand rows -- a mass send of notifications -- the job
#      is not even in comms when WAIT_SECONDS run out, and the person gets
#      transcription_unavailable. The quota unit is spent; no model is asked
#      (the recording is deleted first, see _discard).
#   2. Status: acknowledged by design.
#   3. Task: none -- accepted at the BE-184 gate as the price of keeping
#      the endpoint synchronous; the trigger says when it bites.
#   4. Trigger: transcription_deadline in the app log while the outbox has
#      more than comms_relay_batch_size unpublished rows.
#   5. Agreed fix form: a relay pass that keeps shipping while a batch comes
#      back full (no sleep between full batches), or an llm job shipped ahead
#      of notifications.
#   6. Rejected: an XADD into the comms stream straight from this service --
#      the outbox is the one way a request reaches comms (one relay, one
#      order, a request id per entry, redaction of shipped payloads), and a
#      second producer would have to repeat all four.
#
# NOTHING OF A TAKE IN A LOG. Not the link (a working read of the recording
# for its whole life), not the transcript: only the job's key, the reason of
# a failure, and sizes. core/storage.py holds botocore's loggers at WARNING
# for the same reason.
#
# FAILURE MODEL: every failure is a VeloError with a MACHINE CODE, never a
# bare HTTPException with a {"detail": ...} envelope. core/comms.py raises
# nine of those and the frontend cannot read a code off any of them; that is
# a known defect, not a pattern to copy -- the polling loop below swallows
# them and reads again.
#
# WHAT IS NOT HERE, deliberately: the per-person quota. It is spent at the
# route, before this service is called (BE-67, modules/ai/quota.py), because
# it is VELO's budget rule: comms knows the request key, not a person's
# budget.
#
# SESSION RULES: one short transaction of this service's own, holding one
# INSERT (the outbox row) and no lock -- the outbox has no foreign key -- and
# committed before the first read of the job: the relay ships only committed
# rows. No HTTP call is made inside it. The route takes no session.
# =============================================================================

import asyncio
import base64
import binascii
import re
from typing import Protocol
from uuid import UUID, uuid4

import structlog
from fastapi import HTTPException

from app.core import storage
from app.core.database import get_session_factory
from app.core.exceptions import BadRequestError, VeloError
from app.core.llm import LlmAudio, LlmResult, enqueue_llm_job, read_llm_job

logger = structlog.get_logger()

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


# The llm type of comms-profile/types.yaml, and the prefix of its keys. No
# other key of this product starts with it, and no handler of the push
# listener claims it: the listener acknowledges our pushes without a read,
# because this service reads its own job (core/comms_listener.py handle_key).
VOICE_TYPE = "voice.transcribe"
JOB_PREFIX = "llm-voice:"
# The registry type the recordings go to (core/storage_registry.yaml).
VOICE_BUCKET = "voice"
# What the recorder produces (frontend/src/utils/audio.ts), as comms tells
# the model.
AUDIO_FORMAT = "wav"
AUDIO_CONTENT_TYPE = "audio/wav"

# The time ladder (module header). Only these four are this code's; comms'
# own two are named for the ladder's test.
WAIT_SECONDS = 25
POLL_SECONDS = 1.0
JOB_EXPIRES_SECONDS = 30
LINK_TTL_SECONDS = 600
COMMS_LLM_CALL_SECONDS = 120
COMMS_AUDIO_FETCH_SECONDS = 35

# The model's parameters, as they were sent to the provider before BE-184.
_PARAMS = {"temperature": 0, "max_tokens": 1000}

# An answer that came, but whose shape holds no text (core/llm.py reasons):
# the old "no content field" -- silence to the person, who can record again.
# Every other unreadable answer is the transport's or the provider's.
_NO_SPEECH_REASONS = frozenset({"no_choices", "choice_not_an_object", "blank_answer"})

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


class TranscriptionUnavailableError(VeloError):
    """No outcome in time: the storage, the outbox or comms did not get the
    take to the model and back within WAIT_SECONDS."""

    def __init__(self) -> None:
        super().__init__(
            message="Transcription provider did not answer",
            code="transcription_unavailable",
            status_code=502,
        )


class TranscriptionFailedError(VeloError):
    """The job ended without an answer, or with one that is no answer.

    One code for every failure behind comms, including a key out of credit.
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


def job_key(take_id: UUID) -> str:
    """The key of one take's job: a fresh request every time (comms section
    7, "the idempotency key names the request"). The take's id is also the
    id of its recording in the bucket."""
    return f"{JOB_PREFIX}{take_id}"


def letter() -> list[dict[str, str]]:
    """The model's letter: the instruction alone. comms appends the audio
    as the next message (section 11) -- the prompt speaks of "this audio"
    knowing it comes last."""
    return [{"role": "user", "content": _TRANSCRIBE_PROMPT}]


def transcript_of(result: LlmResult) -> str:
    """What one finished job gives the person: the cleaned transcript, or a
    coded failure. Pure; `in_progress` is the caller's to wait on."""
    if result.kind == "answer" and result.text is not None:
        text = clean_transcript(result.text)
        if is_no_speech(text):
            raise SpeechNotRecognizedError()
        return text
    if result.kind == "unreadable" and result.reason in _NO_SPEECH_REASONS:
        raise SpeechNotRecognizedError()
    raise TranscriptionFailedError()


# Deletions in flight: asyncio keeps only a weak reference to a task.
_DISCARDS: set[asyncio.Task[None]] = set()


async def _delete_recording(
    where: storage.Bucket, owner_id: UUID, take_id: UUID,
) -> None:
    try:
        await storage.delete_object(where, owner_id, take_id)
    except storage.StorageError:
        # The bucket's own rule removes it within two days (registry).
        logger.warning("transcription_recording_not_deleted", key=job_key(take_id))


def _discard(where: storage.Bucket, owner_id: UUID, take_id: UUID) -> None:
    """Delete the recording -- on EVERY way out of the service, without
    making the person wait for it.

    THE DEPARTURE FROM THE CONTRACT, deliberate (decided at the BE-184
    gate). comms section 11 asks that "the link and the object live at least
    as long as the job". On an answer or a failure the job is over and the
    rule holds. On WAIT_SECONDS running out it is broken on purpose: the
    person has been told "no" already, and a job that has not fetched the
    body yet then fetches a 404 -- `failed`, message_rejected, no model
    asked, nothing billed. Keeping the object would let an abandoned job
    still reach the model and cost money for an answer nobody reads.

    A task and not FastAPI's BackgroundTasks: those run only after a
    response built from the route's RETURN value (fastapi routing.py,
    get_request_handler) -- a route that raises gets its response from the
    exception handler, and three of the four ways out of here are raises.
    The task uses no session. A process that dies first leaves the object to
    the bucket's one-day rule.
    """
    task = asyncio.create_task(_delete_recording(where, owner_id, take_id))
    _DISCARDS.add(task)
    task.add_done_callback(_DISCARDS.discard)


class TranscriptionServiceProtocol(Protocol):
    """Interface for the voice transcription service."""

    async def transcribe(self, audio: bytes, owner_id: UUID) -> str:
        """Return the transcript of one WAV recording made by `owner_id`.

        Raises a VeloError subclass from this module for every failure; never
        returns an empty string.
        """
        ...


class CommsTranscriptionService:
    """Transcription through an llm job of comms (module header)."""

    async def transcribe(self, audio: bytes, owner_id: UUID) -> str:
        """One take: store, queue, wait for the outcome, clean -- within
        WAIT_SECONDS, and the recording deleted whatever happens.

        The payload was already validated by the caller and the quota spent:
        a malformed or oversized recording is refused before this is
        reached, because that is the failure the person can act on.

        Raises:
            TranscriptionUnavailableError: no outcome within WAIT_SECONDS,
                or the storage refused the recording.
            TranscriptionFailedError: the job ended without an answer.
            SpeechNotRecognizedError: the answer holds no speech.
            sqlalchemy errors: the database refused the outbox row --
                propagated, a 500 like any write that cannot be made.
        """
        take_id = uuid4()
        where = storage.bucket(VOICE_BUCKET)
        try:
            async with asyncio.timeout(WAIT_SECONDS):
                return await self._take(audio, owner_id, take_id, where)
        except TimeoutError as exc:
            logger.warning("transcription_deadline", key=job_key(take_id))
            raise TranscriptionUnavailableError() from exc
        finally:
            _discard(where, owner_id, take_id)

    async def _take(
        self, audio: bytes, owner_id: UUID, take_id: UUID, where: storage.Bucket,
    ) -> str:
        key = job_key(take_id)
        try:
            await storage.put_object(
                where, owner_id, take_id, audio, AUDIO_CONTENT_TYPE,
            )
            link = await storage.signed_read_link(
                where, owner_id, take_id, LINK_TTL_SECONDS,
            )
        except storage.StorageError as exc:
            # The error names the bucket and an S3 code, never the link.
            logger.warning(
                "transcription_storage_failed", key=key, error=type(exc).__name__,
            )
            raise TranscriptionUnavailableError() from exc

        # Committed here: from now on the relay may ship the job.
        async with get_session_factory()() as session, session.begin():
            await enqueue_llm_job(
                session,
                idempotency_key=key,
                type=VOICE_TYPE,
                messages=letter(),
                params=_PARAMS,
                audio=LlmAudio(url=link, format=AUDIO_FORMAT),
            )

        while True:
            await asyncio.sleep(POLL_SECONDS)
            try:
                result = await read_llm_job(key)
            except HTTPException:
                # comms did not answer this read; the deadline bounds the
                # next ones (core/comms.py logged the failure).
                continue
            if result.kind != "in_progress":
                return transcript_of(result)


def get_transcription_service() -> TranscriptionServiceProtocol:
    """FastAPI dependency -- the active transcription implementation.

    A separate seam from get_ai_service(): the two capabilities are swapped
    independently, and today one of them is real while the other is still a
    stub. See this module's header for why they do not share a protocol.
    """
    return CommsTranscriptionService()
