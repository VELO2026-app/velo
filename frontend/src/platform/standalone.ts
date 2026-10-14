// =============================================================================
// VELO Frontend -- Standalone Platform (Phase F1.1, updated TD-F01)
// =============================================================================
//
// The app opened outside Telegram: a browser tab, or the app installed on
// the home screen.
//
// There is no initData here (getInitData() -> null): the person signs in on
// the login screen with "Log In With Telegram" (platform/browser-login.ts,
// stores/auth.ts). The session token is kept in localStorage, so the
// installed app stays signed in between launches (session-token.ts).
// Haptics, the native back button and close() have nothing to drive and
// are no-ops.
//
// TD-F01: added getStartParam() stub -- always null outside Telegram.
// =============================================================================

import type { Platform } from './types'
import { host } from './host'
import { sessionTokenStore } from './session-token'

/** Session token carrier: localStorage (session-token.ts). */
const _tokens = sessionTokenStore(() => host.localStorage)

export const standalonePlatform: Platform = {
  name: 'standalone',

  async init(): Promise<void> {
    // Nothing to initialize outside Telegram.
  },

  getInitData(): string | null {
    // No Telegram initData outside Telegram -- the login screen signs in.
    return null
  },

  // Kept between launches of the installed app (session-token.ts).
  readSessionToken: () => _tokens.read(),
  writeSessionToken: (token: string | null) => _tokens.write(token),

  getStartParam(): string | null {
    // No deep link support outside Telegram.
    return null
  },

  getTheme(): 'light' | 'dark' {
    // Dark theme is out of MVP scope.
    return 'light'
  },

  /**
   * [TG-SURFACE 2026-09-07] No-op: a browser tab owns its whole surface --
   * there is no native backdrop under a resized viewport (the soft keyboard
   * overlays the page, and the page paints everything visible).
   */
  setKeyboardSurface(_dark: boolean): void {
    // Intentional no-op.
  },

  hapticFeedback(): void {
    // Browser has no haptic API.
  },

  hapticNotification(): void {
    // Browser has no haptic API.
  },

  openLink(url: string): void {
    // Open in a new tab. noopener prevents the opened page from
    // accessing window.opener.
    window.open(url, '_blank', 'noopener')
  },

  showBackButton(): void {
    // Browser has its own back button.
  },

  hideBackButton(): void {
    // No-op.
  },

  close(): void {
    // Can't programmatically close a browser tab.
  },
}
