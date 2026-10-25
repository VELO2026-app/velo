# =============================================================================
# VELO Backend -- LLM jobs over comms (BE-134)
# =============================================================================
#
# comms carries a letter to a model and keeps the answer; it never reads
# either (comms deploy/INTEGRATION.md section 11). Two calls, one each way:
#
#   enqueue_llm_job -- a notification_request of an llm type through the
#     OUTBOX, in the caller's transaction: the job exists exactly when the
#     caller's change commits. The envelope is the key and the type; the
#     letter is `llm` and nothing else (no address, no title/body -- comms
#     rejects them on an llm type).
#   read_llm_job -- the job read back by its key (section 8) and decided
#     into ONE of four (LlmResult): the model's text, an answer that cannot
#     be read, a job that ended without an answer, or still in work.
#
# TWO KINDS OF "NO", KEPT APART because comms keeps them apart (section
# 12): a job that ended WITHOUT an answer -- failed, expired, cancelled, or
# refused at intake -- is the TRANSPORT's ("failed"); asking again is a new
# job. A job that ANSWERED is an answer to comms whatever it says -- a cut
# text, a filtered one, not a chat completion, purged before it was read:
# "unreadable" is the product's verdict on an answer, never comms'. Only a
# chat completion whose first choice finished with "stop" and carries
# non-blank text is an answer ("answer", the text). What the text says is
# the caller's to parse (support/translation.py parse_translation).
#
# NO TEXT IN A LOG. The letter carries what a person wrote and the answer
# carries its translation; neither is ever logged here -- only the key and
# the reason. The letter's copy in the outbox row is redacted by the
# relay's retention pass like every shipped payload (relay.py
# redact_published_payloads, PAYLOAD_RETENTION_DAYS) -- not at publication.
# =============================================================================

import json
from dataclasses import dataclass
from typing import Any, Literal

import structlog
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.comms import comms_request
from app.core.events.models import OutboxEvent
from app.core.events.notify import _envelope_string
from app.core.events.service import EVENT_NOTIFICATION_REQUEST, emit_event

logger = structlog.get_logger()

BY_KEY_PATH = "/api/v1/notifications/by-key"

# comms job statuses that are not an outcome yet (section 8, `job`).
_ACTIVE_STATUSES = frozenset({"pending", "processing"})


@dataclass(frozen=True)
class LlmResult:
    """What became of one llm job.

    kind:
      "answer"      -- `text` is the model's answer, stripped, non-blank;
      "unreadable"  -- the job answered, and the answer cannot be used;
      "failed"      -- the job ended without an answer (the transport's);
      "in_progress" -- not over yet, or comms does not know the key yet
                       (the outbox row not relayed): read again later.
    `reason` names why, for the log and the tests -- never any text.
    """

    kind: Literal["answer", "unreadable", "failed", "in_progress"]
    text: str | None = None
    reason: str | None = None


async def enqueue_llm_job(
    session: AsyncSession,
    *,
    idempotency_key: str,
    type: str,
    messages: list[dict[str, Any]],
    params: dict[str, Any] | None = None,
) -> OutboxEvent:
    """Queue one llm job in the caller's transaction.

    Args:
        session: The caller's read-write session; the job commits and
            rolls back with the caller's change.
        idempotency_key: Names THIS request (1..200 characters): the same
            key is the same job; asking again is a new key.
        type: An llm type of the comms profile (channels: [llm]).
        messages: The chat messages, handed to the model as they are.
        params: The model's parameters (temperature, ...); never a name
            the transport writes (comms rejects those at intake).
    """
    letter: dict[str, Any] = {"messages": messages}
    if params:
        letter["params"] = params
    return await emit_event(
        session,
        EVENT_NOTIFICATION_REQUEST,
        {
            "idempotency_key": _envelope_string(
                "idempotency_key",
                idempotency_key,
            ),
            "type": type,
            "llm": letter,
        },
    )


async def read_llm_job(idempotency_key: str) -> LlmResult:
    """Read one llm job by its key and decide what became of it.

    Raises:
        HTTPException: comms unreachable or answering something it should
            not (core/comms.py) -- the caller reads again later. A 404 is
            not raised: it is in_progress (see LlmResult).
    """
    try:
        payload = await comms_request(
            "GET",
            BY_KEY_PATH,
            params={"key": idempotency_key},
        )
    except HTTPException as exc:
        if exc.status_code == 404:
            # Never received yet (the relay has not shipped it), or past
            # comms' retention. The first is the only one that reaches an
            # unfinished row of ours within the retention window.
            return LlmResult("in_progress", reason="not_found")
        raise
    result = decide(payload)
    if result.kind in ("unreadable", "failed"):
        logger.info(
            "llm_job_without_answer",
            key=idempotency_key,
            kind=result.kind,
            reason=result.reason,
        )
    return result


def decide(payload: Any) -> LlmResult:
    """The by-key summary (comms section 8) -> an LlmResult. Pure."""
    if not isinstance(payload, dict):
        return LlmResult("failed", reason="summary_not_an_object")
    job = payload.get("job")
    if job is None:
        intake = payload.get("intake")
        if isinstance(intake, list) and intake:
            # Refused at intake: comms never took it and never will --
            # only a corrected request under a new key would be.
            return LlmResult("failed", reason="rejected_at_intake")
        return LlmResult("in_progress", reason="no_job_yet")
    if not isinstance(job, dict):
        return LlmResult("failed", reason="job_not_an_object")
    status = job.get("status")
    if status in _ACTIVE_STATUSES:
        return LlmResult("in_progress")
    if status != "sent":
        return LlmResult("failed", reason=f"status_{status}")
    answer = job.get("answer")
    if not isinstance(answer, dict):
        return LlmResult("unreadable", reason="no_answer")
    if answer.get("state") == "purged":
        return LlmResult("unreadable", reason="purged")
    body = answer.get("body")
    if answer.get("state") != "kept" or not isinstance(body, str):
        return LlmResult("unreadable", reason="no_answer")
    return parse_chat_completion(body)


def parse_chat_completion(body: str) -> LlmResult:
    """A provider's raw chat-completion body -> answer or unreadable. Pure."""
    try:
        doc = json.loads(body)
    except ValueError:
        return LlmResult("unreadable", reason="body_not_json")
    choices = doc.get("choices") if isinstance(doc, dict) else None
    if not isinstance(choices, list) or not choices:
        return LlmResult("unreadable", reason="no_choices")
    first = choices[0]
    if not isinstance(first, dict):
        return LlmResult("unreadable", reason="choice_not_an_object")
    if first.get("finish_reason") != "stop":
        return LlmResult("unreadable", reason="not_finished")
    message = first.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, str) or not content.strip():
        return LlmResult("unreadable", reason="blank_answer")
    return LlmResult("answer", text=content.strip())
