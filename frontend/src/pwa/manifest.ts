// =============================================================================
// VELO Frontend -- Web App Manifest (BE-149, standalone phase 2; F1 §2.3)
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
// Identity (tz-whitelabel §2). The object below carries the values of the
// build without a skin package: the neutral core (FE-230), its name the
// core's neutral word (FE-231, platform/skin.ts CORE_SKIN). A branded build
// takes name, short_name and colours from the skin package's brand record
// (§1; FE-131: $extensions["velo-skin"] of the package) through
// pwaManifestFor() -- the brand name has no other source. This module is
// evaluated at CONFIG time in Node (imported by vite.config.ts), where
// import.meta.env does not exist -- which is also why it must NOT import
// platform/instance.ts (a browser module; and a dynamic env read here would
// inline the whole env into the client bundle). description is Russian,
// matching lang: 'ru' (it used to be English under a Russian lang).
//
// Colours: theme_color mirrors <meta name="theme-color"> in index.html;
// background_color is the body background (--velo-bg-start in variables.css),
// which is what the Android splash screen should match. tz-whitelabel §1:
// the SINGLE source of the header colour is the skin's brand record,
// materialized at build time; without a skin both consumers keep the golden
// default and this file deliberately does not invent its own.
//
// Icons: `any` and `maskable` are SEPARATE entries on purpose. A single
// "any maskable" entry makes the launcher crop the transparent-cornered circle
// mark as if it were full-bleed (maskable) or show the full-bleed square where
// a round mark is expected (any). The maskable file is the same mark on a
// solid square; the mark sits inside the 80% safe zone. The files on these
// paths are the core's neutral ones, or the skin package's (FE-230).
// The iOS home-screen icon is NOT read from here -- iOS takes
// <link rel="apple-touch-icon"> from index.html.
// =============================================================================

import type { ManifestOptions } from 'vite-plugin-pwa'

import { CORE_SKIN, type SkinPackage } from '../platform/skin'

export const pwaManifest: Partial<ManifestOptions> = {
  id: '/',
  name: CORE_SKIN.displayName,
  short_name: CORE_SKIN.shortName,
  description: 'Платформа для ведения практик благополучия',
  lang: 'ru',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'portrait',
  theme_color: CORE_SKIN.themeColor,
  background_color: CORE_SKIN.backgroundColor,
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

/** The build's manifest: identity and colours from the skin package's brand
 *  record (§1: the single source -- no env value names the brand, FE-231);
 *  no package returns the core object unchanged. `lang`/`description` are NOT
 *  here (FE-155): they are the instance part, chosen at container start from
 *  the per-locale files below. */
export function pwaManifestFor(skin: SkinPackage | null): Partial<ManifestOptions> {
  if (!skin) return pwaManifest
  return {
    ...pwaManifest,
    name: skin.displayName,
    short_name: skin.shortName,
    theme_color: skin.themeColor,
    background_color: skin.backgroundColor,
  }
}

// -- Instance part of the manifest (FE-155) -----------------------------------
//
// `lang` and `description` belong to the INSTANCE (defaultLocale of
// /config.json), not to the build: with the primer machine one image serves
// instances of different languages. The build therefore emits one manifest per
// shipped locale (manifest.<locale>.webmanifest, same skin part: colours,
// icons, name); the container entrypoint (nginx/40-manifest-locale.sh) copies
// the one matching DEFAULT_LANGUAGE over manifest.webmanifest at start. No
// DEFAULT_LANGUAGE (or an unknown one) leaves the golden manifest untouched.

export const MANIFEST_LOCALES = ['ru', 'en', 'uk'] as const

/** The manifest of `locale`: base with `lang` and the localized description. */
export function manifestForLocale(
  base: Record<string, unknown>,
  locale: string,
  description: string,
): Record<string, unknown> {
  return { ...base, lang: locale, description }
}
