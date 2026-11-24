// =============================================================================
// The Figma Variables sync: the modes of the `velo` collection from the code
// (FE-124 track T; three modes since FE-234 item 6).
// =============================================================================
//
// Direction (owner's decision 2026-11-09, tz-whitelabel.md §3.3): the code is
// the source of truth, Figma is a mirror updated FROM it.
//
// Modes (owner's decision 23.11.2026, frontend/design/figma-modes.json):
// `core` first -- the neutral tokens.json; then one mode per skin --
// tokens.json plus the overrides of its brand's package, pinned (tag and
// commit) in .github/brand-skins.json. A mode is found by its NAME, never by
// its position. Names pair by the FE-124 rule, values compare by VALUE
// (lib/figma-token-sync.mjs, lib/figma-modes.mjs).
//
// INPUT
//   --snapshot <file>  a dump WITH mode names: snapshot() of
//                      docs/figma/front/modes-lib.figma.js (also the bridge
//                      shape with variableCollections, the REST shape). The
//                      old compact single-mode dump is refused.
//   --rest             the Variables REST API (GET /v1/files/{key}/variables/local;
//                      env FIGMA_TOKEN; Enterprise-locked, dormant).
//   Packages           cloned at the pinned tag, the commit checked; a private
//                      repo reads git credentials or BRAND_REPO_TOKEN (sent as
//                      a header, never in the URL). --pkg <mode>=<checkout>: a
//                      local checkout at the pinned commit with a clean tree.
//                      --only <mode,...> limits the drift report.
//
// COMMANDS
//   --snapshot|--rest   drift report for EVERY mode (core vs tokens.json, a
//                       skin mode vs tokens.json + package); a configured mode
//                       Figma lacks and a Figma mode the config lacks are drift.
//     --apply           the dormant Figma -> code direction: lossless updates of
//                       the CORE mode only into tokens.json (+ variables.css).
//   --skin --snapshot <file> --payload <out.json>
//                       the values of every mode for modes-lib.figma.js apply(),
//                       with a digest of every existing mode (apply stops when
//                       Figma changed since the snapshot); the report lists what
//                       changes and what Figma cannot hold.
//   --skin <dir> --mode <id> --dry-run
//                       (FE-219) one local package against the core, a report
//                       only -- for a package not tagged yet.
//
// Exit codes: 0 clean · 1 error · 2 drift found -- the dormant CI autosync
// (token-sync.yml) turns 2 into an auto-PR; a human reviews it as code.
//
// Run from frontend/:  node scripts/sync-figma-variables.mjs --snapshot dump.json
// =============================================================================
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, dirname, resolve } from 'node:path'
import process from 'node:process'
import { collectLeaves, buildNameMap, reconstructCss } from './lib/figma-token-sync.mjs'
import { generateVariables } from './generate-variables.mjs'
import { loadSkinPackage } from './lib/skin-package.mjs'
import { checkoutProblem, fetchPackage } from './lib/brand-packages.mjs'
import { skinModeReport, formatSkinModeReport, parseSkinArgs } from './lib/skin-mode.mjs'
import {
  buildModeValues,
  modeDrift,
  modeRegistry,
  normalizeSnapshot,
  parseModesConfig,
} from './lib/figma-modes.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const frontendDir = join(here, '..')
const repoRoot = join(frontendDir, '..')
const tokensPath = join(frontendDir, 'tokens.json')
const cssPath = join(frontendDir, 'src', 'styles', 'variables.css')
const modesPath = join(frontendDir, 'design', 'figma-modes.json')
const brandSkinsPath = join(repoRoot, '.github', 'brand-skins.json')

// --- args --------------------------------------------------------------------
const args = process.argv.slice(2)
function argValue(flag) {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}
function argValues(flag) {
  return args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]] : []))
}
/**
 * @param {string} message
 * @returns {never}
 */
function die(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}
const snapshotPath = argValue('--snapshot')
const useRest = args.includes('--rest')
const apply = args.includes('--apply')
const reportPath = argValue('--report')
const payloadPath = argValue('--payload')
const dryRun = args.includes('--dry-run')
const skinArgs = parseSkinArgs(args)
if (skinArgs && 'error' in skinArgs) die(skinArgs.error)

