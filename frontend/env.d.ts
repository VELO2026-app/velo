/// <reference types="vite/client" />

// Vue Single File Components.
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}

// Vite environment variables (VITE_ prefix required).
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string
  readonly VITE_TELEGRAM_BOT_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

// =============================================================================
// Telegram WebApp SDK (Phase F1.1, updated TD-F01)
// =============================================================================
// Minimal type declarations for the SDK loaded via CDN in index.html.
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
  /** Tell Telegram the app is ready to be shown. */
  ready(): void
  /** Expand the WebApp to full viewport height. */
  expand(): void
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
