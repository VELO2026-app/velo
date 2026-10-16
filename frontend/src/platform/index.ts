// =============================================================================
// VELO Frontend -- Platform Autodetect (Phase F1.1)
// =============================================================================
//
// Detects whether the app is running inside Telegram or in a browser.
//
// DETECTION LOGIC:
//   The Telegram SDK (telegram-web-app.js) is loaded by platform/launch.ts
//   ONLY when the URL or the session says Telegram launched the page, and the
//   app is imported after it has loaded (BE-149). Outside Telegram there is
//   no window.Telegram at all. Inside, the deciding signal is still
//   WebApp.initData -- a non-empty string ONLY when Telegram actually launched
//   the WebApp from a bot (a reply-keyboard launch has launch params but an
//   empty initData, and stays standalone, as it always did).
//   Evaluated ONCE, at module evaluation -- which is why main.ts must import
//   the app only after prepareHost() resolves.
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
