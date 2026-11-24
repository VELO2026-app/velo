// =============================================================================
// VELO Frontend -- where the web console opens (FE-262)
// =============================================================================
//
// The console is for a computer: a browser window at least CONSOLE_MIN_WIDTH
// wide. Inside Telegram (any device: the Mini App window is a phone column
// even on the desktop client) and in a narrower window the console shows a
// stub that sends the person to a computer instead of its screens.
// =============================================================================

import type { Platform } from '@/platform/types'

/** The narrowest browser window the console opens in, px. */
export const CONSOLE_MIN_WIDTH = 1024

/** The media query of a window wide enough for the console. */
export const CONSOLE_WIDE_QUERY = `(min-width: ${CONSOLE_MIN_WIDTH}px)`

/** Why the console does not open here: inside Telegram, or a narrow window. */
export type ConsoleBlock = 'telegram' | 'narrow'

/**
 * Whether the console opens in this environment, and if not, why.
 *
 * @param platformName - the running platform (telegram or standalone browser)
 * @param wide - whether the window matches CONSOLE_WIDE_QUERY
 * @returns null when the console opens, else the reason it does not
 */
export function consoleBlock(platformName: Platform['name'], wide: boolean): ConsoleBlock | null {
  if (platformName === 'telegram') return 'telegram'
  return wide ? null : 'narrow'
}
