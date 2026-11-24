// FE-234 item 6: the modes of the Figma `velo` collection -- the config, the
// snapshot forms, the values per mode and the drift per mode.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildModeValues,
  modeDigest,
  figmaValueFor,
  modeDrift,
  modeRegistry,
  normalizeSnapshot,
  parseModesConfig,
} from './figma-modes.mjs'

const SHA = 'a'.repeat(40)
const pin = (name) => ({ repo: `org/${name}`, tag: 'v1.0.0', sha: SHA, dir: 'skin' })
const brands = () => ({
  brands: { 'velo-brand': pin('velo-brand'), 'goodo-brand': pin('goodo-brand') },
})
/** @returns {any} */
const baseConfig = () => ({
  file: 'F',
  collection: 'velo',
  coreOnlyCollections: ['legacy'],
  screensMode: 'gold',
  modes: [
    { name: 'core', source: 'tokens.json' },
    { name: 'gold', figmaModeId: '1:0', brand: 'velo-brand' },
    { name: 'goodo', brand: 'goodo-brand' },
  ],
})

describe('parseModesConfig', () => {
  it('a skin mode takes its package pin from brand-skins.json, the one pin file', () => {
    const cfg = parseModesConfig(baseConfig(), brands())
    expect(cfg.modes[2]?.package).toEqual({ name: 'goodo-brand', ...pin('goodo-brand') })
    expect(cfg.modes[0]?.package).toBeUndefined()
  })
  it('the repo config resolves against the repo pin file', () => {
    const read = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'))
    const cfg = parseModesConfig(
      read('../../design/figma-modes.json'),
      read('../../../.github/brand-skins.json'),
    )
    expect(cfg.modes.map((m) => [m.name, m.package?.name])).toEqual([
      ['core', undefined],
      ['gold', 'velo-brand'],
      ['goodo', 'goodo-brand'],
    ])
  })
  /** @type {Array<[string, (c: any) => unknown, RegExp]>} */
  const broken = [
    ['a skin first', (c) => c.modes.reverse(), /first mode is the core/],
    ['the core with a brand', (c) => (c.modes[0].brand = 'velo-brand'), /first mode is the core/],
    [
      'a second core',
      (c) => (c.modes[2] = { name: 'goodo', source: 'tokens.json' }),
      /only the first mode/,
    ],
    [
      'five modes',
      (c) => c.modes.push({ name: 'a', brand: 'velo-brand' }, { name: 'b', brand: 'velo-brand' }),
      /plan allows 4/,
    ],
    [
      'a brand with no pin',
      (c) => (c.modes[2].brand = 'nobody'),
      /not in .github\/brand-skins.json/,
    ],
    ['a duplicate name', (c) => (c.modes[2].name = 'gold'), /twice/],
    ['two modes on one Figma id', (c) => (c.modes[2].figmaModeId = '1:0'), /same figmaModeId/],
    ['screens in an unknown mode', (c) => (c.screensMode = 'night'), /screensMode "night"/],
    [
      'the moded collection as core-only',
      (c) => (c.coreOnlyCollections = ['velo']),
      /coreOnlyCollections/,
    ],
  ]
  it.each(broken)('refuses %s', (_, mutate, error) => {
    const cfg = baseConfig()
    mutate(cfg)
    expect(() => parseModesConfig(cfg, brands())).toThrow(error)
  })
  it('refuses a malformed pin in brand-skins.json', () => {
    const b = brands()
    b.brands['goodo-brand'].sha = 'main'
    expect(() => parseModesConfig(baseConfig(), b)).toThrow(/goodo-brand: bad sha/)
  })
})

describe('normalizeSnapshot', () => {
  it('refuses the compact dump: its modes have no names', () => {
    expect(() => normalizeSnapshot({ variables: [{ n: 'color/primary', t: 'COLOR' }] })).toThrow(
      /no mode names/,
    )
  })
  it('reads the REST shape into the same form', () => {
    const s = normalizeSnapshot({
      meta: {
        variableCollections: {
          c: { id: 'c', name: 'velo', modes: [{ modeId: 'm', name: 'gold' }] },
        },
        variables: {
          v: {
            id: 'v',
            name: 'color/primary',
            variableCollectionId: 'c',
            resolvedType: 'COLOR',
            valuesByMode: {},
          },
        },
      },
    })
    expect(s.collections[0].modes).toEqual([{ modeId: 'm', name: 'gold' }])
    expect(s.variables[0].collectionId).toBe('c')
  })
})

