# =============================================================================
# VELO Backend -- AI Schemas (Phase 9.1)
# =============================================================================
#
# Response models for the two AI endpoints, which share a module and
# nothing else:
#   GET  /api/v1/practices/{id}/ai-summary -- still a stub (is_mock=True)
#   POST /api/v1/ai/transcribe             -- real, GT-41
# =============================================================================

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class AISummaryResponse(BaseModel):
    """GET /api/v1/practices/{id}/ai-summary -- response body.

    practice_id: The practice this summary belongs to.
    summary:     Generated text. Placeholder in Phase 9.1.
    is_mock:     True when returned by MockAIService.
    generated_at: When the summary was produced.
    """

    practice_id: UUID
    summary: str
    is_mock: bool
    generated_at: datetime


class TranscribeRequest(BaseModel):
    """POST /api/v1/ai/transcribe -- request body.

    audio_base64: one WAV recording, base64-encoded. Base64 rather than
        multipart because the frontend's shared client serialises every body
        as JSON, and a second transport would have to be built and kept in
        step for one endpoint.

        The size ceiling is enforced on the DECODED bytes
        (transcription.MAX_AUDIO_BYTES), not on this string: base64 is a
        third larger than what the recorder produced and a third larger than
        what the provider receives.
    """

    audio_base64: str


class TranscribeResponse(BaseModel):
    """POST /api/v1/ai/transcribe -- response body.

    Success only: every failure leaves through a VeloError with a machine
    code, so this model never has to carry an "ok" flag or an error field.
    text is never empty -- an empty transcript is speech_not_recognized.
    """

    text: str
