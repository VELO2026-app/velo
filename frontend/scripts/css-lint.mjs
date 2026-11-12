// Stylelint gate with the warning budget (FE-157 5A.3), the same ratchet
// model as lint-budget.mjs: the rules the recommended-vue preset adds that
// the code does not satisfy yet are set to severity `warning` in
// .stylelintrc.json, and --max-warnings is read from lint-budget.json
// (`maxCssWarnings`). More warnings than the budget -> failure; every error
// (the token law, the other preset rules) fails regardless. The budget may
// only decrease; lowering it is part of the fixing commit.
//
// One run over the app and the kit (packages/velo-ui): the kit's own
// `pnpm lint` extends this config but has no budget of its own, so its
// budgeted warnings do not fail it.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const budget = JSON.parse(readFileSync(new URL('../lint-budget.json', import.meta.url), 'utf8'))

const run = spawnSync(
  'node_modules/.bin/stylelint',
  [
    'src/**/*.{css,vue}',
    '../packages/velo-ui/src/**/*.{css,vue}',
    '--max-warnings',
    String(budget.maxCssWarnings),
  ],
  { stdio: 'inherit' },
)
if (run.error) throw run.error
process.exit(run.status ?? 1)
