// =============================================================================
// VELO Frontend -- validate-skin tests (tz-whitelabel §3, F2; FE-131)
// =============================================================================
// The validator is the "an invalid package never ships" gate. Pinned here: a
// well-formed package of the machine's DTCG format must PASS -- so a golden
// change that breaks the contract is caught by the suite, not by a deploy --
// and deliberately broken packages must FAIL with named reasons.
// =============================================================================

import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Plain ESM module, typed by scripts/validate-skin.d.mts.
import { skinBuildGate, validateSkin } from '../../scripts/validate-skin.mjs'
import {
  FIXTURE_BRAND,
  FIXTURE_TOKENS,
  cleanupSkinFixtures,
  png,
  tempDir,
  writeSkinPackage,
} from './skin.test.fixture'

afterEach(cleanupSkinFixtures)

// vitest runs from frontend/ (import.meta.url is not file:// here, so the
// paths anchor to the working directory).
const FRONTEND = process.cwd()

type Report = { fails: string[]; passed: string[]; manual: string[]; warns: string[] }

const failsOf = (dir: string): string => (validateSkin(dir, FRONTEND) as Report).fails.join('\n')

describe('validate-skin (tz-whitelabel §3)', () => {
  it('a well-formed package passes the contract', () => {
    const report = validateSkin(writeSkinPackage(), FRONTEND) as Report
    expect(report.fails).toEqual([])
    expect(report.passed.length).toBeGreaterThan(8)
    // The font seam is load-bearing: the shipped family is the one --font-body names.
    expect(report.passed.some((line) => line.includes('self-hosted family "Rubik"'))).toBe(true)
    // The safe zone needs eyes -- it must never silently disappear.
    expect(report.manual.some((line) => line.includes('safe zone'))).toBe(true)
  })

  it('a DARK package without an assets/bg photo fails: light text on the golden photo', () => {
    // the velo_test_front_bot incident: tokens shipped, the background did
    // not -- light theme photo stayed under light text tokens
    const dark = {
      brand: {
        displayName: 'Night',
        shortName: 'Night',
        themeColor: '#1b1530',
        backgroundColor: '#14101f',
      },
      tokens: {
        velo: {
          tg: { header: { $value: '#1b1530' } },
          bg: { card: { solid: { $value: '#1e1832' } } },
          text: { primary: { $value: '#ece9f7' }, secondary: { $value: '#c8c2e0' } },
        },
      },
    }
    expect(failsOf(writeSkinPackage({ ...dark, bg: true }))).toBe('')
    expect(failsOf(writeSkinPackage(dark))).toContain('FAIL assets/bg/background: missing')
  })

  // FE-157: the photo may be WebP (preferred) or PNG (released skins).
  const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])
  const report = (extra: Record<string, Buffer> = {}): Report =>
    validateSkin(writeSkinPackage({ extra }), FRONTEND) as Report

  it('assets/bg/: absent warns, a webp passes clean, a small png passes clean', () => {
    expect(report().warns.join('\n')).toContain('assets/bg/background missing')
    const webp = report({ 'assets/bg/background.webp': WEBP })
    expect(webp.fails).toEqual([])
    expect(webp.passed).toContain('assets/bg/background.webp present')
    expect(webp.warns.join('\n')).not.toContain('bg/background')
    const small = report({ 'assets/bg/background.png': png(1080, 1920) })
    expect(small.fails).toEqual([])
    expect(small.passed).toContain('assets/bg/background.png present')
    expect(small.warns.join('\n')).not.toContain('bg/background')
  })

  it('a png photo over 300 KB passes but warns to ship webp', () => {
    const big = report({
      'assets/bg/background.png': Buffer.concat([png(1080, 1920), Buffer.alloc(400 * 1024)]),
    })
    expect(big.fails).toEqual([])
    expect(big.warns.join('\n')).toContain('assets/bg/background.png is')
    expect(big.warns.join('\n')).toContain('background.webp')
  })

  it('a bad brand record fails, named', () => {
    const joined = failsOf(
      writeSkinPackage({
        brand: {
          displayName: 'X',
          shortName: 'MuchTooLongName',
          themeColor: '#12345',
          backgroundColor: '#ffffff',
        },
      }),
    )
    expect(joined).toContain('exceeds 12 chars')
    expect(joined).toContain('themeColor: must be a 6-digit hex color')
  })

  it('an external fontUrl is refused: a package makes no external request', () => {
    const joined = failsOf(
      writeSkinPackage({
        brand: {
          displayName: 'X',
          shortName: 'X',
          themeColor: '#1b2a41',
          backgroundColor: '#ffffff',
          fontUrl: 'https://fonts.googleapis.com/css2?family=Rubik',
        },
      }),
    )
    expect(joined).toContain('fontUrl: a package makes no external request')
  })

  it('an unknown token path fails, named (a typo themes nothing)', () => {
    const dir = writeSkinPackage({
      tokens: { velo: { tg: { header: { $value: '#1b2a41' } }, primari: { $value: '#ff0000' } } },
      brand: {
        displayName: 'X',
        shortName: 'X',
        themeColor: '#1b2a41',
        backgroundColor: '#ffffff',
      },
    })
    expect(failsOf(dir)).toContain('velo.primari is not a token of the product')
  })

  it('a token removed in the skin contract Gen-2 fails as unknown (FE-150)', () => {
    // goodo-brand v0.1.1 sets velo.mood.low: after Gen-2 nothing reads it.
    const dir = writeSkinPackage({
      tokens: {
        ...FIXTURE_TOKENS,
        velo: { ...FIXTURE_TOKENS.velo, mood: { low: { $value: '#726bcf' } } },
      },
    })
    expect(failsOf(dir)).toContain('velo.mood.low is not a token of the product')
  })

  it('a deprecated token override warns, never fails (the name stays until the next generation)', () => {
    // A frontend whose registry marks velo.primary.dark DTCG $deprecated.
    const fe = tempDir()
    const doc = JSON.parse(readFileSync(join(FRONTEND, 'tokens.json'), 'utf8'))
    doc.root.velo.primary.dark.$deprecated = '2026-11-10: test, delete in Gen-3'
    writeFileSync(join(fe, 'tokens.json'), JSON.stringify(doc))
    const dir = writeSkinPackage({
      tokens: {
        ...FIXTURE_TOKENS,
        velo: {
          ...FIXTURE_TOKENS.velo,
          primary: { $value: '#2c4a6e', dark: { $value: '#1b2a41' } },
        },
      },
    })
    const report = validateSkin(dir, fe) as Report
    expect(report.fails).toEqual([])
    expect(report.warns.join('\n')).toContain('--velo-primary-dark is deprecated (2026-11-10: test')
    expect(report.warns.join('\n')).not.toContain('--velo-primary is deprecated')
  })

  it('a frozen bare token fails -- velo.* and bare.font-body only', () => {
    const dir = writeSkinPackage({
      tokens: {
        velo: { tg: { header: { $value: '#1b2a41' } } },
        bare: { 'space-1': { $value: '2px' } },
      },
      brand: {
        displayName: 'X',
        shortName: 'X',
        themeColor: '#1b2a41',
        backgroundColor: '#ffffff',
      },
    })
    expect(failsOf(dir)).toContain('bare.space-1 is a frozen bare token')
  })

  it('a shipped font that --font-body never names fails', () => {
    const dir = writeSkinPackage({ tokens: { velo: { tg: { header: { $value: '#1b2a41' } } } } })
    expect(failsOf(dir)).toContain('bare.font-body is not set')
  })

  it('the shipped family is matched by exact name, not as a substring', () => {
    const dir = writeSkinPackage({
      brand: {
        displayName: 'X',
        shortName: 'X',
        themeColor: '#1b2a41',
        backgroundColor: '#ffffff',
        fonts: [{ family: 'Rub', file: 'assets/fonts/rubik-400.woff2' }],
      },
    })
    expect(failsOf(dir)).toContain('must name the shipped family "Rub"')
  })

  it('a reference cannot dodge the contrast gate', () => {
    // white text on the white card, spelled as a reference
    const dir = writeSkinPackage({
      tokens: {
        velo: {
          tg: { header: { $value: '#1b2a41' } },
          text: { primary: { $value: '{velo.bg.card.solid}' } },
        },
        bare: { 'font-body': { $value: ['Rubik', 'sans-serif'] } },
      },
    })
    expect(failsOf(dir)).toMatch(
      /FAIL contrast: --velo-text-primary on --velo-bg-card-solid is 1\.00:1/,
    )
  })

  it.each([
    ['an rgb() nested in color-mix()', 'color-mix(in srgb, rgb(0, 0, 0) 1%, rgb(255, 255, 255))'],
    ['a var() fallback', 'var(--velo-bg-card-solid, rgb(0, 0, 0))'],
  ])('%s cannot fake the contrast', (_, value) => {
    const dir = writeSkinPackage({
      tokens: {
        velo: { tg: { header: { $value: '#1b2a41' } }, text: { primary: { $value: value } } },
        bare: { 'font-body': { $value: ['Rubik', 'sans-serif'] } },
      },
    })
    expect(failsOf(dir)).toMatch(/FAIL contrast: (cannot evaluate )?--velo-text-primary/)
    expect(failsOf(dir)).not.toContain('21.00:1')
  })

  it('an overridden pair the gate cannot evaluate fails, not warns', () => {
    const dir = writeSkinPackage({
      tokens: {
        velo: {
          tg: { header: { $value: '#1b2a41' } },
          text: { primary: { $value: 'color-mix(in srgb, #000 50%, #fff)' } },
        },
        bare: { 'font-body': { $value: ['Rubik', 'sans-serif'] } },
      },
    })
    expect(failsOf(dir)).toContain('FAIL contrast: cannot evaluate --velo-text-primary')
  })

  it('velo.tg.header must equal the brand themeColor (§1 single source)', () => {
    const dir = writeSkinPackage({
      tokens: { velo: { tg: { header: { $value: '#000000' } } } },
      brand: {
        displayName: 'X',
        shortName: 'X',
        themeColor: '#1b2a41',
        backgroundColor: '#ffffff',
      },
    })
    expect(failsOf(dir)).toContain('FAIL §1 single source: velo.tg.header (#000000)')
  })

  it('a dark surface with golden text fails the contrast gate', () => {
    const dir = writeSkinPackage({
      brand: {
        displayName: 'Dark',
        shortName: 'Dark',
        themeColor: '#111111',
        backgroundColor: '#ffffff',
      },
      tokens: {
        velo: {
          tg: { header: { $value: '#111111' } },
          bg: { card: { solid: { $value: '#222222' } } },
        },
      },
    })
    expect(failsOf(dir)).toMatch(/contrast: --velo-text-primary on --velo-bg-card-solid/)
  })

  it('a light primary fails: the white practice-card art would vanish (FE-230)', () => {
    const withPrimary = (primary: string): string =>
      writeSkinPackage({
        tokens: {
          ...FIXTURE_TOKENS,
          velo: { ...FIXTURE_TOKENS.velo, primary: { $value: primary } },
        },
      })
    expect(failsOf(withPrimary('#dddddd'))).toMatch(
      /FAIL contrast: #ffffff on --velo-primary is 1\.36:1 < 3:1/,
    )
    expect(failsOf(withPrimary('#2c4a6e'))).not.toContain('--velo-primary')
  })

  it('an apple-touch icon with alpha fails (iOS paints it black)', () => {
    const dir = writeSkinPackage()
    writeFileSync(join(dir, 'assets', 'apple-touch-icon-180.png'), png(180, 180, 6))
    expect(failsOf(dir)).toContain('assets/apple-touch-icon-180.png: has an alpha channel')
  })
})

