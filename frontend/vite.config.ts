// =============================================================================
// VELO Frontend -- Vite Configuration (updated BE-149: PWA shell)
// =============================================================================
//
// Vite is the build tool (like Docker build for frontend).
// It bundles .vue + .ts files into static HTML/JS/CSS for production.
//
// Key settings:
//   - resolve.alias: @/ -> src/ (short imports)
//   - server.proxy: /api requests -> backend during local dev
//   - build.outDir: dist/ (what Nginx serves)
//   - VitePWA: generates the service worker (precache of the whole build) and
//     the ONE web app manifest (src/pwa/manifest.ts) plus its <link>
// =============================================================================

import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import VueI18nPlugin from '@intlify/unplugin-vue-i18n/vite'
import { fileURLToPath, URL } from 'node:url'
import { cpSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pwaManifestWithPassport } from './src/pwa/manifest'
import { shellOnlyTransform } from './src/pwa/precache-shell'
import { keepManifestOutOfPrecache, perLocaleManifest } from './src/pwa/manifest-locales'
// tz-whitelabel F1 (§2.2): resolves the %VELO_*% passport placeholders in
// index.html (lang, brand title) to the golden defaults when the env var is
// undefined -- CI builds without a .env. Lives in src/platform/passport-html
// so the unit suite can pin it (import.meta.url here is not file:// under
// vitest, so the test cannot import this config file).
import { passportHtmlDefaults } from './src/platform/passport-html'
// tz-whitelabel F2 (§3): the skin package (public/skin/, deploy-supplied).
// No package = the golden build; the derivatives (the skin-tokens cascade,
// index.html theme-color/font, manifest identity/colours) materialize HERE,
// at config time.
import { readSkin } from './src/platform/skin'
import { skinVirtualModules } from './src/platform/skin-virtual'
import { featureDefineMap, resolveFeatureFlags, type EditionTable } from './src/platform/features'
import type { Plugin } from 'vite'

/** Modules of the Zoom Meeting SDK chunk: the SDK and its peer stack (its
 * package.json peerDependencies, pinned in ours), plus what those pull in. */
const ZOOM_SDK_MODULE =
  /[\\/]node_modules[\\/](@zoom[\\/]meetingsdk|react|react-dom|react-redux|redux|redux-thunk|lodash|scheduler|use-sync-external-store|hoist-non-react-statics|react-is)[\\/]/

/** tz-whitelabel §3: apply the skin's ASSETS on the build -- the deploy puts
 * the package into public/skin/, and its files must WIN on the canonical
 * public paths (VeloLogo renders /icons/..., the mandala lives on /bg/...).
 * Runs at closeBundle: the golden files are already in dist/, this copies
 * the skin's over them. The package itself also ships inside dist/skin/
 * (publicDir copy) -- that copy is inert, the spilled paths are canonical.
 * Dev servers see the golden assets (a dev stand with a skin is not a
 * supported flow; build with the skin instead). */
function skinAssetSpill(skinDir: string | null, distDir: string): Plugin {
  return {
    name: 'velo-skin-asset-spill',
    apply: 'build',
    closeBundle() {
      if (!skinDir) return
      const spills: Array<[string, string]> = [
        // package root -> /icons/ (logos + PWA icons + favicon)
        [join(skinDir, 'mandala-white.png'), 'icons/mandala-white.png'],
        [join(skinDir, 'mandala-blue.png'), 'icons/mandala-blue.png'],
        [join(skinDir, 'velo-word-filled.svg'), 'icons/velo-word-filled.svg'],
        [join(skinDir, 'velo-word-blue.svg'), 'icons/velo-word-blue.svg'],
        [join(skinDir, 'logo-white.svg'), 'icons/logo-white.svg'],
        [join(skinDir, 'favicon.svg'), 'icons/favicon.svg'],
        [join(skinDir, 'icon-192.png'), 'icons/icon-192.png'],
        [join(skinDir, 'icon-512.png'), 'icons/icon-512.png'],
        [join(skinDir, 'icon-maskable-512.png'), 'icons/icon-maskable-512.png'],
        [join(skinDir, 'apple-touch-icon-180.png'), 'icons/apple-touch-icon-180.png'],
      ]
      for (const [from, to] of spills) {
        if (existsSync(from)) {
          cpSync(from, join(distDir, to), { force: true })
        }
      }
      for (const dir of ['bg', 'onboarding']) {
        const src = join(skinDir, dir)
        if (existsSync(src)) {
          cpSync(src, join(distDir, dir), { force: true, recursive: true })
        }
      }
    },
  }
}

