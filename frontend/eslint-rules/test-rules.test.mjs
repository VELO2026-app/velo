// FE-203: the test rules are themselves checks (docs/testing.md rule 7
// exception), so each catches what it names, lets the safe twin through, and
// the exception list ratchets: over -> every finding, equal -> pass, under ->
// "lower the entry".
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { RuleTester } from 'eslint'
import { describe, expect, it } from 'vitest'
import { findRuleDisables } from './directives.mjs'
import { loadAllowlist } from './index.mjs'
import noFixedSleep from './no-fixed-sleep.mjs'
import noFlakeMasking from './no-flake-masking.mjs'
import noHeadersOutsideApi from './no-headers-outside-api.mjs'
import noWaitForTimeout from './no-wait-for-timeout.mjs'
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

const SPEC = path.join(REPO_ROOT, 'frontend/e2e/sample.spec.ts')
const SPEC_KEY = 'frontend/e2e/sample.spec.ts'

tester.run('no-wait-for-timeout', noWaitForTimeout, {
  valid: [
    // Waits that name what they wait for.
    { filename: SPEC, code: 'await expect(page.getByRole("button")).toBeVisible()' },
    { filename: SPEC, code: 'await page.clock.runFor(60_000)' },
    { filename: SPEC, code: 'await page.waitForResponse("**/api/v1/users/me")' },
    // A detached method is a known gap (see the rule's header), not caught.
    { filename: SPEC, code: 'waitForTimeout(500)' },
    {
      filename: SPEC,
      code: 'await page.waitForTimeout(500)',
      options: [{ allow: { [SPEC_KEY]: 1 } }],
    },
  ],
  invalid: [
    {
      filename: SPEC,
      code: 'await page.waitForTimeout(1_000)',
      errors: [{ messageId: 'pause' }],
    },
    {
      // Whatever the argument and the receiver: the method only sleeps.
      filename: SPEC,
      code: 'await frame.waitForTimeout(delay); await page["waitForTimeout"](0)',
      errors: [{ messageId: 'pause' }, { messageId: 'pause' }],
    },
    {
      filename: SPEC,
      code: 'await page.clock.runFor(1)',
      options: [{ allow: { [SPEC_KEY]: 1 } }],
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
    // A hook's default is 10000 ms: that is not a raise.
    { filename: FILE, code: 'beforeAll(() => {}, 10000)' },
    {
      filename: FILE,
      code: "// skip: FE-123 the upstream fix lands first\nit.skip('x', () => {})",
    },
    { filename: FILE, code: "it.skipIf(slow)('x', () => {}) // skip: BE-7 no runner" },
    {
      filename: FILE,
      code: "it('x', (ctx) => {\n  // skip: DM-30 storage is off\n  ctx.skip()\n})",
    },
    // Not the test API: a query's own retry, a skip outside a test body.
    { filename: FILE, code: 'useQuery({ retry: 3 })' },
    { filename: FILE, code: 'function later(ctx) { ctx.skip() }' },
    {
      filename: path.join(REPO_ROOT, 'frontend/vitest.config.ts'),
      code: 'export default { test: { testTimeout: 5000, hookTimeout: 10000 } }',
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
      code: 'vi.setConfig({ testTimeout: 10000, hookTimeout: 15000, retry: 1 })',
      errors: [{ messageId: 'timeout' }, { messageId: 'timeout' }, { messageId: 'retry' }],
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
      filename: FILE,
      code: "it.runIf(flag)('x', () => {})",
      errors: [{ messageId: 'skip' }],
    },
    {
      // A bare task key is not a marker: `skip:` must name it.
      filename: FILE,
      code: "// FE-157 5C: a note\nit.skip('x', () => {})",
      errors: [{ messageId: 'skip' }],
    },
    {
      // Nor is a key of no team of ours.
      filename: FILE,
      code: "// skip: UTF-8 fixture\nit.skip('x', () => {})",
      errors: [{ messageId: 'skip' }],
    },
    {
      filename: FILE,
      code: "it('x', (ctx) => { ctx.skip() })",
      errors: [{ messageId: 'skip' }],
    },
    {
      filename: FILE,
      code: "test('x', ({ skip }) => { skip() })",
      errors: [{ messageId: 'skip' }],
    },
    {
      filename: path.join(REPO_ROOT, 'frontend/vitest.config.ts'),
      code: 'export default { test: { testTimeout: 10000, hookTimeout: 20000, retry: 2 } }',
      errors: [{ messageId: 'timeout' }, { messageId: 'timeout' }, { messageId: 'retry' }],
    },
  ],
})

describe('the exception list', () => {
  /** Writes a list into a temp dir and returns its absolute path. */
  function list(files) {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'fe203-')), 'list.json')
    writeFileSync(file, JSON.stringify({ files }))
    return file
  }
  const REAL = 'frontend/src/router/guards.test.ts'

  it('splits a valid list per rule', () => {
    expect(loadAllowlist(list({ [REAL]: { 'no-fixed-sleep': 2 } }))).toEqual({
      'no-fixed-sleep': { [REAL]: 2 },
      'no-flake-masking': {},
      'no-wait-for-timeout': {},
    })
  })

  it('takes an e2e file as a key (FE-211)', () => {
    const spec = 'frontend/e2e/entry.spec.ts'
    expect(loadAllowlist(list({ [spec]: { 'no-wait-for-timeout': 1 } }))).toMatchObject({
      'no-wait-for-timeout': { [spec]: 1 },
    })
  })

  it.each([
    ['a missing file', { 'frontend/src/gone.test.ts': { 'no-fixed-sleep': 1 } }, /does not exist/],
    ['an unknown rule', { [REAL]: { 'no-sleep': 1 } }, /unknown rule "no-sleep"/],
    ['a file the rules do not lint', { 'frontend/src/router/guards.ts': {} }, /not a file/],
  ])('rejects %s', (_name, files, message) => {
    expect(() => loadAllowlist(list(files))).toThrow(message)
  })
})

