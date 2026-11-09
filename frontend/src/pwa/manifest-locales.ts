// =============================================================================
// VELO Frontend -- per-locale manifest files (FE-155). Node-only (build time).
// =============================================================================
// After VitePWA writes dist/manifest.webmanifest, derive
// manifest.<locale>.webmanifest for every locale in MANIFEST_LOCALES. The
// description comes from the locale catalog (common.pwaDescription); the rest
// (skin part) is copied as built.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'
import { MANIFEST_LOCALES, manifestForLocale } from './manifest'

export function perLocaleManifest(frontendDir: string): Plugin {
  return {
    name: 'velo-per-locale-manifest',
    apply: 'build',
    enforce: 'post',
    closeBundle: {
      order: 'post',
      sequential: true,
      handler() {
        const dist = join(frontendDir, 'dist')
        const built = join(dist, 'manifest.webmanifest')
        if (!existsSync(built)) throw new Error(`per-locale manifests: ${built} is missing`)
        const base = JSON.parse(readFileSync(built, 'utf8')) as Record<string, unknown>
        for (const locale of MANIFEST_LOCALES) {
          const catalog = JSON.parse(
            readFileSync(join(frontendDir, 'src', 'locales', locale, 'common.json'), 'utf8'),
          ) as { common: { pwaDescription?: string } }
          const description = catalog.common.pwaDescription
          if (!description)
            throw new Error(`per-locale manifests: common.pwaDescription missing in ${locale}`)
          writeFileSync(
            join(dist, `manifest.${locale}.webmanifest`),
            JSON.stringify(manifestForLocale(base, locale, description)),
          )
        }
      },
    },
  }
}

/** FE-155: the manifest's lang/description are chosen at CONTAINER START,
 *  after the build stamped the precache revision -- a precached copy would go
 *  stale on a DEFAULT_LOCALE change under the same sw.js. vite-plugin-pwa adds
 *  the manifest to the precache on its own (workbox manifestTransforms never
 *  sees that entry), so drop it through the plugin's own api; nginx serves the
 *  manifest no-cache. */
export function keepManifestOutOfPrecache(): Plugin {
  return {
    name: 'velo-manifest-out-of-precache',
    apply: 'build',
    // buildStart, not configResolved: vite-plugin-pwa resolves its options
    // (and the manifest entry in them) in an ASYNC configResolved.
    buildStart() {
      const pwa = this.environment?.config.plugins.find((p) => p.name === 'vite-plugin-pwa') as
        | {
            api?: { extendManifestEntries(fn: (entries: Array<{ url?: string }>) => unknown): void }
          }
        | undefined
      if (!pwa?.api) throw new Error('vite-plugin-pwa api not found')
      pwa.api.extendManifestEntries((entries) =>
        entries.filter((e) => !String(e.url).endsWith('.webmanifest')),
      )
    },
  }
}
