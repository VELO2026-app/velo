// =============================================================================
// VELO Frontend -- validate-skin tests (tz-whitelabel §3, F2)
// =============================================================================
// The validator is the «невалидный пакет не выкатывается» gate. Pinned here:
// the repo's OWN test-reference skin (skins/test-contrast) must PASS -- so a
// golden change that breaks the contract is caught by the suite, not by a
// deploy -- and deliberately broken packages must FAIL with named reasons.
// =============================================================================

import { describe, expect, it } from 'vitest'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Plain ESM module (types loosely declared in env.d.ts).
// @ts-expect-error -- *.mjs modules carry no type information
import { validateSkin } from '../../scripts/validate-skin.mjs'

// vitest runs from frontend/ (import.meta.url is not file:// here, so the
// paths anchor to the working directory).
const FRONTEND = process.cwd()
const REFERENCE_SKIN = join(process.cwd(), 'skins', 'test-contrast')
const NIGHTFALL_SKIN = join(process.cwd(), 'skins', 'nightfall')

describe('validate-skin (tz-whitelabel §3)', () => {
  it('the repo test-reference skin passes the contract', () => {
    const report = validateSkin(REFERENCE_SKIN, FRONTEND) as {
      fails: string[]
      passed: string[]
      manual: string[]
    }
    expect(report.fails).toEqual([])
    expect(report.passed.length).toBeGreaterThan(10)
    // The safe zone needs eyes -- it must never silently disappear.
    expect(report.manual.some((line) => line.includes('safe zone'))).toBe(true)
  })

  it('the nightfall show-piece skin (dark theme) passes the contract', () => {
    const report = validateSkin(join(process.cwd(), 'skins', 'nightfall'), FRONTEND) as {
      fails: string[]
      passed: string[]
    }
    expect(report.fails).toEqual([])
    // The font seam is load-bearing: a dark demo with the golden Marmelad
    // would give the lie to «другое приложение».
    expect(report.passed.some((line) => line.includes('Unbounded'))).toBe(true)
  })

  it('a DARK package without bg/background.png fails: light text on the golden photo', () => {
    // the velo_test_front_bot incident: tokens shipped, the background did
    // not -- light theme photo stayed under light text tokens
    const dir = mkdtempSync(join(tmpdir(), 'velo-bad-skin-'))
    cpSync(NIGHTFALL_SKIN, dir, { recursive: true }) // the DARK show-piece
    rmSync(join(dir, 'bg'), { recursive: true, force: true })
    const report = validateSkin(dir, FRONTEND) as { fails: string[] }
    expect(report.fails.join('\n')).toContain('FAIL bg/background.png: missing')
  })

  it('a package with an unknown token and a 13-char shortName fails, named', () => {
    const dir = mkdtempSync(join(tmpdir(), 'velo-bad-skin-'))
    cpSync(REFERENCE_SKIN, dir, { recursive: true })
    writeFileSync(
      join(dir, 'brand.json'),
      JSON.stringify({
        displayName: 'X',
        shortName: 'СлишкомДлинноеИмя',
        themeColor: '#12345',
        backgroundColor: '#ffffff',
      }),
    )
    writeFileSync(join(dir, 'tokens.css'), '--velo-primari: #ff0000;\n')
    const report = validateSkin(dir, FRONTEND) as { fails: string[] }
    const joined = report.fails.join('\n')
    expect(joined).toContain('exceeds 12 chars')
    expect(joined).toContain('themeColor must be 6-digit hex')
    expect(joined).toContain('--velo-primari does not exist in variables.css')
  })

  it('a dark surface with golden text fails the contrast gate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'velo-bad-skin-'))
    cpSync(REFERENCE_SKIN, dir, { recursive: true })
    const brand = JSON.parse(
      // keep the reference brand, keep --velo-tg-header in sync (§1)
      JSON.stringify({
        displayName: 'Тёмная',
        shortName: 'Тьма',
        themeColor: '#111111',
        backgroundColor: '#ffffff',
      }),
    )
    writeFileSync(join(dir, 'brand.json'), JSON.stringify(brand))
    writeFileSync(
      join(dir, 'tokens.css'),
      '--velo-tg-header: #111111;\n--velo-bg-card-solid: #222222;\n',
    )
    const report = validateSkin(dir, FRONTEND) as { fails: string[] }
    expect(report.fails.join('\n')).toMatch(/contrast: --velo-text-primary on --velo-bg-card-solid/)
  })
})
