// =============================================================================
// VELO Frontend -- instance-checklist tests (tz-whitelabel §6.4, FE-114)
// =============================================================================
// evaluateChecklist() is the §6.4 acceptance table: every dist fact vs its
// source of record (skin/passport/golden). Pinned here: a matching build is
// green, every drift fails named, and the rows that cannot be automated
// (description seam, maskable safe-zone) stay INFO/MANUAL instead of
// pretending.
// =============================================================================

import { describe, expect, it } from 'vitest'

// Plain ESM module (types loosely declared in env.d.ts).
// @ts-expect-error -- *.mjs modules carry no type information
import { evaluateChecklist } from '../../scripts/instance-checklist.mjs'

const EXPECTED = {
  skin: { displayName: 'НОВА', shortName: 'Нова', themeColor: '#1B1530' },
  brand: 'НОВА',
  brandSource: 'skin package',
  shortBrand: 'Нова',
  themeColor: '#1B1530',
  themeSource: 'skin package',
  defaultLocale: 'ru',
  locales: ['ru'],
  botUrl: 'https://telegram.me/veloappbot',
  botUrlSource: 'golden default',
}

const GREEN_FACTS = {
  title: 'НОВА',
  htmlLang: 'ru',
  themeMeta: '#1B1530',
  manifest: {
    name: 'НОВА',
    short_name: 'Нова',
    description: 'Платформа для ведения практик благополучия',
    lang: 'ru',
    theme_color: '#1B1530',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192' },
      { src: '/icons/icon-512.png', sizes: '512x512' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512' },
    ],
  },
  distIcons: {
    '/icons/icon-192.png': { width: 192, height: 192 },
    '/icons/icon-512.png': { width: 512, height: 512 },
    '/icons/icon-maskable-512.png': { width: 512, height: 512 },
    '/icons/apple-touch-icon-180.png': { width: 180, height: 180 },
    '/icons/favicon.svg': 'svg',
  },
  botUrlFound: true,
  catalogs: ['en', 'ru', 'uk'],
}

type Checklist = {
  rows: Array<{ item: string; status: string; fact: string; expect: string; source: string }>
  fails: string[]
}
const check = (facts: unknown, expected: unknown): Checklist =>
  evaluateChecklist({ facts, expected }) as Checklist

describe('evaluateChecklist (tz-whitelabel §6.4)', () => {
  it('a build whose facts match the sources is green, with the honest rows', () => {
    const { rows, fails } = check(GREEN_FACTS, EXPECTED)
    expect(fails).toEqual([])
    const byItem: Record<string, { status: string; source: string }> = Object.fromEntries(
      rows.map((r) => [r.item, r]),
    )
    expect(byItem['manifest name']!.status).toBe('PASS')
    expect(byItem['manifest name']!.source).toBe('skin package')
    // No passport seam for description yet: reported, not gated.
    expect(byItem['manifest description']!.status).toBe('INFO')
    // The safe zone needs eyes and says so.
    expect(byItem['maskable safe-zone']!.status).toBe('MANUAL')
    expect(byItem['locales']!.status).toBe('INFO')
  })

  it('a half-skinned title fails, named', () => {
    const { fails } = check({ ...GREEN_FACTS, title: 'VELO' }, EXPECTED)
    expect(fails.some((f) => f.startsWith('index.html title'))).toBe(true)
  })

  it('the meta and the manifest disagreeing on theme-color fails the single source', () => {
    const { fails } = check(
      { ...GREEN_FACTS, manifest: { ...GREEN_FACTS.manifest, theme_color: '#334D6E' } },
      EXPECTED,
    )
    expect(fails.some((f) => f.startsWith('theme-color single source'))).toBe(true)
    expect(fails.some((f) => f.startsWith('theme_color (manifest)'))).toBe(true)
  })

  it('a manifest icon missing from dist fails the icons row', () => {
    const { rows } = check(
      {
        ...GREEN_FACTS,
        distIcons: { ...GREEN_FACTS.distIcons, '/icons/icon-192.png': undefined },
      },
      EXPECTED,
    )
    const icons = rows.find((r) => r.item === 'icons')!
    expect(icons.status).toBe('FAIL')
    expect(icons.fact).toContain('icon-192.png missing')
  })

  it('a wrong-size icon fails the icons row', () => {
    const { rows } = check(
      {
        ...GREEN_FACTS,
        distIcons: {
          ...GREEN_FACTS.distIcons,
          '/icons/apple-touch-icon-180.png': { width: 180, height: 179 },
        },
      },
      EXPECTED,
    )
    const icons = rows.find((r) => r.item === 'icons')!
    expect(icons.status).toBe('FAIL')
    expect(icons.fact).toContain('apple-touch-icon-180.png: 180x179')
  })

  it('the bot URL not inlined into the bundle fails', () => {
    const { fails } = check({ ...GREEN_FACTS, botUrlFound: false }, EXPECTED)
    expect(fails.some((f) => f.startsWith('bot URL'))).toBe(true)
  })
})
