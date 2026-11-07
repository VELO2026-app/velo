// =============================================================================
// VELO Frontend -- api/client.ts Unit Tests (W29-trimmed: request id suffix)
// =============================================================================
//
// Every OTHER consumer of @/api/client mocks the module itself (or a
// domain-level @/api/* wrapper), so request()'s real body never runs under
// test -- see api/bookings.test.ts's header comment ("Client mocked at the
// seam"). This file stubs global fetch directly so request() executes for
// real, which is the only way to exercise the request-id suffix it appends.
// =============================================================================

import { describe, it, expect, vi, afterEach } from 'vitest'
import { api, ApiResponseError } from '@/api/client'

function stubFetch(status: number, body: unknown, headers?: Record<string, string>) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers })),
  )
}

async function captureError(): Promise<ApiResponseError> {
  try {
    await api.get('/whatever')
  } catch (e) {
    return e as ApiResponseError
  }
  throw new Error('expected api.get to reject')
}

describe('request() request id suffix (W29-trimmed)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('appends " · код <first 6 chars>" when X-Request-ID is present', async () => {
    stubFetch(
      400,
      { error: 'bad_request', message: 'Insufficient balance' },
      { 'X-Request-ID': 'abcdef1234567890' },
    )
    const err = await captureError()
    expect(err.detail).toBe('Insufficient balance · код abcdef')
  })

  it('appends nothing when X-Request-ID is absent', async () => {
    stubFetch(400, { error: 'bad_request', message: 'Insufficient balance' })
    const err = await captureError()
    expect(err.detail).toBe('Insufficient balance')
    expect(err.detail).not.toContain('код')
  })

  it('uses the FIRST six characters of the request id, not the last', async () => {
    // First 6 chars ("aaaaaa") deliberately differ from the last 6 ("zzzzzz")
    // so a wrong-end slice would be caught, not accidentally pass.
    const fullRequestId = 'aaaaaa-1111-2222-3333-zzzzzz'
    stubFetch(500, { error: 'server_error', message: 'Boom' }, { 'X-Request-ID': fullRequestId })
    const err = await captureError()
    expect(err.detail).toBe(`Boom · код ${fullRequestId.slice(0, 6)}`)
    expect(err.detail).not.toContain(fullRequestId.slice(-6))
  })

  it('also suffixes the 401 path (message constructed before the body is read)', async () => {
    stubFetch(401, {}, { 'X-Request-ID': 'ffffff000000' })
    const err = await captureError()
    expect(err.detail).toBe('Session expired · код ffffff')
  })

  it('also suffixes the Pydantic 422 validation-error path', async () => {
    stubFetch(
      422,
      { detail: [{ loc: ['body', 'title'], msg: 'field required', type: 'missing' }] },
      { 'X-Request-ID': '112233445566' },
    )
    const err = await captureError()
    expect(err.detail).toBe('field required · код 112233')
  })
})
