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
//     return { ok: false, error: extractApiError(e, 'Не удалось выполнить действие') }
//   }
// =============================================================================

import { ApiResponseError } from '@/api/client'
import { ERROR_MESSAGES, GENERIC_ERROR_MESSAGE } from '@/api/errorMessages'

/**
 * Look up a known backend error code's Russian phrase directly, with no
 * caught exception and no caller-supplied fallback.
 *
 * PROMPT №747: replaces the `ERROR_MESSAGES.some_code!` non-null-assertion
 * pattern the 7 migrated point-branches used -- that assertion SILENCED
 * `noUncheckedIndexedAccess` instead of answering it. This function answers
 * it: a code with a table entry returns its phrase; anything else (a typo,
 * a future code the table hasn't caught up with yet) returns
 * GENERIC_ERROR_MESSAGE, never `undefined`, so the type is `string`
 * everywhere without an assertion at any call site.
 */
export function errorMessage(code: string): string {
  return ERROR_MESSAGES[code] || GENERIC_ERROR_MESSAGE
}

/**
 * Extract a human-readable error message from a caught exception.
 *
 * - ApiResponseError whose code has a table entry (errorMessages.ts):
 *   returns that Russian phrase. If a code has a phrase, it wins.
 * - Anything else (an unmapped code, or not an ApiResponseError at all):
 *   returns the caller-provided fallback string.
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
 * B3 (Батч 3, PROMPT №580, historical): the empty-detail fallback was
 * previously duplicated inline at several call sites (`e.detail || fallback`,
 * not just `e.detail`) -- folded in here so every caller gets it. That
 * concern is now subsumed: an empty detail and an unmapped code both land on
 * the caller's fallback the same way.
 */
export function extractApiError(e: unknown, fallback: string): string {
  if (e instanceof ApiResponseError) {
    return ERROR_MESSAGES[e.code] || fallback
  }
  return fallback
}
