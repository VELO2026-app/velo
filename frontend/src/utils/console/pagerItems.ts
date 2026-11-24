// =============================================================================
// VELO Frontend -- page buttons of the console pager (FE-262)
// =============================================================================
//
// Which page numbers the pager shows: the first and the last page and the
// current one with its neighbours; a longer run in between is one gap.
// =============================================================================

/** Pages up to this count are all shown; more get gaps. */
const ALL_PAGES_UP_TO = 7

/**
 * The buttons of a pager: a page number, or `null` for a gap ("...").
 *
 * @param page - current page, 1-based
 * @param count - number of pages
 * @returns page numbers in order, with `null` where a run of pages is left out
 */
export function pagerItems(page: number, count: number): Array<number | null> {
  if (count <= ALL_PAGES_UP_TO) return Array.from({ length: count }, (_, i) => i + 1)
  const shown = new Set([1, count, page - 1, page, page + 1].filter((n) => n >= 1 && n <= count))
  const numbers = [...shown].sort((a, b) => a - b)
  const items: Array<number | null> = []
  let previous = 0
  for (const n of numbers) {
    // A gap of exactly one page shows that page: "1 ... 3" would hide only "2".
    if (n - previous === 2) items.push(previous + 1)
    else if (n - previous > 2) items.push(null)
    items.push(n)
    previous = n
  }
  return items
}
