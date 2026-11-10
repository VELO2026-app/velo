// =============================================================================
// VELO Frontend -- api/client.ts Unit Tests (W29-trimmed: trace id suffix)
// =============================================================================
//
// Every OTHER consumer of @/api/client mocks the module itself (or a
// domain-level @/api/* wrapper), so request()'s real body never runs under
// test -- see api/bookings.test.ts's header comment ("Client mocked at the
// seam"). This file stubs global fetch directly so request() executes for
// real, which is the only way to exercise the trace-id suffix it appends.
// FE-157 adds the 401-for-the-current-token rule and api.request's options
// (timeoutMs, signal) on the same real path.
// =============================================================================

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  api,
  ApiNetworkError,
  ApiResponseError,
  ApiTimeoutError,
  resetClientState,
  setAuthToken,
  setOnUnauthorized,
} from '@/api/client'

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
    // Deferred fetches: GET#1 must still be in flight when GET#2 registers,
    // and settle only after it -- the order the guard exists for.
    const pending: Array<() => void> = []
    const fetchMock = vi
      .fn()
      .mockImplementation((_url: string, init: RequestInit) =>
        init.method === 'GET'
          ? new Promise((resolve) => pending.push(() => resolve(ok())))
          : Promise.resolve(ok()),
      )
    vi.stubGlobal('fetch', fetchMock)
    const first = api.get('/x')
    await api.patch('/x', {})
    const second = api.get('/x')
    pending[0]!() // GET#1 settles while GET#2 is in flight
    await first
    const third = api.get('/x') // must join GET#2, not open a new request
    pending[1]!()
    await Promise.all([second, third])
    expect(fetchMock).toHaveBeenCalledTimes(3) // GET, PATCH, one shared GET
  })

  it('a GET issued during a mutation is not joined by a GET after it', async () => {
    let finishPost!: () => void
    const pendingGets: Array<() => void> = []
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) =>
      init.method === 'POST'
        ? new Promise((resolve) => {
            finishPost = () => resolve(ok())
          })
        : new Promise((resolve) => pendingGets.push(() => resolve(ok()))),
    )
    vi.stubGlobal('fetch', fetchMock)
    const mutation = api.post('/x', { a: 1 })
    const during = api.get('/x') // still in flight after the mutation: pre-mutation state
    finishPost()
    await mutation
    const after = api.get('/x')
    for (const settle of pendingGets) settle()
    await Promise.all([during, after])
    const methods = fetchMock.mock.calls.map((c) => (c[1] as RequestInit).method)
    expect(methods).toEqual(['POST', 'GET', 'GET'])
  })
})

