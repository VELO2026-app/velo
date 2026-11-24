// =============================================================================
// VELO Frontend -- width classes of a console screen (FE-262)
// =============================================================================
//
// The console opens from 744 px. The menu folds to an icon strip below
// 1200 px, and below 1400 px the content of a split screen is too narrow for
// its widest tables (utils/console/layout.ts has the numbers). Layout that CSS alone can decide stays in the screen's
// own media queries; this is for what changes the markup (which table
// columns exist, list and card side by side or one under the other).
//
// Both flags read false without matchMedia (tests): the full layout.
// =============================================================================

import { useMediaQuery } from '@/composables/useMediaQuery'
import { CONSOLE_MEDIUM_QUERY, CONSOLE_NARROW_QUERY } from '@/utils/console/layout'

/** Width classes of the window: narrow -- the menu is folded; medium -- under 1400 px. */
export function useConsoleWidth() {
  return {
    /** Under 1200 px: a tablet or a small laptop, the menu is an icon strip. */
    narrow: useMediaQuery(CONSOLE_NARROW_QUERY),
    /** Under 1400 px: the widest tables drop their secondary columns. */
    medium: useMediaQuery(CONSOLE_MEDIUM_QUERY),
  }
}
