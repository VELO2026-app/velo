// =============================================================================
// VELO Frontend -- a status word the screen knows, or the one that came (FE-262)
// =============================================================================
//
// The API sends statuses as strings, and a newer backend can send one the
// screen has no word for. The screen shows its own word for the statuses it
// knows and the raw string for the rest, never a missing-key path.
// =============================================================================

/**
 * The word of a known status, else the status as it came.
 *
 * @param value - the status as the API sent it
 * @param isKnown - a type guard: whether the screen has a word for the status
 * @param label - the word of a known status
 */
export function labelOrRaw<Known extends string>(
  value: string,
  isKnown: (value: string) => value is Known,
  label: (known: Known) => string,
): string {
  return isKnown(value) ? label(value) : value
}
