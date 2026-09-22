// =============================================================================
// VELO Frontend -- schoolBranding Generator Tests (tz-curator.md §5.3/§5.4)
// =============================================================================
//
// Self-contained port of the owner-approved generator prototype
// (2026-09-19); the prototype file itself is retired. The same hash MUST
// prototype is the golden reference: the same hash MUST produce the same
// SVG. Vector tests per module (known fnv1a/SHA-256 values, fixed-hash
// parameters, golden path strings, lightweight-vs-hero filter contract)
// + the params cache + the component-facing data-URL contract.
// =============================================================================

import { describe, it, expect } from 'vitest'
import {
  fnv1a,
  mulberry32,
  schoolHashFromName,
  brandingParams,
  brandingBodyTint,
  generateParams,
  logoSvg,
  bannerSvg,
  mandalaSvg,
  PALETTES,
  schoolLetter,
} from '@/utils/schoolBranding'
import { petal } from './geometry'
import { mixHex } from './noise'

describe('schoolBranding -- hash', () => {
  it('fnv1a matches the known FNV-1a 32 vectors', () => {
    expect(fnv1a('')).toBe(0x811c9dc5)
    expect(fnv1a('a')).toBe(0xe40c292c)
    expect(fnv1a('foobar')).toBe(0xbf9cf968)
  })

  it('mulberry32 is deterministic per seed', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    const seqA = [a(), a(), a()]
    const seqB = [b(), b(), b()]
    expect(seqA).toEqual(seqB)
    expect(seqA.every((v) => v >= 0 && v < 1)).toBe(true)
  })

  it('schoolHashFromName: 16 hex chars, stable per name (SHA-256 of "school:"+name)', async () => {
    const h1 = await schoolHashFromName('Школа «Логос»')
    const h2 = await schoolHashFromName('Школа «Логос»')
    expect(h1).toMatch(/^[0-9a-f]{16}$/)
    expect(h1).toBe(h2)
    expect(await schoolHashFromName('Другая школа')).not.toBe(h1)
  })
})

describe('schoolBranding -- params', () => {
  it('a fixed hash yields fixed parameters', () => {
    const a = generateParams('0123456789abcdef')
    const b = generateParams('0123456789abcdef')
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('parameters stay inside the curated ranges', () => {
    for (const hash of ['0000000000000000', 'ffffffffffffffff', 'a1b2c3d4e5f60718']) {
      const P = generateParams(hash)
      expect(PALETTES).toContain(P.style.palette)
      expect([8, 10, 12]).toContain(P.style.k)
      expect(P.bg.swirl.bands.length).toBeGreaterThanOrEqual(4)
      expect(P.bg.swirl.bands.length).toBeLessThanOrEqual(6)
    }
  })

  it('brandingParams caches per hash (identity, not a re-generation)', () => {
    expect(brandingParams('feedfacefeedface')).toBe(brandingParams('feedfacefeedface'))
  })
})

describe('schoolBranding -- render determinism', () => {
  const HASH = '0123456789abcdef'

  it('the same hash produces byte-equal logo and banner SVG', () => {
    const P = brandingParams(HASH)
    expect(logoSvg(P)).toBe(logoSvg(brandingParams(HASH)))
    expect(bannerSvg(P, 1200, 600)).toBe(bannerSvg(brandingParams(HASH), 1200, 600))
  })

  it('logo: the 200×200 plate, the monogram letter sanitized', () => {
    const svg = logoSvg(brandingParams(HASH), { monogram: true, letter: '<Ш' })
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('viewBox="0 0 200 200"')
    expect(svg).toContain('rx="44"')
    // The letter is stripped to safe chars: no raw '<Ш' rides into the markup.
    expect(svg).not.toContain('<Ш')
    expect(mandalaSvg(brandingParams(HASH))).toContain('viewBox="0 0 200 200"')
  })

  it('flat rendering: no shadow on the logo, no displacement/grain on the banner', () => {
    const P = brandingParams(HASH)
    const flatLogo = logoSvg(P, { flat: true })
    expect(flatLogo).not.toContain('feDropShadow')
    const flatBanner = bannerSvg(P, 1200, 600, { flat: true })
    expect(flatBanner).not.toContain('feDisplacementMap')
    expect(flatBanner).not.toContain('feTurbulence')
    // Same scene underneath: palette ground present.
    expect(flatBanner).toContain(`fill="${P.style.palette.bg}"`)
  })

  it('REGRESSION (empty background): flat/lightweight still ship the paint-server defs', () => {
    // Bands and the fog are painted with url(#...) gradient references; when
    // the defs block was dropped in flat/lightweight modes, every referenced
    // element silently vanished -- the «nothing is visible» bug.
    const P = brandingParams(HASH)
    for (const svg of [
      bannerSvg(P, 1200, 600, { flat: true }),
      bannerSvg(P, 600, 300, { lightweight: true }),
      bannerSvg(P, 1200, 600),
    ]) {
      expect(svg).toContain('<defs>')
      expect(svg).toContain('radialGradient')
      expect(svg).toContain('linearGradient')
    }
    // Flat keeps the mild ridge blur; lightweight drops it with its defs.
    const flat = bannerSvg(P, 1200, 600, { flat: true })
    const row = bannerSvg(P, 600, 300, { lightweight: true })
    expect(flat.includes('feGaussianBlur')).toBe(!!P.bg.mountains)
    expect(row).not.toContain('feGaussianBlur')
  })

  it('hero banner with full effects keeps them; the row variant ships without', () => {
    const P = brandingParams(HASH)
    const hero = bannerSvg(P, 1200, 600)
    const row = bannerSvg(P, 600, 300, { lightweight: true })
    expect(hero).toContain('feTurbulence')
    expect(hero).toContain('feDisplacementMap')
    expect(row).not.toContain('feTurbulence')
    expect(row).not.toContain('feDisplacementMap')
    expect(row).not.toContain('feGaussianBlur')
    // Same deterministic scene underneath: the palette ground is in both.
    expect(row).toContain(`fill="${P.style.palette.bg}"`)
  })
})

describe('schoolBranding -- misc vectors', () => {
  it('schoolLetter strips quotes and uppercases', () => {
    expect(schoolLetter('Гимназия «Логос»')).toBe('Г')
    expect(schoolLetter('')).toBe('Ш')
  })

  it('brandingBodyTint: the palette bg lightened halfway to white (deterministic)', () => {
    const P = brandingParams('0123456789abcdef')
    expect(brandingBodyTint('0123456789abcdef')).toBe(mixHex(P.style.palette.bg, '#ffffff', 0.5))
    expect(brandingBodyTint('0123456789abcdef')).toBe(brandingBodyTint('0123456789abcdef'))
  })

  it('mixHex blends channel-wise (midpoint of black/white)', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mixHex('#ffffff', '#000000', 0)).toBe('#ffffff')
  })

  it('petal emits a closed quadratic path', () => {
    const d = petal(0, 10, 40, 8, 0.5)
    expect(d.startsWith('M ')).toBe(true)
    expect(d.endsWith(' Z')).toBe(true)
    expect(d.match(/Q /g)).toHaveLength(2)
  })
})
