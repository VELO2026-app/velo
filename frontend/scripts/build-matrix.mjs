// =============================================================================
// VELO Frontend -- build matrix, the whitelabel acceptance GATE
// (FE-114, F5.1; moved onto the machine's channel by FE-152, F5 rev.4)
// =============================================================================
// Builds a SKIN x EDITION matrix from the current working tree, through the
// same two inputs the deploy machine uses -- and nothing else:
//
//   edition   PRIMER_EDITION, resolved through editions.json at the repo
//             root (FE-130). VITE_FEATURES is stripped from the build env:
//             it is the local-dev channel, the machine never builds through
//             it.
//   skin      the package copied WHOLE into public/skin/ (the machine's
//             build context, FE-148), then gated by validate-skin on that
//             very directory. A rejected package aborts the matrix.
//
// The cells (not the full product -- tz-whitelabel §6, F5 rev.4):
//
//   golden x every edition of editions.json   (core, school, ...)
//   every skin x full     (the --skin list; velo carries no skins -- FE-131,
//                          partner skins live in their own repositories)
//
// After each `vite build` the dist facts are snapshotted. The GATE part
// (any FAIL = exit 1), all of it read from dist/:
//
//   a. identity: title + theme-color equal the cell's source of record --
//      the skin's brand record, or the golden defaults (VITE_BRAND ?? 'VELO',
//      #334D6E) for golden cells;
//   b. brand grep: a skin cell's bundle carries the skin's displayName and
//      every one of its token declarations; a golden cell carries NO
//      matrix skin's displayName and none of its distinctive declarations
//      (the ones variables.css does not already declare verbatim), and no
//      dist/skin/ copy of a package at all;
//   c. DCE: a module the cell's edition turns on has its chunks in dist, a
//      module it leaves off has NONE (tz-whitelabel §4: "a disabled module
//      leaves no chunks", F3 variant "a");
//   d. the dist asset COUNT is equal across all `full` cells (a skin
//      repaints, it never adds or removes chunks).
//
// The pre-run public/skin/ is backed up and put back verbatim, then dist/ is
// rebuilt from it with the ambient env (what a plain `pnpm build` makes).
//
// Usage: node scripts/build-matrix.mjs [--skin <path>]... [--no-restore]
//          --skin        adds a skin package directory (repeatable): a package
//                        directory -- a broken one fails the matrix
//          --no-restore  skip the final rebuild (CI: dist/ is thrown away)
//          --cell <name> build and gate ONE cell (e.g. golden/core) -- CI
//                        fans the cells out as a job matrix. Invariant d
//                        spans cells, so it is checked after the fan-in
//                        (--check-assets); a lone cell cannot trip it.
//          --facts-out <file>  write the cell's asset facts as JSON
//          --list        print the cell names as a JSON array and exit
//                        (builds nothing; needs no node_modules)
//          --check-assets <dir>  fan-in: invariant d over every --facts-out
//                        file in <dir>
//        (or: pnpm build:matrix)
// evaluateMatrix() and planCells() are exported for the unit suite
// (src/platform/build-matrix.test.ts).
// =============================================================================

import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findBuildLogWarnings } from './lib/build-log-gate.mjs'
import { MANDATORY_ASSETS, loadSkinPackage, readGoldenTokens } from './lib/skin-package.mjs'

// Resolved lazily: under vitest import.meta.url is not file:// (the same
// reason passport-html tests anchor to process.cwd()), and the unit suite
// imports this module for the pure functions only.
const frontendDir = () => resolve(fileURLToPath(new URL('..', import.meta.url)))

/** Chunk-name probes per switchable module (§4): the route files a cut
 *  module would leave behind. Keys mirror FEATURE_NAMES (platform/
 *  features.ts) -- the unit suite pins the two lists together. */
export const MODULE_CHUNKS = {
  ai: [/AiSummary/, /AiConnections/],
}

/** GOLDEN_SKIN.themeColor (platform/skin.ts) -- the skinless build's header
 *  color, pinned here the same mirror-and-pin way passport-html.test.ts and
 *  the manifest comments pin it. No env seam exists for colors (§1). */
const GOLDEN_THEME = '#334D6E'

