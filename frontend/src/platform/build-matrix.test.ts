// =============================================================================
// VELO Frontend -- build-matrix gate tests (tz-whitelabel §6.1/§4, FE-114,
// FE-152: the skin x edition matrix on PRIMER_EDITION)
// =============================================================================
// evaluateMatrix() is the acceptance gate pnpm build:matrix runs after its
// builds: dist facts vs every cell's source of record. Pinned here: the
// green matrix stays silent, and every FAIL branch fires with a named
// reason -- a gate that cannot fail is a report. planCells() pins the cell
// set against the real editions.json; the grep helpers are pinned against
// the shapes the minifier actually emits.
// =============================================================================

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FEATURE_NAMES } from './features'

// Plain ESM module (types loosely declared in env.d.ts) -- the surface the
// suite uses is typed here, by hand.
import * as matrixModule from '../../scripts/build-matrix.mjs'

type Modules = Record<string, boolean>
interface Cell {
  name: string
  skin: { label: string; source: string } | null
  edition: string
  modules: Modules
}
/** One --facts-out record of a per-cell CI run. */
interface FactsEntry {
  cell: string
  edition: string
  assets: number
}
interface Facts {
  title: string
  theme: string
  assets: number
  chunks: Record<string, string[]>
  brandMissing?: boolean
  tokensMissing?: string[]
  leaked?: string[]
}

const {
  assetCountFails,
  bundleHas,
  cssHasDecl,
  evaluateMatrix,
  fanInFails,
  MODULE_CHUNKS,
  normalizeDecl,
  planCells,
  tokenDecls,
} = matrixModule as unknown as {
  assetCountFails(entries: FactsEntry[]): string[]
  fanInFails(cellNames: string[], entries: FactsEntry[]): string[]
  bundleHas(bundle: string, text: string): boolean
  cssHasDecl(css: string, decl: string): boolean
  evaluateMatrix(input: {
    cells: Cell[]
    facts: Record<string, Facts>
    expected: Record<string, { title: string; theme: string }>
  }): string[]
  MODULE_CHUNKS: Record<string, RegExp[]>
  normalizeDecl(decl: string): string
  planCells(editions: unknown, skins: Array<{ label: string; source: string }>): Cell[]
  tokenDecls(css: string): string[]
}

const EDITIONS = JSON.parse(readFileSync(join(process.cwd(), '..', 'editions.json'), 'utf8'))
const SKINS = [
  { label: 'acme', source: '/pkg/acme' },
  { label: 'nova', source: '/pkg/nova' },
]
const CELLS: Cell[] = planCells(EDITIONS, SKINS)

const AI = ['AiSummary-1.js']
const PAY = ['TopupView-1.js']
const golden = (assets: number, ai: string[], payments: string[]): Facts => ({
  title: 'VELO',
  theme: '#334D6E',
  assets,
  chunks: { ai, payments },
  leaked: [],
})
const skinned = (title: string, theme: string): Facts => ({
  title,
  theme,
  assets: 120,
  chunks: { ai: AI, payments: PAY },
  brandMissing: false,
  tokensMissing: [],
})

const GREEN: Record<string, Facts> = {
  'golden/core': golden(100, [], []),
  'golden/school': golden(100, [], []),
  'golden/school-payments': golden(110, [], PAY),
  'golden/full': golden(120, AI, PAY),
  'acme/full': skinned('ПРАКТИКА 42', '#1B2A41'),
  'nova/full': skinned('НОВА', '#1B1530'),
}
const EXPECTED = Object.fromEntries(
  Object.entries(GREEN).map(([name, f]) => [name, { title: f.title, theme: f.theme }]),
)
const withFact = (name: string, patch: Partial<Facts>) =>
  evaluateMatrix({
    cells: CELLS,
    facts: { ...GREEN, [name]: { ...GREEN[name]!, ...patch } },
    expected: EXPECTED,
  })

