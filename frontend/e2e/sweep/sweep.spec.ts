/**
 * The sweep (FE-161): every route of the router, under every role the table
 * (./routes.ts) lists for it, against the real backend of the e2e stack. One
 * test per route x role, named `[role] /path`. Read-only by contract: a test
 * opens the screen and judges it, it never clicks -- so the tests share the
 * seed without touching each other and run fully parallel.
 *
 * Each test: the role's session token into localStorage (standalone mode, no
 * new login), goto, settle (the splash gone, the API quiet), then "not
 * empty": the shell's <main> (or a heading, for the screens outside a shell)
 * is visible. The crash detector judges the rest.
 */
import { readParams, tokenOf } from '../stack/state'
import { settle, trackApi } from '../support/settle'
import { expect, test } from '../support/test'
import { SESSION_TOKEN_KEY } from '../support/fixtures'
import { SWEEP, fillPath, type SweepRole } from './routes'

const params = readParams()

/** Screens App.vue draws INSTEAD of the route (src/views/auth/). */
const GATES = /^(splash|welcome|login)$/

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

for (const [name, entry] of Object.entries(SWEEP)) {
  if ('skip' in entry) continue
  for (const role of entry.roles) {
    // Titled by the route TEMPLATE: the values (an invite token minted per
    // run) differ between the listing and the worker.
    test(`[${role}] ${entry.path}`, { tag: `@${name}` }, async ({ page, crashes }) => {
      const path = fillPath(entry, params)
      test.skip(path === null, `no value for a parameter of ${entry.path} (see params.json)`)
      for (const allowance of entry.allow?.(role) ?? []) crashes.allow(allowance)
      await signIn(page, role)
      const tracker = trackApi(page)

      await page.goto(path!)
      await settle(page, tracker)

      // The route itself is on screen: not a sign-in gate drawn instead of
      // it, and the URL is where the route (or its by-design redirect) is.
      await expect(page.getByTestId(GATES), 'a sign-in gate instead of the screen').toHaveCount(0)
      await expect(page).toHaveURL(entry.lands ?? new RegExp(`${escape(path!)}$`))
      await expect(
        page.getByRole('main').or(page.getByRole('heading')).first(),
        'the screen rendered something',
      ).toBeVisible()
    })
  }
}

async function signIn(page: import('@playwright/test').Page, role: SweepRole): Promise<void> {
  await page.addInitScript(
    ([key, token]) => localStorage.setItem(key!, token!),
    [SESSION_TOKEN_KEY, tokenOf(role)],
  )
}