/** Startup (motion report §8.3.7): main.ts awaits prepareHost() -- in
 * Telegram, the telegram-web-app.js download -- and only THEN imports the
 * app chunk, so the two downloads ran back to back before the first frame.
 * This lists the app chunk and its static imports as <link rel=modulepreload>
 * (and its CSS as a preload) in index.html: the browser fetches them in
 * parallel with the Telegram script, while EVALUATION still waits for
 * main.ts -- the platform pick at app import time is unchanged. Files the
 * entry already preloads are skipped; the Zoom SDK chunk is never static. */
function preloadAppChunk(): Plugin {
  let base = '/'
  return {
    name: 'velo-preload-app-chunk',
    apply: 'build',
    configResolved(config) {
      base = config.base
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const bundle = ctx.bundle
        if (!bundle) return
        // Not facadeModuleId: Rollup merges app.ts into a chunk without a
        // facade (it comes back null), so match on the module list instead.
        const app = Object.values(bundle).find(
          (out) =>
            out.type === 'chunk' &&
            out.isDynamicEntry &&
            out.moduleIds.some((id) => id.endsWith('/src/app.ts')),
        )
        if (!app || app.type !== 'chunk') return
        const scripts = new Set<string>()
        const styles = new Set<string>()
        const walk = (file: string): void => {
          const chunk = bundle[file]
          if (!chunk || chunk.type !== 'chunk' || scripts.has(file)) return
          scripts.add(file)
          for (const css of chunk.viteMetadata?.importedCss ?? []) styles.add(css)
          for (const dep of chunk.imports) walk(dep)
        }
        walk(app.fileName)
        const fresh = (file: string): boolean => !html.includes(`${base}${file}"`)
        return [
          ...[...scripts].filter(fresh).map((file) => ({
            tag: 'link',
            attrs: { rel: 'modulepreload', crossorigin: true, href: `${base}${file}` },
            injectTo: 'head' as const,
          })),
          ...[...styles].filter(fresh).map((file) => ({
            tag: 'link',
            attrs: { rel: 'preload', as: 'style', crossorigin: true, href: `${base}${file}` },
            injectTo: 'head' as const,
          })),
        ]
      },
    },
  }
}

// tz-whitelabel F1 (§2.3): the manifest identity follows the instance
// passport -- the resolved VITE_* map (.env files + process.env) is handed
// to pwaManifestWithPassport(), so two .env files produce two builds (§2.4).
// tz-whitelabel F2 (§3): the skin package (when the deploy ships one in
// public/skin/) rides on top and materializes its derivatives.
// FE-157 s2: the precache cut to the app shell (see workbox.globPatterns).
// It reads the built files from the RESOLVED outDir (set by the plugin
// below): a build into another outDir (bundle-report --modules) must not
// read an earlier frontend/dist build.
let builtDir = fileURLToPath(new URL('./dist/', import.meta.url))
const shellOnly = shellOnlyTransform((url) => {
  try {
    return readFileSync(join(builtDir, url), 'utf8')
  } catch {
    return ''
  }
})
/** Points the precache transform at this build's outDir. */
const precacheReadsOutDir: Plugin = {
  name: 'velo-precache-outdir',
  apply: 'build',
  configResolved(config) {
    builtDir = resolve(config.root, config.build.outDir)
  },
}

