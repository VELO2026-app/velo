// =============================================================================
// VELO Frontend -- useApiError (WARNING-1)
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

/**
 * Extract a human-readable error message from a caught exception.
 *
 * - ApiResponseError with a non-empty detail: returns e.detail (message from backend)
 * - ApiResponseError with an EMPTY detail, or anything else: returns the
 *   provided fallback string
 *
 * B3 (Батч 3, ПРОМТ №580): the empty-detail fallback was previously
 * duplicated inline at several call sites (`e.detail || fallback`, not just
 * `e.detail`) -- folded in here so every caller gets it, not just the ones
 * that happened to write the guard themselves. A backend response with a
 * genuinely empty detail string (e.g. client.ts's VeloError branch when
 * `message` is `""`) would otherwise toast a blank message.
 */
export function extractApiError(e: unknown, fallback: string): string {
  return e instanceof ApiResponseError ? e.detail || fallback : fallback
}
