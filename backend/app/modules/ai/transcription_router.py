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
# AUTH AND QUOTA: get_current_user keeps strangers away from our credit --
# the dependency runs before a single byte of audio is looked at. Signed-in
# people are bounded by a daily quota per person (BE-67, modules/ai/quota.py),
# spent before the provider is called; the quota lives here, at VELO's entry
# point, rather than in the provider client, so it survives voice moving to
# comms (BE-136).
#
# SESSION: none. This endpoint touches no database at all -- it takes no
# session dependency rather than taking one and ignoring it. The quota
# counter is in Redis, not in Postgres.
# =============================================================================

import structlog
from fastapi import APIRouter, Depends

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
    (malformed or oversized audio costs us nothing to refuse, and does not
    spend the person's quota), then the daily quota (BE-67), then the key
    and the provider inside the service. A person who sends a huge file to a
    server with no key is told the file is too large, because that is the
    problem they can actually fix.

    The quota comes BEFORE the key, and that has a price, named here because
    it is a decision and not an accident: on a server with no key every take
    still spends a unit, although nothing is billed. The feature is off
    there anyway; the person is told so until the quota runs out, and then
    is told the quota is used up.
    """
    audio = decode_audio(body.audio_base64)
    await consume_transcription_quota(user.id)
    text = await service.transcribe(audio)

    logger.info(
        "transcription_completed",
        user_id=str(user.id),
        audio_bytes=len(audio),
        text_length=len(text),
    )

    return TranscribeResponse(text=text)
