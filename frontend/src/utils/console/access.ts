// =============================================================================
// VELO Frontend -- where the web console opens (FE-262)
// =============================================================================
//
// The console is for a computer or a tablet: a browser window at least
// CONSOLE_MIN_WIDTH wide and CONSOLE_MIN_HEIGHT tall. The height rule keeps
// a phone turned sideways out (its width passes, its height does not); a
// tablet passes in both orientations, a small laptop always. Inside
// Telegram (any device: the Mini App window is a phone column even on the
// desktop client) the console shows a stub that sends the person to a
// browser instead of its screens.
// =============================================================================

import type { Platform } from '@/platform/types'

/** The narrowest browser window the console opens in, px (iPad mini
 *  portrait is 744). */
export const CONSOLE_MIN_WIDTH = 744

/** The lowest browser window the console opens in, px (a phone in
 *  landscape is about 430). */
export const CONSOLE_MIN_HEIGHT = 560

/** The media query of a window large enough for the console. */
export const CONSOLE_WIDE_QUERY = `(min-width: ${CONSOLE_MIN_WIDTH}px) and (min-height: ${CONSOLE_MIN_HEIGHT}px)`

/** Why the console does not open here: inside Telegram, or a small window. */
export type ConsoleBlock = 'telegram' | 'narrow'

/**
 * Whether the console opens in this environment, and if not, why.
 *
 * @param platformName - the running platform (telegram or standalone browser)
 * @param large - whether the window matches CONSOLE_WIDE_QUERY
 * @returns null when the console opens, else the reason it does not
 */
export function consoleBlock(platformName: Platform['name'], large: boolean): ConsoleBlock | null {
  if (platformName === 'telegram') return 'telegram'
  return large ? null : 'narrow'
}
