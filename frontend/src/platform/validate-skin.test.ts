// =============================================================================
// VELO Frontend -- validate-skin tests (tz-whitelabel §3, F2)
// =============================================================================
// The validator is the "an invalid package never ships" gate. Pinned here: a
// well-formed package must PASS -- so a golden change that breaks the
// contract is caught by the suite, not by a deploy -- and deliberately
// broken packages must FAIL with named reasons.
//
// The suite does not lean on skins/ (those are product content -- they
// change, and a half-filled one may legitimately warn). It writes its own
// minimal package into a temp dir: the validator reads PNG facts from IHDR
// only, so a signature + IHDR chunk is a complete enough PNG for it.
// =============================================================================

import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Plain ESM module (types loosely declared in env.d.ts).
// @ts-expect-error -- *.mjs modules carry no type information
import { validateSkin } from '../../scripts/validate-skin.mjs'

// vitest runs from frontend/ (import.meta.url is not file:// here, so the
// paths anchor to the working directory).
const FRONTEND = process.cwd()

type Report = { fails: string[]; passed: string[]; manual: string[]; warns: string[] }

/** A PNG the validator can read: signature + an IHDR chunk. colorType 2 =
 *  RGB (no alpha), 6 = RGBA. */
function png(width: number, height: number, colorType = 2): Buffer {
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'ascii')
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  ihdr[16] = 8 // bit depth
  ihdr[17] = colorType
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), ihdr])
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'

/** A complete, valid LIGHT package (dark text on the golden photo is fine,
 *  so no bg/ is needed). `patch` overrides brand.json / tokens.css. */
function writePackage(patch: { brand?: object; tokens?: string; bg?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'velo-skin-'))
  const brand = patch.brand ?? {
    displayName: 'Фикстура',
    shortName: 'Фикс',
    themeColor: '#1b2a41',
    backgroundColor: '#f5f1ea',
    fontUrl: 'https://fonts.googleapis.com/css2?family=Rubik:wght@400;600&display=swap',
  }
  const tokens =
    patch.tokens ??
    "--velo-tg-header: #1b2a41;\n--font-body: 'Rubik', 'Noto Sans', sans-serif;\n--velo-primary: #2c4a6e;\n"
  writeFileSync(join(dir, 'brand.json'), JSON.stringify(brand))
  writeFileSync(join(dir, 'tokens.css'), tokens)
  for (const svg of ['velo-word-filled.svg', 'velo-word-blue.svg', 'logo-white.svg', 'favicon.svg'])
    writeFileSync(join(dir, svg), SVG)
  writeFileSync(join(dir, 'mandala-white.png'), png(64, 64, 6))
  writeFileSync(join(dir, 'mandala-blue.png'), png(64, 64, 6))
  writeFileSync(join(dir, 'icon-192.png'), png(192, 192, 6))
  writeFileSync(join(dir, 'icon-512.png'), png(512, 512, 6))
  writeFileSync(join(dir, 'icon-maskable-512.png'), png(512, 512, 6))
  writeFileSync(join(dir, 'apple-touch-icon-180.png'), png(180, 180, 2))
  if (patch.bg) {
    mkdirSync(join(dir, 'bg'))
    writeFileSync(join(dir, 'bg', 'background.png'), png(1080, 1920))
  }
  return dir
}

describe('validate-skin (tz-whitelabel §3)', () => {
  it('a well-formed package passes the contract', () => {
    const report = validateSkin(writePackage(), FRONTEND) as Report
    expect(report.fails).toEqual([])
    expect(report.passed.length).toBeGreaterThan(10)
    // The font seam is load-bearing: fontUrl and --font-body name one family.
    expect(report.passed.some((line) => line.includes('Rubik'))).toBe(true)
    // The safe zone needs eyes -- it must never silently disappear.
    expect(report.manual.some((line) => line.includes('safe zone'))).toBe(true)
  })

  it('a DARK package without bg/background.png fails: light text on the golden photo', () => {
    // the velo_test_front_bot incident: tokens shipped, the background did
    // not -- light theme photo stayed under light text tokens
    const dark = {
      brand: {
        displayName: 'Ночь',
        shortName: 'Ночь',
        themeColor: '#1b1530',
        backgroundColor: '#14101f',
      },
      tokens:
        '--velo-tg-header: #1b1530;\n--velo-bg-card-solid: #1e1832;\n--velo-text-primary: #ece9f7;\n--velo-text-secondary: #c8c2e0;\n',
    }
    expect((validateSkin(writePackage({ ...dark, bg: true }), FRONTEND) as Report).fails).toEqual(
      [],
    )
    const report = validateSkin(writePackage(dark), FRONTEND) as Report
    expect(report.fails.join('\n')).toContain('FAIL bg/background.png: missing')
  })

  it('a package with an unknown token and a 13-char shortName fails, named', () => {
    const dir = writePackage({
      brand: {
        displayName: 'X',
        shortName: 'СлишкомДлинноеИмя',
        themeColor: '#12345',
        backgroundColor: '#ffffff',
      },
      tokens: '--velo-primari: #ff0000;\n',
    })
    const report = validateSkin(dir, FRONTEND) as Report
    const joined = report.fails.join('\n')
    expect(joined).toContain('exceeds 12 chars')
    expect(joined).toContain('themeColor must be 6-digit hex')
  })

  it('an unknown --velo-* token fails, named (a typo themes nothing)', () => {
    const dir = writePackage({
      tokens:
        "--velo-tg-header: #1b2a41;\n--font-body: 'Rubik', sans-serif;\n--velo-primari: #ff0000;\n",
    })
    const report = validateSkin(dir, FRONTEND) as Report
    expect(report.fails.join('\n')).toContain('--velo-primari does not exist in variables.css')
  })

  it('a dark surface with golden text fails the contrast gate', () => {
    const dir = writePackage({
      brand: {
        displayName: 'Тёмная',
        shortName: 'Тьма',
        themeColor: '#111111',
        backgroundColor: '#ffffff',
      },
      tokens: '--velo-tg-header: #111111;\n--velo-bg-card-solid: #222222;\n',
    })
    const report = validateSkin(dir, FRONTEND) as Report
    expect(report.fails.join('\n')).toMatch(/contrast: --velo-text-primary on --velo-bg-card-solid/)
  })

  it('an apple-touch icon with alpha fails (iOS paints it black)', () => {
    const dir = writePackage()
    writeFileSync(join(dir, 'apple-touch-icon-180.png'), png(180, 180, 6))
    const report = validateSkin(dir, FRONTEND) as Report
    expect(report.fails.join('\n')).toContain('apple-touch-icon-180.png: has an alpha channel')
  })
})