const config = (() => {
  try {
    return parseModesConfig(
      JSON.parse(readFileSync(modesPath, 'utf8')),
      JSON.parse(readFileSync(brandSkinsPath, 'utf8')),
    )
  } catch (e) {
    return die(e instanceof Error ? e.message : String(e))
  }
})()
const fileKey = argValue('--file-key') ?? config.file
const only = argValue('--only')?.split(',').filter(Boolean)
if (only && only.some((n) => !config.modes.some((m) => m.name === n))) {
  die(`--only ${only.join(',')}: the modes are ${config.modes.map((m) => m.name).join(', ')}`)
}
const pkgDirs = new Map()
for (const spec of argValues('--pkg')) {
  const eq = spec.indexOf('=')
  if (eq <= 0) die(`--pkg ${spec}: use <mode>=<package dir>`)
  pkgDirs.set(spec.slice(0, eq), resolve(spec.slice(eq + 1)))
}

function output(text) {
  if (reportPath) {
    writeFileSync(reportPath, `${text}\n`)
    console.log(`report: ${reportPath}`)
  } else {
    console.log(text)
  }
}

// --- input -------------------------------------------------------------------
async function loadSnapshot() {
  if (snapshotPath) return normalizeSnapshot(JSON.parse(readFileSync(snapshotPath, 'utf8')))
  if (useRest) {
    const token = process.env.FIGMA_TOKEN
    if (!token) throw new Error('--rest needs FIGMA_TOKEN in the environment')
    const res = await fetch(`https://api.figma.com/v1/files/${fileKey}/variables/local`, {
      headers: { 'X-Figma-Token': token },
    })
    if (!res.ok) throw new Error(`Figma REST ${res.status}: ${await res.text()}`)
    /** @type {any} */
    const json = await res.json()
    if (json.error) throw new Error(`Figma REST: ${JSON.stringify(json.error)}`)
    return normalizeSnapshot(json)
  }
  throw new Error('pass --snapshot <file> or --rest')
}

// --- packages ----------------------------------------------------------------
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim()

/**
 * core + one entry per skin mode: {name, leaves, source}. A package comes
 * from a local checkout (--pkg: the pinned commit, a clean tree) or a fresh
 * clone at the pinned tag. Throws; the clones are removed on every exit path.
 */
