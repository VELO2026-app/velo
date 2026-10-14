// =============================================================================
// VELO Frontend -- Web App Manifest (BE-149, standalone phase 2)
// =============================================================================
//
// The ONE source of the web app manifest. vite.config.ts hands this object to
// VitePWA, which writes dist/manifest.webmanifest and injects the single
// <link rel="manifest"> into the built index.html. There is no hand-written
// manifest file and no hand-written manifest link: two manifests used to ship
// side by side (a public/manifest.json linked first, so it won, plus the
// plugin's own icon-less default) and nobody could tell which one an install
// used.
//
// It lives under src/ (not inside vite.config.ts) for one reason: the unit
// suite runs BEFORE the build in the Docker image, so the only manifest a test
// can see is this object -- src/pwa/manifest.test.ts pins its fields.
//
// Colours: theme_color mirrors <meta name="theme-color"> in index.html;
// background_color is the body background (--velo-bg-start in variables.css),
// which is what the Android splash screen should match.
//
// Icons: `any` and `maskable` are SEPARATE entries on purpose. A single
// "any maskable" entry makes the launcher crop the transparent-cornered circle
// mark as if it were full-bleed (maskable) or show the full-bleed square where
// a round mark is expected (any). The maskable file is the same mark on a
// solid #334D6E square; the mark already sits inside the 80% safe zone.
// The iOS home-screen icon is NOT read from here -- iOS takes
// <link rel="apple-touch-icon"> from index.html.
// =============================================================================

import type { ManifestOptions } from 'vite-plugin-pwa'

export const pwaManifest: Partial<ManifestOptions> = {
  id: '/',
  name: 'VELO',
  short_name: 'VELO',
  description: 'Platform for wellness practice facilitators',
  lang: 'ru',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'portrait',
  theme_color: '#334D6E',
  background_color: '#ffffff',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    {
      src: '/icons/icon-maskable-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    },
  ],
}
