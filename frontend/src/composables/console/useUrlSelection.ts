// =============================================================================
// VELO Frontend -- the open item of a master-detail screen, in the URL
// =============================================================================
//
// A list screen keeps the item that is open next to the list (a complaint, a
// ticket) in one query parameter, so a reload and the back button land on it.
// Without it a wide window opens the first item of the list and a narrow one
// shows the list (useSplitLayout).
// =============================================================================

import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

/**
 * Read, set and drop the open item named in one query parameter.
 *
 * @param param - the query parameter that holds the item's id
 */
export function useUrlSelection(param: string) {
  const route = useRoute()
  const router = useRouter()
  return {
    /** The id in the URL, null when none is named. */
    urlId: computed<string | null>(() => {
      const value = route.query[param]
      return typeof value === 'string' && value ? value : null
    }),
    /** Open an item: the URL names it (a replace, so the back button leaves the screen). */
    select(id: string): void {
      void router.replace({ query: { ...route.query, [param]: id } })
    },
    /** Leave the open item. */
    clear(): void {
      void router.replace({ query: { ...route.query, [param]: undefined } })
    },
  }
}
