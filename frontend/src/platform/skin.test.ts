// =============================================================================
// VELO Frontend -- skin package reader tests (tz-whitelabel §3, F2; FE-131)
// =============================================================================
// platform/skin.ts is the BUILD-side seam: readSkin() reads the deploy-
// supplied public/skin/ (the machine's DTCG package), materializedSkinTokens()
// produces the cascade file app.ts imports after global.css. No package =
// golden.
// =============================================================================

import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { materializedSkinTokens, readSkin } from './skin'
import { writeSkinPackage, type FixturePatch } from './skin.test.fixture'

const created: string[] = []
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fake frontend/public dir whose skin/ holds the package; the reader
 *  anchors tokens.json at public/.. -- so it needs the real one beside it. */
function withPackage(patch?: FixturePatch): string {
  const frontend = mkdtempSync(join(tmpdir(), 'velo-frontend-'))
  created.push(frontend)
  writeFileSync(join(frontend, 'tokens.json'), readTokensJson())
  const publicDir = join(frontend, 'public')
  mkdirSync(publicDir)
  if (patch !== undefined) writeSkinPackage(patch, join(publicDir, 'skin'))
  return publicDir
}
const TOKENS_JSON = readFileSync(join(process.cwd(), 'tokens.json'), 'utf8')
const readTokensJson = (): string => TOKENS_JSON

describe('readSkin (tz-whitelabel §3)', () => {
  it('an absent package is null -- the golden build', () => {
    expect(readSkin(withPackage())).toBeNull()
  })

  it('a valid package parses into the skin record', () => {
    expect(readSkin(withPackage({}))).toEqual({
      displayName: 'Fixture School',
      shortName: 'Fixture',
      themeColor: '#1b2a41',
      backgroundColor: '#f5f1ea',
      fonts: [
        { family: 'Rubik', file: 'assets/fonts/rubik-400.woff2', weight: 400, style: 'normal' },
      ],
    })
  })

  it('a malformed package THROWS the build -- never ships half-skinned', () => {
    const dir = withPackage({})
    writeFileSync(join(dir, 'skin', 'tokens', 'skin.tokens.json'), '{ not json')
    expect(() => readSkin(dir)).toThrow(/validate-skin/)
  })

  it('bad colors are rejected at the seam', () => {
    const dir = withPackage({
      brand: { displayName: 'X', shortName: 'X', themeColor: '#12345', backgroundColor: '#ffffff' },
    })
    expect(() => readSkin(dir)).toThrow(/themeColor/)
  })
})

describe('materializedSkinTokens (the §3 cascade file)', () => {
  it('no package -> the golden stub', () => {
    const css = materializedSkinTokens(withPackage(), null)
    expect(css).toContain('GENERATED')
    expect(css).not.toContain('--velo-')
  })

  it('a package -> its DTCG tokens as CSS custom properties, fonts first', () => {
    const publicDir = withPackage({})
    const css = materializedSkinTokens(publicDir, readSkin(publicDir))
    expect(css).toContain('GENERATED')
    expect(css).toContain(':root {')
    expect(css).toContain('  --velo-tg-header: #1b2a41;')
    expect(css).toContain("  --font-body: Rubik, 'Noto Sans', sans-serif;")
    expect(css).toContain("src: url('/skin/assets/fonts/rubik-400.woff2') format('woff2');")
    expect(css.indexOf('@font-face')).toBeLessThan(css.indexOf(':root'))
  })
})
