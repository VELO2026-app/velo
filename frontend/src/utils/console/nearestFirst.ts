// =============================================================================
// VELO Frontend -- "nearest first" pages of the upcoming practices (FE-262)
// =============================================================================
//
// GET /admin/practices lists every scope newest first, upcoming included, so
// the nearest practices stand on the LAST page. Until the backend can sort the
// upcoming scope ascending, the console pages it from the end: page 1 is the
// last slice of the answer, its rows turned around. This is the slice.
// =============================================================================

/** The slice of a newest-first list that one page of the nearest-first view shows. */
export interface NearestFirstWindow {
  /** Where the slice starts in the newest-first list. */
  offset: number
  /** How many rows the slice has. */
  limit: number
}

/**
 * The slice of a newest-first list for page `page` of the same list read
 * nearest first.
 *
 * @param total - rows in the whole list
 * @param page - the page, 1-based
 * @param size - rows per page
 * @returns the slice, or null when the page lies past the end of the list
 */
export function nearestFirstWindow(
  total: number,
  page: number,
  size: number,
): NearestFirstWindow | null {
  const start = (page - 1) * size
  if (start >= total) return null
  const end = Math.min(page * size, total)
  return { offset: total - end, limit: end - start }
}
