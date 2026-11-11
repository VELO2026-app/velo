/**
 * Record the API answers of the visual screens (FE-162): `pnpm visual:record`
 * against a running stack seeded with the `e2e` profile. One HAR per role,
 * `content: 'embed'` (text, reviewable in a diff), only `/api/` traffic.
 * Afterwards the HAR is scrubbed of credentials and the recording time is
 * saved to har/meta.json for `page.clock.setFixedTime` on replay.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readParams, tokenOf } from '../stack/state'
import { SESSION_TOKEN_KEY } from '../support/fixtures'
import { settle, trackApi } from '../support/settle'
import { test } from '../support/test'
import { fillPath } from '../sweep/routes'
import { HAR_DIR, META_FILE, harOf, type HarMeta } from './har'
import { ROLES, SCREENS, rowOf, VIEWPORT } from './screens'

const recordedAt = new Date().toISOString()
const params = readParams()

for (const role of ROLES) {
  test.describe(`record ${role}`, () => {
    test.use({
      viewport: VIEWPORT,
      contextOptions: {
        recordHar: { path: harOf(role), content: 'embed', urlFilter: /\/api\// },
      },
    })

    test(`[${role}] HAR`, async ({ page, crashes }) => {
      mkdirSync(HAR_DIR, { recursive: true })
      // The same clock the replay uses, so date-derived query strings match.
      await page.clock.setFixedTime(recordedAt)
      await page.addInitScript(
        ([key, token]) => localStorage.setItem(key!, token!),
        [SESSION_TOKEN_KEY, tokenOf(role)],
      )
      const tracker = trackApi(page)
      for (const screen of SCREENS.filter((s) => s.role === role)) {
        // Screens that are a signal by design (the 404 screen) say so in the sweep table.
        for (const allowance of rowOf(screen).allow?.(role) ?? []) crashes.allow(allowance)
        const path = fillPath(rowOf(screen), params)
        if (!path) throw new Error(`visual: no params for ${screen.name}`)
        await page.goto(path)
        await settle(page, tracker)
      }
    })
  })
}

// One worker, in order: a HAR is written when its context closes, i.e. after
// its own test -- so the last test sees all of them finished.
test.describe.configure({ mode: 'serial' })

test('scrub the HARs, save the recording time', () => {
  for (const role of ROLES) scrub(harOf(role), tokenOf(role))
  writeFileSync(META_FILE, JSON.stringify({ recordedAt } satisfies HarMeta, null, 2) + '\n')
})

/** Drop auth headers and cookies; blank the session token wherever it shows. */
function scrub(file: string, token: string): void {
  const har = JSON.parse(readFileSync(file, 'utf8')) as {
    log: { entries: Array<Record<string, any>> }
  }
  const secret = /^(authorization|cookie|set-cookie|x-telegram-init-data)$/i
  for (const entry of har.log.entries) {
    for (const part of [entry.request, entry.response]) {
      part.headers = part.headers.filter((h: { name: string }) => !secret.test(h.name))
      part.cookies = []
    }
  }
  const text = JSON.stringify(har, null, 1)
    .split(token)
    .join('REDACTED')
    .replace(/(init_?data=)[^"&\\]+/gi, '$1REDACTED')
  writeFileSync(file, text + '\n')
}