export default defineConfig(({ mode }) => {
  const frontendDir = fileURLToPath(new URL('.', import.meta.url))
  const instanceEnv = loadEnv(mode, frontendDir, 'VITE_')
  // tz-whitelabel §4 (F3, variant "a") + FE-130: the module flags resolve from
  // the MACHINE's channel first -- PRIMER_EDITION through editions.json at
  // the repo root (the ONE "edition -> modules" table, shared with the
  // backend, BE-182); an unknown edition fails the build (repo/passport
  // desync must be red). VITE_FEATURES stays the local-dev channel; neither
  // input -- the golden all-on set. The map carries BOTH consumption shapes:
  // per-module literals (route gates read them directly -- a literal `false`
  // folds the gate, Rollup tree-shakes the module's dynamic imports, and its
  // chunks are physically absent from dist/) and the resolved flags as JSON
  // for the runtime accessor, so featureEnabled() can never disagree with
  // the cut chunks.
  const editionEnv = loadEnv(mode, frontendDir, 'PRIMER_')
  const editions: EditionTable = JSON.parse(
    readFileSync(join(frontendDir, '..', 'editions.json'), 'utf8'),
  )
  const defines = featureDefineMap(
    resolveFeatureFlags(editionEnv.PRIMER_EDITION, instanceEnv.VITE_FEATURES, editions),
  )
  const publicDir = join(frontendDir, 'public')
  const skin = readSkin(publicDir)

  return {
    plugins: [
      // §3 cascade + the brand text (tz-whitelabel §1): virtual modules, served
      // from memory -- a build writes nothing into tracked files.
      skinVirtualModules(publicDir, skin),
      passportHtmlDefaults(skin),
      skinAssetSpill(skin ? join(publicDir, 'skin') : null, join(frontendDir, 'dist')),
      preloadAppChunk(),
      perLocaleManifest(frontendDir),
      precacheReadsOutDir,
      // tz-i18n §4.1: locale catalogs (src/locales/*.json) compile ahead of
      // runtime into message ASTs. Precompiling alone did NOT keep the
      // message compiler out of the bundle: vue-i18n still shipped it for
      // runtime strings (about 41 KB raw). dropMessageCompiler removes it
      // (FE-157), so a plain string message now renders as raw text -- every
      // message created at runtime is a message function instead
      // (locales/index.ts: the brand, applyInstanceOverrides).
      VueI18nPlugin({
        // Only the catalogs themselves: the plugin requires `export default`
        // message objects, and locales/*.ts (the singleton, test helper) are
        // regular modules.
        include: [fileURLToPath(new URL('./src/locales/**/*.json', import.meta.url))],
        dropMessageCompiler: true,
      }),
      vue(),
      VitePWA({
        // Generate SW automatically from build output.
        strategies: 'generateSW',
        // The single manifest (BE-149). The plugin writes manifest.webmanifest
        // and injects the only <link rel="manifest">; index.html carries none.
        manifest: pwaManifestWithPassport(instanceEnv, skin),
        // 'autoUpdate': the generated worker gets skipWaiting()/clientsClaim(),
        // so a deployed build takes over on the next launch -- and mid-session
        // once the new worker installs. Owner decision 2026-10-26 (per-instance
        // skin deploys): under the previous 'prompt' scheme users stayed on old
        // builds for days -- a waiting worker never activates while ANY window
        // of the installed PWA is alive, and mobile webviews keep their window
        // alive through close/reopen. This reopens the failure the old decision
        // guarded against: the swap purges the old precache under an open page,
        // and that page's next LAZY ROUTE can 404. The mitigation predates the
        // swap: platform/chunk-reload.ts catches the failed chunk import and
        // silently reloads the page onto the new build. The registration script
        // is still auto-injected (registerSW.js) -- no app-side registerSW().
        registerType: 'autoUpdate',
        // Include these file types in precache.
        workbox: {
          // FE-157 s2 (owner decision R1): the precache is the SHELL only --
          // the entry, its CSS and static imports, the font, the PWA icons,
          // the background photo and the splash logo. The app has no offline
          // mode (every screen needs the API), so precaching all routes bought
          // nothing and cost every install the whole build, and every deploy a
          // background re-download of each changed chunk. Everything else is
          // cached on first use by the /assets/ rule in runtimeCaching below.
          //
          // The globs are the candidates; shellOnly() below cuts assets/ down
          // to the startup closure. Not listed on purpose: onboarding art,
          // feat-*.png, the blue logo variant, logo-white.svg (welcome screen
          // only) -- lazy screens fetch them on demand. Zoom SDK, admin and
          // master chunks are not in the startup closure, so they stay out
          // too; the Zoom Meeting SDK (about 5 MB, practice screen only,
          // Standalone F4) is also named in globIgnores as a belt.
          //
          // index.html is NOT precached, and navigations are not answered
          // from the precache (navigateFallback: null): with the route chunks
          // gone from the precache, a reload served the OLD index.html by the
          // still-active worker would point at chunks the server no longer
          // has, and platform/chunk-reload.ts (FE-106) would spend its reload
          // on the old build. Navigations go network-first instead (the
          // runtime rule below); there is no offline mode to lose.
          globPatterns: [
            'registerSW.js',
            'fonts/*.woff2',
            // The background photo paints the first frame of every screen;
            // already-released skins ship it as PNG (platform/skin.ts).
            'bg/background.{webp,png}',
            // PWA icons, favicon, and the splash logo (LoadingView: spinning
            // mandala ring under the filled wordmark).
            'icons/{icon-192,icon-512,icon-maskable-512,apple-touch-icon-180,favicon,mandala-white,velo-word-filled}.*',
            'assets/*.{js,css}',
          ],
          // Don't precache source maps -- nor the Zoom Meeting SDK chunk.
          globIgnores: ['**/*.map', '**/zoom-sdk-*.js'],
          manifestTransforms: [shellOnly],
          navigateFallback: null,
          // Runtime caching also gives the service worker a valid strategy
          // when the precache manifest is empty (workbox-build otherwise
          // aborts, reproduced on workbox 7.3.0 and 7.4.0).
          //
          // SAME ORIGIN ONLY (Standalone F4): the Zoom Meeting SDK pulls its
          // scripts, styles and images from Zoom's CDN (source.zoom.us).
          // Cross-origin responses would be opaque -- booked against the
          // storage quota far above their size -- and a stale copy of Zoom's
          // own files would be served back to Zoom's SDK.
          runtimeCaching: [
            {
              // Navigations: always the CURRENT deploy's index.html when the
              // network answers; the cached copy only when it does not.
              urlPattern: ({ request, sameOrigin }) => sameOrigin && request.mode === 'navigate',
              handler: 'NetworkFirst',
              options: {
                cacheName: 'velo-pages',
                expiration: { maxEntries: 10 },
                cacheableResponse: { statuses: [200] },
              },
            },
            {
              // Hashed build output: a URL never changes its bytes, so
              // CacheFirst is safe. The limits keep chunks of old builds from
              // piling up: least-recently-used entries go first, and nothing
              // lives past 30 days.
              //
              // After a deploy the server no longer has the old chunk names.
              // A miss falls through to the network, which fails or answers
              // 404; either way the import rejects and platform/chunk-reload.ts
              // (FE-106) reloads -- the navigation goes network-first, so the
              // reload lands on the new build. Only 200 responses that
              // are not HTML are stored: an SPA fallback answers a missing
              // chunk with index.html, and caching that under a .js URL would
              // pin the failure.
              urlPattern: ({ url, sameOrigin }) =>
                sameOrigin && url.pathname.startsWith('/assets/'),
              handler: 'CacheFirst',
              options: {
                cacheName: 'velo-assets',
                expiration: { maxEntries: 150, maxAgeSeconds: 30 * 24 * 60 * 60 },
                cacheableResponse: { statuses: [200] },
                plugins: [
                  {
                    cacheWillUpdate: async ({ response }: { response: Response }) =>
                      (response.headers.get('content-type') ?? '').includes('text/html')
                        ? null
                        : response,
                  },
                ],
              },
            },
          ],
        },
      }),
      // After VitePWA: its options are resolved in its own configResolved.
      keepManifestOutOfPrecache(),
    ],

    // tz-whitelabel §4: the per-module literals from `defines` above.
    define: defines,

    resolve: {
      alias: [
        // FE-117 batch A: @velo/ui resolves to the kit's SOURCES so the app
        // bundles the SFCs exactly as it did before the move (chunk graph,
        // cascade and CSS extraction unchanged -- package README §CSS).
        // Exact-match regex, listed FIRST: the '@' prefix entry below would
        // otherwise swallow '@velo/ui' into src/, and any deep subpath
        // ('@velo/ui/...') stays unresolved on purpose -- the P8 boundary
        // allows the barrel only.
        {
          find: /^@velo\/ui$/,
          replacement: fileURLToPath(new URL('../packages/velo-ui/src/index.ts', import.meta.url)),
        },
        // Makes `@/stores/auth` resolve to `src/stores/auth`.
        { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      ],
    },

    server: {
      // Dev server port (only used if someone runs `npm run dev` locally).
      port: 5173,
      // Dev-only tunnel opt-in (LOCAL DEVELOPMENT, never set in prod): Telegram
      // WebApp needs HTTPS + a public host, so a dev stand is often reached
      // through a tunnel domain. Vite blocks unknown Host headers since v5 --
      // start the dev server with the hosts allowlisted, e.g.
      //   VITE_ALLOWED_HOSTS=dev.velo-test.xyz npm run dev
      // Without the variable this stays at Vite's default (localhost + IPs).
      allowedHosts: process.env.VITE_ALLOWED_HOSTS?.split(','),
      // Proxy API requests to backend during local development.
      // In production, Nginx handles this routing.
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:8000',
          changeOrigin: true,
        },
      },
    },

    build: {
      // Output directory for `npm run build`.
      // This is what gets copied into the Docker image.
      outDir: 'dist',
      // Generate source maps for easier debugging.
      sourcemap: false,
      // Target modern browsers (Telegram WebApp uses recent Chromium).
      target: 'es2022',
      rollupOptions: {
        output: {
          // Standalone F4: the Zoom Meeting SDK and the React/redux stack it
          // runs on go into ONE named chunk, 'zoom-sdk', loaded only by the
          // practice screen's dynamic import (platform/zoom-sdk.ts). The fixed
          // name is what lets the service worker keep it out of the precache
          // (workbox globIgnores above). Nothing else in this app uses React.
          manualChunks(id: string): string | undefined {
            return ZOOM_SDK_MODULE.test(id) ? 'zoom-sdk' : undefined
          },
        },
      },
    },
  }
})
