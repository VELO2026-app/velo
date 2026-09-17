// =============================================================================
// VELO Frontend -- OpenRouter transcription tests (voice input MVP, step 1)
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanTranscript, transcribeAudio } from './openrouter'

// The real blobToBase64 routes through happy-dom's FileReader, whose internal
// task scheduling does not cooperate with vi.useFakeTimers (the timeout test
// below hangs). openrouter.ts only consumes the base64 string, so mock that
// boundary wholesale -- the FileReader bridge itself is covered in
// utils/audio.test.ts.
vi.mock('@/utils/audio', () => ({
  blobToBase64: vi.fn(async () => 'AQID'),
}))

const AUDIO_BLOB = new Blob([new Uint8Array([1, 2, 3])]) // base64: AQID

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function transcriptionPayload(content: string): unknown {
  return { choices: [{ message: { content } }] }
}

/** RequestInit.body is not necessarily a string -- assert the shape the
 * wrapper under test actually sends before JSON-parsing it. */
function parseBody(init: RequestInit): {
  model: string
  messages: Array<{ content: Array<Record<string, unknown>> }>
} {
  const raw = init.body
  if (typeof raw !== 'string') throw new Error('expected a string body')
  return JSON.parse(raw)
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubEnv('VITE_OPENROUTER_API_KEY', 'test-key')
  vi.stubEnv('VITE_OPENROUTER_TRANSCRIBE_MODEL', '')
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

describe('transcribeAudio', () => {
  it('sends the WAV as input_audio to the chat-completions endpoint with the bearer key', async () => {
    fetchMock.mockResolvedValue(jsonResponse(transcriptionPayload('привет')))
    const result = await transcribeAudio(AUDIO_BLOB)

    expect(result).toEqual({ ok: true, text: 'привет' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer test-key')

    const body = parseBody(init)
    expect(body.model).toBe('openai/gpt-audio-mini')
    const audioPart = body.messages[0]?.content[1] as {
      input_audio: { data: string; format: string }
    }
    expect(audioPart.input_audio).toEqual({ data: 'AQID', format: 'wav' })
  })

  it('uses VITE_OPENROUTER_TRANSCRIBE_MODEL when set', async () => {
    vi.stubEnv('VITE_OPENROUTER_TRANSCRIBE_MODEL', 'openai/gpt-4o-mini-audio-preview')
    fetchMock.mockResolvedValue(jsonResponse(transcriptionPayload('ок')))
    await transcribeAudio(AUDIO_BLOB)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = parseBody(init)
    expect(body.model).toBe('openai/gpt-4o-mini-audio-preview')
  })

  it('with no key: honest unavailability, and fetch is never called', async () => {
    vi.stubEnv('VITE_OPENROUTER_API_KEY', '')
    const result = await transcribeAudio(AUDIO_BLOB)
    expect(result).toEqual({ ok: false, error: 'Голосовой ввод недоступен' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('cleans fenced and quoted model output', async () => {
    fetchMock.mockResolvedValue(jsonResponse(transcriptionPayload('```\n"сам текст"\n```')))
    const result = await transcribeAudio(AUDIO_BLOB)
    expect(result).toEqual({ ok: true, text: 'сам текст' })
  })

  it('an ok response with empty content is a recognition failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse(transcriptionPayload('   ')))
    const result = await transcribeAudio(AUDIO_BLOB)
    expect(result).toEqual({ ok: false, error: 'Не удалось распознать речь' })
  })
})

describe('error mapping', () => {
  it('maps HTTP status codes to honest messages (key/balance/rate/other)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 401))
    expect(await transcribeAudio(AUDIO_BLOB)).toEqual({
      ok: false,
      error: 'Ключ транскрибации не настроен',
    })

    fetchMock.mockResolvedValue(jsonResponse({}, 402))
    expect(await transcribeAudio(AUDIO_BLOB)).toEqual({
      ok: false,
      error: 'Закончился баланс OpenRouter',
    })

    fetchMock.mockResolvedValue(jsonResponse({}, 429))
    expect(await transcribeAudio(AUDIO_BLOB)).toEqual({
      ok: false,
      error: 'Слишком часто, попробуйте позже',
    })

    fetchMock.mockResolvedValue(jsonResponse({}, 500))
    expect(await transcribeAudio(AUDIO_BLOB)).toEqual({
      ok: false,
      error: 'Сервис транскрибации недоступен',
    })
  })

  it('network failure and malformed JSON both land on the service-unavailable message', async () => {
    fetchMock.mockRejectedValue(new TypeError('network down'))
    expect(await transcribeAudio(AUDIO_BLOB)).toEqual({
      ok: false,
      error: 'Сервис транскрибации недоступен',
    })

    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }))
    expect(await transcribeAudio(AUDIO_BLOB)).toEqual({
      ok: false,
      error: 'Сервис транскрибации недоступен',
    })
  })

  it('a response shape without choices/content is a recognition failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ nope: true }))
    expect(await transcribeAudio(AUDIO_BLOB)).toEqual({
      ok: false,
      error: 'Не удалось распознать речь',
    })
  })

  it('the [NO_SPEECH] marker is a recognition failure, never a transcript', async () => {
    fetchMock.mockResolvedValue(jsonResponse(transcriptionPayload('[NO_SPEECH]')))
    expect(await transcribeAudio(AUDIO_BLOB)).toEqual({
      ok: false,
      error: 'Не удалось распознать речь',
    })
  })

  it('apologetic answers to silence are recognition failures, never transcripts', async () => {
    for (const content of [
      'Извините, не удалось расслышать речь',
      'К сожалению, я не смог распознать аудио.',
      "Sorry, I couldn't hear anything in this audio",
    ]) {
      fetchMock.mockResolvedValue(jsonResponse(transcriptionPayload(content)))
      expect(await transcribeAudio(AUDIO_BLOB)).toEqual({
        ok: false,
        error: 'Не удалось распознать речь',
      })
    }
  })

  it('a long real message that merely starts with «извините» still transcribes', async () => {
    const long = `Извините, я хотел записать важную мысль: ${'х'.repeat(120)}`
    fetchMock.mockResolvedValue(jsonResponse(transcriptionPayload(long)))
    expect(await transcribeAudio(AUDIO_BLOB)).toEqual({ ok: true, text: long })
  })

  it('the 30s timeout aborts the request and reports unavailability', async () => {
    vi.useFakeTimers()
    try {
      fetchMock.mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            )
          }),
      )
      const pending = transcribeAudio(AUDIO_BLOB)
      const assertion = expect(pending).resolves.toEqual({
        ok: false,
        error: 'Сервис транскрибации недоступен',
      })
      await vi.advanceTimersByTimeAsync(30000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('cleanTranscript', () => {
  it('trims plain text untouched', () => {
    expect(cleanTranscript('  привет мир  ')).toBe('привет мир')
  })

  it('strips markdown fences', () => {
    expect(cleanTranscript('```text\nстрока\n```')).toBe('строка')
    expect(cleanTranscript('```\nстрока\n```')).toBe('строка')
  })

  it('strips one layer of wrapping quotes', () => {
    expect(cleanTranscript('"привет"')).toBe('привет')
    expect(cleanTranscript('«привет»')).toBe('привет')
    expect(cleanTranscript('“привет”')).toBe('привет')
  })

  it('keeps meaningful inner quotes', () => {
    expect(cleanTranscript('он сказал «привет»')).toBe('он сказал «привет»')
  })
})
