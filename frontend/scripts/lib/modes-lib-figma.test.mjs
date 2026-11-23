// =============================================================================
// FE-234 item 6 -- the Figma writer of the `velo` modes (docs/figma/front/modes-lib.figma.js)
// against a minimal fake of the plugin variables API (Vitest, the `scripts` project).
// The real file is checked live in Figma; this pins the guards: the core values never land
// in the gold mode, nothing is written before every value is checked and a version is saved.
// =============================================================================
import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { runInNewContext } from 'node:vm'
import { normalizeSnapshot } from './figma-modes.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const LIB = readFileSync(join(root, 'docs/figma/front/modes-lib.figma.js'), 'utf8')

// --- a fake of figma.variables -------------------------------------------------------
let figma
let versions
function fakeFile() {
  let next = 0
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
  const vars = [
    mk('color/blue-500', 'COLOR', 'cv', {
      '3905:0': { r: 98 / 255, g: 122 / 255, b: 156 / 255, a: 1 },
    }),
    mk('color/primary', 'COLOR', 'cv', {
      '3905:0': { type: 'VARIABLE_ALIAS', id: 'id:color/blue-500' },
    }),
    mk('font/body', 'STRING', 'cl', { '3905:1': 'Marmelad' }),
  ]
  versions = []
  figma = {
    fileKey: 'F',
    saveVersionHistoryAsync: (label) => Promise.resolve(versions.push(label)),
    variables: {
      getLocalVariableCollectionsAsync: () => Promise.resolve([col, legacy]),
      getLocalVariablesAsync: () => Promise.resolve(vars),
      createVariableAlias: (v) => ({ type: 'VARIABLE_ALIAS', id: v.id }),
    },
  }
  return { col, vars }
}

function lib() {
  return runInNewContext(`${LIB}\nmakeModes({ thread: 't', task: 'FE-234' })`, {
    figma,
    Map,
    Set,
    JSON,
    Math,
    Error,
    Date,
  })
}

const payload = () => ({
  format: 'velo-figma-modes/1',
  kind: 'payload',
  file: 'F',
  collection: 'velo',
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

describe('modes-lib.figma.js', () => {
  let file
  beforeEach(() => {
    file = fakeFile()
  })

  it('creates core and goodo, writes only what differs, makes the core the default mode', async () => {
    const r = await lib().apply(payload(), { createModes: true, makeCoreDefault: true })
    expect(versions).toHaveLength(1)
    expect(r.created.map((m) => m.name)).toEqual(['core', 'goodo'])
    expect(r.order).toEqual(['core', 'gold', 'goodo'])
    expect(r.defaultMode).toBe('core')
    // gold already holds its values: nothing is written into 3905:0
    expect(r.changes.gold).toBeUndefined()
    const blue = file.vars[0]
    expect(blue.valuesByMode['3905:0'].r).toBeCloseTo(98 / 255)
    const coreId = r.created[0].modeId
    expect(blue.valuesByMode[coreId].r).toBeCloseTo(120 / 255)
    expect(file.vars[2].valuesByMode['3905:1']).toBe('system-ui')
  })

  it('stops before the version when the pinned gold mode was renamed', async () => {
    file.col.modes[0].name = 'core'
    await expect(lib().apply(payload(), { createModes: true })).rejects.toThrow(/named "core"/)
    expect(versions).toEqual([])
    expect(file.vars.every((v) => v.writes === 0)).toBe(true)
  })

  it('stops on a value that does not fit its variable, before any write', async () => {
    const p = /** @type {any} */ (payload())
    p.collections[0].values['color/primary'].goodo = { string: 'none' }
    await expect(lib().apply(p, { createModes: true })).rejects.toThrow(/a string into a COLOR/)
    expect(versions).toEqual([])
    expect(file.col.modes).toHaveLength(1)
  })

  it('stops on an unknown Figma mode, on the plan limit and on missing modes without createModes', async () => {
    file.col.modes.push({ modeId: 'x', name: 'dark' })
    await expect(lib().apply(payload(), { createModes: true })).rejects.toThrow(
      /does not name: dark/,
    )
    file.col.modes.push({ modeId: 'y', name: 'night' })
    const plan = await lib().plan(payload(), { allowExtraModes: true })
    expect(plan.problems.join('\n')).toMatch(/> 4/)
    file.col.modes.splice(1)
    await expect(lib().apply(payload())).rejects.toThrow(/createModes/)
    expect(versions).toEqual([])
  })

  it('snapshot() is the form sync-figma-variables.mjs reads', async () => {
    const s = normalizeSnapshot(await lib().snapshot())
    expect(s.collections.map((c) => c.name)).toEqual(['velo', 'legacy'])
    expect(s.variables[1].valuesByMode['3905:0']).toEqual({
      type: 'VARIABLE_ALIAS',
      id: 'id:color/blue-500',
    })
  })
})
