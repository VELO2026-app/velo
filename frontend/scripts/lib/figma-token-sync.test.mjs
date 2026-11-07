// =============================================================================
// FE-124 stage 2 -- unit tests for the Figma <-> registry equivalence engine
// (node:test; run via `pnpm test:tokens` -- vitest globs src/** only).
// Every branch of parseCssValue / resolveColor / compareValues /
// reconstructCss is pinned, including the lossless-apply refusals.
// =============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  collectLeaves,
  buildNameMap,
  parseCssValue,
  resolveColor,
  figmaToComparableTyped,
  compareValues,
  reconstructCss,
  indexByCssName,
} from './figma-token-sync.mjs'

// --- a miniature registry exercising every value form ------------------------
const REGISTRY_DOC = {
  root: {
    velo: {
      white: {
        $value: '#ffffff',
        $extensions: { pridem: { cssName: '--velo-white', order: 1 } },
      },
      primary: {
        $value: '#627a9c',
        $extensions: { pridem: { cssName: '--velo-primary', order: 2 } },
      },
      scrim: {
        $value: 'rgba(0, 0, 0, 0.5)',
        $extensions: { pridem: { cssName: '--velo-scrim', order: 3 } },
      },
      'bg-start': {
        $value: 'var(--velo-white)',
        $extensions: { pridem: { cssName: '--velo-bg-start', order: 4 } },
      },
      'bg-subtle': {
        $value: 'color-mix(in srgb, var(--velo-primary) 6%, transparent)',
        $extensions: { pridem: { cssName: '--velo-bg-subtle', order: 5 } },
      },
      'dur-press': {
        $value: '120ms',
        $extensions: { pridem: { cssName: '--velo-dur-press', order: 6 } },
      },
      gap: {
        $value: '12px',
        $extensions: { pridem: { cssName: '--velo-gap', order: 7 } },
      },
      'sheet-top': {
        $value: '30px 30px 0 0',
        $extensions: { pridem: { cssName: '--velo-sheet-top', order: 8 } },
      },
      media: {
        $value: 'prefers-reduced-motion placeholder',
        $extensions: {}, // no pridem cssName -> collectLeaves skips it
      },
    },
  },
}

const leaves = collectLeaves(REGISTRY_DOC)
const byCssName = indexByCssName(leaves)

test('collectLeaves: cssName leaves only, media artifact skipped', () => {
  assert.equal(leaves.length, 8)
  assert.ok(leaves.every((l) => l.cssName.startsWith('--')))
})

test('buildNameMap: suffix rule pairs the FE-124 import names bijectively', () => {
  const figma = [
    { name: 'color/primary' },
    { name: 'color/white' },
    { name: 'glass/scrim' },
    { name: 'color/bg-start' },
    { name: 'color/bg-subtle' },
    { name: 'app/dur-press' },
    { name: 'app/gap' },
    { name: 'radius/sheet-top' },
  ]
  const { map, registryOrphans, figmaOrphans } = buildNameMap(leaves, figma)
  assert.equal(map.size, 8)
  assert.deepEqual(registryOrphans, [])
  assert.deepEqual(figmaOrphans, [])
  assert.equal(map.get('--velo-primary'), 'color/primary')
  assert.equal(map.get('--velo-sheet-top'), 'radius/sheet-top')
})

test('buildNameMap: orphans surface BOTH ways (new designer token, renamed code token)', () => {
  const figma = [{ name: 'color/primary' }, { name: 'color/brand-new' }]
  const { map, registryOrphans, figmaOrphans } = buildNameMap(leaves, figma)
  assert.equal(map.size, 1)
  assert.equal(registryOrphans.length, 7)
  assert.deepEqual(figmaOrphans, ['color/brand-new'])
})

