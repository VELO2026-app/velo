// =============================================================================
// FE-234 item 6 -- the Figma writer of the `velo` modes (docs/figma/front/modes-lib.figma.js)
// against a minimal fake of the plugin API (Vitest, the `scripts` project). The real file is
// checked live in Figma; this pins the guards: the core values never land in the gold mode,
// nothing is written before every check passes, the lock, the snapshot digest, the pins.
// =============================================================================
import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { runInNewContext } from 'node:vm'
import { MAX_MODES, MODES_FORMAT, modeDigest, normalizeSnapshot } from './figma-modes.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const LIB = readFileSync(join(root, 'docs/figma/front/modes-lib.figma.js'), 'utf8')
const KIT = 'Kit и токены'

// --- a fake of the plugin API ----------------------------------------------------------
/** @type {any} */
let figma
/** @type {string[]} */
let versions
/** @type {any} */
let file

const withModes = (props) => ({
  explicitVariableModes: {},
  setExplicitVariableModeForCollection(c, m) {
    this.explicitVariableModes = { ...this.explicitVariableModes, [c.id]: m }
  },
  ...props,
})
const page = (name, children = []) =>
  withModes({
    type: 'PAGE',
    name,
    children,
    data: {},
    getPluginData(k) {
      return this.data[k] || ''
    },
  })
const node = (name) => withModes({ name })

function fakeFile() {
  let next = 0
  /** @type {any[]} */
  const vars = []
  const col = {
    id: 'cv',
    name: 'velo',
    modes: [{ modeId: '3905:0', name: 'gold' }],
    defaultModeId: '3905:0',
    addMode(name) {
      const id = `new:${++next}`
      this.modes.push({ modeId: id, name })
      // Figma copies the default mode's values into a new mode.
      for (const v of vars.filter((x) => x.variableCollectionId === 'cv'))
        v.valuesByMode[id] = v.valuesByMode[this.defaultModeId]
      return id
    },
    setDefaultMode(id) {
      this.defaultModeId = id
      this.modes.sort((a, b) => (a.modeId === id ? -1 : b.modeId === id ? 1 : 0))
    },
  }
  const legacy = {
    id: 'cl',
    name: 'legacy',
    modes: [{ modeId: '3905:1', name: 'Default' }],
    defaultModeId: '3905:1',
  }
  const mk = (name, resolvedType, variableCollectionId, valuesByMode) => ({
    id: `id:${name}`,
    name,
    resolvedType,
    variableCollectionId,
    valuesByMode,
    writes: 0,
    setValueForMode(mode, value) {
      this.valuesByMode[mode] = value
      this.writes++
    },
  })
  vars.push(
    mk('color/blue-500', 'COLOR', 'cv', {
      '3905:0': { r: 98 / 255, g: 122 / 255, b: 156 / 255, a: 1 },
    }),
    mk('color/primary', 'COLOR', 'cv', {
      '3905:0': { type: 'VARIABLE_ALIAS', id: 'id:color/blue-500' },
    }),
    mk('font/body', 'STRING', 'cl', { '3905:1': 'Marmelad' }),
  )
  const screens = page('Gold · Приложение', [node('Legacy screen / user.dashboard / Dashboard')])
  const kit = page(KIT, [node('Component / Actions')])
  const designer = page('User App', [node('Tanya frame')])
  versions = []
  figma = {
    fileKey: 'F',
    root: { children: [screens, kit, designer] },
    loadAllPagesAsync: () => Promise.resolve(),
    saveVersionHistoryAsync: (label) => Promise.resolve(versions.push(label)),
    variables: {
      getLocalVariableCollectionsAsync: () => Promise.resolve([col, legacy]),
      getLocalVariablesAsync: () => Promise.resolve(vars),
      createVariableAlias: (v) => ({ type: 'VARIABLE_ALIAS', id: v.id }),
    },
  }
  return { col, legacy, vars, screens, kit, designer }
}

const THREAD = 'thr_test'
function lock(who = `front-agent ${THREAD}`, minutes = 30) {
  const until = new Date(Date.now() + minutes * 60e3).toISOString()
  file.kit.data['f2c:lock'] = JSON.stringify({ who, task: 'FE-234', until })
}
function lib(extra = {}) {
  return runInNewContext(`${LIB}\nmakeModes({ thread: '${THREAD}', task: 'FE-234' })`, {
    figma,
    Map,
    Set,
    JSON,
    Math,
    Error,
    Date,
    ...extra,
  })
}
/** The digests the CLI would put in the payload, from the fake's current state. */
function digests() {
  const out = {}
  for (const c of [file.col, file.legacy])
    for (const m of c.modes)
      out[`${c.name}/${m.name}`] = modeDigest(
        file.vars
          .filter((v) => v.variableCollectionId === c.id)
          .map((v) => [v.name, v.valuesByMode[m.modeId]]),
      )
  return out
}