/** The edition every skin cell is built at. */
const SKIN_EDITION = 'full'

/** The cells: golden x every edition, every skin x full. `skins` are
 *  { label, source } pairs; `editions` is the parsed editions.json. Each
 *  cell carries the module set its edition turns on (names outside
 *  MODULE_CHUNKS are ignored -- the backend's list is a superset, the same
 *  rule platform/features.ts applies). */
export function planCells(editions, skins) {
  const modulesOf = (edition) => {
    const entry = editions.editions[edition]
    if (!entry) {
      throw new Error(
        `edition "${edition}" is not in editions.json (known: ${Object.keys(editions.editions).join(', ')})`,
      )
    }
    return Object.fromEntries(
      Object.keys(MODULE_CHUNKS).map((name) => [name, entry.modules.includes(name)]),
    )
  }
  const labels = skins.map((s) => s.label)
  const dup = labels.find((label, i) => labels.indexOf(label) !== i)
  if (dup !== undefined)
    throw new Error(`two skins share the label "${dup}" -- their cells would overwrite each other`)
  return [
    ...Object.keys(editions.editions).map((edition) => ({
      name: `golden/${edition}`,
      skin: null,
      edition,
      modules: modulesOf(edition),
    })),
    ...skins.map((skin) => ({
      name: `${skin.label}/${SKIN_EDITION}`,
      skin,
      edition: SKIN_EDITION,
      modules: modulesOf(SKIN_EDITION),
    })),
  ]
}

// -- the brand/token grep helpers ---------------------------------------------

/** One CSS declaration value in a comparable shape: the minifier drops
 *  spaces, leading zeros and may swap quote style; case is irrelevant. */
export function normalizeDecl(decl) {
  return decl
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/'/g, '"')
    .replace(/([^0-9])0\./g, '$1.')
}

/** The custom-property declarations of a CSS text, normalized. */
export function tokenDecls(css) {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...flat.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;}]+)[;}]/g)].map((m) =>
    normalizeDecl(`${m[1]}:${m[2]}`),
  )
}

/** Does the normalized dist CSS carry the WHOLE declaration `decl`? The
 *  value must end where the declaration ends (`;`, `}` or the end of the
 *  text) -- `--velo-radius:1` is not satisfied by `--velo-radius:12px`. The
 *  name must start a declaration too (`{`, `;` or the start). */
export function cssHasDecl(css, decl) {
  for (let i = css.indexOf(decl); i !== -1; i = css.indexOf(decl, i + 1)) {
    const before = i === 0 ? '' : css[i - 1]
    const after = css[i + decl.length] ?? ''
    if (
      (before === '' || before === '{' || before === ';') &&
      (after === '' || after === ';' || after === '}')
    )
      return true
  }
  return false
}

/** Does the bundle text carry `text` -- verbatim (UTF-8) or as the \uXXXX
 *  escape esbuild may emit for non-ASCII? */
