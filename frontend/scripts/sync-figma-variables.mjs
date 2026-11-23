// =============================================================================
// FE-124 track T, stage 2 -- the Figma Variables autosync
// (tz-whitelabel.md §3.3, track T: the auto-PR stage of the token track).
// =============================================================================
//
// Direction (owner's decision 2026-11-09, tz-whitelabel.md §3.3): the code
// is the source of truth -- tokens.json is the registry the generator builds
// variables.css from (the FE-124 pipeline), and Figma is a mirror updated
// FROM it. Today the useful mode is the dry-run --snapshot drift report
// (no Figma token involved); --apply and --rest serve a possible future
// "Figma -> code" direction and stay dormant until then.
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
// THREE MODES (FE-234 item 6, owner's decision 23.11.2026): the `velo`
// collection holds `core` (the neutral tokens.json) first, then one mode per
// skin package (`gold` = velo-brand, `goodo` = goodo-brand), pinned by tag
// and commit in frontend/design/figma-modes.json. A mode is found by its
// NAME, never by its position: the old "core = the first mode" rule would
// pour the neutral core into `gold` while `gold` is still the first mode.
//
// INPUT
//   --snapshot <file>  a dump of the Figma variables WITH mode names: the
//                      snapshot() of docs/figma/front/modes-lib.figma.js
//                      (also the bridge shape with variableCollections, the
//                      REST shape). The old compact single-mode dump is refused.
//   --rest             the Variables REST API (GET /v1/files/{fileKey}/variables;
//                      env FIGMA_TOKEN, --file-key; Enterprise-locked, dormant).
//   Packages: each skin mode's package is cloned at its pinned tag and its
//   commit is checked (a private repo reads the git credentials or
//   BRAND_REPO_TOKEN); --pkg <mode>=<dir> uses a local checkout instead (its
//   HEAD must be the pinned commit). --only <mode,...> limits the run.
//
// COMMANDS
//   --snapshot|--rest            drift report for EVERY mode: core vs
//                                tokens.json, a skin mode vs tokens.json + its
//                                package; a configured mode Figma lacks and a
//                                Figma mode the config lacks are drift too.
//     --apply                    the dormant Figma -> code direction: the
//                                lossless updates of the CORE mode only, into
//                                tokens.json (+ variables.css).
//   --skin --snapshot <file> --payload <out.json>
//                                the values of every mode for the Figma writer
//                                (modes-lib.figma.js apply()); the report
//                                lists what changes against the snapshot and
//                                what Figma cannot hold.
//   --skin <dir> --mode <id> --dry-run
//                                (FE-219) one local package against the core,
//                                a report only -- for a package not tagged yet.
//
// Exit codes: 0 up-to-date/clean · 1 error · 2 drift found (dry-run) --
// the CI autosync turns 2 into the auto-PR; a human reviews it as code.
//
// Run from frontend/:  node scripts/sync-figma-variables.mjs --snapshot dump.json
// =============================================================================
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, dirname, resolve } from 'node:path'
import process from 'node:process'
import { collectLeaves, buildNameMap, reconstructCss } from './lib/figma-token-sync.mjs'
import { generateVariables } from './generate-variables.mjs'
import { loadSkinPackage } from './lib/skin-package.mjs'
import { skinModeReport, formatSkinModeReport, parseSkinArgs } from './lib/skin-mode.mjs'
import {
  buildModeValues,
  crossCheckPins,
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

const config = parseModesConfig(JSON.parse(readFileSync(modesPath, 'utf8')))
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

/** The directory of a skin mode's package: a local checkout (--pkg) or a
 *  fresh clone at the pinned tag. The commit must be the pinned one. */
function packageDir(mode, scratch) {
  const p = mode.package
  const local = pkgDirs.get(mode.name)
  if (local) {
    let head
    try {
      head = git(local, 'rev-parse', 'HEAD')
    } catch {
      die(`--pkg ${mode.name}=${local}: not a git checkout, the pinned commit cannot be checked`)
    }
    if (head !== p.sha)
      die(`--pkg ${mode.name}: HEAD is ${head}, figma-modes.json pins ${p.tag} ${p.sha}`)
    return join(local, p.dir)
  }
  const target = join(scratch, mode.name)
  const token = process.env.BRAND_REPO_TOKEN ?? ''
  const url = token
    ? `https://x-access-token:${token}@github.com/${p.repo}.git`
    : `https://github.com/${p.repo}.git`
  try {
    // The URL may carry the token: keep git's own output out of the log.
    execFileSync(
      'git',
      [
        '-c',
        'advice.detachedHead=false',
        'clone',
        '--quiet',
        '--depth',
        '1',
        '--branch',
        p.tag,
        url,
        target,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
  } catch {
    die(
      `cannot clone ${p.repo} at ${p.tag} (a private repo needs git credentials or BRAND_REPO_TOKEN; or pass --pkg ${mode.name}=<checkout>)`,
    )
  }
  const head = git(target, 'rev-parse', 'HEAD')
  if (head !== p.sha)
    die(`${p.repo} ${p.tag} is ${head}, figma-modes.json pins ${p.sha}: the tag moved`)
  return join(target, p.dir)
}

/** core + one entry per skin mode: {name, leaves}. */
function loadModes(doc, leaves) {
  if (existsSync(brandSkinsPath)) {
    const disagree = crossCheckPins(config.modes, JSON.parse(readFileSync(brandSkinsPath, 'utf8')))
    if (disagree.length > 0) die(`the package pins disagree:\n  ${disagree.join('\n  ')}`)
  }
  const wanted = config.modes.filter((m, i) => i === 0 || !only || only.includes(m.name))
  const scratch = mkdtempSync(join(tmpdir(), 'figma-modes-'))
  try {
    return wanted.map((m, i) => {
      if (i === 0) return { name: m.name, leaves, source: 'frontend/tokens.json' }
      const p = /** @type {NonNullable<typeof m.package>} */ (m.package)
      const pkg = loadSkinPackage(packageDir(m, scratch), doc)
      if (pkg.problems.length > 0) {
        die(`${p.name} ${p.tag} is not a valid skin package:\n  ${pkg.problems.join('\n  ')}`)
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
const modes = loadModes(doc, leaves)
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