test('buildNameMap: the bare frozen family maps as <family>/<rest>', () => {
  const bareLeaves = [
    { cssName: '--space-1' },
    { cssName: '--radius-md' },
    { cssName: '--z-modal' },
    { cssName: '--transition-fast' },
    { cssName: '--font-body' },
  ]
  const figma = [
    { name: 'space/1' },
    { name: 'radius/md' },
    { name: 'z/modal' },
    { name: 'transition/fast' },
    { name: 'font/body' },
  ]
  const { map, registryOrphans, figmaOrphans } = buildNameMap(bareLeaves, figma)
  assert.equal(map.size, 5)
  assert.deepEqual(registryOrphans, [])
  assert.deepEqual(figmaOrphans, [])
})

test('parseCssValue: multi-line verbatim values collapse before parsing', () => {
  const multiline = 'color-mix(\n    in srgb,\n    var(--velo-blue-500) 30%,\n    transparent\n  )'
  const mix = parseCssValue(multiline)
  assert.equal(mix.kind, 'mix')
  assert.equal(mix.percent, 30)
  assert.deepEqual(mix.base, { kind: 'ref', cssName: '--velo-blue-500' })
  // and the raw compare sees the semantic text, not the authoring whitespace
  assert.deepEqual(parseCssValue('inset 0 1px 0 rgba(255, 255, 255, 0.75),\n 0 0 18px rgba(150, 190, 255, 0.2)'), {
    kind: 'raw',
    text: 'inset 0 1px 0 rgba(255, 255, 255, 0.75), 0 0 18px rgba(150, 190, 255, 0.2)',
  })
})

test('compareValues: a Figma FLOAT alias resolves through the ref chain (dim-vs-ref)', () => {
  // registry: ' var(--space-8)'; figma: alias space/8 = 33
  const verdict = compareValues(
    parseCssValue('var(--space-8)'),
    { kind: 'dim', value: 33 },
    indexByCssName([...collectLeaves(REGISTRY_DOC), { cssName: '--space-8', value: ' 33px' }]),
  )
  assert.equal(verdict.status, 'match')
  const drifted = compareValues(
    parseCssValue('var(--space-8)'),
    { kind: 'dim', value: 40 },
    indexByCssName([...collectLeaves(REGISTRY_DOC), { cssName: '--space-8', value: ' 33px' }]),
  )
  assert.equal(drifted.status, 'drift')
})

test('buildNameMap: suffix collision throws (ambiguous map = a loud bug, not a wrong PR)', () => {
  const figma = [{ name: 'color/primary' }, { name: 'accent/primary' }]
  assert.throws(() => buildNameMap(leaves, figma), /collision/)
})

// --- parseCssValue -------------------------------------------------------------
test('parseCssValue: every registry value form', () => {
  assert.deepEqual(parseCssValue('var(--velo-white)'), { kind: 'ref', cssName: '--velo-white' })
  assert.deepEqual(parseCssValue('#627a9c'), { kind: 'color', rgb: [98, 122, 156], a: 1 })
  assert.deepEqual(parseCssValue('rgba(0, 0, 0, 0.5)'), { kind: 'color', rgb: [0, 0, 0], a: 0.5 })
  const mix = parseCssValue('color-mix(in srgb, var(--velo-primary) 6%, transparent)')
  assert.equal(mix.kind, 'mix')
  assert.equal(mix.percent, 6)
  assert.deepEqual(mix.base, { kind: 'ref', cssName: '--velo-primary' })
  const mixHex = parseCssValue('color-mix(in srgb, #ffffff 40%, transparent)')
  assert.deepEqual(mixHex.base, { kind: 'color', rgb: [255, 255, 255], a: 1 })
  assert.deepEqual(parseCssValue('120ms'), { kind: 'dim', value: 120, unit: 'ms' })
  assert.deepEqual(parseCssValue('-1.5px'), { kind: 'dim', value: -1.5, unit: 'px' })
  assert.deepEqual(parseCssValue('999'), { kind: 'dim', value: 999, unit: '' })
  assert.deepEqual(parseCssValue('30px 30px 0 0'), { kind: 'raw', text: '30px 30px 0 0' })
  assert.equal(parseCssValue('cubic-bezier(0.22, 1, 0.36, 1)').kind, 'raw')
})

