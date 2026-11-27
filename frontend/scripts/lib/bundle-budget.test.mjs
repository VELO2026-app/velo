// =============================================================================
// FE-183 -- unit tests for the bundle budget rules
// (Vitest, the `scripts` project of vitest.config.ts).
// =============================================================================
import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
  assertBudgetShape,
  budgetFor,
  checkBudget,
  checkBudgetRaise,
  suggestBudget,
  CEILING_LABEL,
  GROWTH_LABEL,
} from './bundle-budget.mjs'

const BUDGET = {
  entryGzip: 100000,
  precacheBytes: 500000,
  startupGzip: 110000,
  ceiling: { entryGzip: 150000, precacheBytes: 1000000, startupGzip: 150000 },
  skinned: {
    package: 'brand 1.0.0',
    entryGzip: 100500,
    precacheBytes: 600000,
    startupGzip: 110500,
  },
}
const at = (entryGzip, precacheBytes, startupGzip = 110000) => ({
  entryGzip,
  precacheBytes,
  startupGzip,
})

test('a build equal to the budget passes', () => {
  const { failures, md } = checkBudget(at(100000, 500000), BUDGET)
  assert.deepEqual(failures, [])
  assert.match(md, /Bundle budget: ok/)
  assert.doesNotMatch(md, /--modules/)
})

test('the window is +-2%: edges pass, one byte beyond fails', () => {
  assert.deepEqual(checkBudget(at(102000, 510000), BUDGET).failures, [])
  assert.deepEqual(checkBudget(at(98000, 490000), BUDGET).failures, [])
  assert.equal(checkBudget(at(102001, 500000), BUDGET).failures.length, 1)
  assert.equal(checkBudget(at(100000, 510001), BUDGET).failures.length, 1)
})

test('over the budget points at the label and at --modules', () => {
  const { failures, md } = checkBudget(at(103000, 500000), BUDGET)
  assert.equal(failures.length, 1)
  assert.match(failures[0], /over the budget/)
  assert.match(failures[0], new RegExp(GROWTH_LABEL))
  assert.match(md, /node frontend\/scripts\/bundle-report\.mjs --modules/)
})

test('below the budget by more than 2% fails with a ready number', () => {
  const { failures } = checkBudget(at(90000, 500000), BUDGET)
  assert.equal(failures.length, 1)
  assert.match(failures[0], /lower the budget to 90900/)
})

test('the suggested budget passes the same gate and is rounded up', () => {
  for (const actual of [90000, 97999, 12345, 1000]) {
    const next = { ...BUDGET, entryGzip: suggestBudget(actual) }
    assert.deepEqual(checkBudget(at(actual, 500000), next).failures, [], String(actual))
  }
  assert.equal(suggestBudget(1000), 1010)
  assert.equal(suggestBudget(12345), 12469)
})

test('the ceiling has no tolerance and fails even when the budget allows it', () => {
  const wide = { ...BUDGET, entryGzip: 152000 }
  assert.deepEqual(checkBudget(at(150000, 500000), wide).failures, [])
  const { failures } = checkBudget(at(150001, 500000), wide)
  assert.equal(failures.length, 1)
  assert.match(failures[0], /over the ceiling/)
  assert.match(failures[0], new RegExp(CEILING_LABEL))
  const pre = checkBudget(at(100000, 1000001), { ...BUDGET, precacheBytes: 1000001 })
  assert.match(pre.failures[0], /over the ceiling/)
})

test('the startup JS has its own window and ceiling (FE-169)', () => {
  assert.deepEqual(checkBudget(at(100000, 500000, 112200), BUDGET).failures, [])
  const [over] = checkBudget(at(100000, 500000, 112201), BUDGET).failures
  assert.match(over, /startup JS gzip .* over the budget/)
  const wide = { ...BUDGET, startupGzip: 152000 }
  assert.match(checkBudget(at(100000, 500000, 150001), wide).failures[0], /over the ceiling/)
})

test('over the ceiling and over the budget reports both', () => {
  assert.equal(checkBudget(at(160000, 500000), BUDGET).failures.length, 2)
})

test('an unmeasured precache fails', () => {
  const { failures } = checkBudget(at(100000, null), BUDGET)
  assert.equal(failures.length, 1)
  assert.match(failures[0], /no sw\.js/)
})

test('the report shows the delta against the base build, n/a without one', () => {
  const withBase = checkBudget(at(101000, 500000), BUDGET, at(100000, 500000)).md
  assert.match(withBase, /\+1\.00 kB \(\+1\.0%\)/)
  const without = checkBudget(at(101000, 500000), BUDGET).md
  assert.match(without, /\| n\/a \|/)
})

test('assertBudgetShape wants numeric budget and ceiling', () => {
  assert.doesNotThrow(() => assertBudgetShape(BUDGET))
  assert.throws(() => assertBudgetShape({ ...BUDGET, entryGzip: 'x' }), /entryGzip/)
  assert.throws(() => assertBudgetShape({ ...BUDGET, ceiling: undefined }), /ceiling\.entryGzip/)
  assert.throws(
    () => assertBudgetShape({ ...BUDGET, ceiling: { entryGzip: 1 } }),
    /ceiling\.precacheBytes/,
  )
})

// --- label rule (the guard job) ---------------------------------------------

