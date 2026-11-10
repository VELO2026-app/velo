/**
 * Entry scenarios (FE-157 5A.2): the splash, then the first screen a new and a
 * returning user lands on -- in a browser tab and inside Telegram.
 */
import { expect, test } from '@playwright/test'
import { mockApi } from './support/api'
import { makeUser, mockSignedIn, seedSession, stubTelegram } from './support/fixtures'

test.describe('browser tab', () => {
  test('returning user: splash, then the dashboard', async ({ page }) => {
    const api = await mockApi(page)
    mockSignedIn(api)
    // Held back so the splash is observable.
    api.on('GET', '/api/v1/users/me', () => ({ body: makeUser(), delayMs: 600 }))
    await seedSession(page)

    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Loading' })).toBeAttached()

    await expect(page).toHaveURL(/\/user\/dashboard$/)
    await expect(page.getByRole('heading', { name: 'Loading' })).toHaveCount(0)
    expect(api.unhandled).toEqual([])
  })

  test('no session: the Telegram login screen, no API traffic', async ({ page }) => {
    const api = await mockApi(page)
    // No account yet, so the copy language is the device hint, not a profile's.
    await page.addInitScript(() => localStorage.setItem('velo.locale', 'en'))

    await page.goto('/')

    await expect(page.getByRole('button', { name: 'Log in with Telegram' })).toBeVisible()
    expect(api.calls).toEqual([])
  })
})

test.describe('inside Telegram', () => {
  test('new user: Welcome, the onboarding carousel, then the dashboard', async ({ page }) => {
    const api = await mockApi(page)
    const fresh = makeUser({ onboarding_completed: false })
    mockSignedIn(api, fresh)
    api.on('POST', '/api/v1/auth/telegram', { session_token: 'tg-token', user: fresh })
    api.on('PATCH', '/api/v1/users/me', makeUser({ onboarding_completed: true }))

    await page.goto(await stubTelegram(page))

    // Signed in via the stub's initData, flag not set -> Welcome.
    await page.getByRole('button', { name: 'Log in' }).click()
    await expect(page.getByRole('button', { name: 'Skip' })).toBeVisible()
    expect(api.bodies('POST', '/api/v1/auth/telegram')).toEqual([
      { init_data: expect.stringContaining('hash=e2e-stub') },
    ])

    await page.getByRole('button', { name: 'Skip' }).click()

    await expect(page).toHaveURL(/\/user\/dashboard/)
    expect(api.bodies('PATCH', '/api/v1/users/me')).toEqual([
      expect.objectContaining({ onboarding_completed: true }),
    ])
    expect(api.unhandled).toEqual([])
  })

  test('returning user: straight to the dashboard, no Welcome', async ({ page }) => {
    const api = await mockApi(page)
    mockSignedIn(api)
    api.on('POST', '/api/v1/auth/telegram', { session_token: 'tg-token', user: makeUser() })

    await page.goto(await stubTelegram(page))

    await expect(page).toHaveURL(/\/user\/dashboard/)
    await expect(page.getByRole('button', { name: 'Log in' })).toHaveCount(0)
    expect(api.unhandled).toEqual([])
  })
})
