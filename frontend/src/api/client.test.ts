// =============================================================================
// VELO Frontend -- api/client.ts Unit Tests (W29-trimmed: trace id suffix)
// =============================================================================
//
// Every OTHER consumer of @/api/client mocks the module itself (or a
// domain-level @/api/* wrapper), so request()'s real body never runs under
// test -- see api/bookings.test.ts's header comment ("Client mocked at the
// seam"). This file stubs global fetch directly so request() executes for
// real, which is the only way to exercise the trace-id suffix it appends.
// =============================================================================

import { describe, it, expect, vi, afterEach } from 'vitest'
import { api, ApiResponseError, resetClientState } from '@/api/client'

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

describe('request() trace id suffix (W29-trimmed)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('appends " · код <first 6 chars>" when X-Trace-ID is present', async () => {
    stubFetch(
      400,
      { error: 'bad_request', message: 'Insufficient balance' },
      { 'X-Trace-ID': 'abcdef1234567890' },
    )
    const err = await captureError()
    expect(err.detail).toBe('Insufficient balance · код abcdef')
  })

  it('appends nothing when X-Trace-ID is absent', async () => {
    stubFetch(400, { error: 'bad_request', message: 'Insufficient balance' })
    const err = await captureError()
    expect(err.detail).toBe('Insufficient balance')
    expect(err.detail).not.toContain('код')
  })

  it('uses the FIRST six characters of the trace id, not the last', async () => {
    // First 6 chars ("aaaaaa") deliberately differ from the last 6 ("zzzzzz")
    // so a wrong-end slice would be caught, not accidentally pass.
    const fullTraceId = 'aaaaaa-1111-2222-3333-zzzzzz'
    stubFetch(500, { error: 'server_error', message: 'Boom' }, { 'X-Trace-ID': fullTraceId })
    const err = await captureError()
    expect(err.detail).toBe(`Boom · код ${fullTraceId.slice(0, 6)}`)
    expect(err.detail).not.toContain(fullTraceId.slice(-6))
  })

  it('also suffixes the 401 path (message constructed before the body is read)', async () => {
    stubFetch(401, {}, { 'X-Trace-ID': 'ffffff000000' })
    const err = await captureError()
    expect(err.detail).toBe('Session expired · код ffffff')
  })

  it('also suffixes the Pydantic 422 validation-error path', async () => {
    stubFetch(
      422,
      { detail: [{ loc: ['body', 'title'], msg: 'field required', type: 'missing' }] },
      { 'X-Trace-ID': '112233445566' },
    )
    const err = await captureError()
    expect(err.detail).toBe('field required · код 112233')
  })
})

describe('GET in-flight dedupe', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    resetClientState()
  })

  const ok = () => new Response(JSON.stringify({}), { status: 200 })

  it('joins identical simultaneous GETs into one network call', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok())
    vi.stubGlobal('fetch', fetchMock)
    await Promise.all([api.get('/x'), api.get('/x')])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a mutation while a GET is in flight makes the next GET hit the network', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok())
    vi.stubGlobal('fetch', fetchMock)
    const first = api.get('/x')
    const mutation = api.post('/x', { a: 1 })
    const second = api.get('/x')
    await Promise.all([first, mutation, second])
    const methods = fetchMock.mock.calls.map((c) => (c[1] as RequestInit).method)
    expect(methods).toEqual(['GET', 'POST', 'GET'])
  })

  it('a settled pre-mutation GET does not evict the newer in-flight GET', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok())
    vi.stubGlobal('fetch', fetchMock)
    const first = api.get('/x')
    await api.patch('/x', {})
    const second = api.get('/x')
    const third = api.get('/x') // joins `second`
    await Promise.all([first, second, third])
    expect(fetchMock).toHaveBeenCalledTimes(3) // GET, PATCH, one shared GET
  })
})