export function bundleHas(bundle, text) {
  if (bundle.includes(text)) return true
  const escaped = [...text]
    .map((ch) =>
      ch.charCodeAt(0) > 0x7e ? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}` : ch,
    )
    .join('')
  return bundle.toLowerCase().includes(escaped.toLowerCase())
}

// -- the gate -----------------------------------------------------------------

/** The gate: dist facts vs every cell's source of record. Pure -- the unit
 *  suite pins every FAIL branch. `cells` come from planCells(); `facts` and
 *  `expected` are keyed by cell name.
 *
 *  facts[cell]    { title, theme, assets, chunks: { <module>: [files] },
 *                   brandMissing: bool,       (skin cells)
 *                   tokensMissing: [decl],    (skin cells)
 *                   layout: [problem],        (skin cells: asset spill,
 *                                              dist/skin prune, fonts)
 *                   leaked: [what] }          (golden cells)
 *  expected[cell] { title, theme } */
export function evaluateMatrix({ cells, facts, expected }) {
  const fails = []
  for (const cell of cells) {
    const f = facts[cell.name]
    if (!f) {
      fails.push(`${cell.name}: no dist facts -- the cell never built`)
      continue
    }
    const e = expected[cell.name]

    // a. identity
    if (f.title !== e.title)
      fails.push(`${cell.name}: dist title "${f.title}" != expected "${e.title}" (brand source)`)
    if (f.theme !== e.theme)
      fails.push(`${cell.name}: dist theme-color "${f.theme}" != expected "${e.theme}"`)

    // b. brand grep
    if (cell.skin) {
      if (f.brandMissing)
        fails.push(`${cell.name}: the skin's displayName "${e.title}" is not in the JS bundle`)
      if ((f.tokensMissing ?? []).length > 0)
        fails.push(
          `${cell.name}: skin token declarations missing from dist CSS: ${f.tokensMissing.join(', ')}`,
        )
      for (const problem of f.layout ?? []) fails.push(`${cell.name}: ${problem}`)
    } else if ((f.leaked ?? []).length > 0) {
      fails.push(`${cell.name}: skin leaked into a golden build: ${f.leaked.join(', ')}`)
    }

    // c. DCE per module
    for (const [module, on] of Object.entries(cell.modules)) {
      const survivors = f.chunks?.[module] ?? []
      if (on && survivors.length === 0)
        fails.push(
          `${cell.name}: ${module} chunks missing -- edition "${cell.edition}" turns it on`,
        )
      if (!on && survivors.length > 0)
        fails.push(
          `${cell.name}: chunks of the DISABLED ${module} module survived the cut: ${survivors.join(', ')}`,
        )
    }
  }

  // d. asset-count invariant across the full cells that built
  const full = cells.filter((c) => c.edition === SKIN_EDITION && facts[c.name])
  const counts = full.map((c) => facts[c.name].assets)
  if (new Set(counts).size > 1)
    fails.push(
      `asset count differs across full cells (${full.map((c) => `${c.name}:${facts[c.name].assets}`).join(' ')}) -- a skin must repaint, not re-chunk`,
    )
  return fails
}

/** Invariant d on its own, for the fan-in of per-cell runs: `entries` are
 *  the --facts-out records ({ cell, edition, assets }). Same rule as in
 *  evaluateMatrix(): every `full`-edition cell has the same asset count. */
export function assetCountFails(entries) {
  const full = entries.filter((e) => e.edition === SKIN_EDITION)
  if (new Set(full.map((e) => e.assets)).size <= 1) return []
  return [
    `asset count differs across full cells (${full.map((e) => `${e.cell}:${e.assets}`).join(' ')}) -- a skin must repaint, not re-chunk`,
  ]
}

/** The whole fan-in verdict (--check-assets): every planned cell reported --
 *  a cell that never ran is not a green cell -- and invariant d holds. */
export function fanInFails(cellNames, entries) {
  const missing = cellNames.filter((n) => !entries.some((e) => e.cell === n))
  return [
    ...missing.map((n) => `${n}: no facts file -- the cell never reported`),
    ...assetCountFails(entries),
  ]
}

// -- the impure part (CLI only) -----------------------------------------------

const publicSkin = () => join(frontendDir(), 'public', 'skin')

/** A package directory -> { label, source }. A missing one fails the
 *  matrix in its pre-flight, named. */
function resolveSkin(arg) {
  const source = resolve(arg)
  // A package checked out as <repo>/skin is named after its repository.
  const label = basename(source) === 'skin' ? basename(resolve(source, '..')) : basename(source)
  return { label, source }
}

/** The machine's path: the package lands WHOLE in public/skin/ and is gated
 *  there (FE-148: an unfit skin fails the build). `pnpm build` runs that
 *  gate as `validate-skin --build`; the matrix calls `vite build` directly,
 *  so it runs the same validator on the same directory itself. */
async function stageSkin(skin) {
  rmSync(publicSkin(), { recursive: true, force: true })
  if (!skin) return
  if (!existsSync(skin.source))
    throw new Error(`skin "${skin.label}": no package at ${skin.source}`)
  cpSync(skin.source, publicSkin(), { recursive: true })
  const { validateSkin } = await import('./validate-skin.mjs')
  const report = validateSkin(publicSkin(), frontendDir())
  if (report.fails.length > 0) {
    for (const line of report.fails) console.error(`  ${line}`)
    throw new Error(
      `skin "${skin.label}" REJECTED by validate-skin (${report.fails.length} fail(s))`,
    )
  }
}