// tz-whitelabel §3.5: another brand does not ship the golden VELO's files.
describe('copied golden assets (FE-234)', () => {
  const fixtureLogo = (dir: string) => readFileSync(join(dir, 'assets', 'favicon.svg'))
  const hashesOf = (bytes: Buffer) =>
    new Map([[createHash('sha256').update(bytes).digest('hex'), 'favicon.svg']])
  const warnsOf = (dir: string, hashes: Map<string, string>) =>
    (validateSkin(dir, FRONTEND, hashes) as Report).warns.join('\n')

  it('a file byte-identical to a golden VELO asset warns, named, in another brand', () => {
    const dir = writeSkinPackage()
    const warns = warnsOf(dir, hashesOf(fixtureLogo(dir)))
    expect(warns).toContain('assets/favicon.svg is byte-identical to the golden VELO asset')
    expect((validateSkin(dir, FRONTEND, hashesOf(fixtureLogo(dir))) as Report).fails).toEqual([])
  })

  it('the golden VELO brand itself and a changed file stay quiet', () => {
    const own = writeSkinPackage({ brand: { ...FIXTURE_BRAND, displayName: 'VELO' } })
    expect(warnsOf(own, hashesOf(fixtureLogo(own)))).not.toContain('byte-identical')
    const other = writeSkinPackage()
    expect(warnsOf(other, hashesOf(Buffer.from('another file')))).not.toContain('byte-identical')
  })
})

