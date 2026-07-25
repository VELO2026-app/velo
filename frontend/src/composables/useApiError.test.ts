// =============================================================================
// VELO Frontend -- useApiError.ts Unit Tests
// =============================================================================
//
// First direct unit tests for this file. B3 (Батч 3, ПРОМТ №580) extended
// extractApiError to also fall back on an EMPTY ApiResponseError.detail --
// previously several call sites duplicated that guard inline
// (`e.detail || fallback`) because the helper's own `e.detail` was
// unconditional. Pinning the full contract here so future edits can't
// silently drop either branch.
// =============================================================================

import { describe, it, expect } from 'vitest'
import { extractApiError } from '@/composables/useApiError'
import { ApiResponseError } from '@/api/client'

describe('extractApiError', () => {
  it('returns detail for an ApiResponseError with a non-empty detail', () => {
    const result = extractApiError(new ApiResponseError(400, 'Недостаточно средств'), 'fallback')
    expect(result).toBe('Недостаточно средств')
  })

  it('B3: falls back when ApiResponseError.detail is an EMPTY string', () => {
    const result = extractApiError(new ApiResponseError(500, ''), 'Не удалось выполнить действие')
    expect(result).toBe('Не удалось выполнить действие')
  })

  it('returns the fallback for a non-ApiResponseError (network failure, etc)', () => {
    const result = extractApiError(new Error('ECONNRESET'), 'Не удалось выполнить действие')
    expect(result).toBe('Не удалось выполнить действие')
  })

  it('returns the fallback for a non-Error thrown value', () => {
    const result = extractApiError('a raw string throw', 'fallback message')
    expect(result).toBe('fallback message')
  })
})
