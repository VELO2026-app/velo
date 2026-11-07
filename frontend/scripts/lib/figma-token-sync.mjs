// =============================================================================
// FE-124 track T, stage 2 -- the Figma <-> registry equivalence engine
// (tz-ui-package.md, track T; consumed by scripts/sync-figma-variables.mjs).
// =============================================================================
//
// tokens.json carries VERBATIM CSS values ($value: `var(--velo-white)`,
// `color-mix(in srgb, var(--velo-blue-500) 6%, transparent)`, `rgba(0, 0, 0,
// 0.5)`, `120ms`, `9px`, verbatim shadow strings) -- the form the generator
// needs to reproduce variables.css byte-for-byte. Figma Variables carry
// PRIMITIVE values instead (the FE-124 import): var() references became
// VARIABLE_ALIAS bindings, colors became {r,g,b,a} floats, durations became
// TIMING seconds, dimensions became unitless FLOATs, and the verbatim
// strings (easings, multi-corner radii, box-shadows) stayed strings.
//
// A value-level copy in EITHER direction is therefore lossy (the hex8
// quantization of a color-mix, the missing px/ms unit on a FLOAT). This
// module does the honest thing instead:
//
//   1. a NAME MAP: registry cssName (`--velo-primary`) <-> Figma variable
//      name (`color/primary`) is derived by DATA, not by a hardcoded
//      taxonomy -- a Figma name matches the cssName without its leading
//      dashes after the last `/` (the FE-124 import rule, verified
//      bijective on the real collections);
//   2. a COMPARABLE model: both sides normalize to
//      {kind: ref | color | dim | raw}; refs resolve through the registry
//      (`var(--velo-blue-500)` -> that leaf's value, cycles guarded) and
//      `color-mix(in srgb, X p%, transparent)` resolves to X at alpha p/100
//      -- so a drift in the BASE token flags every mix built on it;
//   3. a TOLERANT compare: colors compare per channel at +/-1/255 (the
//      float noise of Figma's storage), dims at +/-0.51, raw strings
//      exactly;
//   4. a LOSSLESS APPLY POLICY: only values that reconstruct exactly are
//      rewritten (hex literals, rgba literals -- alpha re-rendered at its
//      shortest in-tolerance decimal, verbatim strings, timing ms); the
//      rest is REPORT-ONLY for the review PR.
//
// PURE (no fs, no network): the unit tests exercise every branch.
// =============================================================================

// --- registry walk -----------------------------------------------------------

/**
 * Collect the token leaves of a DTCG document in a stable order.
 *
 * @param {object} doc the parsed tokens.json
 * @returns {Array<{path: string, cssName: string, value: string, node: object}>}
 *   leaves carrying a pridem cssName (the __media override artifact, which
 *   has no cssName, is skipped -- the generator emits it verbatim from
 *   $extensions).
 */
export function collectLeaves(doc) {
  const out = []
  const walk = (node, path) => {
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith('$')) continue
      const p = path ? `${path}.${key}` : key
      if (!value || typeof value !== 'object') continue
      if ('$value' in value) {
        const cssName = value.$extensions?.pridem?.cssName
        if (typeof cssName === 'string') {
          out.push({ path: p, cssName, value: value.$value, node: value })
        }
      }
      if (Object.keys(value).some((k) => !k.startsWith('$') && value[k] && typeof value[k] === 'object')) {
        walk(value, p)
      }
    }
  }
  walk(doc.root, '')
  return out
}

/** Index the leaves by cssName (the var() chain resolver's lookup). */
export function indexByCssName(leaves) {
  const map = new Map()
  for (const leaf of leaves) map.set(leaf.cssName, leaf)
  return map
}

// --- name map ----------------------------------------------------------------

/**
 * Derive the registry <-> Figma name map from DATA.
 *
 * The FE-124 import named every Figma variable `<group>/<tail>` where tail
 * is the cssName without its leading dashes (`--velo-primary` ->
 * `color/primary`, `--space-1` -> `space/1`); the group taxonomy is Figma's
 * own and is NOT needed here -- matching by the suffix after the last `/`
 * is bijective on the real collections (253 <-> 253).
 *
 * @param {Array<{cssName: string}>} leaves
 * @param {Array<{name: string}>} figmaVariables
 * @returns {{map: Map<string, string>, registryOrphans: string[], figmaOrphans: string[]}}
 *   map: cssName -> Figma variable name; the orphan lists name anything the
 *   suffix rule could not pair (a NEW designer token, a renamed code token)
 *   -- both are drift the sync must surface, never silently drop.
 */