describe('declared contrast exceptions (contract 2.1, FE-230)', () => {
  const MANIFEST_21 = 'schema: 1\ncontract: "2.1"\n'
  const EXCEPTION = {
    text: 'velo.text.secondary',
    surface: 'velo.bg.card.solid',
    reason: 'Secondary text keeps the brand tint.',
  }
  /** A package with secondary text `secondary` on a white card. */
  const pkg = (secondary: string, exceptions?: object[], manifest = MANIFEST_21): string =>
    writeSkinPackage({
      manifest,
      brand: exceptions ? { ...FIXTURE_BRAND, contrastExceptions: exceptions } : FIXTURE_BRAND,
      tokens: {
        ...FIXTURE_TOKENS,
        velo: {
          ...FIXTURE_TOKENS.velo,
          text: { secondary: { $value: secondary } },
          bg: { card: { solid: { $value: '#ffffff' } } },
        },
      },
    })
  const report = (dir: string): Report => validateSkin(dir, FRONTEND) as Report

  it('a declared pair under 4.5:1 warns with its reason; undeclared, it fails', () => {
    const declared = report(pkg('rgba(76, 101, 137, 0.7)', [EXCEPTION]))
    expect(declared.fails).toEqual([])
    expect(declared.warns.join('\n')).toContain(
      '--velo-text-secondary on --velo-bg-card-solid is 3.12:1 < 4.5:1 -- declared exception: Secondary text keeps the brand tint.',
    )
    expect(failsOf(pkg('rgba(76, 101, 137, 0.7)'))).toContain(
      'FAIL contrast: --velo-text-secondary on --velo-bg-card-solid is 3.12:1 < 4.5:1',
    )
  })

  it('a declaration holds down to 3:1, not below', () => {
    expect(failsOf(pkg('rgba(76, 101, 137, 0.5)', [EXCEPTION]))).toContain(
      'a declared exception holds down to 3:1, not below',
    )
  })

  it('a declaration for a pair that clears the floor warns to drop it', () => {
    const passing = report(pkg('#333333', [EXCEPTION]))
    expect(passing.fails).toEqual([])
    expect(passing.warns.join('\n')).toContain('clears the floor or is not overridden')
  })

  it.each([
    ['not a list', 'x', 'must be a non-empty list'],
    ['an empty list', [], 'must be a non-empty list'],
    ['an entry that is not an object', ['x'], '[0]: must be an object'],
    [
      'an unknown key, quoted',
      [{ ...EXCEPTION, 'x\n::error::y': 1 }],
      'unknown field "x\\n::error::y"',
    ],
    [
      'a text that is not a token path',
      [{ ...EXCEPTION, text: 'x\n::error::y' }],
      '[0].text: a token path',
    ],
    [
      'a reason over 300 characters',
      [{ ...EXCEPTION, reason: 'a'.repeat(301) }],
      'longer than 300',
    ],
    ['markup in the reason', [{ ...EXCEPTION, reason: '<b>x</b>' }], 'no < > & "'],
    [
      'the same pair twice',
      [EXCEPTION, EXCEPTION],
      'velo.text.secondary on velo.bg.card.solid is declared twice',
    ],
  ])('a malformed declaration fails: %s', (_, exceptions, message) => {
    const fails = failsOf(pkg('rgba(76, 101, 137, 0.7)', exceptions as object[]))
    expect(fails).toContain(message)
    // A refused path never reaches a later message raw.
    expect(fails).not.toMatch(/^::error::/m)
  })

  it.each([
    [
      'body text on the card (only secondary text may be declared)',
      [{ ...EXCEPTION, text: 'velo.text.primary' }],
      undefined,
      'velo.text.primary on velo.bg.card.solid may not be declared',
    ],
    [
      'a pair the gate does not measure',
      [{ ...EXCEPTION, surface: 'velo.primary' }],
      undefined,
      'velo.text.secondary on velo.primary may not be declared',
    ],
    ['a blank reason', [{ ...EXCEPTION, reason: ' ' }], undefined, 'reason: why the pair stays'],
    [
      'a 2.0 manifest',
      [EXCEPTION],
      'schema: 1\ncontract: "2.0"\n',
      'contrastExceptions need contract "2.1" or later, got "2.0"',
    ],
    [
      'a path that is no product token',
      [{ ...EXCEPTION, text: 'velo.text.nope' }],
      undefined,
      'contrastExceptions: velo.text.nope is not a token of the product',
    ],
  ])('a declaration fails: %s', (_, exceptions, manifest, message) => {
    expect(failsOf(pkg('#333333', exceptions, manifest))).toContain(message)
  })
})

