# =============================================================================
# VELO Backend -- Tests: voice transcription (GT-41, BE-184)
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
# empty content field, and a response shape without choices. Since BE-184
# the last two arrive as comms' answer to an llm job and are asserted on
# that path (test_every_outcome_of_the_job_has_its_code).
#
# HOW A TAKE IS FAKED (BE-184). Three seams, each the one the real path
# crosses:
#
#   - the storage: put_object, signed_read_link and delete_object of
#     app.core.storage are replaced by FakeStore -- the live storage is
#     tests/test_storage.py's, and a recording the service never needs to
#     read back would only make this file depend on velo-storage too;
#   - comms: app.core.llm.comms_request, as tests/test_support_translation.py
#     does -- so read_llm_job and decide run for real over the summary comms
#     would give (deploy/INTEGRATION.md section 8);
#   - the outbox: REAL. The job's row is written and committed by the
#     service's own transaction and read back here; its rows are removed by
#     key prefix (the band's cleanup does not reach a row with no person).
#
# THE CLOCK. POLL_SECONDS is cut to a hundredth so a take is quick, and
# WAIT_SECONDS to a fraction of a second where the deadline is the point.
#
# Endpoint tests stub OUR OWN service method (_TRANSCRIBE_SEAM), never the
# transport under it: the test client IS an httpx.AsyncClient, and patching
# httpx there hijacks the request the test itself makes into the app.
# =============================================================================

import asyncio
import base64
import json
from collections.abc import AsyncGenerator
from dataclasses import dataclass, field
from typing import Any
from unittest.mock import AsyncMock, patch
from uuid import UUID

import pytest
import structlog
from fastapi import HTTPException
from httpx import AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import storage
from app.core.database import get_session_factory
from app.core.events.models import OutboxEvent
from app.core.exceptions import VeloError
from app.core.storage_registry import load_registry
from app.modules.ai import transcription
from app.modules.ai.transcription import (
    AUDIO_FORMAT,
    JOB_PREFIX,
    LINK_TTL_SECONDS,
    MAX_AUDIO_BYTES,
    VOICE_TYPE,
    CommsTranscriptionService,
    clean_transcript,
    decode_audio,
    is_no_speech,
)
from tests.helpers import auth_headers, full_cleanup_range, login_user, sent_data

TRANSCRIBE_URL = "/api/v1/ai/transcribe"

_TID_MIN = 69200
_TID_MAX = 69299

# The endpoint tests' seam: our service's own method, not the transport.
_TRANSCRIBE_SEAM = (
    "app.modules.ai.transcription.CommsTranscriptionService.transcribe"
)

_OWNER = UUID("00000000-0000-4000-8000-000000069201")


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """Clean all test data for this band before/after each test (ORM only),
    and every voice job's outbox row."""
    await _do_cleanup(db_session)
    yield
    await _do_cleanup(db_session)


async def _do_cleanup(session: AsyncSession) -> None:
    # full_cleanup_range does not commit on its own.
    await full_cleanup_range(session, _TID_MIN, _TID_MAX, delete_users=True)
    await session.execute(
        delete(OutboxEvent).where(
            OutboxEvent.payload["idempotency_key"].astext.like(f"{JOB_PREFIX}%"),
        )
    )
    await session.commit()


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
# The fakes
# ===================================================================


@dataclass
class FakeStore:
    """The three storage calls the service makes, recorded."""

    put: list[tuple[str, UUID, UUID, bytes, str]] = field(default_factory=list)
    signed: list[tuple[str, UUID, UUID, int]] = field(default_factory=list)
    deleted: list[tuple[str, UUID, UUID]] = field(default_factory=list)
    put_error: Exception | None = None

    async def put_object(self, where, owner_id, object_id, body, content_type):
        if self.put_error is not None:
            raise self.put_error
        self.put.append((where.name, owner_id, object_id, body, content_type))
        return f"{owner_id}/{object_id}"

    async def signed_read_link(self, where, owner_id, object_id, ttl_seconds):
        self.signed.append((where.name, owner_id, object_id, ttl_seconds))
        return (
            f"http://velo-storage:9000/{where.name}/{owner_id}/{object_id}"
            f"?X-Amz-Signature=sig-{object_id.hex}"
        )

    async def delete_object(self, where, owner_id, object_id):
        self.deleted.append((where.name, owner_id, object_id))


def _completion(content: Any, finish: str = "stop") -> str:
    return json.dumps(
        {"choices": [{"finish_reason": finish, "message": {"content": content}}]}
    )


