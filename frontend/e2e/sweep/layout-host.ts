/**
 * The host of the `sweep-layout-<width>` projects (FE-240): the screen opened
 * the way Telegram on an iPhone opens it in fullscreen (IPHONE_HOST), at the
 * project's size, then judged by the layout detector (e2e/support/layout.ts).
 *
 * The launch: the session token where the Telegram platform keeps it
 * (sessionStorage), the marks a reload inside Telegram leaves (the app's
 * `velo:telegram-launch`, @tma.js's launch parameters), and the stubbed
 * telegram-web-app.js with the insets. The app restores the session (its
 * owner is the initData user), so no login is spent; the URL is the route's
 * own, without launch parameters in the hash. env(safe-area-inset-*) carries
 * the system insets too (emulateSafeArea).
 */
import type { Page } from '@playwright/test'
import { PEOPLE, tokenOf } from '../stack/state'
import {
  IPHONE_HOST,
  SESSION_TOKEN_KEY,
  emulateSafeArea,
  launchParams,
  stubInitData,
  routeTelegramScript,
  telegramScript,
} from '../support/fixtures'
import type { SweepRole } from './routes'

/** The prefix of the Playwright projects that run the sweep under this host, one per size. */
export const LAYOUT_PROJECT = 'sweep-layout'

/** Whether a project is one of the layout sweep's (`sweep-layout-390`, ...). */
export function isLayoutProject(name: string): boolean {
  return name.startsWith(`${LAYOUT_PROJECT}-`)
}

/** Make the next navigation a Telegram launch of `role`. Call before goto. */
export async function launchInTelegram(page: Page, role: SweepRole): Promise<void> {
  const user = PEOPLE[role]
  // Unsigned: the session is restored, initData only names its owner.
  const initData = stubInitData(user)
  await routeTelegramScript(page, telegramScript(initData, { user }, IPHONE_HOST))
  await page.addInitScript(
    ([key, token, params]) => {
      sessionStorage.setItem(key!, token!)
      // TELEGRAM_LAUNCH_KEY of src/platform/launch.ts (that module pulls the
      // app's host layer in) and @tma.js's own key of the launch parameters.
      sessionStorage.setItem('velo:telegram-launch', '1')
      sessionStorage.setItem('tapps/launchParams', JSON.stringify(params))
    },
    [SESSION_TOKEN_KEY, tokenOf(role), launchParams(initData, IPHONE_HOST)],
  )
  await emulateSafeArea(page, IPHONE_HOST.insets!)
}
