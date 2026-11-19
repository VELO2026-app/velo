// Lint gate with the warning budget (FE-73 ratchet policy).
// Runs eslint over src/ with --max-warnings from lint-budget.json and
// propagates eslint's exit code: more warnings than the budget -> failure.
// The budget may only decrease; lowering it is part of the fixing commit.
//
// FE-116 (tz-ui-package.md §3.7): the gate also covers packages/velo-ui.
// ESLint flat config refuses files outside the config's base path
// ("File ignored because outside of base path", verified on eslint 9.39),
// so the package carries its own eslint.config.js -- a mirror of this
// app's law -- and this script runs it from the package directory under
// the SAME budget.
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { findRuleDisables } from '../eslint-rules/directives.mjs'

const budget = JSON.parse(readFileSync(new URL('../lint-budget.json', import.meta.url), 'utf8'))

// FE-203: no inline directive may switch the test rules off (see
// eslint-rules/directives.mjs for why ESLint cannot check this itself).
// Scans the files the rules lint: the tests and vitest configs of both
// packages, and the app's Playwright suite (FE-211).
const testRoots = ['.', '../packages/velo-ui']
/** The files under `dir` whose name ends with `suffix`, as paths. */
const filesIn = (dir, suffix) =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith(suffix))
    .map((f) => path.join(dir, f))
const disables = []
for (const root of testRoots) {
  const files = filesIn(path.join(root, 'src'), '.test.ts')
  if (root === '.') files.push(...filesIn('e2e', '.ts'))
  for (const file of [...files, path.join(root, 'vitest.config.ts')]) {
    for (const hit of findRuleDisables(readFileSync(file, 'utf8'))) {
      disables.push(`${file}:${hit.line}  ${hit.text}`)
    }
  }
}
if (disables.length > 0) {
  console.error(
    'FE-203: these directives switch the velo-tests rules off. Fix the test instead, ' +
      'or count a known debt in eslint-rules/test-lint-allowlist.json:',
  )
  for (const d of disables) console.error(`  ${d}`)
  process.exit(1)
}
// Content-hash cache (CI: restored by actions/cache). `content`, not the
// default `metadata`: a fresh checkout has new mtimes on every file, which
// would invalidate a metadata cache on each run. The cache lives under
// node_modules (git-ignored, outside both source trees). ESLint stores the
// warnings of a cached file too, so the --max-warnings budget stays exact.
// Limit: an entry is invalidated only by ITS file or the config, while the
// type-aware rules read types from other files -- after a cross-file type
// change a local cached run can stay green where a cold run fails. CI reuses
// a cache only for identical lint inputs (ci.yml), so the gate stays cold.
const cacheArgs = (name) => [
  '--cache',
  '--cache-strategy',
  'content',
  '--cache-location',
  `node_modules/.cache/eslint/${name}.json`,
]
const args = ['src/', '--max-warnings', String(budget.maxWarnings)]
// FE-157 5C: the app run also covers its build tooling (scripts/*.mjs, the
// local ESLint plugin in eslint-rules/, the Vite/Vitest configs, and the
// Playwright suite); the kit package has no such files.
const appArgs = [
  'scripts/',
  'eslint-rules/',
  'e2e/',
  'playwright.config.ts',
  'vite.config.ts',
  'vitest.config.ts',
  ...args,
]

const fe = spawnSync('node_modules/.bin/eslint', [...appArgs, ...cacheArgs('app')], {
  stdio: 'inherit',
})
if (fe.error) throw fe.error
if (fe.status !== 0) process.exit(fe.status ?? 1)

// The kit's vitest.config.ts carries the FE-203 timeout/retry check.
const ui = spawnSync(
  'node_modules/.bin/eslint',
  ['vitest.config.ts', ...args, ...cacheArgs('ui')],
  {
    stdio: 'inherit',
    cwd: '../packages/velo-ui',
  },
)
if (ui.error) throw ui.error
process.exit(ui.status ?? 1)
