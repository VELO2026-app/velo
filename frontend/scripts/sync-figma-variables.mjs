// =============================================================================
// FE-124 track T, stage 2 -- the Figma Variables autosync
// (tz-whitelabel.md §3.3, track T: the auto-PR stage of the token track).
// =============================================================================
//
// Figma is where a designer retokens the product; tokens.json is the
// registry the generator builds variables.css from (the FE-124 pipeline).
// This CLI is the bridge stage: it reads the Figma variable collections
// (velo/legacy of the token file), pairs them with the registry by the
// FE-124 name rule, compares by VALUE (not by string -- see
// lib/figma-token-sync.mjs), and produces:
//
//   - a drift REPORT (markdown, ready for the auto-PR body): every token
//     where Figma and the registry disagree, plus BOTH orphan lists (a new
//     designer token, a renamed code token);
//   - with --apply: the LOSSLESS updates written into tokens.json ($value
//     only -- the pridem formatting extensions stay untouched) and
//     variables.css regenerated from the updated registry; everything
//     lossy (a broken alias, a unit-less dimension rewrite, a mix with a
//     moved base) stays report-only for the human review the plan
//     requires (token diffs review like code).
//
// INPUT MODES
//   --snapshot <file>  a JSON dump of the Figma variables (the shape the
//                      Desktop Bridge / figma_get_variables returns: at
//                      least {variables:[{id,name,resolvedType,valuesByMode}]})
//   --rest             the published-variables REST API
//                      (GET /v1/files/{fileKey}/variables; env FIGMA_TOKEN,
//                      --file-key, default IV92js0q2cBHmHmDxB0zxM). The
//                      Local Variables endpoint is Enterprise-locked; the
//                      file's library must be published. CI runs this mode
//                      (.github/workflows/token-sync.yml).
//
// Exit codes: 0 up-to-date/clean · 1 error · 2 drift found (dry-run) --
// the CI autosync turns 2 into the auto-PR; a human reviews it as code.
//
// Run from frontend/:  node scripts/sync-figma-variables.mjs --snapshot dump.json
// =============================================================================
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import process from 'node:process'
import {
  collectLeaves,
  indexByCssName,
  buildNameMap,
  parseCssValue,
  figmaToComparableTyped,
  compareValues,
  reconstructCss,
} from './lib/figma-token-sync.mjs'
import { generateVariables } from './generate-variables.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const tokensPath = join(here, '..', 'tokens.json')
const cssPath = join(here, '..', 'src', 'styles', 'variables.css')
const DEFAULT_FILE_KEY = 'IV92js0q2cBHmHmDxB0zxM' // the token file

// --- args --------------------------------------------------------------------
const args = process.argv.slice(2)
function argValue(flag) {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}
const snapshotPath = argValue('--snapshot')
const useRest = args.includes('--rest')
const apply = args.includes('--apply')
const reportPath = argValue('--report')
const fileKey = argValue('--file-key') ?? DEFAULT_FILE_KEY

// --- input -------------------------------------------------------------------
async function loadFigmaVariables() {
  if (snapshotPath) {
    const raw = JSON.parse(readFileSync(snapshotPath, 'utf8')).variables
    // Two snapshot shapes: the bridge's own ({id,name,resolvedType,
    // valuesByMode}) and the compact execute dump ({n, t, c:[rgba]|a:name|v})
    // -- the latter is what `--bridge-hint` below documents; normalize both.
    if (raw.length > 0 && raw[0].n !== undefined) {
      return raw.map((entry) => {
        let value
        if (entry.c) {
          const [r, g, b, a] = entry.c
          value = { r: r / 255, g: g / 255, b: b / 255, a }
        } else if (entry.a) {
          value = { type: 'VARIABLE_ALIAS', id: `name:${entry.a}` }
        } else {
          value = entry.v
        }
        return { id: `name:${entry.n}`, name: entry.n, resolvedType: entry.t, valuesByMode: { m: value } }
      })
    }
    return raw
  }
  if (useRest) {
    const token = process.env.FIGMA_TOKEN
    if (!token) {
      throw new Error('--rest needs FIGMA_TOKEN in the environment (the published-variables REST API)')
    }
    const res = await fetch(`https://api.figma.com/v1/files/${fileKey}/variables`, {
      headers: { 'X-Figma-Token': token },
    })
    if (!res.ok) {
      throw new Error(`Figma REST ${res.status}: ${await res.text()}`)
    }
    const json = await res.json()
    if (json.error) throw new Error(`Figma REST: ${JSON.stringify(json.error)}`)
    // Published variables arrive as {variables:[{id,name,resolvedType,
    // valuesByMode}]}, the same shape the bridge snapshot carries.
    return json.variables
  }
  throw new Error('pass --snapshot <file> or --rest')
}

// --- main --------------------------------------------------------------------
const doc = JSON.parse(readFileSync(tokensPath, 'utf8'))
const leaves = collectLeaves(doc)
const byCssName = indexByCssName(leaves)
const figmaVariables = await loadFigmaVariables()