export function buildNameMap(leaves, figmaVariables) {
  const byName = new Map(figmaVariables.map((v) => [v.name, v.name]))
  const byTail = new Map()
  for (const v of figmaVariables) {
    const tail = v.name.slice(v.name.lastIndexOf('/') + 1)
    if (byTail.has(tail)) {
      throw new Error(`name map: Figma suffix collision on "${tail}" (${byTail.get(tail)} vs ${v.name})`)
    }
    byTail.set(tail, v.name)
  }
  const map = new Map()
  const registryOrphans = []
  for (const leaf of leaves) {
    // velo tokens: '--velo-primary' -> 'primary' (the import stripped the
    // velo- prefix; the group taxonomy is Figma's own). Bare frozen family:
    // '--space-1' -> 'space/1', i.e. `<family>/<rest>` -- the family IS the
    // Figma group there, so a bare token needs BOTH halves.
    const tail = leaf.cssName.replace(/^--(velo-)?/, '')
    let figmaName = byTail.get(tail)
    if (figmaName === undefined && !leaf.cssName.startsWith('--velo-')) {
      const bare = leaf.cssName.slice(2)
      const dash = bare.indexOf('-')
      if (dash > 0) figmaName = byName.get(`${bare.slice(0, dash)}/${bare.slice(dash + 1)}`)
    }
    if (figmaName === undefined) {
      registryOrphans.push(leaf.cssName)
      continue
    }
    map.set(leaf.cssName, figmaName)
  }
  const mapped = new Set(map.values())
  const figmaOrphans = figmaVariables.map((v) => v.name).filter((n) => !mapped.has(n))
  return { map, registryOrphans, figmaOrphans }
}

// --- comparable model --------------------------------------------------------

/** Parse a registry css value into the comparable model.
 *  Kinds: ref | color | dim | raw. A color-mix resolves later (it carries a
 *  base that may itself be a ref). */
