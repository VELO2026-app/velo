// Bundle budget guard (FE-183): the label rule of bundle-budget.json.
//
// Runs in the `bundle-budget-guard` job of .github/workflows/bundle-budget.yml
// (FE-206): no install, no build. Compares
// bundle-budget.json of the base branch with the head and fails when a budget
// value was raised without the `bundle-growth` label, or a ceiling value
// without `bundle-ceiling`. Rules: scripts/lib/bundle-budget.mjs, policy:
// docs/agents/bundle.md.
//
// Usage (repository root):
//   node frontend/scripts/bundle-budget-guard.mjs --base <file> --labels <json>
//     --base <file>    bundle-budget.json of the base branch; a missing file
//                      means the base has no budget and nothing is compared
//     --labels <json>  JSON array of the PR label names
// The head file is frontend/bundle-budget.json. The summary is also appended
// to $GITHUB_STEP_SUMMARY when that is set.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertBudgetShape, checkBudgetRaise } from './lib/bundle-budget.mjs'

const argv = process.argv.slice(2)
const flagValue = (name) => {
  const at = argv.indexOf(name)
  return at === -1 ? undefined : argv[at + 1]
}

const headPath = join(fileURLToPath(new URL('..', import.meta.url)), 'bundle-budget.json')
const head = JSON.parse(readFileSync(headPath, 'utf8'))
assertBudgetShape(head, headPath)
const basePath = flagValue('--base')
const base = basePath && existsSync(basePath) ? JSON.parse(readFileSync(basePath, 'utf8')) : null
const labels = JSON.parse(flagValue('--labels') ?? '[]')

const failures = checkBudgetRaise(base, head, labels)
const md = [
  `### Bundle budget guard: ${failures.length ? 'FAIL' : 'ok'}`,
  '',
  `Labels: ${labels.length ? labels.map((l) => `\`${l}\``).join(', ') : 'none'}`,
  ...(base ? [] : ['', 'The base branch has no bundle-budget.json: nothing to compare.']),
  ...(failures.length ? ['', ...failures.map((f) => `- ${f}`)] : []),
].join('\n')
console.log(md)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`)
if (failures.length) process.exit(1)
