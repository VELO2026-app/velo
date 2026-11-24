/**
 * Instance text overlays on the compiled build (FE-261). The bundle's catalogs
 * are precompiled message trees, not the plain strings the unit suite holds: an
 * overlay string must still land on a message the build already has.
 */
import { expect, test } from './support/test'
import { mockApi } from './support/api'

test('a texts package re-words a built-in string', async ({ page }) => {
  await mockApi(page)
  await page.addInitScript(() => localStorage.setItem('velo.locale', 'en'))
  await page.route('**/config.json', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ locales: 'en' }) }),
  )
  await page.route('**/texts/ui/en.json', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ auth: { loginCta: 'Sign in with Telegram' } }),
    }),
  )

  await page.goto('/')

  await expect(page.getByRole('button', { name: 'Sign in with Telegram' })).toBeVisible()
})