// --- resolveColor ---------------------------------------------------------------
test('resolveColor: refs follow the chain, mixes become alpha', () => {
  const ref = resolveColor(parseCssValue('var(--velo-bg-start)'), byCssName)
  assert.deepEqual(ref, { rgb: [255, 255, 255], a: 1 })
  const mix = resolveColor(parseCssValue('color-mix(in srgb, var(--velo-primary) 6%, transparent)'), byCssName)
  assert.deepEqual(mix.rgb, [98, 122, 156])
  assert.ok(Math.abs(mix.a - 0.06) < 1e-9)
  assert.equal(resolveColor(parseCssValue('var(--velo-missing)'), byCssName), null)
  assert.equal(resolveColor(parseCssValue('120ms'), byCssName), null)
})

test('resolveColor: a cycle resolves to null instead of hanging', () => {
  const cyc = indexByCssName([
    { cssName: '--a', value: 'var(--b)' },
    { cssName: '--b', value: 'var(--a)' },
  ])
  assert.equal(resolveColor(parseCssValue('var(--a)'), cyc), null)
})

// --- figma side ------------------------------------------------------------------
const figmaById = {
  aliasWhite: { name: 'color/white' },
}
const nameMap = new Map([
  ['--velo-white', 'color/white'],
  ['--velo-primary', 'color/primary'],
])
const inverse = new Map([...nameMap].map(([k, v]) => [v, k]))

test('figmaToComparableTyped: alias -> ref, seconds -> ms, floats stay dim', () => {
  const alias = figmaToComparableTyped({ type: 'VARIABLE_ALIAS', id: 'aliasWhite' }, 'COLOR', figmaById, nameMap, inverse)
  assert.deepEqual(alias, { kind: 'ref', cssName: '--velo-white' })
  const timing = figmaToComparableTyped(0.12, 'TIMING', figmaById, nameMap, inverse)
  assert.deepEqual(timing, { kind: 'dim', value: 120, unit: 'ms' })
  const float = figmaToComparableTyped(9, 'FLOAT', figmaById, nameMap, inverse)
  assert.deepEqual(float, { kind: 'dim', value: 9, unit: '' })
  const color = figmaToComparableTyped({ r: 0.3843137323856354, g: 0.47843137383461, b: 0.6117647290229797, a: 1 }, 'COLOR', figmaById, nameMap, inverse)
  assert.deepEqual(color, { kind: 'color', rgb: [98, 122, 156], a: 1 })
})

// --- compare -----------------------------------------------------------------------
const FIGMA_PRIMARY = { r: 0.3843137323856354, g: 0.47843137383461, b: 0.6117647290229797, a: 1 }

test('compareValues: hex registry == figma float color (channel quantization)', () => {
  const verdict = compareValues(
    parseCssValue('#627a9c'),
    figmaToComparableTyped(FIGMA_PRIMARY, 'COLOR', figmaById, nameMap, inverse),
    byCssName,
  )
  assert.equal(verdict.status, 'match')
})

test('compareValues: mix registry == figma hex8-quantized color', () => {
  // 6% of primary: alpha byte round(0.06*255)=15 -> 15/255=0.0588...
  const verdict = compareValues(
    parseCssValue('color-mix(in srgb, var(--velo-primary) 6%, transparent)'),
    { kind: 'color', rgb: [98, 122, 156], a: 15 / 255 },
    byCssName,
  )
  assert.equal(verdict.status, 'match')
})

