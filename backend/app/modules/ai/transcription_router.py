# =============================================================================
# VELO Backend -- Voice transcription router (GT-41)
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
# AUTH: get_current_user, and it is the ONLY thing protecting the budget.
# Anyone authenticated may transcribe as much as they like; there is no
# per-person quota in this delivery because nobody has decided what it should
# be. Anonymous access would let a stranger spend our credit, so the
# dependency runs before a single byte of audio is looked at.
#
# SESSION: none. This endpoint touches no database at all -- it takes no
# session dependency rather than taking one and ignoring it.
# =============================================================================

import structlog
from fastapi import APIRouter, Depends

from app.modules.ai.schemas import TranscribeRequest, TranscribeResponse
from app.modules.ai.transcription import (
    TranscriptionServiceProtocol,
    decode_audio,
    get_transcription_service,
)
from app.modules.auth.dependencies import get_current_user
from app.modules.users.models import User

logger = structlog.get_logger()

router = APIRouter(prefix="/api/v1/ai", tags=["ai"])


@router.post("/transcribe", response_model=TranscribeResponse)
async def transcribe_endpoint(
    body: TranscribeRequest,
    user: User = Depends(get_current_user),
    service: TranscriptionServiceProtocol = Depends(get_transcription_service),
) -> TranscribeResponse:
    """Transcribe one recording for the authenticated user.

    Order of refusals is deliberate and asserted by tests: authentication
    first (a stranger never reaches our provider), then the payload
    (malformed or oversized audio costs us nothing to refuse), then the key
    and the provider inside the service. A person who sends a huge file to a
    server with no key is told the file is too large, because that is the
    problem they can actually fix.
    """
    audio = decode_audio(body.audio_base64)
    text = await service.transcribe(audio)

    logger.info(
        "transcription_completed",
        user_id=str(user.id),
        audio_bytes=len(audio),
        text_length=len(text),
    )

    return TranscribeResponse(text=text)
