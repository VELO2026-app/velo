// =============================================================================
// VELO Frontend -- skin package reader tests (tz-whitelabel §3, F2)
// =============================================================================
// platform/skin.ts is the BUILD-side seam: readSkin() reads the deploy-
// supplied public/skin/brand.json, materializedSkinTokens() produces the
// cascade file app.ts imports after global.css. No package = golden.
// =============================================================================

import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GOLDEN_SKIN, materializedSkinTokens, readSkin, skinBackgroundFormat } from './skin'

const created: string[] = []
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fake public/ dir: the package lives at <dir>/skin/, as the deploy ships it. */
function withPackage(brand?: string, tokens?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'velo-skin-'))
  created.push(dir)
  if (brand !== undefined) {
    mkdirSync(join(dir, 'skin'), { recursive: true })
    writeFileSync(join(dir, 'skin', 'brand.json'), brand)
    if (tokens !== undefined) {
      writeFileSync(join(dir, 'skin', 'tokens.css'), tokens)
    }
  }
  return dir
}

const GOOD_BRAND = JSON.stringify({
  displayName: 'ШКОЛА ГАРМОНИИ',
  shortName: 'Гармония',
  themeColor: '#1B2A41',
  backgroundColor: '#F5F1EA',
  fontUrl: 'https://fonts.example.com/rubik.css',
})

describe('readSkin (tz-whitelabel §3)', () => {
  it('an absent package is null -- the golden build', () => {
    expect(readSkin(withPackage())).toBeNull()
  })

  it('a valid package parses into the skin record', () => {
    const skin = readSkin(withPackage(GOOD_BRAND, '--velo-tg-header: #1b2a41;'))
    expect(skin).toEqual({
      displayName: 'ШКОЛА ГАРМОНИИ',
      shortName: 'Гармония',
      themeColor: '#1B2A41',
      backgroundColor: '#F5F1EA',
      fontUrl: 'https://fonts.example.com/rubik.css',
    })
  })

  it('a malformed package THROWS the build -- never ships half-skinned', () => {
    const dir = withPackage('{ not json')
    expect(() => readSkin(dir)).toThrow(/validate-skin/)
  })

  it('bad colors and non-https fonts are rejected at the seam', () => {
    const bad = JSON.stringify({
      displayName: 'X',
      shortName: 'X',
      themeColor: '#12345',
      backgroundColor: '#ffffff',
      fontUrl: 'http://insecure.example/font.css',
    })
    expect(() => readSkin(withPackage(bad))).toThrow(/themeColor/)
  })
})

describe('materializedSkinTokens (the §3 cascade file)', () => {
  it('no package -> the golden stub', () => {
    const css = materializedSkinTokens(withPackage(), null)
    expect(css).toContain('GENERATED')
    expect(css).not.toContain('--velo-')
  })

  it('a package -> its tokens verbatim, under the banner', () => {
    const css = materializedSkinTokens(
      withPackage(GOOD_BRAND, '--velo-tg-header: #1b2a41;'),
      GOLDEN_SKIN,
    )
    expect(css).toContain('GENERATED')
    // flat package declarations get wrapped in :root (bare ones are invalid CSS)
    expect(css).toContain(':root {')
    expect(css).toContain('--velo-tg-header: #1b2a41;')
  })

  describe('background photo token (bg/ format)', () => {
    /** A package dir with the given files under skin/bg/ (none = no bg/). */
    function withBg(...files: string[]): string {
      const dir = withPackage(GOOD_BRAND, '--velo-tg-header: #1b2a41;')
      if (files.length > 0) {
        mkdirSync(join(dir, 'skin', 'bg'), { recursive: true })
        for (const f of files) writeFileSync(join(dir, 'skin', 'bg', f), 'x')
      }
      return dir
    }

    it('no bg/ -> no override: the golden webp from global.css stays', () => {
      const dir = withBg()
      expect(skinBackgroundFormat(dir)).toBeNull()
      expect(materializedSkinTokens(dir, GOLDEN_SKIN)).not.toContain('--velo-app-bg-image')
    })

    it('a legacy png skin -> the token points at the png', () => {
      const dir = withBg('background.png')
      expect(skinBackgroundFormat(dir)).toBe('png')
      expect(materializedSkinTokens(dir, GOLDEN_SKIN)).toContain(
        "--velo-app-bg-image: url('/bg/background.png');",
      )
    })

    it('a webp skin -> the token points at the webp, and webp beats png', () => {
      const dir = withBg('background.webp')
      expect(skinBackgroundFormat(dir)).toBe('webp')
      expect(materializedSkinTokens(dir, GOLDEN_SKIN)).toContain(
        "--velo-app-bg-image: url('/bg/background.webp');",
      )
      const both = withBg('background.png', 'background.webp')
      expect(skinBackgroundFormat(both)).toBe('webp')
    })

    it('the override is its own :root block -- a skin line without `;` cannot swallow it', () => {
      const dir = withPackage(GOOD_BRAND, '--velo-tg-header: #1b2a41')
      mkdirSync(join(dir, 'skin', 'bg'), { recursive: true })
      writeFileSync(join(dir, 'skin', 'bg', 'background.webp'), 'x')
      const css = materializedSkinTokens(dir, GOLDEN_SKIN)
      expect(css).toMatch(
        /--velo-tg-header: #1b2a41\s*\}\s*:root \{\s*--velo-app-bg-image: url\('\/bg\/background\.webp'\);\s*\}/,
      )
    })
  })
})
