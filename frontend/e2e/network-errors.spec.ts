/**
 * Network-failure scenarios (FE-242): on key screens the first request fails
 * (HTTP 500/503 or a dropped connection). The screen must say so -- the error
 * state with "Retry", never the empty state -- and recover on retry.
 *
 * The crash detector flags every 5xx and every visible error state, so each
 * test allows exactly the failure it injects (and nothing else).
 */
import { expect, test } from './support/test'
import { mockApi, type MockReply } from './support/api'
import {
  freezeClock,
  makeBooking,
  makePractice,
  makeUser,
  mockSignedIn,
  paged,
  seedSession,
} from './support/fixtures'

/**
 * An answer that fails every call (the app may ask more than once: prefetch,
 * revalidation) until `heal()` -- the test's "the network is back".
 */
function flaky(
  failure: MockReply,
  success: () => unknown,
): { handler: () => MockReply; heal: () => void } {
  let broken = true
  return { handler: () => (broken ? failure : { body: success() }), heal: () => (broken = false) }
}

test.describe('network failures: error state, then recovery', () => {
  test('my bookings: a 500 is an error with Retry, not "no bookings"', async ({
    page,
    crashes,
  }) => {
    crashes.allow({
      reason: 'FE-242: the 500 and its error state are the point of this test',
      api: [{ method: 'GET', path: /^\/api\/v1\/bookings\/me$/, status: 500 }],
      screen: ['screen-error'],
      console: [/Failed to load resource/],
    })
    const api = await mockApi(page)
    mockSignedIn(api, makeUser())
    const practice = makePractice()
    const bookings = flaky({ status: 500, body: { detail: 'boom' } }, () =>
      paged([makeBooking(practice)]),
    )
    api.on('GET', '/api/v1/bookings/me', bookings.handler)
    await seedSession(page)
    await freezeClock(page)
    await page.goto('/user/bookings')

    await expect(page.getByText('Load error')).toBeVisible()
    await expect(page.getByText('Morning Breathwork')).toHaveCount(0)
    await expect(page.getByText('No bookings')).toHaveCount(0)

    bookings.heal()
    await page.getByRole('button', { name: 'Try again' }).click()

    await expect(page.getByText('Morning Breathwork')).toBeVisible()
    await expect(page.getByText('Load error')).toHaveCount(0)
  })

  test('practice detail: a 503 is "Load error" with Retry, not "not found"', async ({
    page,
    crashes,
  }) => {
    const practice = makePractice()
    const id = practice.id as string
    crashes.allow({
      reason: 'FE-242: the 503 and its error state are the point of this test',
      api: [{ method: 'GET', path: new RegExp(`^/api/v1/practices/${id}$`), status: 503 }],
      screen: ['screen-error'],
      console: [/Failed to load resource/],
    })
    const api = await mockApi(page)
    mockSignedIn(api, makeUser())
    api.on('GET', '/api/v1/bookings/me', paged([]))
    const detail = flaky({ status: 503, body: { detail: 'down' } }, () => practice)
    api.on('GET', `/api/v1/practices/${id}`, detail.handler)
    await seedSession(page)
    await freezeClock(page)
    await page.goto(`/user/practices/${id}`)

    await expect(page.getByText('Load error')).toBeVisible()
    await expect(page.getByText('Practice not found')).toHaveCount(0)

    detail.heal()
    await page.getByRole('button', { name: 'Retry' }).click()

    await expect(page.getByText('Morning Breathwork').first()).toBeVisible()
    await expect(page.getByText('Load error')).toHaveCount(0)
  })

  test('dashboard: a failed upcoming list is an error with Retry, not "no upcoming practices"', async ({
    page,
    crashes,
  }) => {
    crashes.allow({
      reason: 'FE-242: the 500 and its error state are the point of this test',
      api: [{ method: 'GET', path: /^\/api\/v1\/bookings\/me\/upcoming$/, status: 500 }],
      screen: ['screen-error'],
      console: [/Failed to load resource/],
    })
    const api = await mockApi(page)
    mockSignedIn(api, makeUser())
    const upcoming = flaky({ status: 500, body: { detail: 'boom' } }, () => [])
    api.on('GET', '/api/v1/bookings/me/upcoming', upcoming.handler)
    await seedSession(page)
    await freezeClock(page)
    await page.goto('/user/dashboard')

    await expect(page.getByTestId('screen-error')).toBeVisible()
    await expect(page.getByText('No upcoming practices')).toHaveCount(0)

    upcoming.heal()
    await page.getByRole('button', { name: 'Retry' }).click()

    await expect(page.getByTestId('screen-error')).toHaveCount(0)
    await expect(page.getByText('No upcoming practices')).toBeVisible()
  })

  test('calendar: a dropped connection is an error with Retry, then the week loads', async ({
    page,
    crashes,
  }) => {
    crashes.allow({
      reason: 'FE-242: the dropped request and its error state are the point of this test',
      api: [{ method: 'GET', path: /^\/api\/v1\/practices$/, status: 'network' }],
      screen: ['screen-error'],
      console: [/Failed to load resource/, /net::ERR/],
    })
    const api = await mockApi(page)
    mockSignedIn(api, makeUser())
    const week = flaky({ abort: true }, () => paged([makePractice()]))
    api.on('GET', '/api/v1/practices', week.handler)
    await seedSession(page)
    await freezeClock(page)
    await page.goto('/user/calendar')

    await expect(page.getByTestId('screen-error')).toBeVisible()
    await expect(page.getByText('No practices')).toHaveCount(0)
    week.heal()
    await page.getByRole('button', { name: 'Retry' }).click()

    await expect(page.getByText('Morning Breathwork').first()).toBeVisible()
    await expect(page.getByTestId('screen-error')).toHaveCount(0)
  })
})
