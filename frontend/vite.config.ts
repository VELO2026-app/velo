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
import { pwaManifestWithPassport } from './src/pwa/manifest'
// tz-whitelabel F1 (§2.2): resolves the %VITE_*% passport placeholders in
// index.html (lang, brand title) to the golden defaults when the env var is
// undefined -- CI builds without a .env. Lives in src/platform/passport-html
// so the unit suite can pin it (import.meta.url here is not file:// under
// vitest, so the test cannot import this config file).
import { passportHtmlDefaults } from './src/platform/passport-html'

/** Modules of the Zoom Meeting SDK chunk: the SDK and its peer stack (its
 * package.json peerDependencies, pinned in ours), plus what those pull in. */
const ZOOM_SDK_MODULE =
  /[\\/]node_modules[\\/](@zoom[\\/]meetingsdk|react|react-dom|react-redux|redux|redux-thunk|lodash|scheduler|use-sync-external-store|hoist-non-react-statics|react-is)[\\/]/

// tz-whitelabel F1 (§2.3): the manifest identity follows the instance
// passport -- the resolved VITE_* map (.env files + process.env) is handed
// to pwaManifestWithPassport(), so two .env files produce two builds (§2.4).
export default defineConfig(({ mode }) => {
  const instanceEnv = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_')

  return {
    plugins: [
      passportHtmlDefaults(),
      // tz-i18n §4.1: locale catalogs (src/locales/*.json) compile ahead of
      // runtime -- the message compiler stays out of the bundle and the PWA
      // precache. Include is scoped to the catalogs; other .json imports
      // (package.json etc.) must not be treated as messages.
      VueI18nPlugin({
        // Only the catalogs themselves: the plugin requires `export default`
        // message objects, and locales/*.ts (the singleton, test helper) are
        // regular modules.
        include: [fileURLToPath(new URL('./src/locales/**/*.json', import.meta.url))],
      }),
      vue(),
      VitePWA({
        // Generate SW automatically from build output.
        strategies: 'generateSW',
        // The single manifest (BE-149). The plugin writes manifest.webmanifest
        // and injects the only <link rel="manifest">; index.html carries none.
        manifest: pwaManifestWithPassport(instanceEnv),
        // 'prompt' WITHOUT a prompt UI: a new service worker installs and then
        // WAITS until every window of the app is closed, so a new build takes
        // over at the next open, never mid-session (TZ decision 16). While it
        // waits, the old worker keeps serving the old build from its precache,
        // including every lazy chunk the open page may still ask for -- which is
        // what keeps an open app working across a deploy. Nothing in the app
        // posts SKIP_WAITING, so the generated worker never skips the wait.
        // Deliberately NO skipWaiting / clientsClaim: they swapped the worker
        // under an open page, the swap purged the old precache, and the page's
        // next lazy route 404'd. Pages without a worker (first visit, webviews
        // without service workers) are covered by platform/chunk-reload.ts.
        // The registration script is still auto-injected (registerSW.js).
        registerType: 'prompt',
        // Include these file types in precache.
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
          // Don't precache source maps -- nor the Zoom Meeting SDK chunk
          // (Standalone F4, manualChunks below): about 5 MB that only the
          // practice screen loads, on «Войти»/«Начать». Precached, every
          // install and every update would download it for everyone.
          globIgnores: ['**/*.map', '**/zoom-sdk-*.js'],
          // Runtime caching gives the service worker a valid strategy even when
          // the precache manifest is empty. Without this, workbox-build aborts
          // with "Couldn't find configuration for either precaching or runtime
          // caching" (reproduced on workbox 7.3.0 AND 7.4.0 -- not a version
          // issue). network-first: try network, fall back to cache offline.
          //
          // SAME ORIGIN ONLY (Standalone F4): the Zoom Meeting SDK pulls its
          // scripts, styles and images from Zoom's CDN (source.zoom.us). Without
          // this check they matched by destination and were cached here --
          // opaque cross-origin responses, which the browser books against the
          // storage quota far above their size, and a stale copy of Zoom's own
          // files served back to Zoom's SDK. Zoom's files are Zoom's to cache.
          runtimeCaching: [
            {
              urlPattern: ({ request, sameOrigin }) =>
                sameOrigin &&
                (request.destination === 'document' ||
                  request.destination === 'script' ||
                  request.destination === 'style' ||
                  request.destination === 'image' ||
                  request.destination === 'font'),
              handler: 'NetworkFirst',
              options: {
                cacheName: 'velo-runtime',
                expiration: { maxEntries: 200 },
              },
            },
          ],
        },
      }),
    ],

    resolve: {
      alias: {
        // Makes `@/stores/auth` resolve to `src/stores/auth`.
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
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
