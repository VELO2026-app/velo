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

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'
import { pwaManifest } from './src/pwa/manifest'

export default defineConfig({
  plugins: [
    vue(),
    VitePWA({
      // Generate SW automatically from build output.
      strategies: 'generateSW',
      // The single manifest (BE-149). The plugin writes manifest.webmanifest
      // and injects the only <link rel="manifest">; index.html carries none.
      manifest: pwaManifest,
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
        // Don't precache source maps.
        globIgnores: ['**/*.map'],
        // Runtime caching gives the service worker a valid strategy even when
        // the precache manifest is empty. Without this, workbox-build aborts
        // with "Couldn't find configuration for either precaching or runtime
        // caching" (reproduced on workbox 7.3.0 AND 7.4.0 -- not a version
        // issue). network-first: try network, fall back to cache offline.
        runtimeCaching: [
          {
            urlPattern: ({ request }) =>
              request.destination === 'document' ||
              request.destination === 'script' ||
              request.destination === 'style' ||
              request.destination === 'image' ||
              request.destination === 'font',
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
  },
})
