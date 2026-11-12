// =============================================================================
// VELO Frontend -- useApiError (WARNING-1; B8 PROMPT №746)
// =============================================================================
//
// Single source of truth for API error message extraction.
// Replaces 7+ identical try/catch patterns across stores.
//
// Usage:
//   import { extractApiError } from '@/composables/useApiError'
//
//   } catch (e) {
//     return { ok: false, error: extractApiError(e, fallbackMessage) }
//   }
//
// tz-i18n 1.2: a known code resolves through the `errors` catalog
// (locales/ru/errors.json, was the ERROR_MESSAGES table); the caller fallback is
// still a plain string -- stores use storeErrors.* keys, views migrate in
// their phase-3 batches.
// =============================================================================

import { ApiResponseError } from '@/api/client'
import i18n from '@/locales'
import { hasErrorMessage } from '@/api/errorMessages'

export { errorMessage } from '@/api/errorMessages'

/** Append the trace code (when the error carries one) to a user-facing message. */
function withTrace(message: string, e: ApiResponseError): string {
  // The same six-character prefix api/client.ts folds into `detail`.
  const code = e.traceId?.slice(0, 6)
  return code ? i18n.global.t('common.traceSuffix', { message, code }) : message
}

/**
 * Extract a human-readable error message from a caught exception.
 *
 * B8 (PROMPT №746): this used to return e.detail -- the backend's own,
 * often-English message -- whenever it was non-empty, and only fell back to
 * the caller's Russian string on a genuinely empty detail. That is the exact
 * mechanism that put raw English on a Russian speaker's screen for every
 * code with no hand-written point-branch upstream. e.detail is no longer
 * read here at all: a known code shows its phrase, an unknown one shows the
 * caller's own fallback, which is already Russian at every existing call
 * site -- so nothing downstream needed to change to stop leaking English.
 *
 * The backend trace code, when the response carried one, is appended through
 * i18n:common.traceSuffix so support can find the request in the box log.
 *
 * @returns For an ApiResponseError whose code has a catalog entry (locales
 *   errors.*), that phrase -- if a code has a phrase, it wins; anything else
 *   (an unmapped code, or not an ApiResponseError at all) returns the
 *   caller-provided fallback string. Either result carries the trace suffix
 *   when the error has a trace code.
 */
export function extractApiError(e: unknown, fallback: string): string {
  if (e instanceof ApiResponseError) {
    const key = `errors.${e.code}`
    return withTrace(hasErrorMessage(e.code) ? i18n.global.t(key) : fallback, e)
  }
  return fallback
}
