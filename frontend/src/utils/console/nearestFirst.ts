// =============================================================================
// VELO Frontend -- "nearest first" pages of the upcoming practices (FE-262)
// =============================================================================
//
// The console shows the upcoming practices nearest first. GET /admin/practices
// has listed every scope newest first, which puts the nearest practices on the
// LAST page; BE-257 sorts the upcoming scope ascending instead. The console
// does not rely on either: it reads which way the answer runs (the first and
// the last row) and takes the slice that page `page` of the nearest-first view
// is made of, then sorts that slice by date itself.
// =============================================================================

/** The slice of the API's list that one page of the nearest-first view shows. */
export interface NearestFirstWindow {
  /** Where the slice starts in the API's list. */
  offset: number
  /** How many rows the slice has. */
  limit: number
}

/**
 * The slice of the API's list for page `page` of the same list read nearest
 * first.
 *
 * @param total - rows in the whole list
 * @param page - the page, 1-based
 * @param size - rows per page
 * @param ascending - the API's list runs nearest first already (BE-257);
 *  false: newest first, so the page is counted from the end
 * @returns the slice, or null when the page lies past the end of the list
 */
export function nearestFirstWindow(
  total: number,
  page: number,
  size: number,
  ascending = false,
): NearestFirstWindow | null {
  const start = (page - 1) * size
  if (start >= total) return null
  const end = Math.min(page * size, total)
  return ascending
    ? { offset: start, limit: end - start }
    : { offset: total - end, limit: end - start }
}

/**
 * Does a list run nearest first? Read from its first and last rows: equal
 * dates (one row, or every row at one moment) count as nearest first --
 * then both ways give the same page.
 */
export function runsAscending(first: string | undefined, last: string | undefined): boolean {
  if (first === undefined || last === undefined) return true
  return Date.parse(first) <= Date.parse(last)
}

/** The rows sorted by date, nearest first; rows at one moment keep their order. */
export function nearestFirst<T extends { scheduled_at: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at))
}
