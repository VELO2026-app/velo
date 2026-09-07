// =============================================================================
// VELO Frontend -- Standalone Platform (Phase F1.1, updated TD-F01)
// =============================================================================
//
// Stub implementation for when the app is opened outside Telegram:
// direct browser visit, PWA from Home Screen, etc.
//
// All methods are safe no-ops. getInitData() returns null, which
// signals to the auth flow that Telegram login is not available.
//
// Phase F10 will replace the stubs with real standalone auth
// (email / magic link).
//
// TD-F01: added getStartParam() stub -- always null outside Telegram.
// =============================================================================

import type { Platform } from './types'

export const standalonePlatform: Platform = {
  name: 'standalone',

  async init(): Promise<void> {
    // Nothing to initialize outside Telegram.
  },

  getInitData(): string | null {
    // No Telegram initData available -- auth flow will show
    // "Open via Telegram" stub screen.
    return null
  },

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
