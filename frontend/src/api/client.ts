// =============================================================================
// VELO Frontend -- API Client (Phase F1.2, fixed 10.2, fixed CRITICAL-2, F-03)
// =============================================================================
//
// FIX 10.2: 401 handler delegates cleanup to auth store via
// onUnauthorized callback. No direct token/sessionStorage mutation.
// No window.location.href redirect -- Vue reactivity does it.
// FE-157: the callback fires only for a 401 to a request that left with the
// CURRENT token -- a late 401 for a session that is already gone must not
// tear down the one that replaced it.
//
// FIX CRITICAL-2: AbortController + 15s timeout on every request.
// Timeout throws ApiTimeoutError. Network failure throws ApiNetworkError.
// FE-157: api.request() takes its own timeout and a caller AbortSignal.
//
// FIX F-03: Backend returns { error: string, message: string } for VeloErrors
// and { detail: Array<...> } for 422 Pydantic errors. Previously client.ts
// read only `detail`, causing all non-422 errors to show "Request failed (NNN)".
// ApiResponseError now carries both `detail` (human message) and `code`
// (machine-readable) so callers can switch on code instead of string-matching.
// =============================================================================

import type { ApiError } from './types'
import i18n from '@/locales'
import { INSTANCE } from '@/platform/instance'

const BASE_URL = INSTANCE.apiBaseUrl
const REQUEST_TIMEOUT_MS = 15_000

// -- Error classes --

/** A backend-answered failure: status, human detail, machine code, optional 422 validation entries. */
export class ApiResponseError extends Error {
  constructor(
    public status: number,
    /** Human-readable message (for toast display). */
    public detail: string,
    /** Machine-readable error code from backend (e.g. "insufficient_balance"). */
    public code: string = 'unknown',
    /**
     * Raw Pydantic 422 entries (`{loc, msg, type}`) when the failure is a
     * validation error, else undefined. FE-70: the external-activity form
     * binds each 422 to its control (the backend deliberately returns
     * SEVERAL field errors at once), which a joined string cannot express.
     * `detail` stays the single toast line; this is the per-field structure.
     */
    public validation?: Array<{ loc: (string | number)[]; msg: string; type: string }>,
  ) {
    super(detail)
    this.name = 'ApiResponseError'
  }

  /**
   * The backend trace id of the failed response (X-Trace-ID), or null when
   * the response carried none. The full id; `detail` already shows its
   * first six characters (i18n:common.traceSuffix), this keeps it readable
   * as data (useApiError, the error reporter) without parsing the text.
   */
  traceId: string | null = null
}

/** The request never reached the backend (network failure). */
export class ApiNetworkError extends Error {
  constructor() {
    super('Network error -- check your connection')
    this.name = 'ApiNetworkError'
  }
}

/** The request exceeded the client timeout and was aborted. */
export class ApiTimeoutError extends Error {
  constructor(timeoutMs: number = REQUEST_TIMEOUT_MS) {
    super(`Request timed out after ${timeoutMs / 1000}s`)
    this.name = 'ApiTimeoutError'
  }
}

/** HTTP methods the client sends. */
export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

/** Per-request options for `api.request`. */
export interface RequestOptions {
  /** JSON body; omitted means no body and no Content-Type. */
  body?: unknown
  /** Extra headers (e.g. `Idempotency-Key`); Authorization is the client's own. */
  headers?: Record<string, string>
  /**
   * Abort after this many milliseconds and reject with ApiTimeoutError.
   *
   * @defaultValue 15000
   */
  timeoutMs?: number
  /**
   * The caller's cancellation. Aborting it rejects the request with the
   * signal's reason when that is an Error (an `AbortError` DOMException
   * otherwise), never with ApiTimeoutError.
   */
  signal?: AbortSignal
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
 *
 * @remarks
 * Invoked only when the 401 answers a request that carried the token which
 * is still current: a request sent anonymously, or with a token that was
 * replaced or cleared while it was in flight, says nothing about the
 * session the page holds now.
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

async function request<T>(
  method: HttpMethod,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  if (method === 'GET') return send<T>(method, path, options)
  // Any mutation may change what a GET returns, so the in-flight GETs are
  // dropped when it starts AND when it settles: a GET that left while the
  // mutation was in flight may carry the pre-mutation state, and a read
  // issued after the mutation must go to the network, not join it.
  _inFlight.clear()
  try {
    return await send<T>(method, path, options)
  } finally {
    _inFlight.clear()
  }
}

/**
 * The error an aborted caller signal rejects with: its own reason when that
 * is an Error, else an `AbortError` DOMException (older webviews carry no
 * reason at all).
 */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error
    ? reason
    : new DOMException('The request was aborted', 'AbortError')
}

