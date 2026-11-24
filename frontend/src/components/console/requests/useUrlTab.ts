// =============================================================================
// VELO Frontend -- the tab of a console screen, in the URL
// =============================================================================
//
// A tab rides `?tab=`, so a reload and the back button land where the admin
// was. An unknown value is the first tab. A tab change drops the open item
// (it belongs to the tab it was opened in) and every parameter that is not
// listed in `keep`.
// =============================================================================

import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

/**
 * The current tab and a writable model of it for a segmented control.
 *
 * @param tabs - the tab keys; the first is the default
 * @param keep - the query parameters that survive a tab change (filters)
 */
export function useUrlTab<T extends string>(
  tabs: readonly [T, ...T[]],
  keep: readonly string[] = [],
) {
  const route = useRoute()
  const router = useRouter()
  const tab = computed<T>(() => {
    const asked = route.query.tab
    return tabs.find((key) => key === asked) ?? tabs[0]
  })
  const tabModel = computed<string>({
    get: () => tab.value,
    set: (next) => {
      const kept = Object.fromEntries(
        keep.filter((k) => k in route.query).map((k) => [k, route.query[k]]),
      )
      void router.replace({ query: { ...kept, tab: next } })
    },
  })
  return { tab, tabModel }
}
