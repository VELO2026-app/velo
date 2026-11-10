// =============================================================================
// VELO Frontend -- URL path builder
// =============================================================================

/** Marker for an already-safe URL fragment (a base path or a query string). */
class RawPath {
  constructor(public readonly value: string) {}
}

/**
 * Mark a fragment as already URL-safe so `path` inserts it verbatim.
 *
 * Use only for constants (`/api/v1/...` bases) and for output of
 * `buildQuery`; never for ids or other external values.
 */
export function raw(value: string): RawPath {
  return new RawPath(value)
}

/**
 * Encode one path segment. `encodeURIComponent` leaves `.` untouched, so a
 * bare `.` / `..` segment (dot-segment traversal) is escaped explicitly.
 */
function encodeSegment(value: unknown): string {
  const s = String(value)
  if (s === '.') return '%2E'
  if (s === '..') return '%2E%2E'
  return encodeURIComponent(s)
}

/**
 * Tagged template that builds an API path, encoding every interpolated value
 * so an id containing `/`, `?`, `#` or `..` cannot change the route. Values
 * wrapped in `raw` are inserted verbatim.
 *
 * @example
 * ```ts
 * path`/api/v1/practices/${id}`      // id "a/b" -> "/api/v1/practices/a%2Fb"
 * path`/api/v1/practices${raw(qs)}`  // query string kept as is
 * ```
 */
export function path(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = strings[0] ?? ''
  values.forEach((v, i) => {
    out += (v instanceof RawPath ? v.value : encodeSegment(v)) + (strings[i + 1] ?? '')
  })
  return out
}