describe('planCells (FE-152: golden x editions, skins x full)', () => {
  it('golden runs every edition of editions.json, each skin runs full', () => {
    expect(CELLS.map((c) => c.name)).toEqual([
      'golden/core',
      'golden/school',
      'golden/school-payments',
      'golden/full',
      'acme/full',
      'nova/full',
    ])
  })

  it('with no --skin the matrix is golden x editions (the default and CI run)', () => {
    expect(planCells(EDITIONS, []).map((c) => c.name)).toEqual([
      'golden/core',
      'golden/school',
      'golden/school-payments',
      'golden/full',
    ])
  })

  it('two skins with one label are a named error (their cells would collide)', () => {
    expect(() =>
      planCells(EDITIONS, [
        { label: 'goodo', source: '/a/goodo' },
        { label: 'goodo', source: '/b/goodo' },
      ]),
    ).toThrow(/share the label "goodo"/)
  })

  it('each cell carries the module set of its edition', () => {
    const byName = Object.fromEntries(CELLS.map((c) => [c.name, c.modules]))
    expect(byName['golden/core']).toEqual({ ai: false, payments: false })
    expect(byName['golden/school-payments']).toEqual({ ai: false, payments: true })
    expect(byName['nova/full']).toEqual({ ai: true, payments: true })
  })

  it('the chunk probes cover exactly the feature registry', () => {
    expect(Object.keys(MODULE_CHUNKS).sort()).toEqual([...FEATURE_NAMES].sort())
  })

  it('an edition missing from editions.json is a named error', () => {
    expect(() => planCells({ schema: 1, editions: { core: { modules: [] } } }, SKINS)).toThrow(
      /"full" is not in editions\.json/,
    )
  })
})

describe('evaluateMatrix (tz-whitelabel §6.1 gate)', () => {
  it('a matrix whose facts match every source of record stays silent', () => {
    expect(evaluateMatrix({ cells: CELLS, facts: GREEN, expected: EXPECTED })).toEqual([])
  })

  it('a title that drifted from its brand.json fails, named (a)', () => {
    const fails = withFact('nova/full', { title: ' velo ' })
    expect(fails).toHaveLength(1)
    expect(fails[0]).toContain('nova/full')
    expect(fails[0]).toContain('title')
  })

  it('a theme-color drift on a skin cell fails (a)', () => {
    const fails = withFact('acme/full', { theme: '#000000' })
    expect(fails).toHaveLength(1)
    expect(fails[0]).toContain('theme-color')
  })

  it("a skin cell whose bundle lacks the skin's displayName fails (b)", () => {
    const fails = withFact('nova/full', { brandMissing: true })
    expect(fails).toHaveLength(1)
    expect(fails[0]).toContain('displayName')
  })

  it('a skin cell missing token declarations in dist CSS fails, named (b)', () => {
    const fails = withFact('nova/full', { tokensMissing: ['--velo-primary:#8b7cf6'] })
    expect(fails).toHaveLength(1)
    expect(fails[0]).toContain('--velo-primary:#8b7cf6')
  })

  it('skin identity leaking into any golden cell fails (b)', () => {
    const fails = withFact('golden/school', { leaked: ['nova tokens (--velo-primary:#8b7cf6)'] })
    expect(fails).toHaveLength(1)
    expect(fails[0]).toContain('golden/school')
    expect(fails[0]).toContain('leaked')
  })

  it('core carrying an ai or payments chunk fails, named (c)', () => {
    const fails = withFact('golden/core', {
      chunks: { ai: AI, payments: ['AdminWithdrawalsView-9f.js'] },
    })
    expect(fails).toHaveLength(2)
    expect(fails.join('\n')).toContain('DISABLED ai module')
    expect(fails.join('\n')).toContain('AdminWithdrawalsView-9f.js')
  })

  it('an edition losing a module it turns on fails (c)', () => {
    const fails = withFact('golden/school-payments', { chunks: { ai: [], payments: [] } })
    expect(fails).toHaveLength(1)
    expect(fails[0]).toContain('payments chunks missing')
    expect(fails[0]).toContain('school-payments')
  })

  it('an asset-count drift across the full cells fails (d)', () => {
    const fails = withFact('nova/full', { assets: 121 })
    expect(fails).toHaveLength(1)
    expect(fails[0]).toContain('asset count')
  })

  it('the cut editions are free to have fewer assets than full', () => {
    const fails = withFact('golden/core', { assets: 1 })
    expect(fails).toEqual([])
  })

  it('a cell that never built fails instead of passing silently', () => {
    const { 'nova/full': _, ...rest } = GREEN
    const fails = evaluateMatrix({ cells: CELLS, facts: rest, expected: EXPECTED })
    expect(fails).toHaveLength(1)
    expect(fails[0]).toContain('never built')
  })
})

