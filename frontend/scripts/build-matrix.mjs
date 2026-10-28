// =============================================================================
// VELO Frontend -- build matrix (tz-whitelabel F5.1 acceptance prototype)
// =============================================================================
// Builds THREE editions from the current working tree and prints the diff
// report the F5 acceptance reads (§6.1: «из одного коммита собираются VELO
// (золотой) + 2 тестовых бренда; отчёт-диф ассетов и токенов»):
//
//   golden         apply-skin --remove      -> the VELO reference
//   test-contrast  skins/test-contrast      -> the intentionally contrasty skin
//   nightfall      skins/nightfall          -> the show-piece skin
//
// apply-skin validates each package BEFORE it lands (a rejected package
// aborts the matrix), then `vite build` runs and the dist facts are
// snapshotted: brand title, theme-color, background/tokens hashes, asset
// count, and whether the gated modules' chunks survived (§4 cross-check).
//
// The run ENDS on the edition that was applied before it started, with a
// fresh build -- dist/ (what the stand serves) matches the tree the matrix
// found. ~3 min: four full builds.
//
// Usage: node scripts/build-matrix.mjs      (or: pnpm build:matrix)
// =============================================================================
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const frontendDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const skinDir = join(frontendDir, 'public', 'skin')
const distDir = join(frontendDir, 'dist')

const run = (cmd, args) => {
  const res = spawnSync(cmd, args, { cwd: frontendDir, stdio: 'inherit' })
  if (res.status !== 0) {
    console.error(
      `build-matrix: \`${[cmd, ...args].join(' ')}\` failed -- the tree keeps the LAST applied edition`,
    )
    process.exit(1)
  }
}
const apply = (arg) => run('node', ['scripts/apply-skin.mjs', arg])
const build = () => run('node_modules/.bin/vite', ['build'])
const sha12 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12)

function snapshot(name) {
  const html = readFileSync(join(distDir, 'index.html'), 'utf8')
  const theme = html.match(/theme-color" content="([^"]*)/)?.[1] ?? '?'
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '?'
  const bgPath = join(distDir, 'bg', 'background.png')
  const bg = existsSync(bgPath) ? sha12(bgPath) : 'absent'
  const tokensPath = join(skinDir, 'tokens.css')
  const tokens = existsSync(tokensPath) ? sha12(tokensPath) : 'golden'
  const assets = readdirSync(join(distDir, 'assets'))
  const has = (re) => (assets.some((a) => re.test(a)) ? 'yes' : 'NO')
  return {
    edition: name.padEnd(14),
    title: title.slice(0, 18).padEnd(18),
    theme: theme.padEnd(9),
    'bg-sha': bg,
    'tokens-sha': tokens.padEnd(14),
    assets: String(assets.length).padEnd(5),
    ai: has(/AiSummary|AiConnections/).padEnd(4),
    payments: has(/Topup/),
  }
}

// The pre-run edition: whatever public/skin holds now, matched back to a
// skins/<name> package by its display name; anything else restores golden.
function currentEdition() {
  const brandPath = join(skinDir, 'brand.json')
  if (!existsSync(brandPath)) return '--remove'
  const name = JSON.parse(readFileSync(brandPath, 'utf8')).name
  const skinsDir = join(frontendDir, 'skins')
  for (const dir of existsSync(skinsDir) ? readdirSync(skinsDir) : []) {
    const pkg = join(skinsDir, dir, 'brand.json')
    if (existsSync(pkg) && JSON.parse(readFileSync(pkg, 'utf8')).name === name) return dir
  }
  return '--remove'
}

const before = currentEdition()
console.log(`build-matrix: three editions from one tree (restores "${before}" at the end)\n`)

const rows = []
for (const [name, arg] of [
  ['golden', '--remove'],
  ['test-contrast', 'test-contrast'],
  ['nightfall', 'nightfall'],
]) {
  apply(arg)
  build()
  rows.push(snapshot(name))
}

// Restore the owner's pre-run edition and rebuild onto it, so dist/ matches
// the tree the matrix found. The last matrix edition already IS nightfall --
// skip the fourth build when that is also the pre-run state.
if (before !== 'nightfall') {
  apply(before)
  build()
} else {
  apply(before)
}

const header = Object.keys(rows[0])
  .map((k) => k.padEnd(Math.max(k.length, 12)))
  .join('  ')
console.log(`\n${header}`)
for (const row of rows) console.log(Object.values(row).join('  '))
console.log('\nbuild-matrix: done')
