/**
 * VELO Frontend -- OpenRouter transcription (voice input MVP, step 1)
 *
 * WHY RAW FETCH, OUTSIDE src/api/client.ts: OpenRouter is not our API. Our
 * client carries auth headers, base URLs and error normalisation for the VELO
 * backend -- none of which apply to a third-party AI gateway. This module is
 * deliberately self-contained so the whole integration is exactly one file.
 *
 * THE KEY IS PUBLIC: VITE_OPENROUTER_API_KEY is compiled into the client
 * bundle. It must be a throwaway key with a spend cap; it is never logged and
 * never included in error messages.
 *
 * WHEN THE REAL BACKEND LANDS (backend/app/modules/ai/ get_ai_service seam):
 * swap ONLY this function's transport for our proxy endpoint and delete the
 * env keys -- every caller keeps consuming TranscribeResult untouched.
 */

import { blobToBase64 } from '@/utils/audio'

export interface TranscribeResult {
  ok: boolean
  text?: string
  /** User-facing Russian message when ok is false. */
  error?: string
}

const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions'
// NB: OpenRouter RENAMED the OpenAI audio models (2026): the old
// openai/gpt-4o-audio-preview slug 400s ("not a valid model ID"). The live
// audio-input models are openai/gpt-audio and openai/gpt-audio-mini -- the
// mini is the cheap default for short voice notes.
const DEFAULT_MODEL = 'openai/gpt-audio-mini'
const TIMEOUT_MS = 30000

// "ONLY the transcript" is load-bearing: audio models like to wrap the
// transcript in conversational dressing («Ось текст: …»), which would land
// verbatim in the user's composer field. The [NO_SPEECH] marker gives the
// model a defined answer for silence/unintelligible audio -- a bare 200 with
// an apology sentence otherwise, which used to pass as a "transcript".
const TRANSCRIBE_PROMPT =
  'Transcribe the audio verbatim, in the language of the speaker. ' +
  'Respond with the transcript ONLY: no greetings, no introductions, no ' +
  'commentary, no surrounding quotes, no markdown. ' +
  'If the audio contains no intelligible speech, respond with exactly ' +
  '[NO_SPEECH] and nothing else.'

// The audio models answer silence/noise with an apology in the caller's
// language ("Извините, не удалось расслышать…", "Sorry, I couldn't hear…").
// Such a reply is a recognition failure, never a transcript. Matched against
// the WHOLE text and capped by length, so dictating «Извините…» as the start
// of a longer message still transcribes normally.
const NO_SPEECH_RE = /\[?\s*no[\s_-]?speech\s*\]?/i
const APOLOGY_RE =
  /^\s*(извините|простите|извини|к сожалению|сожалею|сорян|жаль|прошу прощения|перепрошую прощения|не (смог|смогла|могу|удалось|расслышал|услышал|понял)|я (не|ничего)|ничего не|sorry|apologies|apologize|i (can'?t|couldn'?t|didn'?t|am not able)|unable to|can'?t hear|didn'?t catch|no audible|silence)/i

function isNoSpeechResponse(text: string): boolean {
  if (NO_SPEECH_RE.test(text)) return true
  return text.length <= 100 && APOLOGY_RE.test(text)
}

interface ChatCompletionsBody {
  model: string
  temperature: number
  max_tokens: number
  messages: Array<{
    role: 'user'
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'input_audio'; input_audio: { data: string; format: 'wav' } }
    >
  }>
}

/** Transcribe a WAV blob via OpenRouter. Never throws: every failure mode --
 * missing key, network, timeout, non-JSON, empty transcript -- comes back as
 * ok:false with an honest user-facing message. */
export async function transcribeAudio(audio: Blob): Promise<TranscribeResult> {
  // Empty/whitespace key = feature not provisioned. Honest failure, no fetch.
  const apiKey = import.meta.env.VITE_OPENROUTER_API_KEY?.trim() ?? ''
  if (!apiKey) {
    return { ok: false, error: 'Голосовой ввод недоступен' }
  }
  const model = import.meta.env.VITE_OPENROUTER_TRANSCRIBE_MODEL?.trim() || DEFAULT_MODEL

  let base64: string
  try {
    base64 = await blobToBase64(audio)
  } catch {
    return { ok: false, error: 'Сервис транскрибации недоступен' }
  }

  const body: ChatCompletionsBody = {
    model,
    temperature: 0,
    max_tokens: 1000,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: TRANSCRIBE_PROMPT },
          {
            type: 'input_audio',
            input_audio: { data: base64, format: 'wav' },
          },
        ],
      },
    ],
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(OPENROUTER_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch {
    clearTimeout(timer)
    return { ok: false, error: 'Сервис транскрибации недоступен' }
  }
  clearTimeout(timer)

  if (!response.ok) {
    return { ok: false, error: httpErrorMessage(response.status) }
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { ok: false, error: 'Сервис транскрибации недоступен' }
  }

  const content = extractMessageContent(payload)
  if (content === null) {
    return { ok: false, error: 'Не удалось распознать речь' }
  }
  const text = cleanTranscript(content)
  // An empty readback, the [NO_SPEECH] marker, or the model's apologetic
  // dressing on silence are all recognition failures -- never a success that
  // would paste an apology into the user's field.
  if (!text || isNoSpeechResponse(text)) {
    return { ok: false, error: 'Не удалось распознать речь' }
  }
  return { ok: true, text }
}

/** Trim model dressing: markdown fences and wrapping quotes. */
export function cleanTranscript(raw: string): string {
  let text = raw.trim()
  const fenced = text.match(/^```[a-zA-Z]*\r?\n?([\s\S]*?)\r?\n?```$/)
  if (fenced) {
    text = (fenced[1] ?? '').trim()
  }
  const wraps = [
    ['"', '"'],
    ['«', '»'],
    ['“', '”'],
  ] as const
  for (const [open, close] of wraps) {
    if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) {
      text = text.slice(1, -1).trim()
    }
  }
  return text
}

function httpErrorMessage(status: number): string {
  if (status === 401 || status === 403) return 'Ключ транскрибации не настроен'
  if (status === 402) return 'Закончился баланс OpenRouter'
  if (status === 429) return 'Слишком часто, попробуйте позже'
  return 'Сервис транскрибации недоступен'
}

function extractMessageContent(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const choices = (payload as { choices?: unknown }).choices
  // Array.isArray would narrow `unknown` to `any[]`; keep the element type
  // honest with an explicit unknown[] view instead.
  if (!Array.isArray(choices)) return null
  const first = (choices as unknown[])[0]
  if (typeof first !== 'object' || first === null) return null
  const message = (first as { message?: unknown }).message
  if (typeof message !== 'object' || message === null) return null
  const content = (message as { content?: unknown }).content
  return typeof content === 'string' ? content : null
}