describe('directives that switch the rules off', () => {
  it('finds a velo-tests disable, a blanket disable and a rule-config comment', () => {
    const text = [
      '// eslint-disable-next-line velo-tests/no-fixed-sleep',
      'await new Promise((r) => setTimeout(r, 500)) // eslint-disable-line',
      '/* eslint-disable no-console, velo-tests/no-flake-masking -- flaky */',
      '/* eslint velo-tests/no-fixed-sleep: off */',
    ].join('\n')
    expect(findRuleDisables(text).map((d) => d.line)).toEqual([1, 2, 3, 4])
  })

  it('lets a disable of another rule and plain prose through', () => {
    const text = [
      '// eslint-disable-next-line @typescript-eslint/no-explicit-any',
      '// eslint flat config refuses files outside its base path',
    ].join('\n')
    expect(findRuleDisables(text)).toEqual([])
  })
})

tester.run('no-headers-outside-api', noHeadersOutsideApi, {
  valid: [
    "api.get('/a')",
    "api.post('/a', body)",
    "api.request('POST', '/a', { body, timeoutMs: 5 })",
    "api.request('GET', '/a')",
    "other.post('/a', body, { 'X-One': '1' })",
    "obj.fetch('/a')",
    // A local named fetch is not the global one.
    'async function f(fetch) { return await fetch() }',
  ],
  invalid: [
    { code: "fetch('/a')", errors: [{ messageId: 'fetch' }] },
    { code: "window.fetch('/a')", errors: [{ messageId: 'fetch' }] },
    { code: "globalThis.fetch('/a')", errors: [{ messageId: 'fetch' }] },
    {
      code: "api.post('/a', body, { 'Idempotency-Key': key })",
      errors: [{ messageId: 'postHeaders' }],
    },
    { code: "api.post('/a', body, h)", errors: [{ messageId: 'postHeaders' }] },
    {
      code: "api.request('POST', '/a', { body, headers: { 'X-One': '1' } })",
      errors: [{ messageId: 'requestHeaders' }],
    },
    {
      code: "api.request('POST', '/a', { body, headers })",
      errors: [{ messageId: 'requestHeaders' }],
    },
    { code: "api.request('POST', '/a', { ...opts })", errors: [{ messageId: 'requestHeaders' }] },
    {
      code: "api.request('POST', '/a', { ['headers']: h })",
      errors: [{ messageId: 'requestHeaders' }],
    },
    { code: "api.request('POST', '/a', opts)", errors: [{ messageId: 'requestHeaders' }] },
  ],
})
