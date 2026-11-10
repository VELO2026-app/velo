// =============================================================================
// VELO Frontend -- service worker precache cut to the app shell (FE-157 s2)
// =============================================================================
//
// Owner decision R1: only the shell is precached. This is the workbox
// manifest transform that enforces it for assets/ (vite.config.ts lists the
// other shell files by glob). Kept out of the config file so the unit suite
// can pin it.
// =============================================================================

/** One precache manifest entry, as workbox hands it to a transform. */
export interface PrecacheEntry {
  url: string
  size: number
  revision: string | null
}

/** Static import edges only: `from"./x.js"` and bare `import"./x.js"`. */
const STATIC_EDGE = /(?:from|import)\s*["']\.\/([^"']+\.js)["']/g

/**
 * Build the manifest transform.
 *
 * Keeps every non-assets/ entry, and from assets/ only the startup closure:
 * the files index.html references, the lazily imported `app` chunk, and all
 * they import STATICALLY (transitively). Dynamic `import()` edges are not
 * followed -- those are route chunks, cached on first use by the runtime rule.
 *
 * @param read - Reads a built file by its dist-relative URL; returns '' when it
 *  cannot be read (another outDir). Then that file's imports are not
 *  expanded: the precache shrinks, nothing throws.
 */
export function shellOnlyTransform(
  read: (url: string) => string,
): (entries: PrecacheEntry[]) => { manifest: PrecacheEntry[]; warnings: string[] } {
  return (entries) => {
    const known = new Set(entries.map((e) => e.url))
    const keep = new Set<string>()
    const queue: string[] = []
    const add = (url: string): void => {
      if (known.has(url) && !keep.has(url)) {
        keep.add(url)
        queue.push(url)
      }
    }
    for (const m of read('index.html').matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g))
      add(m[1] as string)
    for (const e of entries) if (/^assets\/app-[^/]+\.(js|css)$/.test(e.url)) add(e.url)
    while (queue.length > 0) {
      const url = queue.pop() as string
      if (!url.endsWith('.js')) continue
      for (const m of read(url).matchAll(STATIC_EDGE)) add(`assets/${m[1] as string}`)
    }
    return {
      manifest: entries.filter((e) => !e.url.startsWith('assets/') || keep.has(e.url)),
      warnings: [],
    }
  }
}
