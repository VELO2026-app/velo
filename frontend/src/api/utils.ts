// =============================================================================
// VELO Frontend -- API Utilities (Phase F4.1, extended Calendar)
// =============================================================================
//
// Shared helpers used across API modules (practices.ts, bookings.ts, etc.).
// =============================================================================

// A single query value. Arrays are serialized as repeated keys
// (?k=a&k=b), matching FastAPI's list[...] query params.
type QueryScalar = string | number | boolean
type QueryValue = QueryScalar | QueryScalar[] | undefined | null

/**
 * Build query string from an object, skipping undefined/null values and
 * empty arrays. Array values are serialized as repeated keys.
 *
 * @example
 * ```ts
 * buildQuery({ limit: 20, offset: 0, status: undefined })
 * // => "?limit=20&offset=0"
 *
 * buildQuery({ direction: ['yoga', 'breathwork'] })
 * // => "?direction=yoga&direction=breathwork"
 *
 * buildQuery({ direction: [] }) // empty array -> skipped
 * // => ""
 * ```
 */
export function buildQuery(params: Record<string, QueryValue>): string {
  const qs = new URLSearchParams()

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue

    if (Array.isArray(value)) {
      // Empty array means "no value for this axis" -> skip entirely.
      // Each element becomes a repeated key (?key=a&key=b).
      for (const item of value) {
        qs.append(key, String(item))
      }
      continue
    }

    qs.append(key, String(value))
  }

  const result = qs.toString()
  return result ? `?${result}` : ''
}
