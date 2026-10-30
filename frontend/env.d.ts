/// <reference types="vite/client" />

// Vue Single File Components.
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}

// Node-side build scripts imported by the unit suite (validate-skin.mjs):
// typed loosely -- the script itself is plain ESM JavaScript.
declare module '*.mjs' {
  const value: Record<string, unknown>
  export = value
}

// Vite environment variables (VITE_ prefix required).
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string
  readonly VITE_TELEGRAM_BOT_URL?: string
  // Instance passport seams (tz-whitelabel §1). All optional: defaults =
  // the golden build (ru, VELO, full feature set).
  readonly VITE_DEFAULT_LOCALE?: string
  readonly VITE_LOCALES?: string
  readonly VITE_BRAND?: string
  readonly VITE_FEATURES?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

// Feature-gate literals materialized by vite.config.ts `define` from
// VITE_FEATURES (tz-whitelabel §4, F3 variant «а»): literal flags let Rollup's
// DCE drop a disabled module's routes together with its chunks. Present only
// in Vite-processed builds; the runtime accessor lives in platform/features.
declare const __VELO_FEATURE_AI__: boolean
declare const __VELO_FEATURE_PAYMENTS__: boolean

// =============================================================================
// Telegram WebApp SDK (Phase F1.1, updated TD-F01)
// =============================================================================
// Minimal type declarations for the SDK that platform/launch.ts loads from
// the CDN when Telegram launched the app (absent everywhere else).
// Only methods actually used by src/platform/telegram.ts are typed.
// Full SDK docs: https://core.telegram.org/bots/webapps
// =============================================================================

interface TelegramWebApp {
  /** Signed query string with user data. Empty string if not in Telegram. */
  initData: string
  /** Parsed user data from initData. */
  initDataUnsafe: {
    user?: {
      id: number
      first_name: string
      last_name?: string
      username?: string
      language_code?: string
    }
    /**
     * TD-F01: startapp parameter from the bot deep link.
     * Set when the bot URL contains ?startapp=... query.
     * Example: https://t.me/bot?startapp=open_practice__<uuid>
     */
    start_param?: string
  }
  /** Current color scheme: 'light' or 'dark'. */
  colorScheme: 'light' | 'dark'
  /** The Telegram client this Mini App runs in: 'ios', 'android',
   * 'tdesktop', 'macos', 'web', ... ('unknown' when Telegram cannot tell). */
  platform: string
  /** Tell Telegram the app is ready to be shown. */
  ready(): void
  /** Expand the WebApp to full viewport height. */
  expand(): void
  /** True when the client implements Bot API `version` or newer. */
  isVersionAtLeast?(version: string): boolean
  /** Bot API 7.7+: a vertical swipe no longer minimizes/closes the Mini App
   * (the Telegram header can still be dragged). Absent on older clients. */
  disableVerticalSwipes?(): void
  /** Close the WebApp and return to the chat. */
  close(): void
  /** Set the header bar color. */
  setHeaderColor(color: string): void
  /** Set the background color. */
  setBackgroundColor(color: string): void
  /** Open an external URL in the system browser. */
  openLink(url: string): void

  /** Haptic feedback API. */
  HapticFeedback: {
    impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void
    notificationOccurred(type: 'error' | 'success' | 'warning'): void
    selectionChanged(): void
  }

  /** Native back button (top-left corner in Telegram). */
  BackButton: {
    show(): void
    hide(): void
    onClick(callback: () => void): void
    offClick(callback: () => void): void
    isVisible: boolean
  }
}

interface Window {
  Telegram?: {
    WebApp: TelegramWebApp
  }
}
