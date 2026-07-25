// =============================================================================
// VELO Frontend -- API Client (Phase F1.2, fixed 10.2, fixed CRITICAL-2, F-03)
// =============================================================================
//
// FIX 10.2: 401 handler delegates cleanup to auth store via
// onUnauthorized callback. No direct token/sessionStorage mutation.
// No window.location.href redirect -- Vue reactivity does it.
//
// FIX CRITICAL-2: AbortController + 15s timeout on every request.
// Timeout throws ApiTimeoutError. Network failure throws ApiNetworkError.
//
// FIX F-03: Backend returns { error: string, message: string } for VeloErrors
// and { detail: Array<...> } for 422 Pydantic errors. Previously client.ts
// read only `detail`, causing all non-422 errors to show "Request failed (NNN)".
// ApiResponseError now carries both `detail` (human message) and `code`
// (machine-readable) so callers can switch on code instead of string-matching.
// =============================================================================

import type { ApiError } from './types'

const BASE_URL = import.meta.env.VITE_API_BASE_URL || ''
const REQUEST_TIMEOUT_MS = 15_000

// -- Error classes --

export class ApiResponseError extends Error {
  constructor(
    public status: number,
    /** Human-readable message (for toast display). */
    public detail: string,
    /** Machine-readable error code from backend (e.g. "insufficient_balance"). */
    public code: string = 'unknown',
  ) {
    super(detail)
    this.name = 'ApiResponseError'
  }
}

export class ApiNetworkError extends Error {
  constructor() {
    super('Network error -- check your connection')
    this.name = 'ApiNetworkError'
  }
}

export class ApiTimeoutError extends Error {
  constructor() {
    super(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`)
    this.name = 'ApiTimeoutError'
  }
}

// -- Token management (separate from Pinia to avoid circular imports) --

let _token: string | null = null

/** Called by auth store to set/clear the token. */
export function setAuthToken(token: string | null): void {
  _token = token
}

/** Called by auth store to read current token. */
export function getAuthToken(): string | null {
  return _token
}

// -- 401 callback (FIX 10.2) --

let _onUnauthorized: (() => void) | null = null

/**
 * Register a callback invoked on 401 responses.
 * Auth store calls this once at init to wire up _clearSession().
 */
export function setOnUnauthorized(cb: () => void): void {
  _onUnauthorized = cb
}

// -- In-flight deduplication (F-09) --
//
// Concurrent identical GET requests (e.g. multiple components mounting at
// the same time) share a single in-flight Promise instead of hitting the
// network N times. The entry is removed as soon as the request settles,
// so subsequent calls always go to the network.
const _inFlight = new Map<string, Promise<unknown>>()

/**
 * Reset all module-level state (WARNING-13).
 * Call in test beforeEach to prevent state leaking between tests.
 */
export function resetClientState(): void {
  _token = null
  _onUnauthorized = null
  _inFlight.clear()
}

// -- Core request --

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}

  if (_token) {
    headers['Authorization'] = `Bearer ${_token}`
  }

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  let response: Response

  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new ApiTimeoutError()
    }
    throw new ApiNetworkError()
  } finally {
    clearTimeout(timeoutId)
  }

  // W29-trimmed: read once, right after the fetch, so every ApiResponseError
  // construction below can use it. Absent for ApiNetworkError/ApiTimeoutError
  // above -- those throw before a response exists, so there is honestly no
  // trace id to show for them. suffixWithTraceId is called exactly once per
  // throw site below, always on the raw backend-provided message -- never on
  // an already-suffixed string -- so the suffix can never be appended twice.
  const traceId = response.headers.get('X-Trace-ID')

  // 204 No Content (e.g. logout).
  if (response.status === 204) {
    return undefined as T
  }

  // 401 Unauthorized -- notify auth store, then throw.
  // FIX 10.2: no direct token/sessionStorage mutation here.
  if (response.status === 401) {
    _onUnauthorized?.()
    throw new ApiResponseError(401, suffixWithTraceId('Session expired', traceId), 'unauthorized')
  }

  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw new ApiResponseError(
      response.status,
      suffixWithTraceId('Invalid response from server', traceId),
    )
  }

  if (response.ok) {
    return data as T
  }

  // F-03: Backend has two error formats:
  //   VeloError (4xx):  { error: "bad_request", message: "Insufficient balance" }
  //   Pydantic 422:     { detail: [{ loc, msg, type }, ...] }
  //
  // Normalise both to ApiResponseError with:
  //   .detail = human-readable string (for toast)
  //   .code   = machine-readable string (for switch/if logic)
  const errorData = data as ApiError

  // VeloError format: { error, message }
  if (typeof errorData?.message === 'string') {
    throw new ApiResponseError(
      response.status,
      suffixWithTraceId(errorData.message, traceId),
      errorData.error ?? 'unknown',
    )
  }

  // Pydantic 422 format: { detail: string | Array<...> }
  const rawDetail = errorData?.detail
  const detail =
    typeof rawDetail === 'string'
      ? rawDetail
      : Array.isArray(rawDetail)
        ? rawDetail.map((e) => e.msg).join('; ')
        : `Request failed (${response.status})`

  throw new ApiResponseError(
    response.status,
    suffixWithTraceId(detail, traceId),
    'validation_error',
  )
}

// W29-trimmed: append a greppable diagnostic key to a user-facing error
// message, so a tester's bug report carries the same key as the backend log
// line (TraceIdMiddleware, backend/app/core/middleware.py). FIRST six chars
// -- the log line carries the full id, so a prefix match finds it with one
// grep. No header (network/timeout failures, which never reach this
// function) -> no suffix; never render an empty or placeholder code.
function suffixWithTraceId(message: string, traceId: string | null): string {
  return traceId ? `${message} · код ${traceId.slice(0, 6)}` : message
}

// -- Public API --

export const api = {
  get<T>(path: string): Promise<T> {
    // F-09: deduplicate simultaneous identical GET requests.
    const existing = _inFlight.get(path)
    if (existing) return existing as Promise<T>
    const promise = request<T>('GET', path).finally(() => {
      _inFlight.delete(path)
    })
    _inFlight.set(path, promise)
    return promise
  },

  post<T>(path: string, body?: unknown): Promise<T> {
    return request<T>('POST', path, body)
  },

  patch<T>(path: string, body?: unknown): Promise<T> {
    return request<T>('PATCH', path, body)
  },

  put<T>(path: string, body?: unknown): Promise<T> {
    return request<T>('PUT', path, body)
  },

  delete(path: string): Promise<void> {
    return request<void>('DELETE', path)
  },
}
