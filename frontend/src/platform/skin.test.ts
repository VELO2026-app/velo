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

import { GOLDEN_SKIN, materializedSkinTokens, readSkin } from './skin'

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
    expect(css).toContain('--velo-tg-header: #1b2a41;')
  })
})
