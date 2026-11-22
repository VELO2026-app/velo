/**
 * The skin package on the page (FE-230). The smoke build carries the
 * synthetic package of scripts/make-test-skin.mjs; every project runs with
 * reducedMotion: 'reduce' (playwright.config.ts).
 */
import { expect, test } from './support/test'
import { mockApi } from './support/api'

/** A CSS time in ms: the minifier writes 120ms as .12s. */
const ms = (time: string): number =>
  time.endsWith('ms') ? Number(time.slice(0, -2)) : Number(time.slice(0, -1)) * 1000

test('reduced motion outranks a skin that sets motion tokens', async ({ page }) => {
  await mockApi(page)
  await page.addInitScript(() => localStorage.setItem('velo.locale', 'en'))

  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Log in with Telegram' })).toBeVisible()

  const token = (name: string): Promise<number> =>
    page
      .evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name)
      .then(ms)
  // The skin's own value reaches the page (a token outside the reduced-motion set) ...
  expect(await token('--velo-dur-pulse')).toBe(777)
  // ... and its --velo-dur-fast (999ms) loses to the reduced-motion value.
  expect(await token('--velo-dur-fast')).toBe(120)
})
