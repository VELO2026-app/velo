// =============================================================================
// VELO Frontend -- build matrix, the whitelabel acceptance GATE (FE-114, F5.1)
// =============================================================================
// Builds FOUR editions from the current working tree and checks the dist
// facts against the edition's own sources (tz-whitelabel §6.1 + §4):
//
//   golden         apply-skin --remove      the VELO reference
//   test-contrast  skins/test-contrast      the intentionally contrasty skin
//   nightfall      skins/nightfall          the show-piece skin
//   feature-cut    --remove + VITE_FEATURES=ai   golden skin, payments OFF
//
// apply-skin validates each package BEFORE it lands (a rejected package
// aborts the matrix), then `vite build` runs and the dist facts are
// snapshotted. The GATE part (any FAIL = exit 1):
//
//   a. title + theme-color of every edition equal its source of record --
//      the skin's brand.json, or the golden defaults (VITE_BRAND ?? 'VELO',
//      #334D6E) for the skinless editions;
//   b. golden: tokens-sha is 'golden' (no skin tokens leaked); the dist
//      asset COUNT is equal across all full editions (a skin repaints, it
//      never adds or removes chunks);
//   c. full editions carry BOTH gated modules (ai + payments chunks);
//   d. the feature-cut edition carries ai but NO payments chunks --
//      Topup*, MasterFinanceView, AdminWithdrawals* must be physically
//      absent from dist (§4 «чанков выключенного модуля нет», F3 variant «а»);
//   e. the pre-run edition is restored with a fresh FULL build, so dist/
//      matches the tree the matrix found.
//
// Usage: node scripts/build-matrix.mjs      (or: pnpm build:matrix)
// evaluateMatrix() is exported for the unit suite (src/platform/build-matrix.test.ts).
// =============================================================================

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadEnv } from 'vite'

// Resolved lazily: under vitest import.meta.url is not file:// (the same
// reason passport-html tests anchor to process.cwd()), and the unit suite
// imports this module for evaluateMatrix() only.
const frontendDir = () => resolve(fileURLToPath(new URL('..', import.meta.url)))

/** Chunk-name probes (§4): the route files a cut module would leave behind. */
const AI_CHUNKS = [/AiSummary/, /AiConnections/]
const PAYMENTS_CHUNKS = [/Topup/, /MasterFinanceView/, /AdminWithdrawals/]

/** GOLDEN_SKIN.themeColor (platform/skin.ts) -- the skinless build's header
 *  color, pinned here the same mirror-and-pin way passport-html.test.ts and
 *  the manifest comments pin it. No env seam exists for colors (§1). */
const GOLDEN_THEME = '#334D6E'

/** The editions of the matrix. `features` is passed to the build as
 *  VITE_FEATURES (process.env wins over .env files in vite's loadEnv, so
 *  'full'/'ai' here is deterministic regardless of a local .env). */
const EDITIONS = [
  { name: 'golden', skinArg: '--remove', features: 'full' },
  { name: 'test-contrast', skinArg: 'test-contrast', features: 'full' },
  { name: 'nightfall', skinArg: 'nightfall', features: 'full' },
  { name: 'feature-cut', skinArg: '--remove', features: 'ai' },
]
const FULL_EDITIONS = ['golden', 'test-contrast', 'nightfall']

const run = (cmd, args) => {
  const res = spawnSync(cmd, args, { cwd: frontendDir(), stdio: 'inherit' })
  if (res.status !== 0) throw new Error(`\`${[cmd, ...args].join(' ')}\` failed`)
}
const apply = (arg) => run('node', ['scripts/apply-skin.mjs', arg])
const build = (features) => {
  const res = spawnSync('node_modules/.bin/vite', ['build'], {
    cwd: frontendDir(),
    stdio: 'inherit',
    env: { ...process.env, VITE_FEATURES: features },
  })
  if (res.status !== 0) throw new Error(`vite build (VITE_FEATURES=${features}) failed`)
}
const sha12 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12)