def _sent(body: str) -> dict:
    """A job that answered (section 8 summary)."""
    return {
        "intake": [],
        "job": {"status": "sent", "answer": {"state": "kept", "body": body}},
    }


def _ended(status: str) -> dict:
    return {"intake": [], "job": {"status": status, "answer": {"state": "none"}}}


_PENDING = {"intake": [], "job": {"status": "pending", "answer": {"state": "none"}}}
_REJECTED = {
    "intake": [{"outcome": "rejected_at_intake", "reason": "x"}],
    "job": None,
}


class FakeComms:
    """comms' read by key. `script` is what the reads of ONE key return, in
    order -- a summary, or an exception to raise; the last one repeats.
    The first read also records whether the job's outbox row was already
    COMMITTED, looked up from a session of its own."""

    def __init__(self, *script: Any) -> None:
        self.script = list(script)
        self.reads: list[str] = []
        self.committed_at_first_read: bool | None = None

    async def __call__(self, method: str, path: str, **kwargs: Any) -> Any:
        assert (method, path) == ("GET", "/api/v1/notifications/by-key")
        key = kwargs["params"]["key"]
        if not self.reads:
            async with get_session_factory()() as other:
                row = (
                    await other.execute(
                        select(OutboxEvent.id).where(
                            OutboxEvent.payload["idempotency_key"].astext == key,
                        )
                    )
                ).first()
            self.committed_at_first_read = row is not None
        self.reads.append(key)
        step = self.script[min(len(self.reads) - 1, len(self.script) - 1)]
        if isinstance(step, Exception):
            raise step
        return step


@pytest.fixture
def store(monkeypatch: pytest.MonkeyPatch) -> FakeStore:
    fake = FakeStore()
    for name in ("put_object", "signed_read_link", "delete_object"):
        monkeypatch.setattr(storage, name, getattr(fake, name))
    return fake


