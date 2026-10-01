// =============================================================================
// VELO Frontend -- Platform Autodetect (Phase F1.1)
// =============================================================================
//
// Detects whether the app is running inside Telegram or in a browser.
//
// DETECTION LOGIC:
//   The Telegram SDK is always loaded (CDN script in index.html),
//   so window.Telegram.WebApp exists even in a plain browser.
//   The reliable signal is WebApp.initData -- it's a non-empty string
//   ONLY when Telegram actually launched the WebApp from a bot.
//
// USAGE:
//   import { platform } from '@/platform'
//   platform.init()
//   const data = platform.getInitData()  // string | null
// =============================================================================

import type { Platform } from './types'
import { telegramPlatform } from './telegram'
import { standalonePlatform } from './standalone'

/** True when Telegram injected real initData (launched from bot). */
const isRunningInTelegram = !!window.Telegram?.WebApp?.initData

/**
 * Singleton platform instance.
 * Telegram if launched from bot, standalone otherwise.
 */
export const platform: Platform = isRunningInTelegram ? telegramPlatform : standalonePlatform

export { historyHasBack } from './history'
