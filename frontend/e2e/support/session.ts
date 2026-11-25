/**
 * Sign a seeded role in before the app starts (FE-275: the one copy; the
 * sweep, the accessibility sweep and the console sweeps used to carry their
 * own): the role's session token goes where the standalone app keeps it, so
 * the first load restores the session and no login is spent.
 */
import type { Page } from '@playwright/test'
import { tokenOf } from '../stack/state'
import type { SweepRole } from '../sweep/routes'
import { SESSION_TOKEN_KEY } from './fixtures'

/** Put `role`'s session token into localStorage for the next load. */
export async function signIn(page: Page, role: SweepRole): Promise<void> {
  await page.addInitScript(
    ([key, token]) => localStorage.setItem(key!, token!),
    [SESSION_TOKEN_KEY, tokenOf(role)],
  )
}
