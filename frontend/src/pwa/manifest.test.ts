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
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync as read } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SUPPORTED_LOCALES } from '@/platform/instance'
import { MANIFEST_LOCALES } from '@/pwa/manifest'
import { pwaManifest, pwaManifestWithPassport, manifestForLocale } from '@/pwa/manifest'
import { GOLDEN_SKIN } from '@/platform/skin'

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

  it('identity follows the instance passport (tz-whitelabel §2), not literals', () => {
    // vite.config.ts resolves the VITE_* map (loadEnv: .env files +
    // process.env) and hands it to the factory -- two .env files produce two
    // builds (§2.4) without touching this file. Absent keys keep the golden
    // values; an empty map IS the golden object.
    expect(pwaManifestWithPassport({ VITE_BRAND: 'ШКОЛА' })).toMatchObject({
      name: 'ШКОЛА',
      short_name: 'ШКОЛА',
      lang: 'ru',
    })
    // FE-155: lang/description are the INSTANCE part (container start), the
    // build never takes them from the env.
    expect(pwaManifestWithPassport({ VITE_DEFAULT_LOCALE: 'en' })).toBe(pwaManifest)
    expect(pwaManifestWithPassport({})).toBe(pwaManifest)
  })

  it('a skin package wins over the env passport and paints the colours (F2, §1)', () => {
    const skin = {
      displayName: 'ШКОЛА ГАРМОНИИ',
      shortName: 'Гармония',
      themeColor: '#1B2A41',
      backgroundColor: '#F5F1EA',
      fonts: [],
    }
    expect(pwaManifestWithPassport({ VITE_BRAND: 'ENV-БРЕНД' }, skin)).toMatchObject({
      name: 'ШКОЛА ГАРМОНИИ',
      short_name: 'Гармония',
      theme_color: '#1B2A41',
      background_color: '#F5F1EA',
    })
    // The golden skin record resolves to the golden manifest.
    expect(pwaManifestWithPassport({}, GOLDEN_SKIN)).toMatchObject({
      name: 'VELO',
      theme_color: '#334D6E',
    })
  })

  it('description speaks the manifest language (lang: ru -> Russian text)', () => {
    // Regression: the description used to be English under lang: 'ru'
    // (tz-whitelabel §2 fixes the mismatch).
    expect(pwaManifest.description).toBeTruthy()
    expect(pwaManifest.description).toMatch(/\p{Script=Cyrillic}/u)
    expect(pwaManifest.description).not.toMatch(/[a-zA-Z]{4,}/)
  })

  it('theme_color and the index.html meta share the SKIN placeholder (F2, §1)', () => {
    // The source carries %VELO_THEME_COLOR%; passport-html resolves it (to
    // the golden default with no skin -- pinned in passport-html.test.ts).
    // The mirror holds by construction: both consumers resolve the SAME
    // brand-record value at build time.
    const meta = attr(/<meta name="theme-color"[^>]*>/, 'content')

    expect(meta).toBe('%VELO_THEME_COLOR%')
    expect(pwaManifest.theme_color?.toLowerCase()).toBe('#334d6e') // golden default
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

  it('passport placeholders: lang and title come from %VELO_*% (tz-whitelabel F1, FE-153)', () => {
    // The source carries placeholders, not literals; the build substitutes
    // them (passportHtmlDefaults in vite.config.ts -- pinned in
    // platform/passport-html.test.ts). FE-153: never %VITE_*% -- Vite's own
    // html env pass warns on every env-less build for those.
    expect(attr(/<html[^>]*>/, 'lang')).toBe('%VELO_DEFAULT_LOCALE%')
    expect(indexHtml).toMatch(/<title>%VELO_BRAND%<\/title>/)
    expect(indexHtml).not.toMatch(/%VITE_[A-Z0-9_]+%/)
  })

  it('viewport tag is the one Telegram has always had: NO viewport-fit here', () => {
    // viewport-fit=cover is appended at runtime OUTSIDE Telegram only
    // (platform/launch.ts); inside Telegram this tag must stay byte-identical.
    expect(attr(/<meta name="viewport"[^>]*>/, 'content')).toBe(
      'width=device-width, initial-scale=1.0, maximum-scale=3.0, user-scalable=yes, interactive-widget=resizes-visual',
    )
  })
})

describe('instance part of the manifest (FE-155)', () => {
  it('manifestForLocale swaps lang and description, keeps the skin part', () => {
    const m = manifestForLocale(pwaManifest as Record<string, unknown>, 'en', 'A platform')
    expect(m).toMatchObject({
      lang: 'en',
      description: 'A platform',
      theme_color: '#334D6E',
      name: 'VELO',
    })
    expect(m.icons).toBe(pwaManifest.icons)
  })
})

describe('instance part: consistency and the start script (FE-155)', () => {
  const catalog = (loc: string): { common: { pwaDescription: string } } =>
    JSON.parse(readFileSync(`src/locales/${loc}/common.json`, 'utf8'))

  it('MANIFEST_LOCALES is exactly SUPPORTED_LOCALES, each with a description', () => {
    expect([...MANIFEST_LOCALES].sort()).toEqual([...SUPPORTED_LOCALES].sort())
    for (const loc of MANIFEST_LOCALES) expect(catalog(loc).common.pwaDescription).toBeTruthy()
  })

  it('the golden description is the ru catalog text (one source of truth)', () => {
    expect(pwaManifest.description).toBe(catalog('ru').common.pwaDescription)
  })

  it('40-manifest-locale.sh picks the matching file; unknown or empty keeps golden', () => {
    const run = (locale: string): string => {
      const dir = mkdtempSync(join(tmpdir(), 'manifest-'))
      writeFileSync(join(dir, 'manifest.webmanifest'), 'golden')
      for (const l of ['ru', 'en', 'uk']) writeFileSync(join(dir, `manifest.${l}.webmanifest`), l)
      execFileSync('sh', ['nginx/40-manifest-locale.sh'], {
        env: { PATH: process.env.PATH ?? '', MANIFEST_HTML_DIR: dir, DEFAULT_LANGUAGE: locale },
      })
      return read(join(dir, 'manifest.webmanifest'), 'utf8')
    }
    expect(run('en')).toBe('en')
    expect(run('uk')).toBe('uk')
    expect(run('')).toBe('golden')
    expect(run('de')).toBe('golden')
    expect(run('../x')).toBe('golden')
  })
})
