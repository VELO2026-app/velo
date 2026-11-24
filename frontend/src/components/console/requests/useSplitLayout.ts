// =============================================================================
// VELO Frontend -- how a master-detail screen lays out on a narrow window
// =============================================================================
//
// The console opens from 744 px (a tablet) up. Next to the menu strip that
// leaves a content area of ~670 px, too narrow for a list and a card side by
// side: below SINGLE_PANE_QUERY the screen shows the list OR the open item,
// with a way back. Between that and the full desktop the two fit, the list a
// little narrower (MEDIUM_QUERY). CSS-only changes (stacked blocks, fewer
// columns) use the same breakpoints as plain @media rules.
// =============================================================================

import { computed } from 'vue'
import { useMediaQuery } from '@/composables/useMediaQuery'

/** Below it the list and the open item take turns (a tablet in portrait). */
export const SINGLE_PANE_QUERY = '(max-width: 899px)'
/** Below it the menu is a strip of icons and the list column is narrower. */
export const MEDIUM_QUERY = '(max-width: 1199px)'

/**
 * The layout of a master-detail screen for the current window.
 *
 * @param hasOpenItem - whether an item is open (picked in the URL)
 */
export function useSplitLayout(hasOpenItem: () => boolean) {
  const single = useMediaQuery(SINGLE_PANE_QUERY)
  const medium = useMediaQuery(MEDIUM_QUERY)
  return {
    /** The list and the item take turns: no item is picked for the admin. */
    single,
    /** `both` side by side, or the one that is on turn when `single`. */
    pane: computed<'both' | 'list' | 'detail'>(() => {
      if (!single.value) return 'both'
      return hasOpenItem() ? 'detail' : 'list'
    }),
    /** Width of the list column, px. */
    listWidth: (wide: number, narrow: number) => (medium.value ? narrow : wide),
  }
}
