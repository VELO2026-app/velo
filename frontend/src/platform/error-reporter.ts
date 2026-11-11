// =============================================================================
// VELO Frontend -- Client error reporter (FE-157 stage 3, owner decision R2)
// =============================================================================
//
// One funnel for every uncaught frontend error: the Vue error handler,
// `window` error / unhandledrejection events and router navigation errors all
// end in reportError(). Frontend errors belong to the box's own log through
// the backend (BE-203); no third-party error service is used, because a
// product has no outbound route (Primer protocol 4.1) and box data must not
// leave the box.
//
// Until the BE-203 endpoint exists in api/generated.ts the transport is the
// console, in production too (owner decision R2: "until then, the console").
// It must be: once app.config.errorHandler and router.onError are set, Vue
// and vue-router no longer print the error themselves, so a silent default
// would hide every render and navigation failure. A real transport plugs in
// with setErrorTransport() and receives a ready-made, PII-free ErrorEvent.
// =============================================================================

import type { App } from 'vue'
import type { Router } from 'vue-router'
import { ApiResponseError } from '@/api/client'

/** Where in the app an error was caught. */
export type ErrorSource = 'vue' | 'unhandledrejection' | 'window' | 'router'

/** Caller-supplied circumstances of a reported error. */
export interface ErrorContext {
  /** Which global hook caught the error. */
  source: ErrorSource
  /** Extra hint from the hook, e.g. Vue's lifecycle-hook name. */
  info?: string
}

/**
 * A normalized error ready for a transport.
 *
 * Carries no user identity: no Telegram id, no names, no initData. `path` is
 * the location pathname without query or hash.
 */
export interface ClientErrorEvent {
  /** Error class name, e.g. "TypeError". */
  name: string
  message: string
  stack?: string
  source: ErrorSource
  info?: string
  /** location.pathname at the moment of the report. */
  path: string
  /** Epoch milliseconds. */
  ts: number
}

/** Receives every reportable error. Should not throw; a throw is swallowed anyway. */
export type ErrorTransport = (event: ClientErrorEvent) => void

/** The default until BE-203 lands, in every mode: print to the console. */
const consoleTransport: ErrorTransport = (event) => {
  console.error(`[velo:${event.source}] ${event.name}: ${event.message}`, event)
}

function defaultTransport(): ErrorTransport {
  return consoleTransport
}

let transport: ErrorTransport = defaultTransport()

/** Swap the transport (BE-203 sender, tests). Pass null to restore the default. */
export function setErrorTransport(next: ErrorTransport | null): void {
  transport = next ?? defaultTransport()
}

/** Expected failures are not bugs: a 4xx answer from the backend is a normal outcome. */
function isExpected(err: unknown): boolean {
  return err instanceof ApiResponseError && err.status >= 400 && err.status < 500
}

function currentPath(): string {
  return typeof location === 'undefined' ? '' : location.pathname
}

function toEvent(err: unknown, context: ErrorContext): ClientErrorEvent {
  const isError = err instanceof Error
  return {
    name: isError ? err.name : typeof err,
    message: isError ? err.message : String(err),
    stack: isError ? err.stack : undefined,
    source: context.source,
    info: context.info,
    path: currentPath(),
    ts: Date.now(),
  }
}

let reporting = false

/**
 * Report an uncaught error to the active transport.
 *
 * @remarks
 * Expected 4xx `ApiResponseError`s are ignored. Never throws and never
 * recurses: an error raised by the transport itself is dropped.
 */
export function reportError(err: unknown, context: ErrorContext): void {
  if (reporting || isExpected(err)) return
  reporting = true
  try {
    transport(toEvent(err, context))
  } catch {
    // The reporter must never become a new source of errors.
  } finally {
    reporting = false
  }
}

/**
 * Hook every global error channel into reportError().
 *
 * @remarks
 * Call once, after the router is installed.
 * @returns A function that removes the `window` listeners (used by tests).
 */
export function installGlobalErrorHandlers(app: App, router: Router): () => void {
  app.config.errorHandler = (err, _instance, info) => {
    reportError(err, { source: 'vue', info })
  }
  router.onError((err) => reportError(err, { source: 'router' }))

  const onRejection = (e: PromiseRejectionEvent): void =>
    reportError(e.reason, { source: 'unhandledrejection' })
  const onError = (e: ErrorEvent): void => reportError(e.error ?? e.message, { source: 'window' })
  window.addEventListener('unhandledrejection', onRejection)
  window.addEventListener('error', onError)
  return () => {
    window.removeEventListener('unhandledrejection', onRejection)
    window.removeEventListener('error', onError)
  }
}
