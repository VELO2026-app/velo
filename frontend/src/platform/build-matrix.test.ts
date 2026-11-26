// =============================================================================
// VELO Frontend -- build-matrix gate tests (tz-whitelabel §6/§4, FE-114,
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
/** A node of a parsed mood icon (the engine's tree). */
interface MoodNode {
  tag: string
  attrs?: Record<string, string>
  children?: MoodNode[]
}
interface Facts {
  title: string
  theme: string
  assets: number
  chunks: Record<string, string[]>
  brandMissing?: boolean
  supportEmailMissing?: boolean
  moodIconsMissing?: boolean
  tokensMissing?: string[]
  leaked?: string[]
  layout?: string[]
}

const {
  assetCountFails,
  bundleHas,
  bundleHasAllMoodIcons,
  bundleHasAnyMoodIcon,
  moodProbes,
  cssHasDecl,
  evaluateMatrix,
  fanInFails,
  fontPreloadProblems,
  missingTokens,
  MODULE_CHUNKS,
  normalizeDecl,
  planCells,
  skinLeaks,
  tokenDecls,
} = matrixModule as unknown as {
  assetCountFails(entries: FactsEntry[]): string[]
  fanInFails(cellNames: string[], entries: FactsEntry[]): string[]
  fontPreloadProblems(
    fonts: Array<{ file: string; weight: number | string; style: string }>,
    headingWeight: number | null,
    html: string,
  ): string[]
  bundleHas(bundle: string, text: string): boolean
  bundleHasAllMoodIcons(bundle: string, set: Record<string, MoodNode>): boolean
  bundleHasAnyMoodIcon(bundle: string, set: Record<string, MoodNode>): boolean
  moodProbes(set: Record<string, MoodNode>): Record<string, string[]>
  missingTokens(decls: string[], css: string, goldenDecls: Set<string>): string[]
  skinLeaks(input: {
    label: string
    brand: { displayName: string; supportEmail?: string | null }
    decls: string[]
    js: string
    html: string
    css: string
    goldenDecls: Set<string>
    coreName: string
    moodIcons?: Record<string, MoodNode> | null
  }): string[]
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

// The planner is tested against a fixed multi-edition fixture, not the repo's
// editions.json: the file now holds one edition (`ai`, BE-182) and the matrix
// logic -- cut editions, skins x full, invariant d -- must stay pinned.
const EDITIONS = {
  schema: 1,
  editions: {
    core: { modules: [] },
    school: { modules: [] },
    'school-payments': { modules: ['payments'] },
    full: { modules: ['ai', 'payments'] },
  },
}
const REPO_EDITIONS = JSON.parse(readFileSync(join(process.cwd(), '..', 'editions.json'), 'utf8'))
const SKINS = [
  { label: 'acme', source: '/pkg/acme' },
  { label: 'nova', source: '/pkg/nova' },
]
const CELLS: Cell[] = planCells(EDITIONS, SKINS)

const AI = ['AiSummary-1.js']
// FE-151: payments is an instance option, always built -- not a probed module.
const golden = (assets: number, ai: string[]): Facts => ({
  title: 'VELO',
  theme: '#334D6E',
  assets,
  chunks: { ai },
  leaked: [],
})
const skinned = (title: string, theme: string): Facts => ({
  title,
  theme,
  assets: 120,
  chunks: { ai: AI },
  brandMissing: false,
  tokensMissing: [],
})

const GREEN: Record<string, Facts> = {
  'golden/core': golden(100, []),
  'golden/school': golden(100, []),
  'golden/school-payments': golden(100, []),
  'golden/full': golden(120, AI),
  'acme/full': skinned('ПРАКТИКА 42', '#1B2A41'),
  'nova/full': skinned('НОВА', '#1B1530'),
}
const EXPECTED = Object.fromEntries(
  Object.entries(GREEN).map(([name, f]) => [name, { title: f.title, theme: f.theme }]),
)
const withFact = (name: string, patch: Partial<Facts>) =>
  evaluateMatrix({
    cells: CELLS,
    facts: { ...GREEN, [name]: { ...factsOf(name), ...patch } },
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

  it("the repo's editions.json (one edition since BE-182) plans a single golden cell", () => {
    expect(planCells(REPO_EDITIONS, []).map((c) => c.name)).toEqual(['golden/ai'])
  })

  it('with one edition in editions.json the skins ride that edition (CI passes --skin)', () => {
    expect(planCells(REPO_EDITIONS, SKINS).map((c) => c.name)).toEqual([
      'golden/ai',
      'acme/ai',
      'nova/ai',
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
    expect(byName['golden/core']).toEqual({ ai: false })
    // FE-151: payments in an edition's module list is ignored -- an option.
    expect(byName['golden/school-payments']).toEqual({ ai: false })
    expect(byName['nova/full']).toEqual({ ai: true })
  })

  it('the chunk probes cover exactly the feature registry', () => {
    expect(Object.keys(MODULE_CHUNKS).sort()).toEqual([...FEATURE_NAMES].sort())
  })

  it('an edition missing from editions.json is a named error', () => {
    expect(() =>
      planCells({ schema: 1, editions: { core: { modules: [] }, school: { modules: [] } } }, SKINS),
    ).toThrow(/"full" is not in editions\.json/)
  })
})

describe('evaluateMatrix (tz-whitelabel §6 gate)', () => {
  it('a matrix whose facts match every source of record stays silent', () => {
    expect(evaluateMatrix({ cells: CELLS, facts: GREEN, expected: EXPECTED })).toEqual([])
  })

  it('a title that drifted from its brand record fails, named (a)', () => {
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

  it("a skin cell whose bundle lacks the skin's supportEmail fails (b, FE-251)", () => {
    const fails = withFact('acme/full', { supportEmailMissing: true })
    expect(fails).toEqual(["acme/full: the skin's supportEmail is not in the JS bundle"])
  })

  it("a skin cell whose bundle lacks the skin's mood icons fails (b, FE-273)", () => {
    const fails = withFact('acme/full', { moodIconsMissing: true })
    expect(fails).toEqual(["acme/full: the skin's mood icons are not in the JS bundle"])
  })

  it('a skin cell missing token declarations in dist CSS fails, named (b)', () => {
    const fails = withFact('nova/full', { tokensMissing: ['--velo-primary:#8b7cf6'] })
    expect(fails).toHaveLength(1)
    expect(fails[0]).toContain('--velo-primary:#8b7cf6')
  })

  it('a skin cell whose dist layout is off fails, every problem named (FE-131)', () => {
    const fails = withFact('nova/full', {
      layout: [
        "dist/icons/favicon.svg is not the package's assets/favicon.svg",
        'dist/skin/ ships more than the fonts: tokens/skin.tokens.json',
      ],
    })
    expect(fails).toHaveLength(2)
    expect(fails.join('\n')).toContain('nova/full: dist/icons/favicon.svg')
    expect(fails.join('\n')).toContain('ships more than the fonts')
  })

  it('skin identity leaking into any golden cell fails (b)', () => {
    const fails = withFact('golden/school', { leaked: ['nova tokens (--velo-primary:#8b7cf6)'] })
    expect(fails).toHaveLength(1)
    expect(fails[0]).toContain('golden/school')
    expect(fails[0]).toContain('leaked')
  })

  it('core carrying an ai chunk fails, named (c)', () => {
    const fails = withFact('golden/core', { chunks: { ai: ['AiConnectionsView-9f.js'] } })
    expect(fails).toHaveLength(1)
    expect(fails[0]).toContain('DISABLED ai module')
    expect(fails[0]).toContain('AiConnectionsView-9f.js')
  })

  it('an edition losing a module it turns on fails (c)', () => {
    const fails = withFact('golden/full', { chunks: { ai: [] } })
    expect(fails).toHaveLength(1)
    expect(fails[0]).toContain('ai chunks missing')
    expect(fails[0]).toContain('full')
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

  it('bundleHas finds the name as a word inside a message, in any case', () => {
    expect(bundleHas('{s:"Поддержка Goodo"}', 'Goodo')).toBe(true)
    expect(bundleHas('{s:"Откройте GOODO."}', 'Goodo')).toBe(true)
    expect(bundleHas('{s:"in Velo Pro: start"}', 'Velo Pro')).toBe(true)
  })

  it('bundleHas finds the name next to an escape and next to punctuation', () => {
    expect(bundleHas(String.raw`{s:"Привет!\nGoodo"}`, 'Goodo')).toBe(true)
    expect(bundleHas(String.raw`{s:"Goodo.\nНачните"}`, 'Goodo')).toBe(true)
    expect(bundleHas(String.raw`{s:"\tGoodo"}`, 'Goodo')).toBe(true)
    expect(bundleHas(String.raw`{s:"\x47oodo"}`, 'Goodo')).toBe(true)
    expect(bundleHas('{s:"««Goodo.»»"}', 'Goodo')).toBe(true)
    expect(bundleHas('{s:"(…Goodo.)"}', 'Goodo')).toBe(true)
    expect(bundleHas('{s:"<b>Goodo.</b>"}', 'Goodo')).toBe(true)
    expect(bundleHas('{s:"...Goodo"}', 'Goodo')).toBe(true)
  })

  it('bundleHas does not take a part of a word for the name, in any script', () => {
    expect(bundleHas('{s:"сНОВА"}', 'НОВА')).toBe(false)
    expect(bundleHas('{s:"НОВАя"}', 'НОВА')).toBe(false)
    expect(bundleHas('{s:"Goodos"}', 'Goodo')).toBe(false)
  })

  it('bundleHas does not take the core identifiers for the name', () => {
    // --velo-* names, velo:* storage keys and log tags, an e-mail host.
    expect(bundleHas('a.style.setProperty("--velo-primary",c)', 'VELO')).toBe(false)
    expect(bundleHas('const k="velo:diary:recent-searches"', 'VELO')).toBe(false)
    expect(bundleHas('console.error(`[velo:${t.source}] ${t.name}`)', 'VELO')).toBe(false)
    expect(bundleHas('href:"mailto:support@velo.example"', 'VELO')).toBe(false)
    expect(bundleHas('a.style.setProperty("--velo-primary",c)', 'Velo Pro')).toBe(false)
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

  it('invariant d holds per edition: the golden cell and the skin cells of `ai` must agree', () => {
    expect(assetCountFails([entry('golden/ai', 'ai', 385), entry('acme/ai', 'ai', 385)])).toEqual(
      [],
    )
    expect(
      assetCountFails([entry('golden/ai', 'ai', 385), entry('acme/ai', 'ai', 386)]),
    ).toHaveLength(1)
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
    // The repo's editions.json: one edition, `ai` (BE-182).
    expect(cells).toEqual(['golden/ai'])
  })

  it('--cell with an unknown name fails and names the known cells', () => {
    const run = cli('--cell', 'nope/none')
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('no cell "nope/none"')
    expect(run.stderr).toContain('golden/ai')
  })
})

describe('real-brand cells (FE-234)', () => {
  const GOLD = { displayName: 'VELO' }
  const decls = ['--velo-primary:#334d6e', '--velo-dur-pulse:1800ms']
  const core = new Set(['--velo-dur-pulse:1800ms'])
  const leak = (css: string, js = '', coreName = 'App') =>
    skinLeaks({
      label: 'velo-brand',
      brand: GOLD,
      decls,
      js,
      html: '',
      css,
      goldenDecls: core,
      coreName,
    })

  it('a gold token in a core build is a leak, and the golden cell goes red', () => {
    const leaked = leak(':root{--velo-primary:#334d6e}')
    expect(leaked).toEqual(['velo-brand tokens (--velo-primary:#334d6e)'])
    const fails = evaluateMatrix({
      cells: CELLS,
      facts: { ...GREEN, 'golden/full': { ...factsOf('golden/full'), leaked } },
      expected: EXPECTED,
    })
    expect(fails.join('\n')).toContain('golden/full')
  })

  it('a brand named like the core is not told by its name; another name is', () => {
    expect(leak(':root{}', 'const n="VELO"', 'VELO')).toEqual([])
    expect(leak(':root{}', 'const n="VELO"')).toEqual(['velo-brand displayName'])
    const named = skinLeaks({
      label: 'goodo-brand',
      brand: { displayName: 'Goodo' },
      decls: [],
      js: 'const n="Goodo"',
      html: '',
      css: '',
      goldenDecls: core,
      coreName: 'VELO',
    })
    expect(named).toEqual(['goodo-brand displayName'])
  })

  it("a brand's support address in a core build is a leak (FE-251)", () => {
    const withEmail = (js: string) =>
      skinLeaks({
        label: 'velo-brand',
        brand: { displayName: 'VELO', supportEmail: 'support@velo.example' },
        decls: [],
        js,
        html: '',
        css: '',
        goldenDecls: core,
        coreName: 'App',
      })
    expect(withEmail(String.raw`const e="support@velo.example"`)).toEqual([
      'velo-brand supportEmail',
    ])
    expect(withEmail('const e=null')).toEqual([])
  })

  describe('mood icons (FE-273)', () => {
    // Two icons of one size share the glow path; only the faces differ (the
    // real Goodo set: bad and fire, low and good).
    const GLOW = 'M0 0C9 0 9 9 0 9Z'
    const icon = (...paths: string[]): MoodNode => ({
      tag: 'svg',
      children: [{ tag: 'g', children: paths.map((d) => ({ tag: 'path', attrs: { d } })) }],
    })
    const set = { bad: icon(GLOW, 'M1 1h2z'), low: icon(GLOW, 'M2 2h2z') }

    it('an icon is told by the path data it alone carries, not by the glow it shares', () => {
      expect(moodProbes(set)).toEqual({ bad: ['M1 1h2z'], low: ['M2 2h2z'] })
    })

    it('an icon with no path of its own is told by all of its paths', () => {
      expect(moodProbes({ bad: icon(GLOW), low: icon(GLOW, 'M2 2h2z') })).toEqual({
        bad: [GLOW],
        low: ['M2 2h2z'],
      })
    })

    it('a skin bundle carries the set only when EVERY icon is in it, shared glow or not', () => {
      expect(bundleHasAllMoodIcons(`${GLOW}|M1 1h2z|M2 2h2z`, set)).toBe(true)
      // The glow and one face: the other icon is not there, whatever it shares.
      expect(bundleHasAllMoodIcons(`${GLOW}|M1 1h2z`, set)).toBe(false)
      expect(bundleHasAllMoodIcons(GLOW, set)).toBe(false)
    })

    it('a core bundle has an icon of the set only when that icon is proven there', () => {
      expect(bundleHasAnyMoodIcon('x="M2 2h2z"', set)).toBe(true)
      // The shared glow alone proves no icon of the set.
      expect(bundleHasAnyMoodIcon(GLOW, set)).toBe(false)
      expect(bundleHasAnyMoodIcon('x="M9 9h2z"', set)).toBe(false)
    })

    const leakOf = (js: string) =>
      skinLeaks({
        label: 'goodo-brand',
        brand: { displayName: 'Goodo' },
        decls: [],
        js,
        html: '',
        css: '',
        goldenDecls: core,
        coreName: 'App',
        moodIcons: set,
      })

    it('one icon of a skin in a core build is a leak; a core bundle without them is clean', () => {
      expect(leakOf('x="M2 2h2z"')).toEqual(['goodo-brand moodIcons'])
      expect(leakOf('x="M9 9h2z"')).toEqual([])
    })
  })

  describe('the font preload set (FE-278)', () => {
    const face = (file: string, weight: number) => ({ file, weight, style: 'normal' })
    const fonts = [
      face('assets/fonts/r.woff2', 400),
      face('assets/fonts/m.woff2', 500),
      face('assets/fonts/b.woff2', 700),
    ]
    const link = (file: string) => `<link rel="preload" href="/skin/${file}" as="font" />`

    it('Regular and the heading face, and nothing else, are the right set', () => {
      const html = link('assets/fonts/r.woff2') + link('assets/fonts/m.woff2')
      expect(fontPreloadProblems(fonts, 500, html)).toEqual([])
    })

    it('a missing due face and an extra face are both reported', () => {
      expect(fontPreloadProblems(fonts, 500, link('assets/fonts/r.woff2'))).toEqual([
        'no preload of assets/fonts/m.woff2 in index.html',
      ])
      const all = fonts.map((f) => link(f.file)).join('')
      expect(fontPreloadProblems(fonts, 500, all)).toEqual([
        'assets/fonts/b.woff2 is preloaded, but only the regular and heading faces should be',
      ])
    })
  })

  it('a value the core keeps is not a missing declaration; a changed one is', () => {
    expect(missingTokens(decls, ':root{--velo-primary:#334d6e}', core)).toEqual([])
    expect(missingTokens(decls, ':root{}', core)).toEqual(['--velo-primary:#334d6e'])
  })
})
/** The green facts of one cell (a typo in the name is a failure, not undefined). */
function factsOf(name: string): Facts {
  const facts = GREEN[name]
  if (!facts) throw new Error(`no green facts for ${name}`)
  return facts
}
