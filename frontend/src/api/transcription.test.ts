// =============================================================================
// VELO Frontend -- transcription client tests (GT-41)
// =============================================================================
//
// Replaces openrouter.test.ts, deleted with the module it covered. The five
// properties that module owned and this one does NOT are the ones that moved
// to the server with the key -- the prompt, the [NO_SPEECH] marker, the model
// slug, the response shape and the transcript cleaning. They are covered in
// backend/tests/test_ai_transcription.py; the ritual question is "did the
// property disappear", and it did not, it changed address.
//
// What is left here is what the browser still owns: one request, and turning
// a machine code into a sentence a person can read.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { transcribeAudio } from './transcription'
import { setAuthToken, resetClientState } from './client'

// The real blobToBase64 routes through happy-dom's FileReader, whose internal
// task scheduling does not cooperate with vi.useFakeTimers (the timeout test
// below hangs). This module only consumes the base64 string; the FileReader
// bridge itself is covered in utils/audio.test.ts.
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

/** RequestInit.body is not necessarily a string -- assert the shape actually
 * sent before JSON-parsing it. */
function parseBody(init: RequestInit): { audio_base64: string } {
  const raw = init.body
  if (typeof raw !== 'string') throw new Error('expected a string body')
  return JSON.parse(raw)
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  setAuthToken('session-token')
})

afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockReset()
  resetClientState()
})

describe('transcribeAudio', () => {
  it('posts the base64 audio to our endpoint with the session bearer', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: 'привет' }))

    const result = await transcribeAudio(AUDIO_BLOB)

    expect(result).toEqual({ ok: true, text: 'привет' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/ai/transcribe')
    expect(init.method).toBe('POST')
    expect(parseBody(init).audio_base64).toBe('AQID')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer session-token')
  })

  it('sends no key of its own -- the provider credential is not in the browser', async () => {
    // The point of the whole move, asserted rather than assumed: the request
    // this module makes carries OUR session token and nothing else. Before
    // GT-41 the equivalent line carried a provider key read from the bundle.
    fetchMock.mockResolvedValue(jsonResponse({ text: 'привет' }))

    await transcribeAudio(AUDIO_BLOB)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).not.toContain('openrouter')
    const headers = init.headers as Record<string, string>
    expect(Object.keys(headers)).toEqual(['Content-Type', 'Authorization'])
    expect(headers.Authorization).toBe('Bearer session-token')
  })
})

describe('error mapping', () => {
  const CASES: ReadonlyArray<{ code: string; status: number; message: string }> = [
    { code: 'transcription_not_configured', status: 400, message: 'Голосовой ввод недоступен' },
    { code: 'transcription_unavailable', status: 502, message: 'Сервис транскрибации недоступен' },
    { code: 'transcription_failed', status: 502, message: 'Сервис транскрибации недоступен' },
    { code: 'speech_not_recognized', status: 400, message: 'Не удалось распознать речь' },
    { code: 'audio_too_large', status: 400, message: 'Запись слишком длинная' },
    { code: 'audio_invalid', status: 400, message: 'Не удалось обработать запись' },
    { code: 'unauthorized', status: 401, message: 'Сессия истекла, войдите заново' },
  ]

  for (const { code, status, message } of CASES) {
    it(`maps ${code} to its own sentence`, async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ error: code, message: 'server side text' }, status),
      )

      const result = await transcribeAudio(AUDIO_BLOB)

      expect(result).toEqual({ ok: false, error: message })
    })
  }

  it('never shows the vendor or our balance', async () => {
    // The old module answered a 402 with «Закончился баланс OpenRouter». The
    // backend collapses every provider-side failure into one code precisely
    // so that sentence cannot come back: the person can act on neither our
    // vendor nor our credit.
    fetchMock.mockResolvedValue(jsonResponse({ error: 'transcription_failed', message: 'x' }, 502))

    const result = await transcribeAudio(AUDIO_BLOB)

    expect(result.error).not.toMatch(/OpenRouter|баланс/i)
  })

  it('falls back to the generic sentence on a code it does not know', async () => {
    // A raw identifier on screen is the failure mode this table exists to
    // prevent, and new backend codes are added without this file.
    fetchMock.mockResolvedValue(jsonResponse({ error: 'some_future_code', message: 'x' }, 500))

    const result = await transcribeAudio(AUDIO_BLOB)

    expect(result).toEqual({ ok: false, error: 'Сервис транскрибации недоступен' })
  })

  it('network failure and malformed JSON both land on the generic sentence', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network'))
    await expect(transcribeAudio(AUDIO_BLOB)).resolves.toEqual({
      ok: false,
      error: 'Сервис транскрибации недоступен',
    })

    fetchMock.mockResolvedValueOnce(
      new Response('<html>413</html>', {
        status: 413,
        headers: { 'Content-Type': 'text/html' },
      }),
    )
    // nginx answers an oversized body itself, in HTML, before the app sees
    // it. There is no machine code to read, so the generic sentence is the
    // honest answer -- never a crash on JSON.parse.
    await expect(transcribeAudio(AUDIO_BLOB)).resolves.toEqual({
      ok: false,
      error: 'Сервис транскрибации недоступен',
    })
  })

  it('a 200 without usable text is a recognition failure, not a silent paste', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ text: '   ' }))
    await expect(transcribeAudio(AUDIO_BLOB)).resolves.toEqual({
      ok: false,
      error: 'Не удалось распознать речь',
    })

    fetchMock.mockResolvedValueOnce(jsonResponse({}))
    await expect(transcribeAudio(AUDIO_BLOB)).resolves.toEqual({
      ok: false,
      error: 'Не удалось распознать речь',
    })
  })

  it('the 30s timeout aborts the request and reports unavailability', async () => {
    // Thirty, not the shared client's fifteen: a minute of audio does not
    // come back in fifteen seconds, and aborting early would leave the
    // server paying for a completion nobody receives.
    vi.useFakeTimers()
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        }),
    )

    const pending = transcribeAudio(AUDIO_BLOB)
    await vi.advanceTimersByTimeAsync(30000)

    await expect(pending).resolves.toEqual({
      ok: false,
      error: 'Сервис транскрибации недоступен',
    })
    vi.useRealTimers()
  })
})
