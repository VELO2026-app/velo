// Quick lane for agent iterations: scoped feedback in seconds, NOT a gate.
// The total gate lives at commit (pre-commit -> pnpm verify) and stays
// authoritative -- this lane deliberately skips typecheck/build/full suite,
// because those answer "is the slice done", which is the commit's question.
// What runs here, per changed file only:
//   prettier --check  -> formatting
//   eslint --cache    -> same flat config as the gate, cached for speed
//   vitest related    -> tests importing the changed file
// First eslint run builds the type-aware program once (slow); later runs are
// cache hits unless the file changed. Cross-file type effects are exactly what
// this lane may miss -- that is accepted, the commit gate catches them.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
if (root.status !== 0) {
  console.error('verify-quick: not a git repo')
  process.exit(1)
}
const repoRoot = root.stdout.trim()

// Changed = staged + unstaged + untracked vs HEAD, frontend/src only.
// Porcelain paths are repo-root-relative; strip the frontend/ prefix.
const status = spawnSync('git', ['status', '--porcelain=v1', '-uall', '--', 'frontend'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
if (status.status !== 0) {
  console.error(status.stderr)
  process.exit(1)
}
const changed = status.stdout
  .split('\n')
  .map((line) => line.slice(3).trim().replace(/^"|"$/g, ''))
  .filter(Boolean)
  // Rename entries look like "old -> new"; both sides matter.
  .flatMap((p) => (p.includes(' -> ') ? p.split(' -> ') : [p]))
  .filter((p) => p.startsWith('frontend/src/'))
  .map((p) => relative('frontend', p))
  .filter((p) => existsSync(resolve(repoRoot, 'frontend', p)))

if (changed.length === 0) {
  console.log('verify-quick: no changes under frontend/src -- nothing to check')
  process.exit(0)
}

const prettierTargets = changed.filter((f) => /\.(css|vue|ts|js)$/.test(f))
const codeTargets = changed.filter((f) => /^src\/.*\.(ts|vue)$/.test(f) && !/\.test\.ts$/.test(f))

const fail = (name, res) => {
  console.error(`\nverify-quick: ${name} FAILED (exit ${res.status ?? '?'})`)
  process.exit(res.status ?? 1)
}

if (prettierTargets.length > 0) {
  const t = Date.now()
  const res = spawnSync(
    'node_modules/.bin/prettier',
    ['--check', ...prettierTargets],
    { stdio: 'inherit' },
  )
  console.log(`prettier: ${prettierTargets.length} file(s) in ${((Date.now() - t) / 1000).toFixed(1)}s`)
  if (res.status !== 0) fail('prettier', res)
}

if (codeTargets.length > 0) {
  const t = Date.now()
  const res = spawnSync(
    'node_modules/.bin/eslint',
    ['--cache', ...codeTargets],
    { stdio: 'inherit' },
  )
  console.log(`eslint (cached, type-aware): ${codeTargets.length} file(s) in ${((Date.now() - t) / 1000).toFixed(1)}s`)
  if (res.status !== 0) fail('eslint', res)

  const t2 = Date.now()
  const res2 = spawnSync(
    'node_modules/.bin/vitest',
    ['related', '--run', ...codeTargets],
    { stdio: 'inherit' },
  )
  console.log(`vitest related: ${((Date.now() - t2) / 1000).toFixed(1)}s`)
  if (res2.status !== 0) fail('vitest related', res2)
}

console.log('\nverify-quick: green (scoped). Commit gate (pnpm verify) still runs the full stack.')