describe('401 ends the session only for the token that is still current (FE-157)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    resetClientState()
  })

  const unauthorized = () => new Response(JSON.stringify({}), { status: 401 })

  /** A fetch whose 401 answer the test releases by hand. */
  function deferredFetch(): { release: () => void } {
    let release = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () => resolve(unauthorized())
          }),
      ),
    )
    return { release: () => release() }
  }

  it('a 401 for the current token calls the session callback', async () => {
    const onUnauthorized = vi.fn()
    setOnUnauthorized(onUnauthorized)
    setAuthToken('tok_1')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(unauthorized()))

    await expect(api.get('/x')).rejects.toMatchObject({ status: 401, code: 'unauthorized' })
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('a late 401 for a token replaced in flight leaves the new session alone', async () => {
    const onUnauthorized = vi.fn()
    setOnUnauthorized(onUnauthorized)
    setAuthToken('tok_1')
    const fetch = deferredFetch()
    const pending = api.get('/x')

    setAuthToken('tok_2') // a new sign-in while the old request is in flight
    fetch.release()

    await expect(pending).rejects.toMatchObject({ status: 401 })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('a late 401 after the session was already cleared does not clear again', async () => {
    const onUnauthorized = vi.fn()
    setOnUnauthorized(onUnauthorized)
    setAuthToken('tok_1')
    const fetch = deferredFetch()
    const pending = api.get('/x')

    setAuthToken(null) // logout finished first
    fetch.release()

    await expect(pending).rejects.toMatchObject({ status: 401 })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('a 401 to an anonymous request is not about any session', async () => {
    const onUnauthorized = vi.fn()
    setOnUnauthorized(onUnauthorized)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(unauthorized()))

    await expect(api.post('/api/v1/auth/telegram', {})).rejects.toMatchObject({ status: 401 })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })
})

describe('api.request options: timeoutMs and signal (FE-157)', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    resetClientState()
  })

  const ok = () => new Response(JSON.stringify({ done: true }), { status: 200 })

  /** A fetch that never answers and rejects with AbortError once its signal fires. */
  function hangingFetch(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('sends the body and the extra headers next to the bearer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok())
    vi.stubGlobal('fetch', fetchMock)
    setAuthToken('tok_1')

    await expect(
      api.request('POST', '/x', { body: { a: 1 }, headers: { 'Idempotency-Key': 'k1' } }),
    ).resolves.toEqual({ done: true })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"a":1}')
    expect(init.headers).toEqual({
      'Idempotency-Key': 'k1',
      Authorization: 'Bearer tok_1',
      'Content-Type': 'application/json',
    })
  })

  it('timeoutMs replaces the default 15 seconds', async () => {
    vi.useFakeTimers()
    hangingFetch()
    const pending = api.request('POST', '/slow', { timeoutMs: 30_000 })
    const settled = vi.fn()
    pending.then(settled, settled)

    await vi.advanceTimersByTimeAsync(15_000)
    expect(settled).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(15_000)
    await expect(pending).rejects.toBeInstanceOf(ApiTimeoutError)
    await expect(pending).rejects.toThrow('Request timed out after 30s')
  })

  it('the shorthands keep the default 15-second timeout', async () => {
    vi.useFakeTimers()
    hangingFetch()
    const pending = api.get('/slow')
    const assertion = expect(pending).rejects.toThrow('Request timed out after 15s')

    await vi.advanceTimersByTimeAsync(15_000)
    await assertion
  })

  it('a caller abort rejects with AbortError, never as a timeout or a network failure', async () => {
    const fetchMock = hangingFetch()
    const controller = new AbortController()
    const pending = api.request('GET', '/x', { signal: controller.signal })

    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await expect(pending).rejects.not.toBeInstanceOf(ApiTimeoutError)
    await expect(pending).rejects.not.toBeInstanceOf(ApiNetworkError)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.signal?.aborted).toBe(true)
  })

  it('a caller abort with an Error reason rejects with that reason', async () => {
    hangingFetch()
    const controller = new AbortController()
    const reason = new Error('screen left')
    const pending = api.request('GET', '/x', { signal: controller.signal })

    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
  })

  it('an already-aborted signal never reaches the network', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok())
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort()

    await expect(api.request('GET', '/x', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a cancel that lands after the answer still rejects', async () => {
    const controller = new AbortController()
    // The fetch ignores the signal and answers; the caller cancels before
    // the answer is handed back.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        controller.abort()
        return ok()
      }),
    )

    await expect(api.request('GET', '/x', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('a GET through api.request is never joined with another GET', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok())
    vi.stubGlobal('fetch', fetchMock)

    await Promise.all([api.get('/x'), api.request('GET', '/x'), api.request('GET', '/x')])

    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('a non-GET through api.request still drops the in-flight GETs', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok())
    vi.stubGlobal('fetch', fetchMock)

    const first = api.get('/x')
    await api.request('POST', '/y', { body: {} })
    const second = api.get('/x')
    await Promise.all([first, second])

    const methods = fetchMock.mock.calls.map((c) => (c[1] as RequestInit).method)
    expect(methods).toEqual(['GET', 'POST', 'GET'])
  })
})