describe('brand/token grep helpers', () => {
  it('normalizeDecl matches the minified shape of a token declaration', () => {
    expect(normalizeDecl('--velo-bg-subtle: rgba(139, 124, 246, 0.08)')).toBe(
      normalizeDecl('--velo-bg-subtle: rgba(139, 124, 246, .08)'),
    )
    expect(normalizeDecl("--font-body: 'Unbounded', sans-serif")).toBe(
      normalizeDecl('--font-body:"Unbounded",sans-serif'),
    )
  })

  it('tokenDecls reads the flat package format and skips comments', () => {
    expect(tokenDecls('/* --velo-x: #000; */\n--velo-primary: #8B7CF6;\n')).toEqual([
      '--velo-primary:#8b7cf6',
    ])
  })

  it('cssHasDecl matches whole declarations only', () => {
    const css = ':root{--velo-radius:12px;--velo-primary:#8b7cf6}.x{--a-velo-gap:4px}'
    expect(cssHasDecl(css, '--velo-radius:12px')).toBe(true)
    expect(cssHasDecl(css, '--velo-primary:#8b7cf6')).toBe(true)
    expect(cssHasDecl(css, '--velo-radius:1')).toBe(false)
    expect(cssHasDecl(css, '--velo-gap:4px')).toBe(false)
  })

  it('bundleHas finds a brand verbatim or \\u-escaped', () => {
    expect(bundleHas('const b="НОВА"', 'НОВА')).toBe(true)
    expect(bundleHas('const b="\\u041D\\u041E\\u0412\\u0410"', 'НОВА')).toBe(true)
    expect(bundleHas('const b="VELO"', 'НОВА')).toBe(false)
  })
})

// FE-157 s1: CI fans the matrix out one runner per cell; invariant d spans
// cells, so it moved to the fan-in (--check-assets) and is pinned here.
describe('per-cell CI mode: the fan-in (--check-assets)', () => {
  const entry = (cell: string, edition: string, assets: number): FactsEntry => ({
    cell,
    edition,
    assets,
  })

  it('agreeing full cells pass; cut editions may differ', () => {
    expect(
      assetCountFails([
        entry('golden/full', 'full', 392),
        entry('goodo/full', 'full', 392),
        entry('golden/core', 'core', 371),
      ]),
    ).toEqual([])
  })

  it('a full cell with a different asset count fails (d)', () => {
    const fails = assetCountFails([
      entry('golden/full', 'full', 392),
      entry('goodo/full', 'full', 393),
    ])
    expect(fails).toHaveLength(1)
    expect(fails[0]).toContain('goodo/full:393')
  })

  it('a planned cell without a facts file fails -- never a silent green', () => {
    const fails = fanInFails(['golden/full', 'goodo/full'], [entry('golden/full', 'full', 392)])
    expect(fails).toEqual(['goodo/full: no facts file -- the cell never reported'])
  })

  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [join(__dirname, '../../scripts/build-matrix.mjs'), ...args], {
      encoding: 'utf8',
    })

  it('--list prints the planned cells as JSON and builds nothing', () => {
    const run = cli('--list')
    expect(run.status).toBe(0)
    const cells = JSON.parse(run.stdout) as string[]
    expect(cells).toContain('golden/full')
    expect(cells).toContain('golden/core')
  })

  it('--cell with an unknown name fails and names the known cells', () => {
    const run = cli('--cell', 'nope/none')
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('no cell "nope/none"')
    expect(run.stderr).toContain('golden/full')
  })
})
