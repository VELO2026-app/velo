// =============================================================================
// VELO Frontend -- Silent reload on a failed chunk load (BE-149)
// =============================================================================
//
// After a deploy the server no longer has the previous build's hashed chunks.
// A page still running that build 404s on its next lazy route. Since FE-157
// the service worker precaches only the app shell (owner decision R1), so
// this covers pages it controls too: route chunks of the old build are not
// in any cache, and navigations go to the network first (vite.config.ts), so
// the reload always gets the CURRENT index.html.
//
// Vite dispatches `vite:preloadError` on window when a dynamic import (or a
// dependency it preloads) fails, including the app module main.ts imports.
// The handler reloads at most once per RELOAD_WINDOW_MS: the reload fetches
// the current index.html, whose chunk names exist. The window is the loop
// guard: if the failure survives the reload (a broken build, an offline
// device), the next event inside the window is left alone and the error
// surfaces as it did before this handler existed. A failure after the window
// (the next deploy in the same long-lived session) reloads again.
// =============================================================================

import { host } from './host'

/** sessionStorage key: when (epoch ms) this session last reloaded silently. */
export const CHUNK_RELOAD_KEY = 'velo:chunk-reload'

/** A failure within this long after a silent reload is not reloaded again. */
export const RELOAD_WINDOW_MS = 60_000

/**
 * Claim a silent reload.
 *
 * @returns True when no silent reload happened within RELOAD_WINDOW_MS;
 *  false inside the window or when storage cannot hold the mark -- without
 *  the mark a reload could not stop itself, so no mark means no reload.
 */
function claimReload(storage: () => Storage, now: number): boolean {
  try {
    const s = storage()
    // FE-157: the window replaced the once-per-session mark (the fix agreed
    // at the BE-149 gate). The mark used to be safe because a waiting service
    // worker served old chunks to controlled pages; the shell-only precache
    // ended that, so a second deploy in one long-lived session (Telegram
    // keeps its webview) must recover too. Rejected earlier and still out:
    // clearing the mark on mount (a broken INITIAL route chunk loops tight)
    // and keying it by URL (Safari's import error does not name the URL).
    // A legacy '1' mark reads as epoch 1 ms -- long expired, as intended.
    const last = Number(s.getItem(CHUNK_RELOAD_KEY) ?? Number.NaN)
    if (Number.isFinite(last) && now - last < RELOAD_WINDOW_MS) return false
    s.setItem(CHUNK_RELOAD_KEY, String(now))
    return true
  } catch {
    return false
  }
}

/**
 * Listen for `vite:preloadError` on `target` and reload, at most once per
 * RELOAD_WINDOW_MS. The event is marked handled (preventDefault) only when
 * the reload happens; otherwise Vite rethrows it as it always did.
 */
export function installChunkReload(
  target: EventTarget,
  storage: () => Storage,
  reload: () => void,
  now: () => number = Date.now,
): void {
  target.addEventListener('vite:preloadError', (event) => {
    if (!claimReload(storage, now())) return
    event.preventDefault()
    reload()
  })
}

/** Wire the handler to the real window (called from main.ts). */
export function installHostChunkReload(): void {
  installChunkReload(
    host,
    () => host.sessionStorage,
    () => host.location.reload(),
  )
}
