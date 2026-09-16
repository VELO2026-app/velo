// Lint gate with the warning budget (FE-73 ratchet policy).
// Runs eslint over src/ with --max-warnings from lint-budget.json and
// propagates eslint's exit code: more warnings than the budget -> failure.
// The budget may only decrease; lowering it is part of the fixing commit.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const budget = JSON.parse(readFileSync(new URL('../lint-budget.json', import.meta.url), 'utf8'))

const res = spawnSync(
  'node_modules/.bin/eslint',
  ['src/', '--max-warnings', String(budget.maxWarnings)],
  { stdio: 'inherit' },
)
if (res.error) throw res.error
process.exit(res.status ?? 1)
