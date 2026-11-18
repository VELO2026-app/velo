// FE-203: the test rules are themselves checks (docs/testing.md rule 7
// exception), so each catches what it names, lets the safe twin through, and
// the exception list ratchets: over -> every finding, equal -> pass, under ->
// "lower the entry".
import path from 'node:path'
import { RuleTester } from 'eslint'
import { describe, it } from 'vitest'
import noFixedSleep from './no-fixed-sleep.mjs'
import noFlakeMasking from './no-flake-masking.mjs'
import { REPO_ROOT } from './ratchet.mjs'

RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
})
const FILE = path.join(REPO_ROOT, 'frontend/src/sample.test.js')
const KEY = 'frontend/src/sample.test.js'

tester.run('no-fixed-sleep', noFixedSleep, {
  valid: [
    // One macrotask is a flush, not a pause.
    { filename: FILE, code: 'await new Promise((r) => setTimeout(r, 0))' },
    { filename: FILE, code: 'await new Promise((r) => setTimeout(r))' },
    // A timer outside a Promise is the code under test's business.
    { filename: FILE, code: 'setTimeout(tick, 500)' },
    { filename: FILE, code: 'await vi.advanceTimersByTimeAsync(500)' },
    // The ratchet: exactly the allowed count passes.
    {
      filename: FILE,
      code: 'await new Promise((r) => setTimeout(r, 500))',
      options: [{ allow: { [KEY]: 1 } }],
    },
  ],
  invalid: [
    {
      filename: FILE,
      code: 'await new Promise((r) => setTimeout(r, 500))',
      errors: [{ messageId: 'sleep' }],
    },
    {
      filename: FILE,
      code: 'const sleep = (ms) => new Promise((r) => setTimeout(r, ms))',
      errors: [{ messageId: 'sleep' }],
    },
    {
      // A mock that settles after a delay.
      filename: FILE,
      code: 'mock(() => new Promise((resolve) => { window.setTimeout(() => resolve(), 50) }))',
      errors: [{ messageId: 'sleep' }],
    },
    {
      filename: FILE,
      code: "import { setTimeout as wait } from 'node:timers/promises'",
      errors: [{ messageId: 'promisesTimer' }],
    },
    {
      // Over the allowance: every finding is reported.
      filename: FILE,
      code: 'await new Promise((r) => setTimeout(r, 1)); await new Promise((r) => setTimeout(r, 2))',
      options: [{ allow: { [KEY]: 1 } }],
      errors: [{ messageId: 'sleep' }, { messageId: 'sleep' }],
    },
    {
      // Under the allowance: the list must shrink.
      filename: FILE,
      code: 'await flush()',
      options: [{ allow: { [KEY]: 1 } }],
      errors: [{ messageId: 'shrinkAllowlist' }],
    },
  ],
})

tester.run('no-flake-masking', noFlakeMasking, {
  valid: [
    { filename: FILE, code: "it('x', () => {})" },
    { filename: FILE, code: "it('x', { timeout: 1000 }, () => {})" },
    { filename: FILE, code: "it('x', () => {}, 5000)" },
    { filename: FILE, code: "it('x', { retry: 0 }, () => {})" },
    { filename: FILE, code: "// FE-123: the upstream fix lands first\nit.skip('x', () => {})" },
    { filename: FILE, code: "it.skip('x', () => {}) // BE-7" },
    // Not the test API: a query's own retry, a context skip.
    { filename: FILE, code: 'useQuery({ retry: 3 })' },
    { filename: FILE, code: 'ctx.skip()' },
    {
      filename: path.join(REPO_ROOT, 'frontend/vitest.config.ts'),
      code: 'export default { test: { testTimeout: 5000 } }',
    },
  ],
  invalid: [
    {
      filename: FILE,
      code: "it('x', { retry: 3 }, () => {})",
      errors: [{ messageId: 'retry' }],
    },
    {
      filename: FILE,
      code: "describe('x', { timeout: T }, () => {})",
      errors: [{ messageId: 'timeout' }],
    },
    {
      filename: FILE,
      code: "it('x', () => {}, 10000)",
      errors: [{ messageId: 'timeout' }],
    },
    {
      filename: FILE,
      code: 'beforeEach(() => {}, 20_000)',
      errors: [{ messageId: 'timeout' }],
    },
    {
      filename: FILE,
      code: "it.each([1])('x %s', () => {}, 9000)",
      errors: [{ messageId: 'timeout' }],
    },
    {
      filename: FILE,
      code: 'vi.setConfig({ testTimeout: 10000, retry: 1 })',
      errors: [{ messageId: 'timeout' }, { messageId: 'retry' }],
    },
    {
      filename: FILE,
      code: "it.skip('x', () => {})",
      errors: [{ messageId: 'skip' }],
    },
    {
      filename: FILE,
      code: "describe.skipIf(flag)('x', () => {})",
      errors: [{ messageId: 'skip' }],
    },
    {
      filename: path.join(REPO_ROOT, 'frontend/vitest.config.ts'),
      code: 'export default { test: { testTimeout: 10000, retry: 2 } }',
      errors: [{ messageId: 'timeout' }, { messageId: 'retry' }],
    },
  ],
})
