// =============================================================================
// FE-234 item 6 -- the modes of the Figma `velo` collection: core, gold, goodo
// =============================================================================
//
// The owner's decision of 23.11.2026: the first mode of the `velo` collection
// is the CORE -- the neutral values of frontend/tokens.json. Every other mode
// is a SKIN -- tokens.json plus the overrides of a skin package pinned by tag
// and commit (frontend/design/figma-modes.json). Nobody edits a mode by hand.
//
// This module is the pure part:
//   - parseModesConfig: validate figma-modes.json (the first mode is the core,
//     a skin mode names a pinned package, at most MAX_MODES modes);
//   - normalizeSnapshot: a Figma variables dump (docs/figma/front/modes-lib
//     .figma.js snapshot(), the bridge shape with collections, the REST
//     shape) into one form, with mode NAMES -- a mode is found by its name,
//     never by its position;
//   - modeRegistry: the token leaves of a skin mode (core + package decls);
//   - figmaValueFor: one CSS value as the primitive a Figma variable of a
//     given type holds (alias / color / float / string);
//   - buildModeValues: the payload modes-lib.figma.js writes into Figma;
//   - modeDrift: per mode, what Figma holds that the code does not.
//
// PURE (no fs, no network). The CLI is scripts/sync-figma-variables.mjs.
// =============================================================================
import {
  buildNameMap,
  compareValues,
  figmaToComparableTyped,
  parseCssValue,
  resolveColor,
  resolveMagnitude,
} from './figma-token-sync.mjs'

/** Format tag of a snapshot and of a payload (modes-lib.figma.js checks it). */
export const MODES_FORMAT = 'velo-figma-modes/1'
/** Figma Professional: at most 4 modes per collection. */
export const MAX_MODES = 4
/** The source word of the core mode in figma-modes.json. */
export const CORE_SOURCE = 'tokens.json'

const NAME_RE = /^[a-z][a-z0-9-]*$/

/**
 * Validate figma-modes.json. Throws on the first defect: a wrong config
 * must stop the run, never write the core into a skin mode.
 *
 * @param {any} cfg the parsed JSON
 * @returns {{file: string, collection: string, coreOnly: string[], screensMode: string,
 *   modes: Array<{name: string, figmaModeId?: string,
 *     package?: {name: string, repo: string, tag: string, sha: string, dir: string}}>}}
 */
export function parseModesConfig(cfg) {
  const fail = (m) => {
    throw new Error(`figma-modes.json: ${m}`)
  }
  if (!cfg || typeof cfg !== 'object') fail('not an object')
  if (typeof cfg.file !== 'string' || !cfg.file) fail('no file key')
  if (typeof cfg.collection !== 'string' || !cfg.collection) fail('no collection')
  const modes = cfg.modes
  if (!Array.isArray(modes) || modes.length === 0) fail('no modes')
  if (modes.length > MAX_MODES) fail(`${modes.length} modes, the plan allows ${MAX_MODES}`)
  const seen = new Set()
  modes.forEach((m, i) => {
    if (!m || !NAME_RE.test(m.name ?? '')) fail(`mode ${i}: bad name "${m?.name}"`)
    if (seen.has(m.name)) fail(`mode "${m.name}" is listed twice`)
    seen.add(m.name)
    if (i === 0) {
      if (m.source !== CORE_SOURCE || m.package)
        fail(`the first mode is the core: source "${CORE_SOURCE}" and no package`)
      return
    }
    if (m.source !== undefined) fail(`mode "${m.name}": only the first mode reads tokens.json`)
    const p = m.package
    if (!p) fail(`mode "${m.name}": a skin mode needs a package`)
    if (!NAME_RE.test(p.name ?? '')) fail(`mode "${m.name}": bad package name "${p.name}"`)
    if (!/^[\w.-]+\/[\w.-]+$/.test(p.repo ?? '')) fail(`mode "${m.name}": bad repo "${p.repo}"`)
    if (!/^v\d+\.\d+\.\d+$/.test(p.tag ?? '')) fail(`mode "${m.name}": bad tag "${p.tag}"`)
    if (!/^[0-9a-f]{40}$/.test(p.sha ?? '')) fail(`mode "${m.name}": bad sha "${p.sha}"`)
    if (!/^[\w.-]+$/.test(p.dir ?? '')) fail(`mode "${m.name}": bad dir "${p.dir}"`)
  })
  const ids = modes.filter((m) => m.figmaModeId !== undefined).map((m) => m.figmaModeId)
  if (ids.some((id) => typeof id !== 'string' || !id)) fail('a figmaModeId must be a string')
  if (new Set(ids).size !== ids.length) fail('two modes pin the same figmaModeId')
  const screensMode = cfg.screensMode ?? modes[0].name
  if (!seen.has(screensMode)) fail(`screensMode "${screensMode}" is not a mode`)
  const coreOnly = cfg.coreOnlyCollections ?? []
  if (!Array.isArray(coreOnly) || coreOnly.includes(cfg.collection))
    fail('coreOnlyCollections: a list without the moded collection')
  return { file: cfg.file, collection: cfg.collection, coreOnly, screensMode, modes }
}

