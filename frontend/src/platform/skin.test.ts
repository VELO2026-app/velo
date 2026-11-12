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

import { materializedSkinTokens, readSkin, skinBackgroundFormat } from './skin'
import { png, writeSkinPackage, type FixturePatch } from './skin.test.fixture'

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

  describe('background photo token (assets/bg/ format, FE-157)', () => {
    /** A minimal RIFF/WEBP header -- what the package engine sniffs. */
    const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])
    const BG: Record<string, Buffer> = {
      'background.png': png(1080, 1920),
      'background.webp': WEBP,
    }
    /** A valid package with the given files under assets/bg/ (none = no bg/). */
    function withBg(...files: string[]): string {
      const extra: Record<string, Buffer> = {}
      for (const f of files) extra[`assets/bg/${f}`] = BG[f] as Buffer
      return withPackage({ extra })
    }
    const css = (dir: string): string => materializedSkinTokens(dir, readSkin(dir))

    it('no bg/ -> no override: the golden webp from global.css stays', () => {
      const dir = withBg()
      expect(skinBackgroundFormat(dir)).toBeNull()
      expect(css(dir)).not.toContain('--velo-app-bg-image')
    })

    it('a legacy png skin -> the token points at the png', () => {
      const dir = withBg('background.png')
      expect(skinBackgroundFormat(dir)).toBe('png')
      expect(css(dir)).toContain("--velo-app-bg-image: url('/bg/background.png');")
    })

    it('a webp skin -> the token points at the webp, and webp beats png', () => {
      const dir = withBg('background.webp')
      expect(skinBackgroundFormat(dir)).toBe('webp')
      expect(css(dir)).toContain("--velo-app-bg-image: url('/bg/background.webp');")
      expect(skinBackgroundFormat(withBg('background.png', 'background.webp'))).toBe('webp')
    })

    it("the override is its own :root block AFTER the package's tokens", () => {
      expect(css(withBg('background.webp'))).toMatch(
        /--velo-tg-header: #1b2a41;\s*\}\s*:root \{\s*--velo-app-bg-image: url\('\/bg\/background\.webp'\);\s*\}\s*$/,
      )
    })
  })
})
