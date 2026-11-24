/**
 * The host of the `sweep-layout` project (FE-240): the screen opened the way
 * Telegram on an iPhone opens it in fullscreen (IPHONE_HOST), then judged by
 * the layout detector (e2e/support/layout.ts) at each size of LAYOUT_SIZES.
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
  routeTelegramScript,
  telegramScript,
} from '../support/fixtures'
import type { SweepRole } from './routes'

/** The Playwright project that runs the sweep under this host. */
export const LAYOUT_PROJECT = 'sweep-layout'

/** Make the next navigation a Telegram launch of `role`. Call before goto. */
export async function launchInTelegram(page: Page, role: SweepRole): Promise<void> {
  const user = PEOPLE[role]
  // Unsigned: the session is restored, initData only names its owner.
  const initData = new URLSearchParams({
    user: JSON.stringify(user),
    auth_date: '1700000000',
    hash: 'e2e-stub',
    // @tma.js parses initData and requires the field (Bot API 8.0).
    signature: 'e2e-stub',
  }).toString()
  await routeTelegramScript(page, telegramScript(initData, { user }, IPHONE_HOST))
  await page.addInitScript(
    ([key, token, params]) => {
      sessionStorage.setItem(key!, token!)
      sessionStorage.setItem('velo:telegram-launch', '1')
      sessionStorage.setItem('tapps/launchParams', JSON.stringify(params))
    },
    [SESSION_TOKEN_KEY, tokenOf(role), launchParams(initData, IPHONE_HOST)],
  )
  await emulateSafeArea(page, IPHONE_HOST.insets!)
}
