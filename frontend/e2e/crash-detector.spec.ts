/**
 * Self-checks of the crash detector (FE-161), on the API mocks.
 *
 * Each check breaks the page one way and asserts POSITIVELY that the detector
 * saw that signal: the watcher is attached by hand (watchCrashes) and its
 * verdict (`finish()`) must contain the expected kind. A broken detector --
 * a listener not wired, the binding gone -- turns these red. (A `test.fail()`
 * check could not tell: it is green on ANY failure, including a timeout of
 * the check itself.)
 *
 * These tests use the bare Playwright `test` on purpose -- the auto fixture
 * would fail them for the very breakage they cause. The last describe proves
 * the other half: the fixture of e2e/support/test.ts really fails a test.
 */
// eslint-disable-next-line no-restricted-imports -- see the header: the watcher is attached by hand
import { expect, test as bare, type Page } from '@playwright/test'
import { GLOBAL_ALLOWLIST } from './support/allowlist'
import { mockApi } from './support/api'
import { isAllowed, watchCrashes, type CrashSignal, type SignalKind } from './support/crashes'
import { mockSignedIn, seedSession } from './support/fixtures'
import { test } from './support/test'

/** Signed in with an empty but valid account, everything else as the test sets it. */
async function signedIn(page: Page): Promise<Awaited<ReturnType<typeof mockApi>>> {
  const api = await mockApi(page)
  mockSignedIn(api)
  await seedSession(page)
  return api
}

/** Poll the watcher until a signal of `kind` matching `message` shows up. */
async function expectSignal(
  signals: () => CrashSignal[] | Promise<CrashSignal[]>,
  kind: SignalKind,
  message: RegExp,
): Promise<void> {
  await expect
    .poll(async () => (await signals()).some((s) => s.kind === kind && message.test(s.message)), {
      message: `a ${kind} signal matching ${String(message)}`,
    })
    .toBe(true)
}

bare.describe('crash detector sees', () => {
  bare('an endpoint answering 500', async ({ page }) => {
    const watch = await watchCrashes(page)
    const api = await signedIn(page)
    api.on('GET', '/api/v1/bookings/me/upcoming', () => ({ status: 500, body: { detail: 'boom' } }))

    await page.goto('/user/dashboard')

    await expectSignal(
      () => watch.crashes.signals(),
      'api',
      /^GET \/api\/v1\/bookings\/me\/upcoming -> 500$/,
    )
  })

  bare('a screen throwing on a malformed answer', async ({ page }) => {
    const watch = await watchCrashes(page)
    const api = await signedIn(page)
    // An object where the dashboard expects the list: it filters and maps
    // over it while rendering.
    api.on('GET', '/api/v1/bookings/me/upcoming', { bookings: [] })

    await page.goto('/user/dashboard')

    await expectSignal(() => watch.crashes.signals(), 'reported', /TypeError/)
  })

  bare('an uncaught exception', async ({ page }) => {
    const watch = await watchCrashes(page)
    await signedIn(page)
    await page.goto('/user/dashboard')

    await page.evaluate(() =>
      setTimeout(() => {
        throw new Error('e2e: thrown from a timer')
      }),
    )

    await expectSignal(() => watch.crashes.signals(), 'exception', /thrown from a timer/)
  })

  bare('a lazy chunk that fails to load', async ({ page }) => {
    const watch = await watchCrashes(page)
    await page.route('**/assets/CalendarView-*.js', (route) => route.fulfill({ status: 404 }))
    await signedIn(page)

    await page.goto('/user/calendar')

    await expectSignal(
      () => watch.crashes.signals(),
      'asset',
      /^\/assets\/CalendarView-.*\.js -> 404$/,
    )
  })

  bare('a console.error', async ({ page }) => {
    const watch = await watchCrashes(page)
    await signedIn(page)
    await page.goto('/user/dashboard')

    await page.evaluate(() => console.error('e2e: something went wrong'))

    await expectSignal(() => watch.crashes.signals(), 'console', /something went wrong/)
  })

  bare('a visible error state', async ({ page }) => {
    const watch = await watchCrashes(page)
    await signedIn(page)
    await page.goto('/user/no-such-screen')
    await expect(page.getByTestId('not-found')).toBeVisible()

    expect(await watch.finish()).toContainEqual(expect.objectContaining({ kind: 'screen' }))
  })

  bare('a blank screen, and nothing else', async ({ page }) => {
    const watch = await watchCrashes(page)
    await signedIn(page)
    await page.goto('/user/dashboard')
    await expect(page.locator('main')).toBeVisible()

    // The app mounted fine; then everything it drew is gone.
    await page.evaluate(() => document.querySelector('#app')?.replaceChildren())

    expect(await watch.finish()).toEqual([expect.objectContaining({ kind: 'blank' })])
  })

  bare('a healthy screen as healthy', async ({ page }) => {
    const watch = await watchCrashes(page)
    await signedIn(page)
    await page.goto('/user/dashboard')
    await expect(page.locator('main')).toBeVisible()

    expect(await watch.finish()).toEqual([])
  })
})

