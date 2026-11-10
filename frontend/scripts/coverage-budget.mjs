// Coverage ratchet gate (FE-157 5A.1), the same model as lint-budget.mjs:
// coverage-budget.json holds the floors, and coverage may only go up.
//
// Reads coverage/coverage-summary.json (written by `pnpm test:coverage`),
// prints a markdown table with the delta against every floor and appends it
// to $GITHUB_STEP_SUMMARY when that is set (CI). Exit code 1 when any metric
// is below its floor. A metric well above its floor is not an error, but the
// table asks to raise the floor -- a ratchet that never tightens guards nothing.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

const METRICS = ['statements', 'branches', 'functions', 'lines']
const summaryPath = new URL('../coverage/coverage-summary.json', import.meta.url)
if (!existsSync(summaryPath)) {
  console.error(
    'coverage-budget: no coverage/coverage-summary.json -- run `pnpm test:coverage` first',
  )
  process.exit(1)
}
const total = JSON.parse(readFileSync(summaryPath, 'utf8')).total
const budget = JSON.parse(readFileSync(new URL('../coverage-budget.json', import.meta.url), 'utf8'))

const failures = []
const rows = METRICS.map((m) => {
  const actual = total[m].pct
  const floor = budget[m]
  const delta = actual - floor
  let status = 'ok'
  if (actual < floor) {
    status = 'BELOW FLOOR'
    failures.push(`${m} ${actual}% < ${floor}%`)
  } else if (delta >= 0.5) {
    status = 'raise the floor'
  }
  const sign = delta >= 0 ? '+' : ''
  return `| ${m} | ${total[m].covered}/${total[m].total} | ${actual.toFixed(2)}% | ${floor.toFixed(1)}% | ${sign}${delta.toFixed(2)} | ${status} |`
})
const md = [
  '### Coverage (v8, src/**/*.{ts,vue})',
  '',
  '| metric | covered | actual | floor | delta | status |',
  '| --- | --- | --- | --- | --- | --- |',
  ...rows,
  '',
].join('\n')

console.log(md)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`)
if (failures.length) {
  console.error(`coverage-budget: below the floor -- ${failures.join('; ')}`)
  process.exit(1)
}