export function parseCssValue(css) {
  // Verbatim values wrap long forms (color-mix, multi-line shadows) across
  // lines -- the AUTHORING whitespace is not the VALUE. Collapse it here so
  // parsing and raw compares see the semantic text.
  const s = css.trim().replace(/\s+/g, ' ')
  let m
  if ((m = s.match(/^var\((--[A-Za-z0-9-]+)\)$/))) return { kind: 'ref', cssName: m[1] }
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return { kind: 'color', rgb: hexToRgb(s), a: 1 }
  if (/^#[0-9a-fA-F]{8}$/.test(s)) {
    const rgb = hexToRgb(s.slice(0, 7))
    return { kind: 'color', rgb, a: parseInt(s.slice(7, 9), 16) / 255 }
  }
  if ((m = s.match(/^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*([0-9.]+)\s*\)$/))) {
    return { kind: 'color', rgb: [Number(m[1]), Number(m[2]), Number(m[3])], a: Number(m[4]) }
  }
  if (
    (m = s.match(
      /^color-mix\(\s*in srgb,\s*(var\(\s*--[A-Za-z0-9-]+\s*\)|#[0-9a-fA-F]{6})\s+([0-9.]+)%,\s*transparent\s*\)$/,
    ))
  ) {
    const base = m[1].startsWith('var(') ? { kind: 'ref', cssName: m[1].replace(/\s/g, '').slice(4, -1) } : { kind: 'color', rgb: hexToRgb(m[1]), a: 1 }
    return { kind: 'mix', base, percent: Number(m[2]) }
  }
  if ((m = s.match(/^(-?\d*\.?\d+)(ms|px|deg|%)?$/))) {
    return { kind: 'dim', value: Number(m[1]), unit: m[2] ?? '' }
  }
  return { kind: 'raw', text: s }
}

function hexToRgb(hex) {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

/**
 * Resolve a comparable to a final NUMBER when possible (a dimension ref
 * chain: the Figma side models `--velo-screen-padding` as an alias to
 * `space/8`; the registry value is the authored `16px`). Returns the
 * magnitude in the FINAL token's unit or null.
 */
export function resolveMagnitude(comparable, byCssName, seen = new Set()) {
  if (comparable.kind === 'dim') return comparable.value
  if (comparable.kind === 'ref') {
    if (seen.has(comparable.cssName)) return null
    seen.add(comparable.cssName)
    const leaf = byCssName.get(comparable.cssName)
    if (!leaf) return null
    return resolveMagnitude(parseCssValue(leaf.value), byCssName, seen)
  }
  return null
}

/**
 * Resolve a comparable to a final color when possible: refs follow the
 * registry chain (cycles guarded), mixes apply their percent as alpha over
 * the resolved base. Returns {rgb, a} or null for dims/raws.
 */
export function resolveColor(comparable, byCssName, seen = new Set()) {
  if (comparable.kind === 'color') return { rgb: comparable.rgb, a: comparable.a }
  if (comparable.kind === 'ref') {
    const cssName = comparable.cssName
    if (seen.has(cssName)) return null
    seen.add(cssName)
    const leaf = byCssName.get(cssName)
    if (!leaf) return null
    return resolveColor(parseCssValue(leaf.value), byCssName, seen)
  }
  if (comparable.kind === 'mix') {
    const base = resolveColor(comparable.base, byCssName, new Set(seen))
    if (!base) return null
    return { rgb: base.rgb, a: comparable.percent / 100 }
  }
  return null
}

/** Normalize a Figma variable value (one mode) to the comparable model.
 *
 * @param {object} figValue the valuesByMode entry
 * @param {object} figmaById id -> {name}
 * @param {Map<string, string>} nameMap cssName -> Figma name (built first)
 * @param {Map<string, string>} cssNameByFigmaName inverse of nameMap
 */
export function figmaToComparable(figValue, figmaById, nameMap, cssNameByFigmaName) {
  if (figValue === null || figValue === undefined) return { kind: 'raw', text: '' }
  if (figValue.type === 'VARIABLE_ALIAS') {
    const target = figmaById[figValue.id]
    const figmaName = target?.name
    const cssName = figmaName ? cssNameByFigmaName.get(figmaName) : undefined
    if (cssName) return { kind: 'ref', cssName }
    // An alias to a variable OUTSIDE the registry map (a designer's new
    // token): comparable as a raw pointer, never auto-applied.
    return { kind: 'raw', text: `alias:${figValue.id}` }
  }
  if (typeof figValue === 'object' && 'r' in figValue) {
    return {
      kind: 'color',
      rgb: [
        Math.round(figValue.r * 255),
        Math.round(figValue.g * 255),
        Math.round(figValue.b * 255),
      ],
      a: figValue.a ?? 1,
    }
  }
  if (typeof figValue === 'number') {
    // TIMING variables arrive in SECONDS, FLOAT variables are unitless --
    // the caller passes resolvedType so the engine compares magnitudes
    // (the px/ms UNIT is a code-side authoring decision, Figma has none).
    return { kind: 'dim', value: figValue, unit: '' }
  }
  if (typeof figValue === 'string') return { kind: 'raw', text: figValue }
  return { kind: 'raw', text: JSON.stringify(figValue) }
}

/** The resolvedType of a Figma variable turns raw numbers into magnitudes:
 *  TIMING seconds become ms for the compare. */
export function figmaToComparableTyped(figValue, resolvedType, figmaById, nameMap, cssNameByFigmaName) {
  const base = figmaToComparable(figValue, figmaById, nameMap, cssNameByFigmaName)
  if (base.kind === 'dim' && resolvedType === 'TIMING') {
    return { kind: 'dim', value: base.value * 1000, unit: 'ms' }
  }
  return base
}

// --- compare -----------------------------------------------------------------

const BYTE = 1 / 255

/**
 * Compare two comparables. Returns:
 *   {status:'match'}                                  -- equivalent
 *   {status:'drift', figma}                           -- same kind, values differ (auto-appliable for lossless kinds)
 *   {status:'review', reason}                         -- kind mismatch / unresolvable: a human decides
 */
export function compareValues(regComparable, figComparable, byCssName) {
  // A graph-shape change first: the registry references a token where Figma
  // now carries a solid value (or the reverse) -- the alias the designer
  // broke/rewired. Values may still agree; the SHAPE is a review decision.
  // Dimensions are exempt: a Figma FLOAT alias against an authored px value
  // is the NORMAL import shape (screen-padding -> space/8) -- the dim branch
  // below resolves it through the chain.
  if (regComparable.kind !== 'dim' && figComparable.kind !== 'dim') {
    if (regComparable.kind === 'ref' && figComparable.kind !== 'ref') {
      return { status: 'review', reason: 'ref-vs-solid' }
    }
    if (figComparable.kind === 'ref' && regComparable.kind !== 'ref') {
      return { status: 'review', reason: 'solid-vs-ref' }
    }
  }
  const regColor = resolveColor(regComparable, byCssName)
  const figColor = resolveColor(figComparable, byCssName)
  if (regComparable.kind === 'raw' || figComparable.kind === 'raw') {
    if (regComparable.kind === 'raw' && figComparable.kind === 'raw') {
      return regComparable.text === figComparable.text
        ? { status: 'match' }
        : { status: 'drift', figma: figComparable.text }
    }
    return { status: 'review', reason: 'raw-vs-structured' }
  }
  if (regColor && figColor) {
    // The COLOR dimension -- both sides resolve (a ref chain and a mix are
    // equal to the color they render). Channel tolerance: Figma stores
    // floats quantized at 1/255.
    for (let i = 0; i < 3; i++) {
      if (Math.abs(regColor.rgb[i] - figColor.rgb[i]) > 1) {
        return { status: 'drift', figma: figColor }
      }
    }
    if (Math.abs(regColor.a - figColor.a) > BYTE + 0.002) {
      return { status: 'drift', figma: figColor }
    }
    return { status: 'match' }
  }
  if (regComparable.kind === 'dim' || figComparable.kind === 'dim') {
    // Dimensions compare MAGNITUDE; the unit (px/ms/deg) is a code-side
    // authoring decision Figma cannot hold. A dimension alias resolves
    // through the ref chain first.
    const a = regComparable.kind === 'dim' ? regComparable.value : resolveMagnitude(regComparable, byCssName)
    const b = figComparable.kind === 'dim' ? figComparable.value : resolveMagnitude(figComparable, byCssName)
    if (a === null || b === null) return { status: 'review', reason: 'dim-unresolvable' }
    if (Math.abs(a - b) <= Math.max(0.51, Math.abs(a) * 0.001)) return { status: 'match' }
    return { status: 'drift', figma: figComparable }
  }
  if (regComparable.kind === 'ref' && figComparable.kind === 'ref') {
    return regComparable.cssName === figComparable.cssName
      ? { status: 'match' }
      : { status: 'drift', figma: figComparable }
  }
  return { status: 'review', reason: 'kind-mismatch' }
}

// --- apply -------------------------------------------------------------------

/** Shortest decimal alpha within half a byte of the Figma float. */
function alphaToCss(a) {
  for (const decimals of [1, 2, 3, 4]) {
    const candidate = Number(a.toFixed(decimals))
    if (Math.abs(candidate - a) <= BYTE / 2) return String(candidate)
  }
  return String(Number(a.toFixed(6)))
}

/**
 * Reconstruct the registry css string for a Figma value -- ONLY for the
 * lossless classes (see the module header). Returns a string or null when
 * the value must stay report-only.
 *
 * @param {object} regComparable the registry side's parse
 * @param {object} figComparable the figma side's parse
 * @param {number|undefined} resolvedType pass 'TIMING' for durations
 */
export function reconstructCss(regComparable, figComparable, resolvedType) {
  if (figComparable.kind === 'raw') return figComparable.text
  if (figComparable.kind === 'color') {
    const regIsHex = regComparable.kind === 'color' && regComparable.a === 1 && figComparable.a === 1
    if (regIsHex) {
      const [r, g, b] = figComparable.rgb
      return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`
    }
    const regWasRgba = regComparable.kind === 'color'
    if (regWasRgba) {
      const [r, g, b] = figComparable.rgb
      return `rgba(${r}, ${g}, ${b}, ${alphaToCss(figComparable.a)})`
    }
    return null // a mix/ref registry side -- report-only (keeps its form)
  }
  if (figComparable.kind === 'dim' && resolvedType === 'TIMING') {
    const ms = Math.round(figComparable.value)
    return `${ms}ms`
  }
  return null
}