function loadModes(doc, leaves) {
  const wanted = config.modes.filter((m, i) => i === 0 || !only || only.includes(m.name))
  const scratch = mkdtempSync(join(tmpdir(), 'figma-modes-'))
  try {
    return wanted.map((m, i) => {
      if (i === 0) return { name: m.name, leaves, source: 'frontend/tokens.json' }
      const p = /** @type {NonNullable<typeof m.package>} */ (m.package)
      const local = pkgDirs.get(m.name)
      let root = local
      if (local) {
        const problem = checkoutProblem(local, p.sha)
        if (problem) throw new Error(`--pkg ${m.name}: ${problem} (${p.tag})`)
      } else {
        root = join(scratch, m.name)
        fetchPackage(p, root, { token: process.env.BRAND_REPO_TOKEN ?? '' })
      }
      const pkg = loadSkinPackage(join(/** @type {string} */ (root), p.dir), doc)
      if (pkg.problems.length > 0) {
        throw new Error(
          `${p.name} ${p.tag} is not a valid skin package:\n  ${pkg.problems.join('\n  ')}`,
        )
      }
      return {
        name: m.name,
        leaves: modeRegistry(leaves, pkg.decls),
        source: `${p.repo} ${p.tag} ${p.sha.slice(0, 8)}`,
      }
    })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

// --- one local package, report only (FE-219) -----------------------------------
if (skinArgs && 'skinDir' in skinArgs) {
  const { skinDir, modeId } = skinArgs
  if (!dryRun)
    die('--skin <dir> --mode <id> is a report only: add --dry-run (the payload: --skin --payload)')
  const doc = JSON.parse(readFileSync(tokensPath, 'utf8'))
  const coreLeaves = collectLeaves(doc)
  const pkg = loadSkinPackage(skinDir, doc)
  if (pkg.problems.length > 0) {
    die(`skin package is not valid:\n${pkg.problems.map((p) => `  - ${p}`).join('\n')}`)
  }
  // Names are paired by the FE-124 rule only when a Figma snapshot is given.
  const figmaNames = snapshotPath
    ? buildNameMap(coreLeaves, (await loadSnapshot()).variables).map
    : undefined
  output(
    formatSkinModeReport(skinModeReport(coreLeaves, pkg.decls, figmaNames), {
      skinPath: skinDir,
      modeId,
    }),
  )
  process.exit(0)
}

const doc = JSON.parse(readFileSync(tokensPath, 'utf8'))
const leaves = collectLeaves(doc)
const snapshot = await loadSnapshot().catch((e) => die(e instanceof Error ? e.message : String(e)))
/** @type {ReturnType<typeof loadModes>} */
let modes = []
try {
  modes = loadModes(doc, leaves)
} catch (e) {
  die(e instanceof Error ? e.message : String(e))
}
const scoped = {
  ...config,
  modes: config.modes.filter((m) => modes.some((x) => x.name === m.name)),
}

// --- the payload for the Figma writer (--skin) ----------------------------------
if (skinArgs && 'all' in skinArgs) {
  if (!payloadPath)
    die('--skin needs --payload <out.json> (the file modes-lib.figma.js apply() reads)')
  if (only) die('--skin writes every mode: drop --only')
  let commit = 'unknown'
  try {
    commit = git(repoRoot, 'rev-parse', 'HEAD')
  } catch {
    /* not a git checkout: the payload says so */
  }
  const sources = Object.fromEntries(modes.map((m) => [m.name, m.source]))
  const built = buildModeValues({ config, modes, snapshot, source: { commit, modes: sources } })
  writeFileSync(/** @type {string} */ (payloadPath), `${JSON.stringify(built.payload, null, 2)}\n`)
  const drift = modeDrift({ config, modes, snapshot })
  const lines = [
    `## Figma modes payload -- ${payloadPath}`,
    '',
    `Collection \`${config.collection}\`: ${config.modes.map((m) => `\`${m.name}\``).join(' -> ')} (core first; screens in \`${config.screensMode}\`).`,
    '',
    '| mode | source | in Figma | values that change |',
    '|---|---|---|---|',
  ]
  for (const row of drift.modes) {
    const src = row.collection === config.collection ? sources[row.name] : 'frontend/tokens.json'
    const label = row.collection === config.collection ? row.name : `${row.collection} (one mode)`
    const change = row.missing ? 'all (new mode)' : String(row.drift.length + row.review.length)
    lines.push(`| ${label} | ${src} | ${row.missing ? 'missing' : 'yes'} | ${change} |`)
  }
  if (drift.unknownModes.length > 0) {
    lines.push(
      '',
      `Figma modes the config does not know (apply() stops): ${drift.unknownModes.join(', ')}`,
    )
  }
  lines.push('', `### Not stored in Figma (${built.problems.length})`, '')
  if (built.problems.length === 0) lines.push('None.')
  for (const p of built.problems)
    lines.push(`- ${p.mode} \`${p.cssName}\` (\`${p.figmaName}\`): ${p.reason}`)
  if (built.registryOrphans.length > 0) {
    lines.push(
      '',
      `### Tokens with no Figma variable (${built.registryOrphans.length}) -- create the variable first`,
      '',
    )
    for (const n of built.registryOrphans) lines.push(`- \`${n}\``)
  }
  if (built.figmaOrphans.length > 0) {
    lines.push(
      '',
      `### Figma variables with no token (${built.figmaOrphans.length}) -- not written`,
      '',
    )
    for (const n of built.figmaOrphans) lines.push(`- \`${n}\``)
  }
  output(lines.join('\n'))
  process.exit(0)
}

// --- drift report, every mode ------------------------------------------------------
const result = modeDrift({ config: scoped, modes, snapshot })
const coreRow = result.modes.find(
  (r) => r.collection === config.collection && r.name === modes[0].name,
)
const updates = []
if (apply) {
  if (!coreRow || coreRow.missing)
    die('--apply reads the core mode, and Figma has no mode named core')
  // The core of the core-only collections joins the core mode's updates.
  for (const row of result.modes.filter((r) => r.name === modes[0].name && !r.missing)) {
    for (const d of row.drift) {
      const newValue = reconstructCss(d.regComparable, d.figComparable, d.resolvedType)
      if (newValue !== null) updates.push({ cssName: d.cssName, newValue })
    }
  }
  const byName = new Map(leaves.map((l) => [l.cssName, l]))
  for (const { cssName, newValue } of updates) {
    // The registry value keeps its authored leading space ("  --name: VALUE;")
    // -- the generator's verbatim emit depends on it.
    ;/** @type {any} */ (byName.get(cssName)).node.$value = newValue.startsWith(' ')
      ? newValue
      : ` ${newValue}`
  }
  if (updates.length > 0) {
    // indent=2 + trailing newline: byte-identical with the committed file's
    // serialization (verified against the FE-124 extractor's output).
    writeFileSync(tokensPath, `${JSON.stringify(doc, null, 2)}\n`)
    writeFileSync(cssPath, generateVariables(doc))
  }
}

const lines = ['## Figma Variables drift report (FE-234: one section per mode)', '']
lines.push(
  `Registry: ${leaves.length} tokens · Figma: ${snapshot.variables.length} variables · modes: ${scoped.modes.map((m) => m.name).join(', ')}`,
)
if (result.unknownModes.length > 0) {
  lines.push('', `### Figma modes the config does not know (${result.unknownModes.length})`)
  for (const n of result.unknownModes) lines.push(`- \`${n}\``)
}
if (result.registryOrphans.length > 0) {
  lines.push(
    '',
    `### Registry tokens with NO Figma pair (${result.registryOrphans.length}) -- a Figma import is missing them`,
  )
  for (const n of result.registryOrphans) lines.push(`- \`${n}\``)
}
if (result.figmaOrphans.length > 0) {
  lines.push(
    '',
    `### Figma variables with NO registry pair (${result.figmaOrphans.length}) -- new designer tokens, code has no owner yet`,
  )
  for (const n of result.figmaOrphans) lines.push(`- \`${n}\``)
}
for (const row of result.modes) {
  const title =
    row.collection === config.collection
      ? `mode \`${row.name}\``
      : `\`${row.collection}\` (one mode, core)`
  const src = modes.find((m) => m.name === row.name)?.source
  if (row.missing) {
    lines.push('', `### ${title}: MISSING in Figma (${src})`)
    continue
  }
  if (row.drift.length === 0 && row.review.length === 0) {
    lines.push('', `### ${title}: in sync (${src})`)
    continue
  }
  lines.push('', `### ${title}: ${row.drift.length} drift, ${row.review.length} to review (${src})`)
  if (row.drift.length > 0) {
    lines.push('', '| token | code | Figma | applied |', '|---|---|---|---|')
    for (const d of row.drift) {
      const done =
        updates.some((u) => u.cssName === d.cssName) && row.name === modes[0].name ? '✅' : ''
      lines.push(`| \`${d.cssName}\` | \`${d.registry}\` | \`${d.figma}\` | ${done} |`)
    }
  }
  for (const r of row.review) lines.push(`- \`${r.cssName}\`: ${r.reason}`)
}
const drifted =
  result.unknownModes.length > 0 ||
  result.registryOrphans.length > 0 ||
  result.figmaOrphans.length > 0 ||
  result.modes.some((r) => r.missing || r.drift.length > 0 || r.review.length > 0)
if (!drifted) lines.push('', '**In sync.** Every mode, no orphans.')
output(lines.join('\n'))
if (updates.length > 0) {
  console.log(
    `applied: ${updates.length} lossless core update(s) into tokens.json + regenerated variables.css`,
  )
}
// The exit code IS the automation contract: 2 = a PR is needed.
process.exit(drifted ? 2 : 0)
