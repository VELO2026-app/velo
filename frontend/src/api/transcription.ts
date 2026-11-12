/**
 * VELO Frontend -- transcription through our own backend (GT-41)
 *
 * REPLACES src/api/openrouter.ts, which called OpenRouter straight from the
 * browser with a key compiled into the bundle. That key was readable by
 * anyone who opened the page, and it opened a UNIVERSAL endpoint: whoever
 * took it could run any model on our account. Per-person limits, audit and
 * revocation were all impossible while the server was not in the loop.
 *
 * WHAT STAYED HERE: one request and a message table. The prompt, the model
 * choice, the [NO_SPEECH] marker and the transcript cleaning moved to the
 * backend with the key -- they are about how we ask the model, and the
 * browser no longer talks to it.
 *
 * THE SHARED CLIENT, WITH ITS OWN TIMEOUT (FE-157). This module used to
 * send a raw fetch because the shared client aborted every request at 15
 * seconds; a minute of audio does not come back in 15 seconds, and an abort
 * on our side does not stop the completion the server is already paying for.
 * api.request() now takes a per-call timeout, so the request rides the client
 * (token, request id, 401 handling) with a longer one. The timeout ladder is
 * deliberate:
 * `browser 30s > backend 25s (WAIT_SECONDS, backend modules/ai/transcription.py)`;
 * a take the backend gives up on has its recording deleted, so a job not yet started never reaches the model.
 * Whoever gives up first must not be the party holding the bill.
 *
 * TranscribeResult is unchanged from the old module -- `{ok, text?, error?}` --
 * so Composer.vue keeps consuming exactly what it consumed before.
 */

import i18n from '@/locales'

import { blobToBase64 } from '@/utils/audio'

import { api, ApiResponseError } from './client'
import type { TranscribeRequest, TranscribeResponse } from './generated'

/** Transcription outcome: ok plus the transcript, or a user-facing error message. */
export interface TranscribeResult {
  ok: boolean
  text?: string
  /** User-facing Russian message when ok is false. */
  error?: string
}

const TRANSCRIBE_URL = '/api/v1/ai/transcribe'
const TIMEOUT_MS = 30000

/**
 * `Machine code -> the sentence the person reads.` The table lives in
 * locales/ru/errors.json under `transcription` (tz-i18n 1.2) -- keys
 * transcription.<code>, phrases verbatim what the JS table carried.
 *
 * Every entry the backend can raise is there; anything unlisted falls back
 * to transcription.generic rather than showing a raw identifier.
 *
 * The vendor is deliberately absent from all of them. The old module said,
 * in Russian, that the OpenRouter balance had run out on a 402, which told
 * a stranger both who we buy from and what our balance is -- neither is
 * theirs to know, and neither is something they can act on. The backend
 * collapses every provider-side failure into transcription_failed for the
 * same reason, including the provider's own rate limit: that limit is on
 * OUR key and counts everyone's requests, so a "too often" sentence
 * addressed to this person would be false.
 */
function genericError(): string {
  return i18n.global.t('transcription.generic')
}

function transcriptionError(code: string | null): string {
  if (code && i18n.global.te(`transcription.${code}`, 'ru')) {
    return i18n.global.t(`transcription.${code}`)
  }
  return genericError()
}

/** Send a recorded audio take to our backend for transcription (shared client with a 30-second timeout: a minute of audio does not fit the default 15). */
export async function transcribeAudio(audio: Blob): Promise<TranscribeResult> {
  let base64: string
  try {
    base64 = await blobToBase64(audio)
  } catch {
    return { ok: false, error: genericError() }
  }

  let payload: TranscribeResponse | undefined
  try {
    const body: TranscribeRequest = { audio_base64: base64 }
    payload = await api.request<TranscribeResponse | undefined>('POST', TRANSCRIBE_URL, {
      body,
      timeoutMs: TIMEOUT_MS,
    })
  } catch (error) {
    // Our own envelope carries the machine code; a network failure, a
    // timeout or a body that is not JSON (nginx answering a 413 in HTML)
    // carries none and lands on the generic sentence.
    return {
      ok: false,
      error: transcriptionError(error instanceof ApiResponseError ? error.code : null),
    }
  }

  const text: unknown = payload?.text
  // A 200 with no usable text is not a success. The backend raises
  // speech_not_recognized instead of returning an empty transcript, so this
  // guard covers a response shape we did not expect -- never a silent paste
  // of nothing into the composer.
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, error: i18n.global.t('transcription.speech_not_recognized') }
  }
  return { ok: true, text }
}
