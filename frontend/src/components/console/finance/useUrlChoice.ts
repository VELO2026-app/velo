// =============================================================================
// VELO Frontend -- one choice of a console screen, in the URL
// =============================================================================
//
// The tab, or the status or filter inside it, rides one query parameter
// (`?tab=withdrawals`, `?status=approved`), so a reload and the back button
// land where the admin was. A value the screen does not know falls back to
// the first one; a changed choice drops what belonged to the old one.
// =============================================================================

import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

/**
 * One choice from a fixed set, kept in one query parameter.
 *
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
