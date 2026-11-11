/**
 * Telegram entry on the stack (FE-161): one test per role, launched the way
 * Telegram launches the Mini App -- a really signed initData (the stack's bot
 * token, e2e/stack/auth.ts) through the WebApp stub -- so the real
 * `POST /auth/telegram` signs the person in. Lands on the role's start screen.
 * Three logins per run, inside the backend's per-id limit.
 */
import { signInitData } from '../stack/auth'
import { PEOPLE } from '../stack/state'
import { stubTelegram } from '../support/fixtures'
import { settle, trackApi } from '../support/settle'
import { expect, test } from '../support/test'
import type { SweepRole } from './routes'

const START: Partial<Record<SweepRole, RegExp>> = {
  student: /\/user\/dashboard$/,
  master: /\/master\/dashboard$/,
  admin: /\/admin\/dashboard$/,
}

for (const role of Object.keys(START) as Array<'student' | 'master' | 'admin'>) {
  test(`[${role}] telegram entry`, async ({ page }) => {
    const user = PEOPLE[role]
    const tracker = trackApi(page)

    await page.goto(await stubTelegram(page, undefined, { initData: signInitData(user), user }))
    await settle(page, tracker)

    await expect(page.getByTestId(/^(splash|welcome|login)$/)).toHaveCount(0)
    await expect(page).toHaveURL(START[role]!)
    await expect(page.getByRole('main')).toBeVisible()
  })
}
