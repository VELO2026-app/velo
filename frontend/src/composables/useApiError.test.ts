// =============================================================================
// VELO Frontend -- useApiError.ts Unit Tests
// =============================================================================
//
// B8 (PROMPT №746): extractApiError no longer reads e.detail AT ALL -- that
// was the backend's own, usually-English message, and reading it here is
// exactly what put raw English on a Russian speaker's screen for any code
// with no point-branch upstream. It now looks e.code up in errorMessages.ts
// and, on a miss, returns the caller's own fallback -- never the detail.
// Pinning the full contract here so future edits can't silently reintroduce
// the detail read.
//
// B3 (Батч 3, PROMPT №580, historical): extended extractApiError to also
// fall back on an EMPTY ApiResponseError.detail. That concern is subsumed
// now -- an empty detail and an unmapped code land on the fallback the same
// way, since detail is never consulted either way.
// =============================================================================

import { describe, it, expect } from 'vitest'
import { extractApiError } from '@/composables/useApiError'
import { ApiResponseError } from '@/api/client'
import { ERROR_MESSAGES } from '@/api/errorMessages'

describe('extractApiError', () => {
  it('returns the table phrase for an ApiResponseError whose code is mapped, ignoring detail', () => {
    const result = extractApiError(
      new ApiResponseError(
        400,
        'Insufficient balance (raw English detail)',
        'insufficient_balance',
      ),
      'fallback',
    )
    expect(result).toBe(ERROR_MESSAGES.insufficient_balance)
  })

  it('returns the fallback for an ApiResponseError whose code has no table entry -- never e.detail', () => {
    const result = extractApiError(
      new ApiResponseError(500, 'Some raw backend detail', 'some_unmapped_future_code'),
      'Не удалось выполнить действие',
    )
    expect(result).toBe('Не удалось выполнить действие')
  })

  it('returns the fallback for an ApiResponseError with an EMPTY detail and no code (code defaults to "unknown")', () => {
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
