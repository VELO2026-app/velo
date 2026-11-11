// =============================================================================
// VELO Frontend -- service worker cache hygiene (FE-157 s2)
// =============================================================================
// Runtime caches the service worker no longer writes stay on the device until
// something deletes them: workbox's cleanupOutdatedCaches only prunes PRECACHE
// generations. Before FE-157 the worker kept a NetworkFirst cache named
// 'velo-runtime' (up to 200 entries: documents, images, old chunks -- and the
// 5.5 MB Zoom SDK chunk for anyone who had joined a practice). The shell-only
// precache (owner decision R1) replaced it with 'velo-assets'.
// =============================================================================

import { host } from './host'

/** Runtime caches of earlier builds; nothing reads or writes them any more. */
export const LEGACY_CACHES: readonly string[] = ['velo-runtime']

/**
 * Delete the legacy runtime caches. Fire-and-forget: a missing Cache API
 * (insecure context, old webview) or a failing delete changes nothing for
 * the app, so every error is swallowed.
 */
export async function dropLegacyCaches(
  storage: CacheStorage | undefined = host.caches,
): Promise<void> {
  if (!storage) return
  await Promise.all(LEGACY_CACHES.map((name) => storage.delete(name).catch(() => false)))
}
