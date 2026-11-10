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
import { readFileSync } from 'node:fs'

const budget = JSON.parse(readFileSync(new URL('../lint-budget.json', import.meta.url), 'utf8'))
// Content-hash cache (CI: restored by actions/cache). `content`, not the
// default `metadata`: a fresh checkout has new mtimes on every file, which
// would invalidate a metadata cache on each run. The cache lives under
// node_modules (git-ignored, outside both source trees). ESLint stores the
// warnings of a cached file too, so the --max-warnings budget stays exact.
const cacheArgs = (name) => [
  '--cache',
  '--cache-strategy',
  'content',
  '--cache-location',
  `node_modules/.cache/eslint/${name}.json`,
]
const args = ['src/', '--max-warnings', String(budget.maxWarnings)]

const fe = spawnSync('node_modules/.bin/eslint', [...args, ...cacheArgs('app')], {
  stdio: 'inherit',
})
if (fe.error) throw fe.error
if (fe.status !== 0) process.exit(fe.status ?? 1)

const ui = spawnSync('node_modules/.bin/eslint', [...args, ...cacheArgs('ui')], {
  stdio: 'inherit',
  cwd: '../packages/velo-ui',
})
if (ui.error) throw ui.error
process.exit(ui.status ?? 1)