/**
 * The pins of figma-modes.json against another pin file of the same
 * packages (.github/brand-skins.json: {brands: {<name>: {repo, tag, sha}}}).
 * Two pins of one package must agree, or Figma and CI show different skins.
 *
 * @returns {string[]} the disagreements, empty when they agree
 */
export function crossCheckPins(modes, brandSkins) {
  const out = []
  for (const m of modes) {
    const p = m.package
    const other = p && brandSkins?.brands?.[p.name]
    if (!other) continue
    for (const key of ['repo', 'tag', 'sha']) {
      if (other[key] !== p[key])
        out.push(
          `${p.name}: ${key} is ${p[key]} in figma-modes.json, ${other[key]} in brand-skins.json`,
        )
    }
  }
  return out
}

/**
 * One form for every dump of the Figma variables, with mode names.
 * Accepted: the modes-lib snapshot ({format, collections, variables}), the
 * bridge shape with `variableCollections`, the REST shape ({meta}). A dump
 * without mode names (the old compact `{n, t, c|a|v}` form) is refused: the
 * modes would have to be guessed by position.
 *
 * @returns {{collections: Array<{id: string, name: string, modes: Array<{modeId: string, name: string}>, defaultModeId?: string}>,
 *   variables: Array<{id: string, name: string, collectionId: string, resolvedType: string, valuesByMode: Record<string, any>}>}}
 */
export function normalizeSnapshot(json) {
  const src = json?.meta ?? json
  const asList = (x) => (Array.isArray(x) ? x : x && typeof x === 'object' ? Object.values(x) : [])
  const collections = asList(src?.collections ?? src?.variableCollections)
  const variables = asList(src?.variables)
  if (variables.length > 0 && variables[0].n !== undefined) {
    throw new Error(
      'snapshot: the compact dump has no mode names -- dump with snapshot() of docs/figma/front/modes-lib.figma.js',
    )
  }
  if (collections.length === 0 || !collections.every((c) => Array.isArray(c.modes))) {
    throw new Error(
      'snapshot: no collections with modes -- dump with snapshot() of docs/figma/front/modes-lib.figma.js',
    )
  }
  return {
    collections: collections.map((c) => ({
      id: c.id,
      name: c.name,
      modes: c.modes.map((m) => ({ modeId: m.modeId, name: m.name })),
      defaultModeId: c.defaultModeId,
    })),
    variables: variables.map((v) => ({
      id: v.id,
      name: v.name,
      collectionId: v.collectionId ?? v.variableCollectionId,
      resolvedType: v.resolvedType,
      valuesByMode: v.valuesByMode ?? {},
    })),
  }
}

/**
 * The token leaves of a skin mode: the core leaves with the package's
 * declarations in place of their values.
 *
 * @param {Array<{cssName: string, value: string}>} leaves core leaves
 * @param {Array<[string, string]>} decls the package's `[cssName, css]`
 * @returns {Array<{cssName: string, value: string, overridden: boolean}>}
 */
export function modeRegistry(leaves, decls) {
  const set = new Map(decls)
  return leaves.map((l) => ({
    cssName: l.cssName,
    value: set.has(l.cssName) ? /** @type {string} */ (set.get(l.cssName)) : l.value,
    overridden: set.has(l.cssName),
  }))
}

const collapse = (css) => css.trim().replace(/\s+/g, ' ')

/**
 * One CSS value as the primitive a Figma variable of `resolvedType` holds.
 * A reference to a token that has a Figma variable stays an ALIAS (Figma
 * resolves it in the same mode); everything else is baked: a color-mix
 * becomes its color, a duration becomes seconds, a verbatim string stays the
 * CSS text (whitespace collapsed).
 *
 * @param {string} css the token's value in this mode
 * @param {string} resolvedType COLOR | FLOAT | TIMING | STRING
 * @param {Map<string, {value: string}>} byCssName the mode's leaves
 * @param {Map<string, string>} nameMap cssName -> Figma variable name
 * @returns {{ok: true, value: {alias: string} | {color: number[]} | {float: number} | {string: string}}
 *   | {ok: false, reason: string}}
 */
