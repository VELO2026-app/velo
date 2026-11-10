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

/** A path value that cannot be a single safe segment (see `path`). */
export class UnsafePathSegmentError extends Error {
  constructor(public readonly value: string) {
    super(`unsafe path segment: ${JSON.stringify(value)}`)
    this.name = 'UnsafePathSegmentError'
  }
}

/**
 * Encode one path segment, refusing values no encoding can make safe.
 *
 * @remarks Encoding alone is not enough: the URL parser treats `%2E%2E` and
 * `%2E` as dot-segments and collapses them (WHATWG URL), and the backend
 * routes on the DECODED path (uvicorn unquotes raw_path), so an encoded `/`
 * still reaches another endpoint. Every value interpolated today is an id,
 * a token or a slug, none of which may be empty or contain a slash.
 *
 * @throws UnsafePathSegmentError for `''`, `.`, `..`, or a value with `/` or `\`.
 */
function encodeSegment(value: unknown): string {
  const s = String(value)
  if (s === '' || s === '.' || s === '..' || /[/\\]/.test(s)) throw new UnsafePathSegmentError(s)
  return encodeURIComponent(s)
}

/**
 * Tagged template that builds an API path, encoding every interpolated value
 * so an id containing `?`, `#` or other reserved characters cannot change the
 * route, and refusing values that would (an empty value, `.`, `..`, a slash).
 * Values wrapped in `raw` are inserted verbatim.
 *
 * @example
 * ```ts
 * path`/api/v1/practices/${id}`      // id "a?b" -> "/api/v1/practices/a%3Fb"
 * path`/api/v1/practices${raw(qs)}`  // query string kept as is
 * ```
 *
 * @throws UnsafePathSegmentError when a value cannot be one safe segment.
 */
export function path(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = strings[0] ?? ''
  values.forEach((v, i) => {
    out += (v instanceof RawPath ? v.value : encodeSegment(v)) + (strings[i + 1] ?? '')
  })
  return out
}
