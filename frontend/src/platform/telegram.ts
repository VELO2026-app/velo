// =============================================================================
// VELO Frontend -- Telegram Platform (Phase F1.1, fixed 10.1, updated TD-F01)
// =============================================================================
//
// FIX 10.1: WebApp accessed lazily via getter, not at module level.
// If CDN is blocked (VPN, proxy, downtime), standalone mode still works.
//
// TD-F01: added getStartParam() -- reads WebApp.initDataUnsafe.start_param
// for deep link handling (open_practice__{uuid}).
// =============================================================================

import type { Platform } from './types'

/** Lazy accessor -- avoids crash if SDK didn't load. */
function getWebApp(): TelegramWebApp {
  const wa = window.Telegram?.WebApp
  if (!wa) {
    throw new Error('Telegram WebApp SDK not available')
  }
  return wa
}

/** Active BackButton callback reference (for cleanup on hide). */
let _backButtonCallback: (() => void) | null = null

/**
 * Read a design token by NAME (PROMPT №437).
 *
 * The Telegram SDK takes a colour STRING, not a CSS variable, so the app chrome
 * cannot use var() like everything else does. Before this, that meant two bare
 * hex literals lived here and in no token at all -- the chrome around every
 * screen sat outside the design system, and a re-theme would silently miss it.
 *
 * Same by-name idiom as the fog tokens in MobileLayout.vue:151-154. The fallback
 * is mandatory, not defensive dressing: getPropertyValue returns '' if the
 * stylesheet has not applied yet, and handing '' to setHeaderColor would throw
 * away the colour. main.ts imports variables.css (:29) before init runs, so the
 * fallback should never fire -- it exists so that if it ever does, the chrome
 * looks exactly as it does today rather than breaking.
 */
function tokenColor(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

export const telegramPlatform: Platform = {
  name: 'telegram',

  async init(): Promise<void> {
    const webApp = getWebApp()
    webApp.ready()
    webApp.expand()
    // Fallbacks MUST mirror variables.css. telegram.test.ts parses that file and
    // fails if these two drift from it -- do not edit one without the other.
    webApp.setHeaderColor(tokenColor('--velo-tg-header', '#334d6e'))
    webApp.setBackgroundColor(tokenColor('--velo-tg-bg', '#ffffff'))
  },

  getInitData(): string | null {
    return getWebApp().initData || null
  },

  getStartParam(): string | null {
    // start_param is set when the bot link contains startapp=... query.
    // Example: https://t.me/bot?startapp=open_practice__<uuid>
    return getWebApp().initDataUnsafe?.start_param ?? null
  },

  getTheme(): 'light' | 'dark' {
    return getWebApp().colorScheme || 'light'
  },

  hapticFeedback(style: 'light' | 'medium' | 'heavy'): void {
    try {
      getWebApp().HapticFeedback.impactOccurred(style)
    } catch {
      // Silently ignore -- older clients or missing SDK.
    }
  },

  openLink(url: string): void {
    // Telegram opens external links in the system browser.
    getWebApp().openLink(url)
  },

  showBackButton(callback: () => void): void {
    const webApp = getWebApp()
    _backButtonCallback = callback
    webApp.BackButton.onClick(callback)
    webApp.BackButton.show()
  },

  hideBackButton(): void {
    if (_backButtonCallback) {
      getWebApp().BackButton.offClick(_backButtonCallback)
      _backButtonCallback = null
    }
    getWebApp().BackButton.hide()
  },

  close(): void {
    getWebApp().close()
  },
}