test('compareValues: a drift in the BASE token is the drift of every mix on it', () => {
  const verdict = compareValues(
    parseCssValue('color-mix(in srgb, var(--velo-primary) 6%, transparent)'),
    { kind: 'color', rgb: [200, 122, 156], a: 15 / 255 },
    byCssName,
  )
  assert.equal(verdict.status, 'drift')
})

test('compareValues: alias rewired in Figma = drift (the ref the designer broke)', () => {
  const verdict = compareValues(
    parseCssValue('var(--velo-white)'),
    { kind: 'ref', cssName: '--velo-primary' },
    byCssName,
  )
  assert.equal(verdict.status, 'drift')
})

test('compareValues: ref registry vs solid figma = review (the designer broke the alias)', () => {
  const verdict = compareValues(
    parseCssValue('var(--velo-white)'),
    { kind: 'color', rgb: [255, 255, 255], a: 1 },
    byCssName,
  )
  assert.equal(verdict.status, 'review')
})

test('compareValues: dims compare magnitude; the px/ms unit never drifts', () => {
  assert.equal(compareValues(parseCssValue('9px'), { kind: 'dim', value: 9 }, byCssName).status, 'match')
  assert.equal(compareValues(parseCssValue('120ms'), { kind: 'dim', value: 120 }, byCssName).status, 'match')
  assert.equal(compareValues(parseCssValue('120ms'), { kind: 'dim', value: 150 }, byCssName).status, 'drift')
  assert.equal(compareValues(parseCssValue('999'), { kind: 'dim', value: 999.2 }, byCssName).status, 'match')
})

test('compareValues: raw strings compare exactly', () => {
  assert.equal(compareValues(parseCssValue('30px 30px 0 0'), { kind: 'raw', text: '30px 30px 0 0' }, byCssName).status, 'match')
  assert.equal(compareValues(parseCssValue('30px 30px 0 0'), { kind: 'raw', text: '32px 32px 0 0' }, byCssName).status, 'drift')
})

// --- reconstructCss: the lossless apply policy ---------------------------------------
test('reconstructCss: hex literal stays hex', () => {
  const css = reconstructCss(
    parseCssValue('#627a9c'),
    { kind: 'color', rgb: [255, 0, 0], a: 1 },
    'COLOR',
  )
  assert.equal(css, '#ff0000')
})

test('reconstructCss: rgba literal re-renders at its shortest in-tolerance alpha', () => {
  // Figma stored 0.5 as 128/255 = 0.50196...: the css form goes back to 0.5.
  const css = reconstructCss(
    parseCssValue('rgba(0, 0, 0, 0.5)'),
    { kind: 'color', rgb: [0, 0, 0], a: 128 / 255 },
    'COLOR',
  )
  assert.equal(css, 'rgba(0, 0, 0, 0.5)')
})

test('reconstructCss: timing rounds to whole ms', () => {
  assert.equal(reconstructCss(parseCssValue('120ms'), { kind: 'dim', value: 150.0000001 }, 'TIMING'), '150ms')
})

test('reconstructCss: raw strings (shadows, easings) pass verbatim', () => {
  assert.equal(
    reconstructCss(parseCssValue('x'), { kind: 'raw', text: 'inset 0 1px 0 rgba(255,255,255,.75)' }, 'STRING'),
    'inset 0 1px 0 rgba(255,255,255,.75)',
  )
})

test('reconstructCss: refuses to rewrite a mix/ref registry side (report-only)', () => {
  assert.equal(
    reconstructCss(
      parseCssValue('color-mix(in srgb, var(--velo-primary) 6%, transparent)'),
      { kind: 'color', rgb: [200, 122, 156], a: 0.06 },
      'COLOR',
    ),
    null,
  )
  assert.equal(reconstructCss(parseCssValue('var(--velo-white)'), { kind: 'color', rgb: [1, 1, 1], a: 1 }, 'COLOR'), null)
  assert.equal(reconstructCss(parseCssValue('9px'), { kind: 'dim', value: 12 }, 'FLOAT'), null)
})