test.describe('crash detector fixture', () => {
  // The other half of the contract: the auto fixture turns a signal into a
  // failed test. Paired with the positive checks above, a green test.fail()
  // here can only mean the fixture failed it.
  test('fails a test that produced a signal', async ({ page }) => {
    test.fail()
    await signedIn(page)
    await page.goto('/user/dashboard')
    await expect(page.locator('main')).toBeVisible()
    await page.evaluate(() => console.error('e2e: fixture must fail this test'))
  })

  test('allow() accepts a signal the test expects', async ({ page, crashes }) => {
    const api = await signedIn(page)
    api.on('GET', '/api/v1/e2e-probe', () => ({ status: 500, body: { detail: 'boom' } }))
    crashes.allow({
      reason: 'self-check: the 500 and the console line are the point of this test',
      api: [{ method: 'GET', path: /^\/api\/v1\/e2e-probe$/, status: 500 }],
      console: [/expected noise/],
    })
    await page.goto('/user/dashboard')

    await page.evaluate(async () => {
      await fetch('/api/v1/e2e-probe')
      console.error('e2e: expected noise')
    })

    expect(api.calls).toContain('GET /api/v1/e2e-probe')
    expect(crashes.signals()).toEqual([])
  })

  test('allow() refuses an exception without a reason', ({ crashes }) => {
    expect(() => crashes.allow({ reason: ' ', console: [/x/] })).toThrow(/reason is required/)
  })
})

// FE-188: an allowance scoped to an engine. The global entry for WebKit's
// viewport warning accepts that exact text, in WebKit, and nothing else.
bare.describe('crash detector scoped to an engine', () => {
  const WARNING = 'Viewport argument key "interactive-widget" not recognized and ignored.'
  const consoleSignal = (message: string): CrashSignal => ({ kind: 'console', message })

  bare('accepts the WebKit viewport warning only in WebKit, only by its exact text', () => {
    const allowed = (message: string, browser?: 'chromium' | 'firefox' | 'webkit'): boolean =>
      isAllowed(consoleSignal(message), GLOBAL_ALLOWLIST, browser)

    expect(allowed(WARNING, 'webkit')).toBe(true)
    expect(allowed(WARNING, 'chromium')).toBe(false)
    expect(allowed(WARNING, 'firefox')).toBe(false)
    // An engine that cannot be read gets no engine-scoped allowance.
    expect(allowed(WARNING, undefined)).toBe(false)
    // Anything else WebKit prints stays a signal.
    expect(allowed(`${WARNING} Extra.`, 'webkit')).toBe(false)
    expect(allowed(`Error: ${WARNING}`, 'webkit')).toBe(false)
    expect(
      allowed('Viewport argument key "viewport-fit" not recognized and ignored.', 'webkit'),
    ).toBe(false)
    expect(allowed('e2e: something went wrong', 'webkit')).toBe(false)
  })

  bare('takes the engine from the page', async ({ page, browserName }) => {
    const watch = await watchCrashes(page)
    await signedIn(page)
    await page.goto('/user/dashboard')

    await page.evaluate((text) => {
      console.error(text)
      console.error('e2e: the line after the warning')
    }, WARNING)
    // The second line proves the listener ran past the first.
    await expectSignal(() => watch.crashes.signals(), 'console', /the line after the warning/)

    const seen = watch.crashes.signals().some((s) => s.kind === 'console' && s.message === WARNING)
    // Smoke runs on Chromium: the WebKit-only allowance must not hide it there.
    expect(seen, `the warning on ${browserName}`).toBe(browserName !== 'webkit')
  })
})