const figmaById = Object.fromEntries(figmaVariables.map((v) => [v.id, v]))
const figmaByName = Object.fromEntries(figmaVariables.map((v) => [v.name, v]))
// The compact dump's aliases point at NAMES: give them a resolvable id view.
for (const v of figmaVariables) {
  figmaById[`name:${v.name}`] = v
}
const { map, registryOrphans, figmaOrphans } = buildNameMap(leaves, figmaVariables)
const cssNameByFigmaName = new Map([...map].map(([k, v]) => [v, k]))

const updates = [] // {leaf, newValue}
const drift = [] // {cssName, registry, figma, note}
const review = [] // {cssName, reason}

for (const leaf of leaves) {
  const figmaName = map.get(leaf.cssName)
  if (!figmaName) continue // a registry orphan -- reported below
  const figVar = figmaByName[figmaName]
  if (!figVar) {
    review.push({ cssName: leaf.cssName, reason: 'figma variable missing at sync time' })
    continue
  }
  const modeId = Object.keys(figVar.valuesByMode)[0]
  const regComparable = parseCssValue(leaf.value)
  const figComparable = figmaToComparableTyped(
    figVar.valuesByMode[modeId],
    figVar.resolvedType,
    figmaById,
    map,
    cssNameByFigmaName,
  )
  const verdict = compareValues(regComparable, figComparable, byCssName)
  if (verdict.status === 'match') continue
  if (verdict.status === 'review') {
    review.push({ cssName: leaf.cssName, reason: verdict.reason })
    continue
  }
  const newValue = reconstructCss(regComparable, figComparable, figVar.resolvedType)
  const shownFig =
    figComparable.kind === 'color'
      ? `rgba(${figComparable.rgb.join(', ')}, ${figComparable.a.toFixed(3)})`
      : figComparable.kind === 'dim'
        ? `${figComparable.value}${figComparable.unit}`
        : figComparable.kind === 'ref'
          ? figComparable.cssName
          : `"${figComparable.text}"`
  drift.push({ cssName: leaf.cssName, registry: leaf.value.trim(), figma: shownFig })
  if (newValue !== null && apply) {
    updates.push({ leaf, newValue })
  }
}

// --- apply -------------------------------------------------------------------
if (apply && updates.length > 0) {
  for (const { leaf, newValue } of updates) {
    // The registry value keeps its authored leading space ("  --name: VALUE;")
    // -- the generator's verbatim emit depends on it.
    leaf.node.$value = newValue.startsWith(' ') ? newValue : ` ${newValue}`
  }
  // indent=2 + trailing newline: byte-identical with the committed file's
  // serialization (verified against the FE-124 extractor's output).
  writeFileSync(tokensPath, `${JSON.stringify(doc, null, 2)}\n`)
  writeFileSync(cssPath, generateVariables(doc))
}

// --- report ------------------------------------------------------------------
const lines = []
lines.push('## Figma Variables drift report (track T stage 2)')
lines.push('')
lines.push(`Registry: ${leaves.length} tokens · Figma: ${figmaVariables.length} variables · mapped: ${map.size}`)
if (registryOrphans.length > 0) {
  lines.push('')
  lines.push(`### Registry tokens with NO Figma pair (${registryOrphans.length}) -- a Figma import is missing them`)
  for (const n of registryOrphans) lines.push(`- \`${n}\``)
}
if (figmaOrphans.length > 0) {
  lines.push('')
  lines.push(`### Figma variables with NO registry pair (${figmaOrphans.length}) -- new designer tokens, code has no owner yet`)
  for (const n of figmaOrphans) lines.push(`- \`${n}\``)
}
if (drift.length > 0) {
  lines.push('')
  lines.push(`### Value drift (${drift.length}) -- Figma is the designer's word, the registry the code's`)
  lines.push('')
  lines.push('| token | registry | Figma | applied |')
  lines.push('|---|---|---|---|')
  for (const d of drift) {
    const applied = apply && updates.some((u) => u.leaf.cssName === d.cssName) ? '✅' : ''
    lines.push(`| \`${d.cssName}\` | \`${d.registry}\` | \`${d.figma}\` | ${applied} |`)
  }
}
if (review.length > 0) {
  lines.push('')
  lines.push(`### Needs a human decision (${review.length})`)
  for (const r of review) lines.push(`- \`${r.cssName}\`: ${r.reason}`)
}
if (drift.length === 0 && review.length === 0 && registryOrphans.length === 0 && figmaOrphans.length === 0) {
  lines.push('')
  lines.push('**In sync.** No drift, no orphans.')
}
const report = lines.join('\n')

if (reportPath) writeFileSync(reportPath, `${report}\n`)

if (reportPath === undefined) console.log(report)
else console.log(`report: ${reportPath}`)

if (apply && updates.length > 0) {
  console.log(`applied: ${updates.length} lossless value update(s) into tokens.json + regenerated variables.css`)
}

// The exit code IS the automation contract: 2 = a PR is needed.
const drifted = drift.length > 0 || review.length > 0 || registryOrphans.length > 0 || figmaOrphans.length > 0
process.exit(drifted ? 2 : 0)
