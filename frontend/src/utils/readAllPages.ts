// =============================================================================
// VELO Frontend -- read an offset-paged list to its end (FE-260)
// =============================================================================
//
// Some master screens filter or count over a whole list on the client (the
// students search, the needs-attention block, the active promo codes). One
// page of the API would cut the rest silently, so these read page after page
// until the total, up to a cap; past the cap the screen says how many of the
// total it shows.
// =============================================================================

/** One page of an offset-paged list, as the API answers it. */
export interface OffsetPage<T> {
  items: T[]
  total: number
}

/** A list read to its end, or to the cap. */
export interface AllPages<T> {
  items: T[]
  /** The API's count of the whole list. */
  total: number
  /** Every row was read; false -- the cap stopped the read first. */
  complete: boolean
}

/** The API's largest page (`limit` le=100 on the master list routes). */
export const ALL_PAGES_SIZE = 100

/** Pages read at most: 2 000 rows. */
export const ALL_PAGES_MAX = 20

/**
 * Read every page of an offset-paged list.
 *
 * @param read - one page: `limit` rows from `offset`
 * @returns the rows in the API's order, each id once, its total, and whether
 *  all came. The offset moves by the rows the API gave, so a row added
 *  while the pages are read shifts one already read onto the next page --
 *  that repeat is dropped (it would be a duplicate key on screen). An empty
 *  page ends the read (a total that ran ahead of the rows).
 */
export async function readAllPages<T extends { id: string }>(
  read: (limit: number, offset: number) => Promise<OffsetPage<T>>,
): Promise<AllPages<T>> {
  const items: T[] = []
  const seen = new Set<string>()
  let offset = 0
  let total = 0
  for (let page = 0; page < ALL_PAGES_MAX; page++) {
    const answer = await read(ALL_PAGES_SIZE, offset)
    total = answer.total
    offset += answer.items.length
    for (const row of answer.items) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      items.push(row)
    }
    if (answer.items.length === 0 || offset >= total) return { items, total, complete: true }
  }
  return { items, total, complete: offset >= total }
}