function snapshot(name) {
  const distDir = frontendDir() + '/dist'
  const html = readFileSync(join(distDir, 'index.html'), 'utf8')
  const theme = html.match(/theme-color" content="([^"]*)/)?.[1] ?? '?'
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '?'
  const bgPath = join(distDir, 'bg', 'background.png')
  const bg = existsSync(bgPath) ? sha12(bgPath) : 'absent'
  const tokensPath = join(frontendDir(), 'public', 'skin', 'tokens.css')
  const tokens = existsSync(tokensPath) ? sha12(tokensPath) : 'golden'
  const assets = readdirSync(join(distDir, 'assets'))
  const survivors = (probes) => assets.filter((a) => probes.some((re) => re.test(a)))
  return {
    edition: name,
    title,
    theme,
    bgSha: bg,
    tokensSha: tokens,
    assets: assets.length,
    ai: survivors(AI_CHUNKS),
    payments: survivors(PAYMENTS_CHUNKS),
  }
}

// The pre-run edition: whatever public/skin holds now, matched back to a
// skins/<name> package by its displayName (brand.json carries no other
// stable key); anything else restores golden.
function currentEdition() {
  const brandPath = join(frontendDir(), 'public', 'skin', 'brand.json')
  if (!existsSync(brandPath)) return '--remove'
  const displayName = JSON.parse(readFileSync(brandPath, 'utf8')).displayName
  const skinsDir = join(frontendDir(), 'skins')
  for (const dir of existsSync(skinsDir) ? readdirSync(skinsDir) : []) {
    const pkg = join(skinsDir, dir, 'brand.json')
    if (existsSync(pkg) && JSON.parse(readFileSync(pkg, 'utf8')).displayName === displayName)
      return dir
  }
  return '--remove'
}

/** The skinless build's identity, resolved EXACTLY as passport-html resolves
 *  %VITE_BRAND% at build time: process.env -> .env files -> 'VELO'. */
function goldenBrand() {
  const fromFiles = loadEnv('production', frontendDir(), 'VITE_').VITE_BRAND
  return process.env.VITE_BRAND ?? fromFiles ?? 'VELO'
}

/** Expected { title, theme } for a skinless edition: the golden defaults. */
function goldenExpectation() {
  return { title: goldenBrand(), theme: GOLDEN_THEME }
}

/** Expected { title, theme } for a skinned edition, read from the package
 *  the build just consumed (public/skin/brand.json AFTER a successful
 *  apply+build -- a broken package never gets this far, apply-skin rejects
 *  it with a named report first). */
function appliedExpectation() {
  const brand = JSON.parse(readFileSync(join(frontendDir(), 'public', 'skin', 'brand.json'), 'utf8'))
  return { title: brand.displayName, theme: brand.themeColor }
}

/** The gate: dist facts vs the editions' sources of record. Pure -- the unit
 *  suite pins every FAIL branch. `facts`/`expected` are keyed by edition. */
export function evaluateMatrix({ facts, expected }) {
  const fails = []
  const fact = (name, field) => facts[name]?.[field]
  const list = (name, field) => facts[name]?.[field] ?? []

  // a. identity: title + theme-color come from the edition's own record
  for (const name of [...FULL_EDITIONS, 'feature-cut']) {
    const e = expected[name]
    const title = fact(name, 'title')
    if (title !== e.title)
      fails.push(`${name}: dist title "${title}" != expected "${e.title}" (brand source)`)
    const theme = fact(name, 'theme')
    if (theme !== e.theme)
      fails.push(`${name}: dist theme-color "${theme}" != expected "${e.theme}"`)
  }

  // b. golden purity + the asset-count invariant across full editions
  if (fact('golden', 'tokensSha') !== 'golden')
    fails.push(`golden: tokens-sha is "${fact('golden', 'tokensSha')}" -- skin tokens leaked into the golden build`)
  const counts = FULL_EDITIONS.map((name) => fact(name, 'assets'))
  if (new Set(counts).size > 1)
    fails.push(
      `asset count differs across full editions (${FULL_EDITIONS.map((n) => `${n}:${fact(n, 'assets')}`).join(' ')}) -- a skin must repaint, not re-chunk`,
    )

  // c. full editions carry both gated modules
  for (const name of FULL_EDITIONS) {
    if (list(name, 'ai').length === 0) fails.push(`${name}: ai chunks missing from a FULL edition`)
    if (list(name, 'payments').length === 0)
      fails.push(`${name}: payments chunks missing from a FULL edition`)
  }

  // d. the feature-cut edition: ai present, payments physically absent (§4)
  if (list('feature-cut', 'ai').length === 0)
    fails.push('feature-cut: ai chunks missing -- VITE_FEATURES=ai must keep the ai module')
  const survivors = list('feature-cut', 'payments')
  if (survivors.length > 0)
    fails.push(
      `feature-cut: chunks of the DISABLED payments module survived the cut: ${survivors.join(', ')}`,
    )
  return fails
}

// -- CLI ----------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const before = currentEdition()
  console.log(
    `build-matrix: four editions from one tree (restores "${before}" with a full build at the end)\n`,
  )

  const facts = {}
  const expected = {}
  try {
    for (const ed of EDITIONS) {
      apply(ed.skinArg)
      build(ed.features)
      facts[ed.name] = snapshot(ed.name)
      expected[ed.name] = ed.skinArg === '--remove' ? goldenExpectation() : appliedExpectation()
    }
    // e. restore the owner's pre-run edition and rebuild FULL onto it: the
    // last matrix build (feature-cut) left a payments-less dist, which is
    // never what the stand serves.
    apply(before)
    build('full')
  } catch (err) {
    console.error(`build-matrix: ${err.message} -- restoring the pre-run edition`)
    try {
      apply(before)
      build('full')
    } catch (restoreErr) {
      console.error(`build-matrix: restore failed too (${restoreErr.message}) -- fix the tree`)
    }
    process.exit(1)
  }

  const rows = EDITIONS.map(({ name }) => facts[name])
  const header = ['edition', 'title', 'theme', 'bg-sha', 'tokens-sha', 'assets', 'ai', 'payments']
    .map((k) => k.padEnd(12))
    .join('  ')
  console.log(`\n${header}`)
  for (const r of rows) {
    console.log(
      [
        r.edition.padEnd(12),
        r.title.slice(0, 12).padEnd(12),
        r.theme.padEnd(12),
        r.bgSha.padEnd(12),
        r.tokensSha.padEnd(12),
        String(r.assets).padEnd(12),
        (r.ai.length > 0 ? 'yes' : 'NO').padEnd(12),
        r.payments.length > 0 ? 'yes' : 'NO',
      ].join('  '),
    )
  }

  const fails = evaluateMatrix({ facts, expected })
  if (fails.length > 0) {
    console.error(`\nbuild-matrix: ${fails.length} FAIL(s):`)
    for (const f of fails) console.error('  FAIL ' + f)
    process.exit(1)
  }
  console.log('\nbuild-matrix: green -- facts match every edition\'s source of record')
}
