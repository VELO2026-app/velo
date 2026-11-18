# =============================================================================
# VELO Backend -- Voice transcription router (GT-41, BE-184)
# =============================================================================
#
# ENDPOINT:
#   POST /api/v1/ai/transcribe -- one WAV recording in, one transcript out.
#
# WHY A SECOND ROUTER IN THIS MODULE rather than a route on router.py: that
# one is mounted under /api/v1/practices because a summary belongs to a
# practice. A transcription belongs to nobody -- it is a recording the person
# just made, attached to no row -- and hanging it off a practice id would
# invent an owner the feature does not have.
#
# AUTH AND QUOTA: get_current_user keeps strangers away from our credit --
# the dependency runs before a single byte of audio is looked at. Signed-in
# people are bounded by a daily quota per person (BE-67, modules/ai/quota.py),
# spent before the take is handed on; the quota lives here, at VELO's entry
# point, because comms -- which carries the take to the model since BE-184 --
# knows the request key, not a person's budget.
#
# SESSION: none here. The route takes no session dependency; the quota
# counter is in Redis, and the service opens one short transaction of its
# own for the job's outbox row, committed before it waits
# (modules/ai/transcription.py, SESSION RULES).
# =============================================================================

import structlog
from fastapi import APIRouter, Depends

from app.core.options import option_dependency
from app.modules.ai.quota import consume_transcription_quota
from app.modules.ai.schemas import TranscribeRequest, TranscribeResponse
from app.modules.ai.transcription import (
    TranscriptionServiceProtocol,
    decode_audio,
    get_transcription_service,
)
from app.modules.auth.dependencies import get_current_user
from app.modules.users.models import User

logger = structlog.get_logger()

router = APIRouter(
    prefix="/api/v1/ai",
    tags=["ai"],
    # BE-182: voice transcription is an LLM function -- the option `llm`
    # closes it (app/core/options.py).
    dependencies=[option_dependency("llm")],
)


@router.post("/transcribe", response_model=TranscribeResponse)
async def transcribe_endpoint(
    body: TranscribeRequest,
    user: User = Depends(get_current_user),
    service: TranscriptionServiceProtocol = Depends(get_transcription_service),
) -> TranscribeResponse:
    """Transcribe one recording for the authenticated user.

    Order of refusals is deliberate and asserted by tests: authentication
    first (a stranger never reaches our credit), then the payload
    (malformed or oversized audio costs us nothing to refuse, and does not
    spend the person's quota), then the daily quota (BE-67), then the
    storage, comms and the model inside the service.

    The quota comes BEFORE the storage, and that has a price, named here
    because it is a decision and not an accident: a take the storage refuses
    still spends a unit, although no model was asked.
    """
    audio = decode_audio(body.audio_base64)
    await consume_transcription_quota(user.id)
    text = await service.transcribe(audio, user.id)

    logger.info(
        "transcription_completed",
        user_id=str(user.id),
        audio_bytes=len(audio),
        text_length=len(text),
    )

    return TranscribeResponse(text=text)
