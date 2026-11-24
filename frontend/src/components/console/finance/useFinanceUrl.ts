// =============================================================================
// VELO Frontend -- the state of the Finance screen, in the URL
// =============================================================================
//
// The tab, the status or filter inside it and the page ride the query
// (`?tab=withdrawals&status=approved&page=2`), so a reload and the back
// button land where the admin was. A value the screen does not know falls
// back to the first one; a changed choice drops what belonged to the old one.
// =============================================================================

import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

/**
 * One choice from a fixed set, kept in one query parameter.
 *
 * @param param - the query parameter
 * @param values - the allowed values; the first is the default
 * @param dropOnChange - query parameters that go when the choice changes
 */
export function useUrlChoice<T extends string>(
  param: string,
  values: readonly [T, ...T[]],
  dropOnChange: readonly string[] = ['page'],
) {
  const route = useRoute()
  const router = useRouter()
  const value = computed<T>(() => values.find((v) => v === route.query[param]) ?? values[0])
  return {
    /** The current choice. */
    value,
    /** Make a choice; a value outside the set changes nothing. */
    set: (next: string): void => {
      const found = values.find((v) => v === next)
      if (found === undefined) return
      const dropped = Object.fromEntries(dropOnChange.map((key) => [key, undefined]))
      void router.replace({ query: { ...route.query, ...dropped, [param]: found } })
    },
  }
}

/** The page (1-based) in `?page=`; anything that is not a positive whole number is page 1. */
export function useUrlPage() {
  const route = useRoute()
  const router = useRouter()
  const page = computed<number>(() => {
    const n = Number(route.query.page)
    return Number.isInteger(n) && n >= 1 ? n : 1
  })
  return {
    page,
    /** Go to a page; page 1 leaves no `page` in the URL. */
    setPage: (next: number): void => {
      void router.replace({ query: { ...route.query, page: next > 1 ? String(next) : undefined } })
    },
  }
}
