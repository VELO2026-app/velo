// FE-219: the skin-mode engine -- package parsing (real loadSkinPackage on a
// tiny package), reference and color-mix resolution, the name pairing.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectLeaves, buildNameMap } from './figma-token-sync.mjs'
import { loadSkinPackage, readGoldenTokens } from './skin-package.mjs'
import { resolveForFigma, skinModeReport } from './skin-mode.mjs'

const leaf = (cssName, value) => ({ cssName, value })
const gold = [
  leaf('--velo-blue-500', '#0000ff'),
  leaf('--velo-primary', 'var(--velo-blue-500)'),
  leaf('--velo-hover', ' color-mix(in srgb, var(--velo-blue-500) 10%, transparent)'),
  leaf('--velo-radius', '12px'),
  leaf('--velo-ease', 'cubic-bezier(0.2, 0, 0, 1)'),
]

describe('resolveForFigma', () => {
  const byName = new Map(gold.map((l) => [l.cssName, { value: l.value }]))
  it('resolves a reference chain and a color-mix over the mode values', () => {
    expect(resolveForFigma('var(--velo-primary)', byName)).toEqual({
      ok: true,
      kind: 'color',
      text: '#0000FF',
    })
    expect(resolveForFigma(gold[2].value, byName)).toEqual({
      ok: true,
      kind: 'color',
      text: '#0000FF @ 0.1',
    })
  })
  it('refuses a verbatim string and a dangling reference with a reason', () => {
    expect(resolveForFigma(gold[4].value, byName)).toMatchObject({ ok: false })
    expect(resolveForFigma('var(--velo-missing)', byName)).toMatchObject({ ok: false })
  })
  it('a skin override of the base shifts every value that references it', () => {
    const skin = new Map(byName).set('--velo-blue-500', { value: '#120054' })
    expect(resolveForFigma('var(--velo-primary)', skin)).toMatchObject({ text: '#120054' })
  })
})

describe('skinModeReport', () => {
  it('reports gold -> skin per token, gold resolved on the gold values', () => {
    const r = skinModeReport(gold, [
      ['--velo-blue-500', '#120054'],
      ['--velo-primary', 'var(--velo-blue-500)'],
      ['--velo-hover', 'color-mix(in srgb, var(--velo-blue-500) 10%, transparent)'],
    ])
    const hover = r.rows.find((x) => x.cssName === '--velo-hover')
    expect(hover).toMatchObject({ gold: '#0000FF @ 0.1', skin: '#120054 @ 0.1', changed: true })
    const primary = r.rows.find((x) => x.cssName === '--velo-primary')
    expect(primary).toMatchObject({ gold: '#0000FF', skin: '#120054', changed: true })
    expect(r.inexpressible).toEqual([])
  })
  it('lists what Figma cannot hold, and accepts the rest', () => {
    const r = skinModeReport(gold, [
      ['--velo-ease', 'cubic-bezier(0.4, 0, 0.2, 1)'],
      ['--velo-radius', '8px'],
    ])
    expect(r.inexpressible.map((i) => i.cssName)).toEqual(['--velo-ease'])
    expect(r.rows.find((x) => x.cssName === '--velo-radius').skin).toBe('8px')
  })
  it('pairs names through the FE-124 rule and flags a token with no Figma variable', () => {
    const figma = [{ name: 'color/primary' }, { name: 'color/blue-500' }]
    const { map } = buildNameMap(gold, figma)
    const r = skinModeReport(
      gold,
      [
        ['--velo-primary', '#120054'],
        ['--velo-radius', '8px'],
      ],
      map,
    )
    expect(r.rows[0].figmaName).toBe('color/primary')
    expect(r.inexpressible).toEqual([
      { cssName: '--velo-radius', reason: expect.stringContaining('no Figma variable') },
    ])
  })
})

describe('package parsing through the build engine', () => {
  const dirs = []
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
  const frontend = new URL('../../', import.meta.url).pathname
  const goldenDoc = readGoldenTokens(frontend)

  it('a package with an unknown token is refused; a known override loads as a decl', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skin-mode-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'tokens'))
    writeFileSync(
      join(dir, 'tokens', 'skin.tokens.json'),
      JSON.stringify({ velo: { primary: { $value: '#120054' } } }),
    )
    const pkg = loadSkinPackage(dir, goldenDoc)
    // the fixture lacks manifest/assets, so problems exist, but the override still parses
    expect(pkg.decls).toContainEqual(['--velo-primary', '#120054'])
    writeFileSync(
      join(dir, 'tokens', 'skin.tokens.json'),
      JSON.stringify({ velo: { nonsense: { $value: '#120054' } } }),
    )
    const bad = loadSkinPackage(dir, goldenDoc)
    expect(bad.problems.join('\n')).toContain('velo.nonsense is not a token of the product')
    expect(bad.decls).toEqual([])
    expect(collectLeaves(goldenDoc).length).toBeGreaterThan(0)
  })
})
