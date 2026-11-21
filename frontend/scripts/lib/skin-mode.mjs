// =============================================================================
// FE-219 -- the values of a skin MODE for the Figma `velo` collection
// =============================================================================
//
// A skin package (scripts/lib/skin-package.mjs, the same engine the build
// uses) overrides golden tokens with CSS text: `#120054`, `rgba(...)`,
// `color-mix(...)`, `var(--velo-...)` for `{velo.…}` references. A Figma mode
// holds PRIMITIVES (a color, a float, an alias). This module computes, for
// every token the package sets, the golden value, the skin value, and the
// Figma-shaped RESOLVED value -- or the reason it cannot be expressed.
//
// PURE (no fs, no network). The dry-run CLI is sync-figma-variables.mjs.
// =============================================================================
import { parseCssValue, resolveColor } from './figma-token-sync.mjs'

/** @param {{rgb: number[], a: number}} c */
function colorText(c) {
  const hex = `#${c.rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase()
  return c.a === 1 ? hex : `${hex} @ ${Number(c.a.toFixed(3))}`
}

/** Follow a reference chain to its dimension leaf, keeping the unit. */
function resolveDim(parsed, byCssName, seen = new Set()) {
  if (parsed.kind === 'dim') return parsed
  if (parsed.kind !== 'ref' || seen.has(parsed.cssName)) return null
  seen.add(parsed.cssName)
  const target = byCssName.get(parsed.cssName)
  return target ? resolveDim(parseCssValue(target.value), byCssName, seen) : null
}

/**
 * Check the --skin / --mode arguments. A flag without a value must stop the
 * run: silently falling through would take the gold path (and --apply
 * rewrites tokens.json). The gold mode is refused as a target: the gold
 * sync owns the first mode of the collection.
 *
 * @param {string[]} args process arguments
 * @returns {{error: string} | {skinDir: string, modeId: string} | null} null = not a skin run
 */
export function parseSkinArgs(args) {
  const valueOf = (flag) => {
    const i = args.indexOf(flag)
    if (i < 0) return undefined
    const v = args[i + 1]
    return v === undefined || v.startsWith('--') ? null : v
  }
  const skinDir = valueOf('--skin')
  const modeId = valueOf('--mode')
  if (skinDir === undefined && modeId === undefined) return null
  if (skinDir === null) return { error: '--skin needs a package directory' }
  if (modeId === null) return { error: '--mode needs a mode id (e.g. goodo)' }
  if (skinDir === undefined) return { error: '--mode needs --skin <package directory>' }
  if (modeId === undefined) return { error: '--skin needs --mode <id> (e.g. goodo)' }
  if (modeId.toLowerCase() === 'gold') {
    return { error: '--mode gold is refused: gold is the first mode, owned by the gold sync' }
  }
  return { skinDir, modeId }
}

/**
 * Resolve one CSS value, over the effective values of the mode, into
 * something Figma can hold.
 *
 * @param {string} css the token's CSS text
 * @param {Map<string, {value: string}>} byCssName cssName -> {value}, the mode's values
 * @returns {{ok: true, kind: 'color'|'dim', text: string} | {ok: false, reason: string}}
 */
export function resolveForFigma(css, byCssName) {
  const parsed = parseCssValue(css)
  if (parsed.kind === 'raw') {
    return { ok: false, reason: `a verbatim CSS string, not a color or a number: ${parsed.text}` }
  }
  const color = resolveColor(parsed, byCssName)
  if (color) return { ok: true, kind: 'color', text: colorText(color) }
  // A literal and a reference to the same size must print the same text.
  const dim = resolveDim(parsed, byCssName)
  if (dim) return { ok: true, kind: 'dim', text: `${dim.value}${dim.unit}` }
  return { ok: false, reason: 'a reference that does not resolve to a color or a number' }
}

/**
 * The mode report: golden leaves + the package's declarations.
 *
 * @param {Array<{cssName: string, value: string}>} leaves golden token leaves
 * @param {Array<[string, string]>} decls the package's `[cssName, css]` overrides
 * @param {Map<string, string>} [figmaNames] cssName -> Figma variable name, when a snapshot is given
 * @returns {{rows: object[], inexpressible: object[], unknown: string[], derived: object[]}}
 *   rows: every token the package sets (gold, skin, resolved values, whether it
 *   differs); inexpressible: rows Figma cannot hold, with the reason; unknown:
 *   package names the golden registry lacks (the engine refuses these, kept as
 *   a guard).
 */
export function skinModeReport(leaves, decls, figmaNames) {
  const gold = new Map(
    leaves.map((l) => [l.cssName, { value: l.value.trim().replace(/\s+/g, ' ') }]),
  )
  const skin = new Map(gold)
  const unknown = []
  for (const [name, value] of decls) {
    if (!gold.has(name)) unknown.push(name)
    skin.set(name, { value: value.trim().replace(/\s+/g, ' ') })
  }
  const rows = []
  const inexpressible = []
  for (const [name] of decls) {
    const goldEntry = gold.get(name)
    const skinEntry = skin.get(name)
    if (!goldEntry || !skinEntry) continue
    const goldCss = goldEntry.value
    const skinCss = skinEntry.value
    const goldRes = resolveForFigma(goldCss, gold)
    const skinRes = resolveForFigma(skinCss, skin)
    const row = {
      cssName: name,
      figmaName: figmaNames ? (figmaNames.get(name) ?? null) : undefined,
      gold: goldRes.ok ? goldRes.text : goldCss,
      skin: skinRes.ok ? skinRes.text : skinCss,
      goldCss,
      skinCss,
      changed: false,
    }
    row.changed = row.gold !== row.skin
    rows.push(row)
    if (!skinRes.ok) inexpressible.push({ cssName: name, reason: skinRes.reason })
    else if (figmaNames && row.figmaName === null) {
      inexpressible.push({
        cssName: name,
        reason: 'no Figma variable with this name (name rule FE-124)',
      })
    }
  }
  // Tokens the package does NOT set whose value still moves because they
  // reference (or color-mix over) a token it does: a Figma alias follows its
  // base by itself, but a baked value must be written into the mode too.
  const set = new Set(decls.map(([n]) => n))
  const derived = []
  for (const [name, g] of gold) {
    if (set.has(name)) continue
    const before = resolveForFigma(g.value, gold)
    const after = resolveForFigma(g.value, skin)
    if (before.ok && after.ok && before.text !== after.text) {
      derived.push({ cssName: name, css: g.value, gold: before.text, skin: after.text })
    }
  }
  return { rows, inexpressible, unknown, derived }
}

/** Markdown report of a skinModeReport(). */
export function formatSkinModeReport(report, { skinPath, modeId }) {
  const changed = report.rows.filter((r) => r.changed)
  const lines = [
    `## Skin mode \`${modeId}\` -- dry-run (FE-219), nothing written to Figma`,
    '',
    `Package: ${skinPath} · tokens set: ${report.rows.length} · differ from gold: ${changed.length} · moved by reference: ${report.derived.length}`,
    '',
    `| token | Figma name | gold | ${modeId} |`,
    '|---|---|---|---|',
  ]
  for (const r of report.rows) {
    const name = r.figmaName ? `\`${r.figmaName}\`` : r.figmaName === null ? 'none' : 'not checked'
    lines.push(`| \`${r.cssName}\` | ${name} | \`${r.gold}\` | \`${r.skin}\` |`)
  }
  lines.push('', `### Moved by a reference, not set by the package (${report.derived.length})`, '')
  if (report.derived.length === 0) lines.push('None.')
  else {
    lines.push('| token | CSS | gold | ' + modeId + ' |', '|---|---|---|---|')
    for (const d of report.derived) {
      lines.push(`| \`${d.cssName}\` | \`${d.css}\` | \`${d.gold}\` | \`${d.skin}\` |`)
    }
  }
  lines.push('', `### Not expressible in Figma (${report.inexpressible.length})`)
  if (report.inexpressible.length === 0) lines.push('', 'None.')
  for (const i of report.inexpressible) lines.push(`- \`${i.cssName}\`: ${i.reason}`)
  return lines.join('\n')
}