export function figmaValueFor(css, resolvedType, byCssName, nameMap) {
  const parsed = parseCssValue(css)
  if (parsed.kind === 'ref' && nameMap.has(parsed.cssName)) {
    return { ok: true, value: { alias: /** @type {string} */ (nameMap.get(parsed.cssName)) } }
  }
  if (resolvedType === 'COLOR') {
    const c = resolveColor(parsed, byCssName)
    if (!c) return { ok: false, reason: `not a color: ${collapse(css)}` }
    return { ok: true, value: { color: [...c.rgb, Number(c.a.toFixed(4))] } }
  }
  if (resolvedType === 'FLOAT' || resolvedType === 'TIMING') {
    const seconds = collapse(css).match(/^(\d*\.?\d+)s$/)
    if (resolvedType === 'TIMING' && seconds)
      return { ok: true, value: { float: Number(seconds[1]) } }
    const n = resolveMagnitude(parsed, byCssName)
    if (n === null) return { ok: false, reason: `not a number: ${collapse(css)}` }
    return { ok: true, value: { float: resolvedType === 'TIMING' ? n / 1000 : n } }
  }
  if (resolvedType === 'STRING') {
    if (parsed.kind === 'ref') {
      const target = byCssName.get(parsed.cssName)
      if (!target)
        return { ok: false, reason: `a reference that does not resolve: ${collapse(css)}` }
      return figmaValueFor(target.value, resolvedType, byCssName, nameMap)
    }
    return { ok: true, value: { string: collapse(css) } }
  }
  return { ok: false, reason: `a ${resolvedType} variable cannot hold a token value` }
}

/** Index a collection's variables by name; the mode name -> id map. */
function collectionView(snapshot, name) {
  const col = snapshot.collections.find((c) => c.name === name)
  if (!col) return null
  return {
    col,
    vars: snapshot.variables.filter((v) => v.collectionId === col.id),
    modeId: new Map(col.modes.map((m) => [m.name, m.modeId])),
  }
}

/**
 * The values every mode must hold, in the payload form modes-lib.figma.js
 * writes. The moded collection gets one value per configured mode; a
 * core-only collection (`legacy`, one mode) gets the core value, and a skin
 * that overrides one of its tokens is reported: that collection cannot hold it.
 *
 * @param {{config: ReturnType<typeof parseModesConfig>, modes: Array<{name: string, leaves: Array<{cssName: string, value: string, overridden?: boolean}>}>,
 *   snapshot: ReturnType<typeof normalizeSnapshot>, source?: object}} input
 *   modes: the configured modes in config order, the first is the core
 */
export function buildModeValues({ config, modes, snapshot, source = {} }) {
  const names = [config.collection, ...config.coreOnly]
  const views = names.map((n) => collectionView(snapshot, n))
  const missing = names.filter((_, i) => !views[i])
  if (missing.length > 0) throw new Error(`snapshot: no collection ${missing.join(', ')}`)
  const allVars = views.flatMap((v) => /** @type {any} */ (v).vars)
  const core = modes[0]
  const { map, registryOrphans, figmaOrphans } = buildNameMap(core.leaves, allVars)
  const cssByFigma = new Map([...map].map(([css, fig]) => [fig, css]))
  const problems = []
  const collections = views.map((view, i) => {
    const v = /** @type {any} */ (view)
    const moded = i === 0
    const values = {}
    for (const variable of v.vars) {
      const cssName = cssByFigma.get(variable.name)
      if (!cssName) continue // a Figma orphan: reported, never written
      const entry = {}
      for (const mode of moded ? modes : [core]) {
        const byCssName = new Map(mode.leaves.map((l) => [l.cssName, l]))
        const leaf = /** @type {{value: string}} */ (byCssName.get(cssName))
        const r = figmaValueFor(leaf.value, variable.resolvedType, byCssName, map)
        if (r.ok) entry[mode.name] = r.value
        else problems.push({ mode: mode.name, cssName, figmaName: variable.name, reason: r.reason })
      }
      if (!moded) {
        for (const mode of modes.slice(1)) {
          const leaf = mode.leaves.find((l) => l.cssName === cssName)
          if (leaf?.overridden) {
            problems.push({
              mode: mode.name,
              cssName,
              figmaName: variable.name,
              reason: `collection ${v.col.name} has one mode: the ${mode.name} value ${collapse(leaf.value)} is not stored`,
            })
          }
        }
      }
      values[variable.name] = entry
    }
    return moded ? { name: v.col.name, values } : { name: v.col.name, coreOnly: true, values }
  })
  return {
    payload: {
      format: MODES_FORMAT,
      kind: 'payload',
      file: config.file,
      collection: config.collection,
      screensMode: config.screensMode,
      modes: config.modes.map((m) =>
        m.figmaModeId ? { name: m.name, figmaModeId: m.figmaModeId } : { name: m.name },
      ),
      source,
      collections,
    },
    problems,
    registryOrphans,
    figmaOrphans,
  }
}