// --- a tiny registry and a Figma file with the gold mode only (today's file) ----
const leaf = (cssName, value) => ({ cssName, value })
const core = [
  leaf('--velo-blue-500', '#787878'),
  leaf('--velo-primary', 'var(--velo-blue-500)'),
  leaf('--velo-glass', 'color-mix(in srgb, var(--velo-blue-500) 15%, transparent)'),
  leaf('--velo-dur-fast', '180ms'),
  leaf('--velo-shadow', '0 1px 2px rgba(0, 0, 0, 0.2)'),
  leaf('--velo-picker-bg', 'var(--velo-primary)'),
  leaf('--space-8', '16px'),
  leaf('--font-body', 'system-ui, sans-serif'),
]
const gold = modeRegistry(core, [
  ['--velo-blue-500', '#627a9c'],
  ['--font-body', "Marmelad, 'Noto Sans', sans-serif"],
])
const goodo = modeRegistry(core, [
  ['--velo-blue-500', '#120054'],
  ['--velo-picker-bg', 'transparent'],
  ['--velo-shadow', 'none'],
])
const rgb = (r, g, b, a = 1) => ({ r: r / 255, g: g / 255, b: b / 255, a })
const variable = (name, resolvedType, collectionId, valuesByMode) => ({
  id: `id:${name}`,
  name,
  collectionId,
  resolvedType,
  valuesByMode,
})
const snapshot = normalizeSnapshot({
  collections: [
    { id: 'cv', name: 'velo', modes: [{ modeId: '1:0', name: 'gold' }] },
    { id: 'cl', name: 'legacy', modes: [{ modeId: '1:1', name: 'Default' }] },
  ],
  variables: [
    variable('color/blue-500', 'COLOR', 'cv', { '1:0': rgb(98, 122, 156) }),
    variable('color/primary', 'COLOR', 'cv', {
      '1:0': { type: 'VARIABLE_ALIAS', id: 'id:color/blue-500' },
    }),
    variable('glass/glass', 'COLOR', 'cv', { '1:0': rgb(98, 122, 156, 0.149) }),
    variable('app/dur-fast', 'TIMING', 'cv', { '1:0': 0.18 }),
    variable('shadow/shadow', 'STRING', 'cv', { '1:0': '0 1px 2px rgba(0, 0, 0, 0.2)' }),
    variable('color/picker-bg', 'COLOR', 'cv', {
      '1:0': { type: 'VARIABLE_ALIAS', id: 'id:color/primary' },
    }),
    variable('space/8', 'FLOAT', 'cl', { '1:1': 16 }),
    variable('font/body', 'STRING', 'cl', { '1:1': "'Marmelad', 'Noto Sans', sans-serif" }),
  ],
})
const config = parseModesConfig(baseConfig(), brands())
const modes = [
  { name: 'core', leaves: core },
  { name: 'gold', leaves: gold },
  { name: 'goodo', leaves: goodo },
]