test('no raise, no label needed; lowering needs no label', () => {
  assert.deepEqual(checkBudgetRaise(BUDGET, BUDGET, []), [])
  assert.deepEqual(
    checkBudgetRaise(BUDGET, { ...BUDGET, entryGzip: 90000, precacheBytes: 1 }, []),
    [],
  )
})

test('raising a budget value without the label fails, with it passes', () => {
  const head = { ...BUDGET, entryGzip: 100001 }
  const failures = checkBudgetRaise(BUDGET, head, [])
  assert.equal(failures.length, 1)
  assert.match(failures[0], /entryGzip raised 100000 -> 100001/)
  assert.deepEqual(checkBudgetRaise(BUDGET, head, [GROWTH_LABEL]), [])
})

test('raising one value and lowering the other still needs the label', () => {
  const head = { ...BUDGET, entryGzip: 90000, precacheBytes: 500001 }
  assert.equal(checkBudgetRaise(BUDGET, head, []).length, 1)
})

test('raising the ceiling needs bundle-ceiling; bundle-growth is not enough', () => {
  const head = { ...BUDGET, ceiling: { ...BUDGET.ceiling, entryGzip: 160000 } }
  assert.equal(checkBudgetRaise(BUDGET, head, []).length, 1)
  assert.equal(checkBudgetRaise(BUDGET, head, [GROWTH_LABEL]).length, 1)
  assert.deepEqual(checkBudgetRaise(BUDGET, head, [CEILING_LABEL]), [])
})

test('both raised needs both labels', () => {
  const head = { ...BUDGET, entryGzip: 101000, ceiling: { ...BUDGET.ceiling, entryGzip: 160000 } }
  assert.equal(checkBudgetRaise(BUDGET, head, []).length, 2)
  assert.equal(checkBudgetRaise(BUDGET, head, [GROWTH_LABEL]).length, 1)
  assert.deepEqual(checkBudgetRaise(BUDGET, head, [GROWTH_LABEL, CEILING_LABEL]), [])
})

test('removing a value or the ceiling counts as a raise', () => {
  const noCeiling = {
    entryGzip: 100000,
    precacheBytes: 500000,
    startupGzip: 110000,
    skinned: BUDGET.skinned,
  }
  assert.equal(checkBudgetRaise(BUDGET, noCeiling, []).length, 3)
  assert.equal(
    checkBudgetRaise(BUDGET, { ceiling: BUDGET.ceiling, skinned: BUDGET.skinned }, []).length,
    3,
  )
})

// --- the skinned line (FE-230) ---------------------------------------------

test('a skinned build is checked against the skinned line and the shared ceiling', () => {
  const skinned = budgetFor(BUDGET, true)
  assert.deepEqual(checkBudget(at(100500, 600000), skinned).failures, [])
  // The core line would call the same build too big.
  assert.equal(checkBudget(at(100500, 600000), budgetFor(BUDGET, false)).failures.length, 1)
  const { failures, md } = checkBudget(at(100500, 500000), skinned)
  assert.match(failures[0], /lower the budget to \d+ \(skinned\.precacheBytes/)
  assert.match(md, /Bundle budget \(skinned build, brand 1\.0\.0\): FAIL/)
})

test('raising the skinned line needs the growth label; a skinned build needs the line', () => {
  const head = { ...BUDGET, skinned: { ...BUDGET.skinned, precacheBytes: 600001 } }
  assert.match(checkBudgetRaise(BUDGET, head, [])[0], /skinned\.precacheBytes raised/)
  assert.deepEqual(checkBudgetRaise(BUDGET, head, [GROWTH_LABEL]), [])
  assert.throws(
    () => assertBudgetShape({ ...BUDGET, skinned: { precacheBytes: 1 } }),
    /skinned\.entryGzip/,
  )
  assert.throws(() => budgetFor({ ...BUDGET, skinned: undefined }, true), /no `skinned` line/)
})

test('a base without a ceiling has the FE-157 targets: introducing them is no raise, a higher ceiling is', () => {
  const base = { entryGzip: 100000, precacheBytes: 500000 }
  assert.deepEqual(checkBudgetRaise(base, BUDGET, []), [])
  const higher = { ...BUDGET, ceiling: { ...BUDGET.ceiling, entryGzip: 160000 } }
  assert.equal(checkBudgetRaise(base, higher, []).length, 1)
  assert.deepEqual(checkBudgetRaise(base, higher, [CEILING_LABEL]), [])
})

test('introducing the startup metric at the FE-157 target is no raise (FE-169)', () => {
  const {
    startupGzip: _s,
    ceiling: { startupGzip: _c, ...ceiling },
    ...rest
  } = BUDGET
  const { startupGzip: _k, ...skinned } = BUDGET.skinned
  const base = { ...rest, ceiling, skinned }
  assert.deepEqual(checkBudgetRaise(base, BUDGET, []), [])
  const higher = { ...BUDGET, ceiling: { ...BUDGET.ceiling, startupGzip: 150001 } }
  assert.match(checkBudgetRaise(base, higher, [])[0], /ceiling\.startupGzip raised/)
})

test('a base without a budget file checks nothing', () => {
  assert.deepEqual(checkBudgetRaise(null, BUDGET, []), [])
})
