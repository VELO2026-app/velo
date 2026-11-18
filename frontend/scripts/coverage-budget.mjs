// Coverage ratchet gate (FE-157 5A.1), the same model as lint-budget.mjs:
// coverage-budget.json holds the floors, and coverage may only go up.
//
// Reads coverage/coverage-summary.json (written by `pnpm test:coverage`),
// prints a markdown table with the delta against every floor and appends it
// to $GITHUB_STEP_SUMMARY when that is set (CI). Exit code 1 when any metric
// is below its floor. A metric well above its floor is not an error, but the
// table asks to raise the floor -- a ratchet that never tightens guards nothing.
//
// FE-204: CI merges the coverage of test shards. A merge only knows the files
// some shard loaded, so an app file no test imports would silently drop out
// of the denominator. Every app file must therefore be in the report; a
// missing one fails here rather than flattering the percentage.
import { appendFileSync, existsSync, globSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const METRICS = ['statements', 'branches', 'functions', 'lines']
const summaryPath = new URL('../coverage/coverage-summary.json', import.meta.url)
if (!existsSync(summaryPath)) {
  console.error(
    'coverage-budget: no coverage/coverage-summary.json -- run `pnpm test:coverage` first',
  )
  process.exit(1)
}
const summary = JSON.parse(readFileSync(summaryPath, 'utf8'))
const total = summary.total

// The same set as vitest.config.ts coverage.include minus its exclude (and
// the setup files, which Vitest leaves out of coverage on its own).
const root = fileURLToPath(new URL('..', import.meta.url))
const reported = new Set(Object.keys(summary).map((f) => f.replaceAll('\\', '/')))
const NOT_APP = /(\.test\.ts|\.d\.ts)$|^src\/main\.ts$|^src\/test-setup(\.node)?\.ts$/
const missing = globSync('src/**/*.{ts,vue}', { cwd: root })
  .filter((f) => !NOT_APP.test(f))
  .filter((f) => !reported.has(`${root}${f}`.replaceAll('\\', '/')))
if (missing.length) {
  console.error(
    `coverage-budget: ${missing.length} app file(s) missing from the report -- no test loads them:\n  ${missing.join('\n  ')}`,
  )
  process.exit(1)
}
const budget = JSON.parse(readFileSync(new URL('../coverage-budget.json', import.meta.url), 'utf8'))

// A floor trailing the measurement by this many points (percent) is stale.
const RAISE_AT = 0.2

const failures = []
const rows = METRICS.map((m) => {
  const actual = total[m].pct
  const floor = budget[m]
  const delta = actual - floor
  let status = 'ok'
  if (actual < floor) {
    status = 'BELOW FLOOR'
    failures.push(`${m} ${actual}% < ${floor}%`)
  } else if (delta >= RAISE_AT) {
    // Rounded down to 0.1, the value to paste into coverage-budget.json.
    status = `raise the floor to ${(Math.floor(actual * 10) / 10).toFixed(1)}`
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