describe('skin build gate (FE-148: an invalid package fails the build)', () => {
  it('no skin directory = the golden build, nothing to check', () => {
    const dir = join(tempDir('velo-no-skin-'), 'skin')
    expect(skinBuildGate(dir, FRONTEND)).toBeNull()
  })

  it('a well-formed package passes the gate', () => {
    const report = skinBuildGate(writeSkinPackage(), FRONTEND) as Report
    expect(report.fails).toEqual([])
  })

  it('a present directory without primer-package.yaml fails -- never passes as golden', () => {
    const dir = writeSkinPackage()
    rmSync(join(dir, 'primer-package.yaml'))
    const report = skinBuildGate(dir, FRONTEND) as Report
    expect(report.fails.join('\n')).toContain('primer-package.yaml: missing')
  })

  it('a generation-1 package (brand.json + tokens.css) fails, named', () => {
    const dir = tempDir('velo-gen1-skin-')
    writeFileSync(join(dir, 'brand.json'), '{}')
    writeFileSync(join(dir, 'tokens.css'), '--velo-primary: #000;')
    const joined = (skinBuildGate(dir, FRONTEND) as Report).fails.join('\n')
    expect(joined).toContain('brand.json: not a file of the skin format')
    expect(joined).toContain('primer-package.yaml: missing')
  })
})