/** Short text of a comparable for a report. */
function shown(c) {
  if (c.kind === 'color') return `rgba(${(c.rgb ?? []).join(', ')}, ${c.a.toFixed(3)})`
  if (c.kind === 'dim') return `${c.value}${c.unit}`
  if (c.kind === 'ref') return c.cssName
  return `"${c.text}"`
}

/**
 * Per mode, what Figma holds that the code does not. A configured mode the
 * collection lacks is `missing`; a Figma mode the config does not know is
 * listed in `unknownModes`. A core-only collection is compared with the core.
 *
 * @returns {{modes: Array<{name: string, collection: string, missing: boolean,
 *   drift: Array<{cssName: string, registry: string, figma: string, figComparable: object, regComparable: object, resolvedType: string}>,
 *   review: Array<{cssName: string, reason: string}>}>,
 *   unknownModes: string[], registryOrphans: string[], figmaOrphans: string[]}}
 */
export function modeDrift({ config, modes, snapshot }) {
  const names = [config.collection, ...config.coreOnly]
  const views = names.map((n) => collectionView(snapshot, n))
  const missing = names.filter((_, i) => !views[i])
  if (missing.length > 0) throw new Error(`snapshot: no collection ${missing.join(', ')}`)
  const allVars = views.flatMap((v) => /** @type {any} */ (v).vars)
  const core = modes[0]
  const { map, registryOrphans, figmaOrphans } = buildNameMap(core.leaves, allVars)
  const cssByFigma = new Map([...map].map(([css, fig]) => [fig, css]))
  // Aliases point at variable ids; the compact `name:` ids of older dumps too.
  const figmaById = {}
  for (const v of allVars) {
    figmaById[v.id] = v
    figmaById[`name:${v.name}`] = v
  }
  const out = []
  views.forEach((view, i) => {
    const v = /** @type {any} */ (view)
    const moded = i === 0
    const targets = moded
      ? modes.map((m) => ({ mode: m, modeName: m.name }))
      : [{ mode: core, modeName: v.col.modes[0]?.name }]
    for (const { mode, modeName } of targets) {
      const modeId = v.modeId.get(modeName)
      /** @type {{name: string, collection: string, missing: boolean, drift: any[], review: any[]}} */
      const row = {
        name: mode.name,
        collection: v.col.name,
        missing: !modeId,
        drift: [],
        review: [],
      }
      out.push(row)
      if (!modeId) continue
      const byCssName = new Map(mode.leaves.map((l) => [l.cssName, l]))
      for (const variable of v.vars) {
        const cssName = cssByFigma.get(variable.name)
        if (!cssName) continue
        const leaf = /** @type {any} */ (byCssName.get(cssName))
        const regComparable = parseCssValue(leaf.value)
        const figComparable = figmaToComparableTyped(
          variable.valuesByMode[modeId],
          variable.resolvedType,
          figmaById,
          map,
          cssByFigma,
        )
        const verdict = compareValues(regComparable, figComparable, byCssName)
        if (verdict.status === 'match') continue
        if (verdict.status === 'review') {
          row.review.push({ cssName, reason: verdict.reason })
          continue
        }
        row.drift.push({
          cssName,
          registry: collapse(leaf.value),
          figma: shown(figComparable),
          figComparable,
          regComparable,
          resolvedType: variable.resolvedType,
        })
      }
    }
  })
  const moded = /** @type {any} */ (views[0])
  const known = new Set(config.modes.map((m) => m.name))
  const unknownModes = moded.col.modes.map((m) => m.name).filter((n) => !known.has(n))
  return { modes: out, unknownModes, registryOrphans, figmaOrphans }
}
