// =============================================================================
// VELO Frontend -- Platform Interface (Phase F1.1, updated TD-F01)
// =============================================================================
//
// Contract that both Telegram and Standalone implementations follow.
// Components use `platform.*` without knowing which environment they're in.
//
// Telegram: real SDK calls (initData, haptic, back button, etc.)
// Standalone: safe no-ops (browser, PWA from Home Screen)
//
// TD-F01: added getStartParam() for deep link handling.
// =============================================================================

export interface Platform {
  /** Which environment we're running in. */
  readonly name: 'telegram' | 'standalone'

  /**
   * Initialize the platform.
   * Telegram: calls WebApp.ready(), expand(), sets header color.
   * Standalone: no-op.
   */
  init(): Promise<void>

  /**
   * Get Telegram initData for authentication.
   * Telegram: signed query string from WebApp.initData.
   * Standalone: null (no Telegram auth available).
   */
  getInitData(): string | null

  /**
   * Get the startapp parameter from the deep link.
   * Telegram: WebApp.initDataUnsafe.start_param (set when bot link has startapp=...).
   * Standalone: null.
   *
   * TD-F01: used to handle open_practice__{uuid} deep links.
   */
  getStartParam(): string | null

  /**
   * Get current color scheme.
   * Telegram: reads WebApp.colorScheme.
   * Standalone: always 'light' (dark theme is out of MVP scope).
   */
  getTheme(): 'light' | 'dark'

  /**
   * [TG-SURFACE 2026-09-07] Repaint Telegram's NATIVE under-webview surface.
   *
   * When the keyboard opens, Telegram resizes/moves the WKWebView itself, so
   * the strips under the keyboard's rounded top corners fall OUTSIDE the
   * WebView -- no in-page layer can paint there (device-confirmed); only this
   * native surface shows. `true` switches it to the keyboard variant token
   * (--velo-tg-bg-kbd), `false` restores the rest token (--velo-tg-bg).
   *
   * Telegram: WebApp.setBackgroundColor(token).
   * Standalone: no-op (a browser tab owns its whole surface).
   */
  setKeyboardSurface(dark: boolean): void

  /**
   * Trigger haptic feedback.
   * Telegram: WebApp.HapticFeedback.impactOccurred(style).
   * Standalone: no-op (browser has no haptics).
   */
  hapticFeedback(style: 'light' | 'medium' | 'heavy'): void

  /**
   * Open an external URL (e.g. a Zoom meeting link).
   * Telegram: WebApp.openLink(url) -- opens in the external browser.
   * Standalone: window.open(url) in a new tab.
   *
   * Callers must validate the URL (https only) before calling.
   */
  openLink(url: string): void

  /**
   * Show the native back button (top-left in Telegram).
   * Telegram: WebApp.BackButton.show() + onClick handler.
   * Standalone: no-op (browser has its own back).
   */
  showBackButton(callback: () => void): void

  /**
   * Hide the native back button.
   * Telegram: WebApp.BackButton.hide() + remove handler.
   * Standalone: no-op.
   */
  hideBackButton(): void

  /**
   * Close the WebApp.
   * Telegram: WebApp.close() -- returns user to chat.
   * Standalone: no-op (can't close a browser tab programmatically).
   */
  close(): void
}