/** A matrix cell builds through the machine's channel only (`edition` set,
 *  VITE_FEATURES stripped); `undefined` is the restore build -- the ambient
 *  env untouched, i.e. what a plain `pnpm build` makes. */
function build(edition) {
  const env = { ...process.env }
  if (edition) {
    delete env.VITE_FEATURES
    env.PRIMER_EDITION = edition
  }
  // FE-153: every matrix build's log goes through the same gate as the plain
  // CI build (scripts/lib/build-log-gate.mjs) -- a cycle that only one
  // edition's chunking produces must not slip through. The output is
  // captured, then echoed whole (no live streaming).
  const res = spawnSync('node_modules/.bin/vite', ['build'], {
    cwd: frontendDir(),
    stdio: ['inherit', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env,
  })
  process.stdout.write(res.stdout ?? '')
  process.stderr.write(res.stderr ?? '')
  if (res.status !== 0) throw new Error(`vite build (PRIMER_EDITION=${edition ?? '-'}) failed`)
  const findings = findBuildLogWarnings(`${res.stdout ?? ''}\n${res.stderr ?? ''}`)
  if (findings.length > 0) {
    const lines = findings.map(({ rule, line }) => `  [${rule}] ${line}`).join('\n')
    throw new Error(
      `vite build (PRIMER_EDITION=${edition ?? '-'}): gated build-log warnings\n${lines}`,
    )
  }
}

function readAll(dir, ext) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n')
}

/** The skin's own identity + tokens, read from its source package by the
 *  engine the build converts it with (FE-131). */
function skinRecord(skin) {
  const pkg = loadSkinPackage(skin.source, readGoldenTokens(frontendDir()))
  const decls = pkg.decls.map(([name, value]) => normalizeDecl(`${name}:${value}`))
  // The matrix packages are known-good fixtures: a null brand means the
  // package did not load, which loadSkinPackage reports in pkg.problems.
  if (pkg.brand === null) throw new Error(`${skin.label}: ${pkg.problems.join('; ')}`)
  return { brand: pkg.brand, decls, files: pkg.files }
}

/** Where the build must have put the package (FE-131): the fixed assets on
 *  /icons, assets/bg and assets/onboarding on /bg and /onboarding, byte for
 *  byte; dist/skin/ pruned to the fonts; every font behind an @font-face
 *  and a preload. Returns the problems, [] when the layout holds. */
