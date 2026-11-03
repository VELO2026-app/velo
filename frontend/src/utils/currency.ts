// =============================================================================
// VELO Frontend -- Currency utilities
// =============================================================================
//
// W-6: parseFloat(raw) * 100 is unsafe due to IEEE-754 float precision.
// Classic trap: parseFloat('14.99') * 100 = 1498.9999999999998
//               Math.round(...)         = 1499  (correct here, but brittle)
//               parseFloat('0.575') * 100 = 57.49999999999999
//               Math.round(...)           = 57   (wrong!)
//
// eurStringToCents() parses the integer and fractional parts as integers,
// avoiding any floating-point multiplication entirely.
// =============================================================================

/**
 * Convert a user-typed euro string to integer cents.
 * Handles missing fractional part, single-digit fractions, and empty/invalid input.
 *
 * Examples:
 *   `"15"     -> 1500`
 *   `"15.9"   -> 1590`
 *   `"15.99"  -> 1599`
 *   `"15.999" -> 1599`  (truncated, not rounded -- display-only input)
 *   `"0"      -> 0`
 *   `""       -> 0`
 *   `"abc"    -> 0`
 */
export function eurStringToCents(raw: string): number {
  const trimmed = raw.trim()
  if (!trimmed) return 0

  const dotIndex = trimmed.indexOf('.')
  let intPart: string
  let fracPart: string

  if (dotIndex === -1) {
    intPart = trimmed
    fracPart = '00'
  } else {
    intPart = trimmed.slice(0, dotIndex)
    // Pad to 2 digits, truncate anything beyond 2 decimal places
    fracPart = trimmed
      .slice(dotIndex + 1)
      .padEnd(2, '0')
      .slice(0, 2)
  }

  const euros = parseInt(intPart || '0', 10)
  const cents = parseInt(fracPart, 10)

  if (isNaN(euros) || isNaN(cents) || euros < 0) return 0
  return euros * 100 + cents
}

/**
 * Convert integer cents to a display string suitable for price inputs.
 * Always returns exactly 2 decimal places.
 *
 * Examples:
 *   `1599 -> "15.99"`
 *   `1500 -> "15.00"`
 *   `100  -> "1.00"`
 *   `0    -> "0.00"`
 */
export function centsToEurString(cents: number): string {
  // toFixed(2) is safe here: we're converting from an integer, no float math.
  return (cents / 100).toFixed(2)
}
