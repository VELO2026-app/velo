/**
 * The web console of an instance without the payments option (FE-275): the
 * Goodo instance as goodo-dev carries it (GOODO_INSTANCE_CONFIG). The build is
 * the same; the run answers the app's `/config.json` with that instance's
 * options, as the deploy machine's nginx would. What it proves:
 *
 * - the menu has no Finance, and a typed `/console/finance` lands on the
 *   "section unavailable" screen;
 * - the dashboard has no revenue tile and no payout queue, the masters list
 *   has no payout column -- the money the instance does not have is not shown;
 * - every other console screen opens and passes the layout detector in a
 *   laptop window, as on an instance with every option (./console.spec.ts).
 *
 * The same accounts, the same stack and the same skin as the other
 * `sweep-console` tests: the CI cells run it on both brand skins.
 */
import { readParams } from '../stack/state'
import { GOODO_INSTANCE_CONFIG, serveInstanceConfig } from '../support/instance'
import { WEB_WINDOW, checkLayout } from '../support/layout'
import { signIn } from '../support/session'
import { settle, trackApi } from '../support/settle'
import { expect, test } from '../support/test'
import { CONSOLE_VIEWPORT, SWEEP, fillPath } from './routes'

test.describe('console of an instance without payments', () => {
  test.use({ viewport: CONSOLE_VIEWPORT })

  test.beforeEach(async ({ page }) => {
    await serveInstanceConfig(page, GOODO_INSTANCE_CONFIG)
    await signIn(page, 'admin')
  })

  test('the menu has no Finance and the typed address lands on "section unavailable"', async ({
    page,
  }) => {
    const tracker = trackApi(page)
    await page.goto('/console/dashboard')
    await settle(page, tracker)
    await expect(page.getByTestId('console-nav-dashboard')).toBeVisible()
    await expect(page.getByTestId('console-nav-schools')).toBeVisible()
    await expect(page.getByTestId('console-nav-finance')).toHaveCount(0)

    await page.goto('/console/finance')
    await settle(page, tracker)
    await expect(page).toHaveURL(/\/unavailable$/)
    await expect(page.getByRole('heading', { name: 'Section unavailable' })).toBeVisible()
  })

  test('the dashboard has no revenue tile and no payout queue', async ({ page }) => {
    const tracker = trackApi(page)
    await page.goto('/console/dashboard')
    await settle(page, tracker)

    await expect(page.getByTestId('console-dashboard')).toBeVisible()
    // The other figures are there; the revenue and the payouts are not.
    await expect(page.getByText('New users', { exact: true })).toBeVisible()
    await expect(page.getByText('Revenue', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Payouts', { exact: true })).toHaveCount(0)
  })

  test('the masters list has no payout column', async ({ page }) => {
    const tracker = trackApi(page)
    await page.goto('/console/masters')
    await settle(page, tracker)

    await expect(page.getByTestId('console-table-row').first()).toBeVisible()
    // The other counters are columns; the payout balance is not.
    await expect(page.getByRole('columnheader', { name: 'Practices' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: 'To withdraw' })).toHaveCount(0)
  })

  for (const [name, entry] of Object.entries(SWEEP)) {
    // Finance is not there on this instance (above).
    if ('skip' in entry || !entry.path.startsWith('/console/') || name === 'console-finance')
      continue
    test(
      `[admin] ${entry.path} opens and has no layout finding`,
      { tag: `@${name}` },
      async ({ page, crashes }, testInfo) => {
        const path = fillPath(entry, readParams(testInfo.project.name))
        expect(path, `no value for a parameter of ${entry.path} in params.json`).not.toBeNull()
        const tracker = trackApi(page)

        await page.goto(path!)
        await settle(page, tracker)

        await expect(page.getByTestId('console-sidebar'), 'the console shell').toBeVisible()
        await expect(page).toHaveURL(new RegExp(`${path!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
        await checkLayout(page, crashes, name, WEB_WINDOW)
      },
    )
  }
})