function skinLayout(source, files, brand, distDir, html, css) {
  const problems = []
  const same = (a, b) => existsSync(b) && readFileSync(a).equals(readFileSync(b))
  for (const name of MANDATORY_ASSETS)
    if (!same(join(source, 'assets', name), join(distDir, 'icons', name)))
      problems.push(`dist/icons/${name} is not the package's assets/${name}`)
  for (const file of files.filter((f) => /^assets\/(bg|onboarding)\//.test(f)))
    if (!same(join(source, file), join(distDir, file.slice('assets/'.length))))
      problems.push(`dist/${file.slice('assets/'.length)} is not the package's ${file}`)
  const shipped = []
  const walk = (rel) => {
    const abs = join(distDir, 'skin', rel)
    if (!existsSync(abs)) return
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(next)
      else shipped.push(next)
    }
  }
  walk('')
  const extra = shipped.filter((f) => !f.startsWith('assets/fonts/'))
  if (extra.length > 0) problems.push(`dist/skin/ ships more than the fonts: ${extra.join(', ')}`)
  for (const font of brand.fonts) {
    if (!shipped.includes(font.file)) problems.push(`dist/skin/${font.file} missing`)
    if (!css.includes(`/skin/${font.file}`))
      problems.push(`no @font-face for ${font.file} in dist CSS`)
    if (!html.includes(`href="/skin/${font.file}"`))
      problems.push(`no preload of ${font.file} in index.html`)
  }
  return problems
}

function snapshot(cell, skins, goldenDecls) {
  const distDir = join(frontendDir(), 'dist')
  const html = readFileSync(join(distDir, 'index.html'), 'utf8')
  const assetsDir = join(distDir, 'assets')
  const assets = readdirSync(assetsDir)
  const js = readAll(assetsDir, '.js')
  const css = normalizeDecl(readAll(assetsDir, '.css'))
  const facts = {
    title: html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '?',
    theme: html.match(/theme-color" content="([^"]*)/)?.[1] ?? '?',
    assets: assets.length,
    chunks: Object.fromEntries(
      Object.entries(MODULE_CHUNKS).map(([module, probes]) => [
        module,
        assets.filter((a) => probes.some((re) => re.test(a))),
      ]),
    ),
  }
  if (cell.skin) {
    const { brand, decls, files } = skinRecord(cell.skin)
    facts.brandMissing = !bundleHas(js, brand.displayName)
    facts.tokensMissing = decls.filter((d) => !cssHasDecl(css, d))
    facts.layout = skinLayout(
      cell.skin.source,
      files,
      brand,
      distDir,
      html,
      readAll(assetsDir, '.css'),
    )
  } else {
    facts.leaked = existsSync(join(distDir, 'skin')) ? ['dist/skin/ (a package shipped)'] : []
    for (const skin of skins) {
      const { brand, decls } = skinRecord(skin)
      if (bundleHas(js, brand.displayName) || html.includes(brand.displayName))
        facts.leaked.push(`${skin.label} displayName`)
      const foreign = decls.filter((d) => !goldenDecls.has(d) && cssHasDecl(css, d))
      if (foreign.length > 0) facts.leaked.push(`${skin.label} tokens (${foreign.join(', ')})`)
    }
  }
  return facts
}

/** The skinless build's identity, resolved EXACTLY as passport-html resolves
 *  %VELO_BRAND% at build time: process.env -> .env files -> 'VELO'. */
async function goldenBrand() {
  // Lazy: `--list` must run without node_modules.
  const { loadEnv } = await import('vite')
  const fromFiles = loadEnv('production', frontendDir(), 'VITE_').VITE_BRAND
  return process.env.VITE_BRAND ?? fromFiles ?? 'VELO'
}

async function expectationOf(cell) {
  if (!cell.skin) return { title: await goldenBrand(), theme: GOLDEN_THEME }
  const { brand } = skinRecord(cell.skin)
  return { title: brand.displayName, theme: brand.themeColor }
}

function printTable(cells, facts) {
  const cols = ['cell', 'title', 'theme', 'assets', ...Object.keys(MODULE_CHUNKS), 'brand-grep']
  const pad = (v, i) => v.padEnd(i === 0 ? 24 : 14)
  console.log(`\n${cols.map(pad).join('  ')}`)
  for (const cell of cells) {
    const f = facts[cell.name]
    if (!f) continue
    const grep = cell.skin
      ? !f.brandMissing && f.tokensMissing.length === 0
        ? 'skin ok'
        : 'SKIN MISSING'
      : f.leaked.length === 0
        ? 'no leak'
        : 'LEAK'
    console.log(
      [
        cell.name,
        f.title.slice(0, 14),
        f.theme,
        String(f.assets),
        ...Object.keys(MODULE_CHUNKS).map((m) => (f.chunks[m].length > 0 ? 'yes' : 'no')),
        grep,
      ]
        .map(pad)
        .join('  '),
    )
  }
}

function parseArgs(argv) {
  const skins = []
  let restore = true
  let cell = null
  let factsOut = null
  let list = false
  let checkAssets = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--skin') skins.push(argv[++i])
    else if (argv[i] === '--no-restore') restore = false
    else if (argv[i] === '--cell') cell = argv[++i]
    else if (argv[i] === '--facts-out') factsOut = argv[++i]
    else if (argv[i] === '--list') list = true
    else if (argv[i] === '--check-assets') checkAssets = argv[++i]
    else throw new Error(`unknown argument "${argv[i]}"`)
  }
  if (
    (cell !== null && !cell) ||
    (factsOut !== null && !factsOut) ||
    (checkAssets !== null && !checkAssets)
  )
    throw new Error('--cell, --facts-out and --check-assets need a value')
  return { skins, restore, cell, factsOut, list, checkAssets }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2))
  const editions = JSON.parse(readFileSync(join(frontendDir(), '..', 'editions.json'), 'utf8'))
  const skins = args.skins.map(resolveSkin)
  const allCells = planCells(editions, skins)

  if (args.list) {
    console.log(JSON.stringify(allCells.map((c) => c.name)))
    process.exit(0)
  }
  if (args.checkAssets) {
    const dir = resolve(args.checkAssets)
    const entries = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
    const fails = fanInFails(
      allCells.map((c) => c.name),
      entries,
    )
    if (fails.length > 0) {
      for (const f of fails) console.error('  FAIL ' + f)
      console.error(`\nbuild-matrix: ${fails.length} FAIL(s) at the fan-in`)
      process.exit(1)
    }
    console.log(`build-matrix: fan-in green -- ${entries.length} cells, asset counts agree`)
    process.exit(0)
  }

  const cells = args.cell ? allCells.filter((c) => c.name === args.cell) : allCells
  if (cells.length === 0) {
    console.error(
      `build-matrix: no cell "${args.cell}" (known: ${allCells.map((c) => c.name).join(', ')})`,
    )
    process.exit(1)
  }
  const goldenDecls = new Set(
    tokenDecls(readFileSync(join(frontendDir(), 'src', 'styles', 'variables.css'), 'utf8')),
  )

  // Pre-flight: every skin is validated BEFORE the first build -- a broken
  // package fails fast and named (the golden cells read every skin's
  // brand record and tokens for the leak grep, so a package-less dir would
  // otherwise surface as a bare ENOENT). stageSkin() re-runs the validator
  // on public/skin/ -- the machine's path -- before each skin cell.
  {
    const { validateSkin } = await import('./validate-skin.mjs')
    let rejected = 0
    for (const skin of skins) {
      const report = validateSkin(skin.source, frontendDir())
      if (report.fails.length === 0) continue
      rejected++
      console.error(`build-matrix: skin "${skin.label}" REJECTED by validate-skin:`)
      for (const line of report.fails) console.error(`  ${line}`)
    }
    if (rejected > 0) {
      console.error(`\nbuild-matrix: ${rejected} skin(s) rejected -- matrix FAILED (nothing built)`)
      process.exit(1)
    }
  }

  // Back up the owner's public/skin/ -- restored verbatim, whatever it was.
  const backup = existsSync(publicSkin()) ? mkdtempSync(join(tmpdir(), 'velo-matrix-skin-')) : null
  if (backup) cpSync(publicSkin(), backup, { recursive: true })
  const restore = () => {
    rmSync(publicSkin(), { recursive: true, force: true })
    if (backup) {
      cpSync(backup, publicSkin(), { recursive: true })
      rmSync(backup, { recursive: true, force: true })
    }
    if (args.restore) build(undefined)
  }

  console.log(
    `build-matrix: ${cells.length} cells -- ${cells.map((c) => c.name).join(', ')}` +
      (args.restore ? ' (then the pre-run tree is rebuilt)' : '') +
      '\n',
  )

  const facts = {}
  const expected = {}
  /** @type {Error | null} */
  let aborted = null
  try {
    for (const cell of cells) {
      console.log(`\n== build-matrix: ${cell.name} (PRIMER_EDITION=${cell.edition}) ==`)
      await stageSkin(cell.skin)
      build(cell.edition)
      facts[cell.name] = snapshot(cell, skins, goldenDecls)
      expected[cell.name] = await expectationOf(cell)
      if (args.factsOut)
        writeFileSync(
          args.factsOut,
          JSON.stringify({
            cell: cell.name,
            edition: cell.edition,
            assets: facts[cell.name].assets,
          }),
        )
    }
  } catch (err) {
    aborted = err instanceof Error ? err : new Error(String(err))
  }
  try {
    restore()
  } catch (restoreErr) {
    console.error(
      `build-matrix: restore failed (${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}) -- fix the tree`,
    )
    process.exit(1)
  }
  if (aborted) {
    console.error(`\nbuild-matrix: ${aborted.message} -- matrix FAILED`)
    process.exit(1)
  }

  printTable(cells, facts)
  const fails = evaluateMatrix({ cells, facts, expected })
  if (fails.length > 0) {
    console.error(`\nbuild-matrix: ${fails.length} FAIL(s):`)
    for (const f of fails) console.error('  FAIL ' + f)
    process.exit(1)
  }
  console.log("\nbuild-matrix: green -- facts match every cell's source of record")
}
