/**
 * Self-checks of the crash detector (FE-161), on the API mocks. Each test
 * breaks the page one way and is marked test.fail(): it is green only when
 * the detector turns it red. Inside, each also asserts that the expected
 * signal was the one seen, so a test failing for an unrelated reason (a
 * timeout, a typo) does not pass for the wrong cause.
 */
import { mockApi } from './support/api'
import { mockSignedIn, seedSession } from './support/fixtures'
import { expect, test } from './support/test'
import type { Crashes, SignalKind } from './support/crashes'

/** Wait until the detector has seen a signal of `kind` matching `message`. */
async function expectSignal(crashes: Crashes, kind: SignalKind, message: RegExp): Promise<void> {
  await expect
    .poll(() => crashes.signals().some((s) => s.kind === kind && message.test(s.message)), {
      message: `a ${kind} signal matching ${String(message)}`,
    })
    .toBe(true)
}

test.describe('crash detector', () => {
  test('an endpoint answering 500', async ({ page, crashes }) => {
    test.fail()
    const api = await mockApi(page)
    mockSignedIn(api)
    api.on('GET', '/api/v1/bookings/me/upcoming', () => ({ status: 500, body: { detail: 'boom' } }))
    await seedSession(page)

    await page.goto('/user/dashboard')

    await expectSignal(crashes, 'api', /^GET \/api\/v1\/bookings\/me\/upcoming -> 500$/)
  })

  test('a screen throwing on a malformed answer', async ({ page, crashes }) => {
    test.fail()
    const api = await mockApi(page)
    mockSignedIn(api)
    // An object where the dashboard expects the list: it filters and maps
    // over it while rendering.
    api.on('GET', '/api/v1/bookings/me/upcoming', { bookings: [] })
    await seedSession(page)

    await page.goto('/user/dashboard')

    await expectSignal(crashes, 'reported', /TypeError/)
  })

  test('an uncaught exception', async ({ page, crashes }) => {
    test.fail()
    const api = await mockApi(page)
    mockSignedIn(api)
    await seedSession(page)
    await page.goto('/user/dashboard')

    await page.evaluate(() =>
      setTimeout(() => {
        throw new Error('e2e: thrown from a timer')
      }),
    )

    await expectSignal(crashes, 'exception', /thrown from a timer/)
  })

  test('a lazy chunk that fails to load', async ({ page, crashes }) => {
    test.fail()
    await page.route('**/assets/CalendarView-*.js', (route) => route.fulfill({ status: 404 }))
    const api = await mockApi(page)
    mockSignedIn(api)
    await seedSession(page)

    await page.goto('/user/calendar')

    await expectSignal(crashes, 'asset', /^\/assets\/CalendarView-.*\.js -> 404$/)
  })

  test('a console.error', async ({ page, crashes }) => {
    test.fail()
    const api = await mockApi(page)
    mockSignedIn(api)
    await seedSession(page)
    await page.goto('/user/dashboard')

    await page.evaluate(() => console.error('e2e: something went wrong'))

    await expectSignal(crashes, 'console', /something went wrong/)
  })

  test('a visible error state', async ({ page }) => {
    test.fail()
    const api = await mockApi(page)
    mockSignedIn(api)
    await seedSession(page)

    await page.goto('/user/no-such-screen')

    // The `screen` signal is taken at the end of the test, after this.
    await expect(page.getByTestId('not-found')).toBeVisible()
  })

  test('a blank screen', async ({ page }) => {
    test.fail()
    await page.route('**/assets/index-*.js', (route) => route.fulfill({ status: 404 }))

    await page.goto('/')
  })

  test('allow() accepts a signal the test expects', async ({ page, crashes }) => {
    const api = await mockApi(page)
    mockSignedIn(api)
    api.on('GET', '/api/v1/e2e-probe', () => ({ status: 500, body: { detail: 'boom' } }))
    crashes.allow({
      reason: 'self-check: the 500 and the console line are the point of this test',
      api: [{ method: 'GET', path: /^\/api\/v1\/e2e-probe$/, status: 500 }],
      console: [/expected noise/],
    })
    await seedSession(page)
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