async function send<T>(method: HttpMethod, path: string, options: RequestOptions): Promise<T> {
  const { body, signal, timeoutMs = REQUEST_TIMEOUT_MS } = options
  if (signal?.aborted) throw abortReason(signal)

  const headers: Record<string, string> = { ...options.headers }

  // The token this request leaves with: a 401 tears down the session only
  // when it answers THIS token and the token is still the current one.
  const sentToken = _token
  if (sentToken) {
    headers['Authorization'] = `Bearer ${sentToken}`
  }

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }

  // One controller serves both the timeout and the caller's signal; the
  // flag tells them apart, so a caller's cancel never reads as a timeout.
  const controller = new AbortController()
  let timedOut = false
  const timeoutId = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const forwardAbort = (): void => controller.abort()
  signal?.addEventListener('abort', forwardAbort)

  let response: Response

  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
  } catch {
    if (signal?.aborted) throw abortReason(signal)
    if (timedOut) throw new ApiTimeoutError(timeoutMs)
    throw new ApiNetworkError()
  } finally {
    clearTimeout(timeoutId)
    signal?.removeEventListener('abort', forwardAbort)
  }

  // A cancel that lands after the headers still means the caller does not
  // want the answer.
  if (signal?.aborted) throw abortReason(signal)

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
  // FE-157: only a 401 for the token that is still current ends the session.
  if (response.status === 401) {
    if (sentToken !== null && sentToken === _token) _onUnauthorized?.()
    throw withTraceId(
      traceId,
      new ApiResponseError(401, suffixWithTraceId('Session expired', traceId), 'unauthorized'),
    )
  }

  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw withTraceId(
      traceId,
      new ApiResponseError(
        response.status,
        suffixWithTraceId('Invalid response from server', traceId),
      ),
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
    throw withTraceId(
      traceId,
      new ApiResponseError(
        response.status,
        suffixWithTraceId(errorData.message, traceId),
        errorData.error ?? 'unknown',
      ),
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

  throw withTraceId(
    traceId,
    new ApiResponseError(
      response.status,
      suffixWithTraceId(detail, traceId),
      'validation_error',
      Array.isArray(rawDetail) ? rawDetail : undefined,
    ),
  )
}

/** Attach the response's trace id to an error built from it (ApiResponseError.traceId). */
function withTraceId(traceId: string | null, error: ApiResponseError): ApiResponseError {
  error.traceId = traceId
  return error
}

// W29-trimmed: append a greppable diagnostic key to a user-facing error
// message, so a tester's bug report carries the same key as the backend log
// line (TraceIdMiddleware, backend/app/core/middleware.py). FIRST six chars
// -- the log line carries the full id, so a prefix match finds it with one
// grep. No header (network/timeout failures, which never reach this
// function) -> no suffix; never render an empty or placeholder code.
// tz-i18n 1.2: the "code" word in the rendered suffix is catalog copy
// (i18n:common.traceSuffix).
function suffixWithTraceId(message: string, traceId: string | null): string {
  return traceId
    ? i18n.global.t('common.traceSuffix', { message, code: traceId.slice(0, 6) })
    : message
}

// -- Public API --

/** The app's typed REST surface: token header, timeout, in-flight GET dedupe, error mapping. */
export const api = {
  /**
   * Send one request with per-call options (timeout, caller signal, body,
   * headers).
   *
   * @remarks
   * The general form behind the shorthands below. A GET sent here is never
   * joined with, or offered to, another in-flight GET: dedupe belongs to
   * `api.get` only, because a shared promise cannot honour one caller's
   * signal or timeout. Any non-GET still drops the in-flight GETs.
   *
   * @example
   * ```ts
   * api.request<Out>('POST', '/api/v1/ai/transcribe', { body, timeoutMs: 30_000 })
   * ```
   */
  request<T>(method: HttpMethod, path: string, options?: RequestOptions): Promise<T> {
    return request<T>(method, path, options)
  },

  get<T>(path: string): Promise<T> {
    // F-09: deduplicate simultaneous identical GET requests.
    const existing = _inFlight.get(path)
    if (existing) return existing as Promise<T>
    const promise = request<T>('GET', path).finally(() => {
      // Only our own entry: a mutation may have cleared the map and a newer
      // GET for the same path may already be registered.
      if (_inFlight.get(path) === promise) _inFlight.delete(path)
    })
    _inFlight.set(path, promise)
    return promise
  },

  post<T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    return request<T>('POST', path, { body, headers })
  },

  patch<T>(path: string, body?: unknown): Promise<T> {
    return request<T>('PATCH', path, { body })
  },

  put<T>(path: string, body?: unknown): Promise<T> {
    return request<T>('PUT', path, { body })
  },

  delete(path: string): Promise<void> {
    return request<void>('DELETE', path)
  },
}
