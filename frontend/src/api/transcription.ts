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
 * WHY A RAW FETCH, OUTSIDE src/api/client.ts -- the same reason the old
 * module gave, with one addition. The shared client aborts every request at
 * 15 seconds; a minute of audio does not come back in 15 seconds, and an
 * abort on our side does not stop the completion the server is already
 * paying for. The timeout ladder is deliberate: browser 30s > backend 25s
 * (OPENROUTER_HTTP_TIMEOUT_SECONDS) > the provider call. Whoever gives up
 * first must not be the party holding the bill.
 *
 * TranscribeResult is unchanged from the old module -- {ok, text?, error?} --
 * so Composer.vue keeps consuming exactly what it consumed before.
 */

import { blobToBase64 } from '@/utils/audio'

import { getAuthToken } from './client'

export interface TranscribeResult {
  ok: boolean
  text?: string
  /** User-facing Russian message when ok is false. */
  error?: string
}

const TRANSCRIBE_URL = '/api/v1/ai/transcribe'
const BASE_URL = import.meta.env.VITE_API_BASE_URL || ''
const TIMEOUT_MS = 30000

const GENERIC_ERROR = 'Сервис транскрибации недоступен'

/**
 * Machine code -> the sentence the person reads.
 *
 * Every entry the backend can raise is here; anything unlisted falls back to
 * GENERIC_ERROR rather than showing a raw identifier.
 *
 * The vendor is deliberately absent from all of them. The old module said
 * «Закончился баланс OpenRouter» on a 402, which told a stranger both who we
 * buy from and what our balance is -- neither is theirs to know, and neither
 * is something they can act on. The backend collapses every provider-side
 * failure into transcription_failed for the same reason, including the
 * provider's own rate limit: that limit is on OUR key and counts everyone's
 * requests, so «слишком часто» addressed to this person would be false.
 */
const MESSAGES: Record<string, string> = {
  transcription_not_configured: 'Голосовой ввод недоступен',
  transcription_unavailable: GENERIC_ERROR,
  transcription_failed: GENERIC_ERROR,
  speech_not_recognized: 'Не удалось распознать речь',
  audio_too_large: 'Запись слишком длинная',
  audio_invalid: 'Не удалось обработать запись',
  unauthorized: 'Сессия истекла, войдите заново',
}

/** Read the machine code out of our own error envelope: {error, message}. */
function codeOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const code = (payload as { error?: unknown }).error
  return typeof code === 'string' ? code : null
}

export async function transcribeAudio(audio: Blob): Promise<TranscribeResult> {
  let base64: string
  try {
    base64 = await blobToBase64(audio)
  } catch {
    return { ok: false, error: GENERIC_ERROR }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const token = getAuthToken()

  let response: Response
  try {
    response = await fetch(`${BASE_URL}${TRANSCRIBE_URL}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ audio_base64: base64 }),
      signal: controller.signal,
    })
  } catch {
    clearTimeout(timer)
    return { ok: false, error: GENERIC_ERROR }
  }
  clearTimeout(timer)

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { ok: false, error: GENERIC_ERROR }
  }

  if (!response.ok) {
    const code = codeOf(payload)
    return { ok: false, error: (code && MESSAGES[code]) || GENERIC_ERROR }
  }

  const text = (payload as { text?: unknown }).text
  // A 200 with no usable text is not a success. The backend raises
  // speech_not_recognized instead of returning an empty transcript, so this
  // guard covers a response shape we did not expect -- never a silent paste
  // of nothing into the composer.
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, error: 'Не удалось распознать речь' }
  }
  return { ok: true, text }
}
