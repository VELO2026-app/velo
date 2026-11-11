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

/** A shell's <main> or a heading that is not part of a gate. */
const ROUTE_CONTENT = [
  'main',
  'h1:not([data-testid=splash] *, [data-testid=welcome] *, [data-testid=login] *)',
  'h2:not([data-testid=splash] *, [data-testid=welcome] *, [data-testid=login] *)',
].join(', ')

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
      // A missing value is a setup bug, not a reason to skip the screen.
      expect(path, `no value for a parameter of ${entry.path} in params.json`).not.toBeNull()
      for (const allowance of entry.allow?.(role) ?? []) crashes.allow(allowance)
      await signIn(page, role)
      const tracker = trackApi(page)

      await page.goto(path!)
      await settle(page, tracker)

      // The route itself is on screen. Positive first: content OUTSIDE the
      // sign-in gates App.vue draws instead of the route (their sr-only
      // headings would satisfy a bare heading check); then no gate at all;
      // then the URL is the route's (or its by-design redirect).
      await expect(
        page.locator(ROUTE_CONTENT).first(),
        'the screen rendered something',
      ).toBeVisible()
      await expect(page.getByTestId(GATES), 'a sign-in gate instead of the screen').toHaveCount(0)
      const lands = typeof entry.lands === 'function' ? entry.lands(role) : entry.lands
      await expect(page).toHaveURL(lands ?? new RegExp(`${escape(path!)}$`))
    })
  }
}

async function signIn(page: import('@playwright/test').Page, role: SweepRole): Promise<void> {
  await page.addInitScript(
    ([key, token]) => localStorage.setItem(key!, token!),
    [SESSION_TOKEN_KEY, tokenOf(role)],
  )
}