@pytest.fixture(autouse=True)
def quick_poll(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(transcription, "POLL_SECONDS", 0.01)


def _comms(monkeypatch: pytest.MonkeyPatch, *script: Any) -> FakeComms:
    fake = FakeComms(*script)
    monkeypatch.setattr("app.core.llm.comms_request", fake)
    return fake


async def _discards_done() -> None:
    """The recording is deleted by a task of its own; wait for it."""
    await asyncio.gather(*list(transcription._DISCARDS))


async def _job_rows(session: AsyncSession) -> list[OutboxEvent]:
    return list(
        (
            await session.execute(
                select(OutboxEvent)
                .where(
                    OutboxEvent.payload["idempotency_key"].astext.like(
                        f"{JOB_PREFIX}%"
                    ),
                )
                .order_by(OutboxEvent.id)
            )
        )
        .scalars()
        .all()
    )


# ===================================================================
# The take: storage, the job, the answer
# ===================================================================


async def test_the_take_goes_to_comms_as_an_llm_job_with_its_recording_by_link(
    monkeypatch: pytest.MonkeyPatch, store: FakeStore, db_session: AsyncSession,
) -> None:
    """item 1 and 2: the recording in the `voice` bucket under <person>/<take>,
    a link signed for LINK_TTL_SECONDS, and comms given an llm job of the
    voice type whose envelope carries that link BESIDE the letter."""
    comms = _comms(monkeypatch, _sent(_completion("привет")))

    text = await CommsTranscriptionService().transcribe(b"wav-bytes", _OWNER)
    await _discards_done()

    assert text == "привет"
    [(bucket, owner, take, body, content_type)] = store.put
    assert (bucket, owner, body, content_type) == (
        "voice", _OWNER, b"wav-bytes", "audio/wav",
    )
    assert store.signed == [("voice", _OWNER, take, LINK_TTL_SECONDS)]

    [row] = await _job_rows(db_session)
    data = sent_data(row)
    assert data["idempotency_key"] == f"{JOB_PREFIX}{take}"
    assert comms.reads and set(comms.reads) == {data["idempotency_key"]}
    assert data["type"] == VOICE_TYPE
    assert data["llm"] == {
        "messages": [{"role": "user", "content": transcription._TRANSCRIBE_PROMPT}],
        "params": {"temperature": 0, "max_tokens": 1000},
    }
    assert data["llm_audio"] == {
        "url": f"http://velo-storage:9000/voice/{_OWNER}/{take}"
        f"?X-Amz-Signature=sig-{take.hex}",
        "format": AUDIO_FORMAT,
    }
    # No address, no title, no body: comms refuses them on an llm type.
    assert set(data) == {"v", "idempotency_key", "type", "llm", "llm_audio"}
    assert store.deleted == [("voice", _OWNER, take)]


async def test_the_job_is_committed_before_it_is_read(
    monkeypatch: pytest.MonkeyPatch, store: FakeStore,
) -> None:
    """The relay ships only committed rows: a job still inside an open
    transaction while the service waits would never reach comms."""
    comms = _comms(monkeypatch, _sent(_completion("текст")))

    await CommsTranscriptionService().transcribe(b"wav", _OWNER)
    await _discards_done()

    assert comms.committed_at_first_read is True


async def test_every_take_is_a_new_request(
    monkeypatch: pytest.MonkeyPatch, store: FakeStore, db_session: AsyncSession,
) -> None:
    """ПОВТОР: the same recording twice is two takes -- two keys, two
    recordings -- never comms' "duplicate" of the first (section 7: the key
    names the request)."""
    _comms(monkeypatch, _sent(_completion("раз")))

    for _ in range(2):
        await CommsTranscriptionService().transcribe(b"same-bytes", _OWNER)
    await _discards_done()

    keys = [sent_data(r)["idempotency_key"] for r in await _job_rows(db_session)]
    takes = [take for _, _, take, _, _ in store.put]
    assert len(set(keys)) == 2
    assert keys == [f"{JOB_PREFIX}{take}" for take in takes]
    assert sorted(t for _, _, t in store.deleted) == sorted(takes)


@pytest.mark.parametrize(
    ("summary", "code"),
    [
        (_sent(_completion("[NO_SPEECH]")), "speech_not_recognized"),
        (_sent(_completion("Извините, ничего не слышно.")), "speech_not_recognized"),
        (_sent(_completion("   ")), "speech_not_recognized"),
        (_sent(_completion(None)), "speech_not_recognized"),
        (_sent(json.dumps({"choices": []})), "speech_not_recognized"),
        (_sent(json.dumps({})), "speech_not_recognized"),
        (_sent("<html>not json</html>"), "transcription_failed"),
        (_sent(_completion("обрезан", finish="length")), "transcription_failed"),
        (_ended("failed"), "transcription_failed"),
        (_ended("expired"), "transcription_failed"),
        (_ended("cancelled"), "transcription_failed"),
        (_REJECTED, "transcription_failed"),
    ],
    ids=[
        "marker",
        "apology",
        "blank",
        "no_content",
        "no_choices",
        "not_a_completion",
        "body_not_json",
        "cut",
        "failed",
        "expired",
        "cancelled",
        "rejected_at_intake",
    ],
)
async def test_every_outcome_of_the_job_has_its_code(
    monkeypatch: pytest.MonkeyPatch, store: FakeStore, summary: dict, code: str,
) -> None:
    """ПУСТОТА: silence and an answer without text are the person's to
    retry (400); a job that ended without an answer, or with one that is no
    answer, is ours (502) -- and the recording goes either way."""
    _comms(monkeypatch, _PENDING, summary)

    with pytest.raises(VeloError) as exc:
        await CommsTranscriptionService().transcribe(b"wav", _OWNER)
    await _discards_done()

    assert exc.value.code == code
    [(_, _, take, _, _)] = store.put
    assert store.deleted == [("voice", _OWNER, take)]


async def test_the_answer_is_cleaned_as_before(
    monkeypatch: pytest.MonkeyPatch, store: FakeStore,
) -> None:
    """The pair of the silence cases on the same path: a real transcript in
    the model's dressing comes back as the person's words."""
    _comms(monkeypatch, _sent(_completion("```\n«реальный текст»\n```")))

    text = await CommsTranscriptionService().transcribe(b"wav", _OWNER)
    await _discards_done()

    assert text == "реальный текст"


async def test_a_job_not_yet_in_comms_and_a_comms_blip_are_waited_out(
    monkeypatch: pytest.MonkeyPatch, store: FakeStore,
) -> None:
    """404 (the relay has not shipped it), a 502 from comms, a job in work --
    each is read again, and the answer that follows is the person's."""
    comms = _comms(
        monkeypatch,
        HTTPException(status_code=404),
        HTTPException(status_code=502),
        _PENDING,
        _sent(_completion("дождались")),
    )

    text = await CommsTranscriptionService().transcribe(b"wav", _OWNER)
    await _discards_done()

    assert text == "дождались"
    assert len(comms.reads) == 4


async def test_no_outcome_in_time_is_unavailable_and_the_recording_goes(
    monkeypatch: pytest.MonkeyPatch, store: FakeStore,
) -> None:
    """НЕХВАТКА: WAIT_SECONDS bound the whole take. The person is told the
    service did not answer, and the recording is deleted although the job
    may still be alive -- a job that has not fetched it yet then fails at
    the fetch and asks no model (transcription._discard)."""
    monkeypatch.setattr(transcription, "WAIT_SECONDS", 0.2)
    comms = _comms(monkeypatch, _PENDING)

    # The outer bound only keeps a service without a deadline from hanging
    # the suite; the code asserted is the service's own.
    with pytest.raises(VeloError) as exc:
        await asyncio.wait_for(
            CommsTranscriptionService().transcribe(b"wav", _OWNER), timeout=5,
        )
    await _discards_done()

    assert exc.value.code == "transcription_unavailable"
    assert len(comms.reads) >= 2  # it did wait, and read more than once
    [(_, _, take, _, _)] = store.put
    assert store.deleted == [("voice", _OWNER, take)]


async def test_a_storage_that_refuses_is_unavailable_and_no_job_is_queued(
    monkeypatch: pytest.MonkeyPatch, store: FakeStore, db_session: AsyncSession,
) -> None:
    """НЕХВАТКА of the storage: no recording, no job -- comms is never
    asked to fetch something that is not there."""
    store.put_error = storage.StorageUnavailableError("voice: 503")
    comms = _comms(monkeypatch, _sent(_completion("никогда")))

    with pytest.raises(VeloError) as exc:
        await CommsTranscriptionService().transcribe(b"wav", _OWNER)
    await _discards_done()

    assert exc.value.code == "transcription_unavailable"
    assert await _job_rows(db_session) == []
    assert comms.reads == []


async def test_the_recording_is_deleted_without_delaying_the_answer(
    monkeypatch: pytest.MonkeyPatch, store: FakeStore,
) -> None:
    """A slow storage at the delete does not hold the person's answer: the
    transcript is back while the deletion is still in flight."""
    _comms(monkeypatch, _sent(_completion("сразу")))
    released = asyncio.Event()

    async def slow_delete(where, owner_id, object_id):
        await released.wait()
        store.deleted.append((where.name, owner_id, object_id))

    monkeypatch.setattr(storage, "delete_object", slow_delete)

    # Bounded: a service that awaited the deletion would wait here forever.
    text = await asyncio.wait_for(
        CommsTranscriptionService().transcribe(b"wav", _OWNER), timeout=5,
    )

    assert text == "сразу"
    assert store.deleted == []
    released.set()
    await _discards_done()
    assert len(store.deleted) == 1


async def test_a_delete_the_storage_refuses_is_logged_not_raised(
    monkeypatch: pytest.MonkeyPatch, store: FakeStore,
) -> None:
    """The bucket's own rule is the fallback; the take's answer stands."""
    _comms(monkeypatch, _sent(_completion("текст")))

    async def refusing_delete(where, owner_id, object_id):
        raise storage.StorageUnavailableError("voice: 503")

    monkeypatch.setattr(storage, "delete_object", refusing_delete)

    with structlog.testing.capture_logs() as logs:
        text = await CommsTranscriptionService().transcribe(b"wav", _OWNER)
        await _discards_done()

    assert text == "текст"
    [refused] = [
        e for e in logs if e["event"] == "transcription_recording_not_deleted"
    ]
    assert refused["key"].startswith(JOB_PREFIX)


# ===================================================================
# Nothing of a take in a log
# ===================================================================


async def test_no_link_and_no_transcript_in_any_log(
    monkeypatch: pytest.MonkeyPatch, store: FakeStore,
) -> None:
    """The link reads the person's recording for its whole life, and the
    transcript is their words: neither in a log line, on the paths that log.
    The pair: those paths DO log, and name the job by its key."""
    words = "секретные слова человека"

    _comms(monkeypatch, _sent(_completion(words)))
    with structlog.testing.capture_logs() as ok_logs:
        assert await CommsTranscriptionService().transcribe(b"wav", _OWNER) == words
        await _discards_done()

    monkeypatch.setattr(transcription, "WAIT_SECONDS", 0.1)
    _comms(monkeypatch, _PENDING)
    with structlog.testing.capture_logs() as deadline_logs:
        with pytest.raises(VeloError):
            await asyncio.wait_for(
                CommsTranscriptionService().transcribe(b"wav", _OWNER), timeout=5,
            )
        await _discards_done()

    links = [f"sig-{take.hex}" for _, _, take, _, _ in store.put]
    [deadline] = [e for e in deadline_logs if e["event"] == "transcription_deadline"]
    assert deadline["key"] == f"{JOB_PREFIX}{store.put[-1][2]}"
    for line in [repr(e) for e in ok_logs + deadline_logs]:
        assert words not in line
        assert all(sig not in line for sig in links)


# ===================================================================
# The time ladder (transcription.py header) and the type's numbers
# ===================================================================


def test_the_time_ladder_holds() -> None:
    """Whoever gives up first must not be the one holding the bill.

    browser 30 s (frontend/src/api/transcription.ts TIMEOUT_MS -- the test
    image carries no frontend, so the number is written here) > the
    endpoint's wait < the job's expiry; the link outlives the job's longest
    life and dies before the bucket's shortest rule can remove the object.
    The type's record is pinned against the same constants by
    tests/test_comms_protocol_3.py."""
    browser = 30
    longest_job = (
        transcription.JOB_EXPIRES_SECONDS
        + transcription.COMMS_LLM_CALL_SECONDS
        + transcription.COMMS_AUDIO_FETCH_SECONDS
    )
    voice_rule_days = load_registry().bucket_type("voice").expire_days

    wait = transcription.WAIT_SECONDS
    link = transcription.LINK_TTL_SECONDS
    assert wait < browser
    assert wait < transcription.JOB_EXPIRES_SECONDS
    assert longest_job < link
    assert voice_rule_days is not None
    assert link < voice_rule_days * 86400


# ===================================================================
# The endpoint
# ===================================================================


async def test_endpoint_returns_the_transcript(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The whole path, from base64 in to text out."""
    login = await login_user(client, telegram_id=69201, first_name="Caller")
    audio = base64.b64encode(b"wav-bytes").decode()
    transcribe = AsyncMock(return_value="привет")

    with patch(_TRANSCRIBE_SEAM, transcribe):
        response = await client.post(
            TRANSCRIBE_URL,
            headers=auth_headers(login["session_token"]),
            json={"audio_base64": audio},
        )

    assert response.status_code == 200
    assert response.json() == {"text": "привет"}
    # The route decoded the payload and handed the SERVICE bytes, not base64:
    # without this the test would pass on a route that forwarded the string.
    # The owner is the caller: the recording is filed under them.
    assert transcribe.await_args.args == (
        b"wav-bytes", UUID(login["user"]["id"]),
    )


async def test_endpoint_refuses_an_anonymous_caller_before_any_provider_call(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A stranger never reaches our provider, and never spends our credit.

    The un-awaited stub is the load-bearing half: a 401 that still made the
    outbound call would be exactly the hole this delivery closes.
    """
    transcribe = AsyncMock(return_value="никогда")
    with patch(_TRANSCRIBE_SEAM, transcribe):
        response = await client.post(
            TRANSCRIBE_URL,
            json={"audio_base64": base64.b64encode(b"wav").decode()},
        )

    assert response.status_code == 401
    transcribe.assert_not_awaited()


async def test_endpoint_refuses_oversized_audio_before_the_service(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Order of refusals, pinned: the payload is judged before anything is
    stored or queued -- that is the failure the person can act on.

    Until BE-184 this was "before the key is consulted", run on a server
    with no key; the key left with OpenRouter, and the property that stays
    is that an oversized take never reaches the service.
    """
    login = await login_user(client, telegram_id=69201, first_name="Caller")
    oversized = base64.b64encode(b"\x00" * (MAX_AUDIO_BYTES + 1)).decode()

    transcribe = AsyncMock(return_value="никогда")
    with patch(_TRANSCRIBE_SEAM, transcribe):
        response = await client.post(
            TRANSCRIBE_URL,
            headers=auth_headers(login["session_token"]),
            json={"audio_base64": oversized},
        )

    assert response.status_code == 400
    assert response.json()["error"] == "audio_too_large"
    transcribe.assert_not_awaited()


async def test_endpoint_takes_a_recording_to_comms_and_back(
    client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    store: FakeStore,
) -> None:
    """The whole path with only the storage and comms faked: the caller's
    recording, under the caller, one job, the text back, the recording gone."""
    login = await login_user(client, telegram_id=69201, first_name="Caller")
    caller = UUID(login["user"]["id"])
    _comms(monkeypatch, _sent(_completion("целиком")))

    response = await client.post(
        TRANSCRIBE_URL,
        headers=auth_headers(login["session_token"]),
        json={"audio_base64": base64.b64encode(b"wav-bytes").decode()},
    )
    await _discards_done()

    assert response.status_code == 200
    assert response.json() == {"text": "целиком"}
    [(_, owner, take, body, _)] = store.put
    assert (owner, body) == (caller, b"wav-bytes")
    assert len(await _job_rows(db_session)) == 1
    assert store.deleted == [("voice", caller, take)]
