// =============================================================================
// VELO Frontend -- width classes of the finance tables
// =============================================================================
//
// The console opens from 744 px; below 1200 px the menu is an icon rail
// (ConsolePage, ConsoleSidebar fold at the same width), and below 1400 px the
// content is too narrow for the tables' widest column set. CSS alone cannot
// drop a table column, so the tables read these flags. Both read false
// without matchMedia (tests): the full layout.
// =============================================================================

import { useMediaQuery } from '@/composables/useMediaQuery'

/** The widest window (px) with the folded menu: the tables keep only the main columns. */
const NARROW_MAX = 1199
/** The widest window (px) where a table drops its secondary columns. */
const MEDIUM_MAX = 1399

/** Width classes of the window for a finance table. */
export function useFinanceWidth() {
  return {
    /** Under 1200 px: a tablet or a small laptop, the menu is an icon rail. */
    narrow: useMediaQuery(`(max-width: ${NARROW_MAX}px)`),
    /** Under 1400 px (a narrow window too): secondary columns move into the first one. */
    medium: useMediaQuery(`(max-width: ${MEDIUM_MAX}px)`),
  }
}
