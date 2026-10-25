// =============================================================================
// VELO Frontend -- web app manifest + index.html head tests (BE-149)
// =============================================================================
//
// The suite runs before the build (Dockerfile: test, then build), so it cannot
// look at dist/. What it CAN pin is everything the build is made from:
//   - src/pwa/manifest.ts, the only manifest source (VitePWA writes it out and
//     injects the only <link rel="manifest">);
//   - the source index.html (read with ?raw): no hand-written manifest link,
//     no Telegram script, the iOS icon, the viewport tag Telegram must keep;
//   - that every icon file referenced exists under public/ (import.meta.glob).
// The "exactly one manifest link in dist/index.html" check is a build-output
// fact and is run by command in the delivery report.
// Pixel sizes of the PNGs are not readable here (no image decoder in the
// suite); they are checked by command in the report as well.
// =============================================================================

import { describe, it, expect } from 'vitest'
import indexHtml from '../../index.html?raw'
import { pwaManifest, pwaManifestWithPassport } from '@/pwa/manifest'

/** Files under public/icons, keyed as their served path (/icons/x.png). */
const iconFiles = new Set(
  Object.keys(import.meta.glob('../../public/icons/*', { query: '?url', eager: true })).map((p) =>
    p.replace('../../public', ''),
  ),
)

/** Attribute value of the first tag matching `selector`-like regex, or null. */
function attr(tagPattern: RegExp, name: string): string | null {
  const tag = indexHtml.match(tagPattern)?.[0]
  if (!tag) return null
  return tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null
}

describe('pwaManifest -- the single manifest', () => {
  it('carries every identity field, none empty', () => {
    expect(pwaManifest).toMatchObject({
      id: '/',
      name: 'VELO',
      short_name: 'VELO',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      lang: 'ru',
    })
    expect(pwaManifest.background_color).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('identity follows the instance passport (tz-whitelabel F1, §2.3), not literals', () => {
    // vite.config.ts resolves the VITE_* map (loadEnv: .env files +
    // process.env) and hands it to the factory -- two .env files produce two
    // builds (§2.4) without touching this file. Absent keys keep the golden
    // values; an empty map IS the golden object.
    expect(pwaManifestWithPassport({ VITE_BRAND: 'ШКОЛА' })).toMatchObject({
      name: 'ШКОЛА',
      short_name: 'ШКОЛА',
      lang: 'ru',
    })
    expect(pwaManifestWithPassport({ VITE_DEFAULT_LOCALE: 'en' })).toMatchObject({
      name: 'VELO',
      lang: 'en',
    })
    expect(pwaManifestWithPassport({})).toBe(pwaManifest)
  })

  it('description speaks the manifest language (lang: ru -> Russian text)', () => {
    // Regression: the description used to be English under lang: 'ru'
    // (tz-whitelabel §2.3 fixes the mismatch).
    expect(pwaManifest.description).toBeTruthy()
    expect(pwaManifest.description).toMatch(/\p{Script=Cyrillic}/u)
    expect(pwaManifest.description).not.toMatch(/[a-zA-Z]{4,}/)
  })

  it('theme_color is the same colour as <meta name="theme-color"> in index.html', () => {
    const meta = attr(/<meta name="theme-color"[^>]*>/, 'content')

    expect(meta).not.toBeNull()
    expect(pwaManifest.theme_color?.toLowerCase()).toBe(meta!.toLowerCase())
  })

  it('icons: "any" and "maskable" are SEPARATE entries -- no combined purpose', () => {
    const icons = pwaManifest.icons ?? []

    expect(icons.length).toBeGreaterThan(0)
    for (const icon of icons) {
      expect(['any', 'maskable']).toContain(icon.purpose)
    }
  })

  it('icons: any 192, any 512 and maskable 512 are all present', () => {
    const has = (purpose: string, sizes: string): boolean =>
      (pwaManifest.icons ?? []).some((i) => i.purpose === purpose && i.sizes === sizes)

    expect(has('any', '192x192')).toBe(true)
    expect(has('any', '512x512')).toBe(true)
    expect(has('maskable', '512x512')).toBe(true)
  })

  it('every icon src is a file that exists under public/', () => {
    expect(iconFiles.size).toBeGreaterThan(0) // the glob itself sees the folder
    for (const icon of pwaManifest.icons ?? []) {
      expect(iconFiles).toContain(icon.src)
    }
  })
})

describe('index.html head -- what the build is made from', () => {
  it('no hand-written manifest link (the plugin injects the only one)', () => {
    // Paired with the manifest tests above: the link is absent HERE because
    // the manifest exists THERE.
    expect(indexHtml).not.toMatch(/rel="manifest"/)
    expect(pwaManifest.icons?.length).toBeGreaterThan(0)
  })

  it('no Telegram script tag: platform/launch.ts loads it, in Telegram only', () => {
    expect(indexHtml).not.toMatch(/<script[^>]*telegram-web-app/)
    expect(indexHtml).toMatch(/<script type="module" src="\/src\/main.ts">/)
  })

  it('iOS icon: an existing 180x180 file', () => {
    const href = attr(/<link rel="apple-touch-icon"[^>]*>/, 'href')

    expect(attr(/<link rel="apple-touch-icon"[^>]*>/, 'sizes')).toBe('180x180')
    expect(href).not.toBeNull()
    expect(iconFiles).toContain(href)
  })

  it('favicon is linked and exists', () => {
    const href = attr(/<link rel="icon"[^>]*>/, 'href')

    expect(href).not.toBeNull()
    expect(iconFiles).toContain(href)
  })

  it('passport placeholders: lang and title come from %VITE_*% (tz-whitelabel F1)', () => {
    // The source carries placeholders, not literals; the build substitutes
    // them (Vite natively, leftovers via passportHtmlDefaults in
    // vite.config.ts -- pinned in platform/passport-html.test.ts).
    expect(attr(/<html[^>]*>/, 'lang')).toBe('%VITE_DEFAULT_LOCALE%')
    expect(indexHtml).toMatch(/<title>%VITE_BRAND%<\/title>/)
  })

  it('viewport tag is the one Telegram has always had: NO viewport-fit here', () => {
    // viewport-fit=cover is appended at runtime OUTSIDE Telegram only
    // (platform/launch.ts); inside Telegram this tag must stay byte-identical.
    expect(attr(/<meta name="viewport"[^>]*>/, 'content')).toBe(
      'width=device-width, initial-scale=1.0, maximum-scale=3.0, user-scalable=yes, interactive-widget=resizes-visual',
    )
  })
})