describe('figmaValueFor', () => {
  const byName = new Map(goodo.map((l) => [l.cssName, l]))
  const names = new Map([['--velo-primary', 'color/primary']])
  it('a reference with a Figma variable stays an alias; a mix and a duration are baked', () => {
    expect(figmaValueFor('var(--velo-primary)', 'COLOR', byName, names)).toEqual({
      ok: true,
      value: { alias: 'color/primary' },
    })
    expect(figmaValueFor(goodo[2].value, 'COLOR', byName, names)).toEqual({
      ok: true,
      value: { color: [18, 0, 84, 0.15] },
    })
    expect(figmaValueFor('180ms', 'TIMING', byName, names)).toEqual({
      ok: true,
      value: { float: 0.18 },
    })
    expect(figmaValueFor('transparent', 'COLOR', byName, names)).toEqual({
      ok: true,
      value: { color: [0, 0, 0, 0] },
    })
  })
  it('a string variable holds the CSS text; a color variable refuses it', () => {
    expect(figmaValueFor('0 1px  2px\n red', 'STRING', byName, names)).toEqual({
      ok: true,
      value: { string: '0 1px 2px red' },
    })
    expect(figmaValueFor('none', 'COLOR', byName, names)).toMatchObject({ ok: false })
  })
  it('a string reference with no Figma variable follows to the text it names', () => {
    const fonts = new Map([['--font-body', { value: 'Manrope, sans-serif' }]])
    expect(figmaValueFor('var(--font-body)', 'STRING', fonts, new Map())).toEqual({
      ok: true,
      value: { string: 'Manrope, sans-serif' },
    })
    expect(figmaValueFor('var(--font-none)', 'STRING', fonts, new Map())).toMatchObject({
      ok: false,
      reason: expect.stringContaining('does not resolve'),
    })
  })
  it('a duration in seconds, a number that is not one, a type no token fits', () => {
    expect(figmaValueFor('0.3s', 'TIMING', byName, names)).toEqual({
      ok: true,
      value: { float: 0.3 },
    })
    expect(figmaValueFor('auto', 'FLOAT', byName, names)).toMatchObject({
      ok: false,
      reason: 'not a number: auto',
    })
    expect(figmaValueFor('1', 'BOOLEAN', byName, names)).toMatchObject({ ok: false })
  })
})

describe('modeDigest', () => {
  it('the payload carries the digest of every existing mode; a changed value changes it', () => {
    const { payload } = buildModeValues({ config, modes, snapshot })
    expect(Object.keys(payload.digests)).toEqual(['velo/gold', 'legacy/Default'])
    const veloVars = snapshot.variables.filter((v) => v.collectionId === 'cv')
    const rows = veloVars.map((v) => [v.name, v.valuesByMode['1:0']])
    expect(payload.digests['velo/gold']).toBe(modeDigest(rows))
    expect(modeDigest([...rows].reverse())).toBe(modeDigest(rows))
    rows[0] = [rows[0][0], rgb(98, 122, 157)]
    expect(modeDigest(rows)).not.toBe(payload.digests['velo/gold'])
  })
})

describe('modeDrift', () => {
  it('today: gold is in sync with tokens.json + its package, core and goodo are missing', () => {
    const r = modeDrift({ config, modes, snapshot })
    const by = Object.fromEntries(r.modes.map((m) => [`${m.collection}/${m.name}`, m]))
    expect(by['velo/gold']).toMatchObject({ missing: false, drift: [], review: [] })
    expect(by['velo/core'].missing).toBe(true)
    expect(by['velo/goodo'].missing).toBe(true)
    // the old rule ("core = the first mode") would compare the neutral core with gold:
    expect(by['legacy/core'].drift.map((d) => d.cssName)).toEqual(['--font-body'])
    expect(r.unknownModes).toEqual([])
  })
  it('a Figma mode the config does not know is reported', () => {
    const extra = structuredClone(snapshot)
    extra.collections[0].modes.push({ modeId: '1:9', name: 'dark' })
    expect(modeDrift({ config, modes, snapshot: extra }).unknownModes).toEqual(['dark'])
  })
})

describe('buildModeValues', () => {
  const built = buildModeValues({ config, modes, snapshot })
  const velo = built.payload.collections[0].values
  it('every mode of every mapped variable, the gold mode pinned by id', () => {
    expect(built.payload.modes).toEqual([
      { name: 'core' },
      { name: 'gold', figmaModeId: '1:0' },
      { name: 'goodo' },
    ])
    expect(velo['color/blue-500']).toEqual({
      core: { color: [120, 120, 120, 1] },
      gold: { color: [98, 122, 156, 1] },
      goodo: { color: [18, 0, 84, 1] },
    })
    expect(velo['color/picker-bg'].goodo).toEqual({ color: [0, 0, 0, 0] })
    expect(velo['shadow/shadow'].goodo).toEqual({ string: 'none' })
  })
  it('a core-only collection gets the core; a skin value it cannot hold is reported', () => {
    expect(built.payload.collections[1]).toMatchObject({ name: 'legacy', coreOnly: true })
    expect(built.payload.collections[1].values['font/body']).toEqual({
      core: { string: 'system-ui, sans-serif' },
    })
    expect(built.problems.map((p) => `${p.mode} ${p.cssName}`)).toEqual(['gold --font-body'])
  })
})
