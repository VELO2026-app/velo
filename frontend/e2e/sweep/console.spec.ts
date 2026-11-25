/**
 * The web console's layout sweep (FE-275): every `/admin` screen of the
 * sweep table, opened in a browser window of each CONSOLE_SIZES size and
 * judged by the layout detector (docs/agents/e2e.md). The console is for a
 * computer, so the window is a desktop browser -- no Telegram host, no safe
 * areas -- and the detector runs with WEB_WINDOW: `overflow`, `overlap` and
 * `covered-target` apply, the phone's tap-target floor and bands do not.
 *
 * Read-only like the sweep: it opens a screen and judges it. One test per
 * screen and size; the screen LOADS at its size (the app reads the window at
 * start). The skin is the one of the build under test, so the CI cells
 * (`sweep-console@velo-brand`, `sweep-console@goodo-brand`) judge both.
 */
import { readParams } from '../stack/state'
import { WEB_WINDOW, checkLayout } from '../support/layout'
import { signIn } from '../support/session'
import { settle, trackApi } from '../support/settle'
import { expect, test } from '../support/test'
import { CONSOLE_SIZES, sizeLabel } from '../support/console-sizes'
import { SWEEP, fillPath } from './routes'

for (const size of CONSOLE_SIZES) {
  test.describe(`console @${sizeLabel(size)}`, () => {
    test.use({ viewport: size })

    for (const [name, entry] of Object.entries(SWEEP)) {
      if ('skip' in entry || !name.startsWith('console-')) continue
      for (const role of entry.roles) {
        test(
          `[${role}] ${entry.path}`,
          { tag: `@${name}` },
          async ({ page, crashes }, testInfo) => {
            const path = fillPath(entry, readParams(testInfo.project.name))
            expect(path, `no value for a parameter of ${entry.path} in params.json`).not.toBeNull()
            for (const allowance of entry.allow?.(role) ?? []) crashes.allow(allowance)
            await signIn(page, role)
            const tracker = trackApi(page)

            await page.goto(path!)
            await settle(page, tracker)

            // The console itself, not its device stub or a sign-in gate.
            await expect(page.getByTestId('console-sidebar'), 'the console shell').toBeVisible()
            await expect(page.getByTestId('console-stub')).toHaveCount(0)
            await checkLayout(page, crashes, name, WEB_WINDOW)
          },
        )
      }
    }
  })
}
