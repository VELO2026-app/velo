// =============================================================================
// VELO Frontend -- Silent reload on a failed chunk load (BE-149)
// =============================================================================
//
// After a deploy the server no longer has the previous build's hashed chunks.
// A page still running that build 404s on its next lazy route. The service
// worker covers this for pages it controls (it keeps the old build in its
// precache until every window closes -- see vite.config.ts); this handler
// covers pages it does not: the first visit, and webviews without a service
// worker.
//
// Vite dispatches `vite:preloadError` on window when a dynamic import (or a
// dependency it preloads) fails, including the app module main.ts imports.
// The handler reloads ONCE per session: the reload fetches the current
// index.html, whose chunk names exist. The once-per-session mark is the loop
// guard: if the failure survives the reload (a broken build, an offline
// device), the second event is left alone and the error surfaces as it did
// before this handler existed.
// =============================================================================

import { host } from './host'

/** sessionStorage key: this session already spent its silent reload. */
export const CHUNK_RELOAD_KEY = 'velo:chunk-reload'

/**
 * Claim the session's single reload. True exactly once per session; false
 * when already claimed or when storage cannot hold the mark -- without the
 * mark a reload could not stop itself, so no mark means no reload.
 */
function claimReload(storage: () => Storage): boolean {
  try {
    const s = storage()
    // KNOWN CEILING -- a second stale-chunk failure in the same session is not
    // recovered.
    //   1. Mechanics: the mark is set on the first reload and never cleared
    //      for the life of the session (sessionStorage: a tab, or one run of
    //      the installed app). A page that survives one deploy and then a
    //      SECOND deploy without being closed, and fails a chunk load both
    //      times, gets no silent reload the second time; the failed
    //      navigation surfaces as before this handler.
    //   2. Status: acknowledged by design.
    //   3. Task: none -- accepted at the BE-149 gate (dispatcher's answer):
    //      the precache of a waiting service worker already serves old chunks
    //      to controlled pages, so this path runs only for uncontrolled ones.
    //   4. Unfreeze trigger: a user report of a broken screen after a deploy
    //      in an app that had already reloaded once in that session.
    //   5. Agreed fix: replace the per-session mark with a time window
    //      (reload when the previous silent reload is older than N seconds).
    //   6. Rejected: clearing the mark when the app mounts -- if the INITIAL
    //      route's chunk is the broken one, mount -> clear -> fail -> reload
    //      is a tight loop. Keying the mark by the failing URL -- Safari's
    //      import error does not name the URL.
    if (s.getItem(CHUNK_RELOAD_KEY) !== null) return false
    s.setItem(CHUNK_RELOAD_KEY, '1')
    return true
  } catch {
    return false
  }
}

/**
 * Listen for `vite:preloadError` on `target` and reload once per session.
 * The event is marked handled (preventDefault) only when the reload happens;
 * otherwise Vite rethrows it as it always did.
 */
export function installChunkReload(
  target: EventTarget,
  storage: () => Storage,
  reload: () => void,
): void {
  target.addEventListener('vite:preloadError', (event) => {
    if (!claimReload(storage)) return
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
