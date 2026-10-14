// =============================================================================
// VELO Frontend -- Host preparation before the app starts (BE-149)
// =============================================================================
//
// Runs from main.ts BEFORE the application module graph is imported. Two jobs,
// both decided by ONE question -- did Telegram launch this page?
//
//   Telegram   -> load telegram-web-app.js and WAIT for it, so that
//                 platform/index.ts (which picks the platform from
//                 window.Telegram.WebApp.initData at module evaluation) sees
//                 the SDK exactly as it did when the script was a blocking tag
//                 in index.html. The viewport tag is left untouched.
//   otherwise  -> no request to telegram.org at all; append viewport-fit=cover
//                 so the installed app draws edge to edge and
//                 env(safe-area-inset-*) carries the real insets.
//
// WHY THE APP IS IMPORTED AFTER THIS, NOT BESIDE IT: platform/index.ts decides
// at import time. A static import chain from main.ts would evaluate it before
// any line of main.ts runs, i.e. before the script could have loaded. Hence
// main.ts -> prepareHost() -> import('./app').
//
// WHY viewport-fit ONLY OUTSIDE TELEGRAM: the bottom clearance of the tab bars
// already reads env(safe-area-inset-bottom) everywhere, Telegram included.
// Without viewport-fit=cover iOS reports those insets as 0 inside Telegram;
// with it, the bars would move. Telegram keeps its viewport byte-for-byte.
//
// DETECTION. Telegram passes its launch parameters (tgWebAppData,
// tgWebAppVersion, tgWebAppPlatform, ...) in the URL -- the hash, and the
// query on some clients. The URL loses them as soon as the router navigates,
// so a reload inside Telegram (its "Reload" menu item, or platform/
// chunk-reload.ts) would look like a plain browser. The first detection is
// therefore remembered in sessionStorage, which a reload keeps and which is
// private to the Telegram webview's tab. @tma.js/bridge resolves its launch
// params the same way (URL query+hash, then session storage).
// =============================================================================

import { host } from './host'

export const TELEGRAM_SCRIPT_URL = 'https://telegram.org/js/telegram-web-app.js'

/** sessionStorage key remembering that Telegram launched this tab. */
export const TELEGRAM_LAUNCH_KEY = 'velo:telegram-launch'

/** Prefix shared by every Telegram Mini App launch parameter. */
const LAUNCH_PARAM_PREFIX = 'tgWebApp'

/** True when the URL's query or hash carries any Telegram launch parameter. */
export function hasLaunchParams(href: string): boolean {
  // Query and hash are read as ONE parameter list ("?a=1#b=2" -> "a=1&b=2"),
  // because clients differ in which of the two they use.
  const tail = href.replace(/^[^?#]*[?#]/, '').replace(/[?#]/g, '&')
  if (tail === href) return false
  for (const key of new URLSearchParams(tail).keys()) {
    if (key.startsWith(LAUNCH_PARAM_PREFIX)) return true
  }
  return false
}

/**
 * Did Telegram launch this tab? URL parameters first; when the URL has lost
 * them (navigation, then reload), the mark left by the first detection.
 * Storage that throws (blocked, private mode) reads as "no mark".
 */
export function isTelegramLaunch(href: string, storage: () => Storage): boolean {
  if (hasLaunchParams(href)) {
    try {
      storage().setItem(TELEGRAM_LAUNCH_KEY, '1')
    } catch {
      // Unwritable storage: this load is still detected from the URL; only a
      // later reload in this tab would not be.
    }
    return true
  }
  try {
    return storage().getItem(TELEGRAM_LAUNCH_KEY) === '1'
  } catch {
    return false
  }
}

let _scriptLoad: Promise<void> | null = null

/**
 * Load telegram-web-app.js once and resolve when it has loaded OR failed.
 * A failure resolves too: the app then starts as standalone, exactly what a
 * blocked CDN did to the old blocking <script> tag. No timeout -- a slow load
 * waits, as the blocking tag did.
 */
export function loadTelegramScript(doc: Document): Promise<void> {
  if (_scriptLoad) return _scriptLoad
  _scriptLoad = new Promise<void>((resolve) => {
    const script = doc.createElement('script')
    script.src = TELEGRAM_SCRIPT_URL
    script.onload = () => resolve()
    script.onerror = () => resolve()
    doc.head.appendChild(script)
  })
  return _scriptLoad
}

/** Append viewport-fit=cover to the viewport tag (idempotent). */
export function applyStandaloneViewport(doc: Document): void {
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="viewport"]')
  if (!meta || meta.content.includes('viewport-fit')) return
  meta.content = `${meta.content}, viewport-fit=cover`
}

/** Prepare the host for the platform main.ts is about to start. */
export async function prepareHost(): Promise<void> {
  if (isTelegramLaunch(host.location.href, () => host.sessionStorage)) {
    await loadTelegramScript(host.document)
  } else {
    applyStandaloneViewport(host.document)
  }
}

/** Test seam: forget the memoised script load. */
export function _resetLaunchForTests(): void {
  _scriptLoad = null
}