/** @returns {any} */
const payload = () => ({
  format: 'velo-figma-modes/1',
  kind: 'payload',
  file: 'F',
  collection: 'velo',
  screensMode: 'gold',
  digests: digests(),
  modes: [{ name: 'core' }, { name: 'gold', figmaModeId: '3905:0' }, { name: 'goodo' }],
  collections: [
    {
      name: 'velo',
      values: {
        'color/blue-500': {
          core: { color: [120, 120, 120, 1] },
          gold: { color: [98, 122, 156, 1] },
          goodo: { color: [18, 0, 84, 1] },
        },
        'color/primary': {
          core: { alias: 'color/blue-500' },
          gold: { alias: 'color/blue-500' },
          goodo: { alias: 'color/blue-500' },
        },
      },
    },
    { name: 'legacy', coreOnly: true, values: { 'font/body': { core: { string: 'system-ui' } } } },
  ],
})

/** Pin every mirror page and its top-level nodes, as MODES.pin would. */
function pinFront(mode = '3905:0') {
  for (const p of [file.screens, file.kit]) {
    p.explicitVariableModes = { cv: mode }
    for (const n of p.children) n.explicitVariableModes = { cv: mode }
  }
}

describe('modes-lib.figma.js', () => {
  beforeEach(() => {
    file = fakeFile()
    lock()
  })

  it('keeps the format and the plan limit of figma-modes.mjs', () => {
    expect(LIB).toContain(`const MODES_FORMAT = '${MODES_FORMAT}';`)
    expect(LIB).toContain(`const MODES_MAX = ${MAX_MODES};`)
  })

  it('creates core and goodo, writes only what differs, leaves the gold mode as it was', async () => {
    const r = await lib().apply(payload(), { createModes: true })
    expect(versions).toHaveLength(1)
    expect(r.created.map((m) => m.name)).toEqual(['core', 'goodo'])
    expect(r.changes.gold).toBeUndefined()
    const blue = file.vars[0]
    expect(blue.valuesByMode['3905:0'].r).toBeCloseTo(98 / 255)
    expect(blue.valuesByMode[r.created[0].modeId].r).toBeCloseTo(120 / 255)
    expect(file.vars[2].valuesByMode['3905:1']).toBe('system-ui')
    expect(r.defaultMode).toBe('gold')
  })

  it('makes the core the default only once every Фронт page and top-level node is pinned', async () => {
    await lib().apply(payload(), { createModes: true })
    const p = payload()
    await expect(lib().apply(p, { makeCoreDefault: true })).rejects.toThrow(
      /not pinned.*page "Gold · Приложение" \(no explicit mode\).*Dashboard/s,
    )
    expect(file.col.defaultModeId).toBe('3905:0')
    pinFront()
    const r = await lib().apply(p, { makeCoreDefault: true })
    expect(r).toMatchObject({
      defaultMode: 'core',
      order: ['core', 'gold', 'goodo'],
      defaultNote: null,
    })
    // a designer page is not a condition and is not touched
    expect(file.designer.explicitVariableModes).toEqual({})
  })

  it('reports a Figma without setDefaultMode instead of failing silently', async () => {
    await lib().apply(payload(), { createModes: true })
    pinFront()
    delete file.col.setDefaultMode
    const r = await lib().apply(payload(), { makeCoreDefault: true })
    expect(r.defaultNote).toMatch(/by hand/)
    expect(r.defaultMode).toBe('gold')
  })

  it('refuses makeCoreDefault before the core mode exists', async () => {
    pinFront()
    await expect(
      lib().apply(payload(), { createModes: true, makeCoreDefault: true }),
    ).rejects.toThrow(/does not exist yet/)
    expect(versions).toEqual([])
  })

  it('stops before the version without the live front lock of this thread', async () => {
    file.kit.data['f2c:lock'] = ''
    await expect(lib().apply(payload(), { createModes: true })).rejects.toThrow(
      /no live front lock/,
    )
    lock('front-agent thr_other')
    await expect(lib().apply(payload(), { createModes: true })).rejects.toThrow(
      /no live front lock/,
    )
    lock(undefined, -1)
    await expect(lib().apply(payload(), { createModes: true })).rejects.toThrow(
      /no live front lock/,
    )
    expect(versions).toEqual([])
  })

  it('stops when Figma changed since the snapshot (a hand edit of gold)', async () => {
    const p = payload()
    file.vars[0].valuesByMode['3905:0'] = { r: 1, g: 0, b: 0, a: 1 }
    await expect(lib().apply(p, { createModes: true })).rejects.toThrow(
      /velo\/gold changed in Figma/,
    )
    expect(versions).toEqual([])
  })

  it('stops when a variable has no value for a new mode: it would keep the gold value', async () => {
    const p = payload()
    delete p.collections[0].values['color/primary'].goodo
    await expect(lib().apply(p, { createModes: true })).rejects.toThrow(
      /color\/primary: no value for the new mode goodo/,
    )
    expect(file.col.modes).toHaveLength(1)
  })

  it('stops before the version when the pinned gold mode was renamed', async () => {
    file.col.modes[0].name = 'core'
    const p = payload()
    p.digests = {}
    await expect(lib().apply(p, { createModes: true })).rejects.toThrow(/named "core"/)
    expect(versions).toEqual([])
    expect(file.vars.every((v) => v.writes === 0)).toBe(true)
  })

  it('stops on a value that does not fit its variable, before any write', async () => {
    const p = payload()
    p.collections[0].values['color/primary'].goodo = { string: 'none' }
    await expect(lib().apply(p, { createModes: true })).rejects.toThrow(/a string into a COLOR/)
    expect(versions).toEqual([])
  })

  it('stops on an unknown Figma mode, on the plan limit and on missing modes without createModes', async () => {
    file.col.modes.push({ modeId: 'x', name: 'dark' })
    const p = payload()
    p.digests = {}
    await expect(lib().apply(p, { createModes: true })).rejects.toThrow(/does not name: dark/)
    file.col.modes.push({ modeId: 'y', name: 'night' })
    const plan = await lib().plan(p, { allowExtraModes: true })
    expect(plan.problems.join('\n')).toMatch(/> 4/)
    file.col.modes.splice(1)
    await expect(lib().apply(p)).rejects.toThrow(/createModes/)
    expect(versions).toEqual([])
  })

  it('plan() lists the Фронт nodes with no explicit mode', async () => {
    const plan = await lib().plan(payload())
    expect(plan.ok).toBe(true)
    expect(plan.unpinned).toEqual([
      'page "Gold · Приложение" (no explicit mode)',
      '"Gold · Приложение" / "Legacy screen / user.dashboard / Dashboard" (no explicit mode)',
      `page "${KIT}" (no explicit mode)`,
      `"${KIT}" / "Component / Actions" (no explicit mode)`,
    ])
  })

  it('a pin must be the mode the node shows: gold, or its own mode for a Skin / <mode> card', async () => {
    await lib().apply(payload(), { createModes: true })
    pinFront()
    const coreId = file.col.modes.find((m) => m.name === 'core').modeId
    const goodoId = file.col.modes.find((m) => m.name === 'goodo').modeId
    file.screens.children[0].explicitVariableModes = { cv: coreId }
    file.kit.children.push(node('Skin / goodo'))
    file.kit.children[1].explicitVariableModes = { cv: goodoId }
    const plan = await lib().plan(payload())
    expect(plan.unpinned).toEqual([
      '"Gold · Приложение" / "Legacy screen / user.dashboard / Dashboard" (mode core, expected gold)',
    ])
    await expect(lib().apply(payload(), { makeCoreDefault: true })).rejects.toThrow(
      /mode core, expected gold/,
    )
  })

  it('refuses to change the gold mode without the owner-approved flag', async () => {
    const p = payload()
    p.collections[0].values['color/blue-500'].gold = { color: [99, 122, 156, 1] }
    await expect(lib().apply(p, { createModes: true })).rejects.toThrow(
      /1 value\(s\) of the gold mode would change/,
    )
    expect(versions).toEqual([])
    const r = await lib().apply(p, { createModes: true, allowScreensModeChanges: true })
    expect(r.changes.gold).toBe(1)
  })

  it('pin() sets the mode of the payload collection, only inside FRONT.write', async () => {
    const target = file.screens.children[0]
    await expect(lib().pin(payload(), target, 'gold')).rejects.toThrow(/front-lib/)
    /** @type {string[]} */
    const guarded = []
    const m = lib({ c2fNeedGuard: (n) => guarded.push(n.name) })
    expect(await m.pin(payload(), target, 'gold')).toMatchObject({ mode: 'gold' })
    expect(target.explicitVariableModes).toEqual({ cv: '3905:0' })
    expect(guarded).toEqual([target.name])
    await expect(m.pin(payload(), target, 'night')).rejects.toThrow(/no mode night in velo/)
  })

  it('snapshot() is the form the CLI reads, and its digest is the CLI digest', async () => {
    const s = normalizeSnapshot(await lib().snapshot())
    expect(s.collections.map((c) => c.name)).toEqual(['velo', 'legacy'])
    const rows = s.variables
      .filter((v) => v.collectionId === 'cv')
      .map((v) => [v.name, v.valuesByMode['3905:0']])
    expect(modeDigest(rows)).toBe(digests()['velo/gold'])
  })
})
