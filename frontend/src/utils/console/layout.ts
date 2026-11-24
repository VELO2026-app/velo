// =============================================================================
// VELO Frontend -- the console's width breakpoints (FE-262)
// =============================================================================
//
// One place for the widths the console changes its layout at. A CSS media
// query cannot read a constant, so the stylesheets that fold at the same
// width (ConsolePage, ConsoleSidebar, the practice screen) repeat the number
// in a comment that points here; change it in all of them together.
// =============================================================================

/** The widest window (px) with a folded menu: below 1200 px it is an icon rail (a tablet, a small laptop). */
export const CONSOLE_NARROW_MAX = 1199

/** The widest window (px) where the content of a split screen is too narrow for its widest tables. */
export const CONSOLE_MEDIUM_MAX = 1399

/** The media query of a window with a folded menu. */
export const CONSOLE_NARROW_QUERY = `(max-width: ${CONSOLE_NARROW_MAX}px)`

/** The media query of a window under CONSOLE_MEDIUM_MAX. */
export const CONSOLE_MEDIUM_QUERY = `(max-width: ${CONSOLE_MEDIUM_MAX}px)`
