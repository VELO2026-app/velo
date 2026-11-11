/**
 * Visual shots (FE-162): every screen of ./screens.ts, API answered from the
 * HAR of its role (no backend), the clock stood at the recording time. No
 * baselines: the shots go to VISUAL_OUT (e.g. visual-out/head) and
 * ./compare.mjs sets two such folders side by side.
 *
 * A request that is not in the HAR is aborted, which the crash detector
 * reports as a failure: the app now asks for something the recording lacks --
 * re-record (docs/agents/e2e.md).
 */
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { SESSION_TOKEN_KEY } from '../support/fixtures'
import { settle, trackApi } from '../support/settle'
import { test, expect } from '../support/test'
import { harOf, META_FILE, type HarMeta } from './har'
import { SCREENS, rowOf, VIEWPORT } from './screens'
import { readFileSync } from 'node:fs'

const OUT = resolve(process.env.VISUAL_OUT ?? 'visual-out/head')
const meta = JSON.parse(readFileSync(META_FILE, 'utf8')) as HarMeta

test.use({ viewport: VIEWPORT })
mkdirSync(OUT, { recursive: true })

for (const screen of SCREENS) {
  test(`[${screen.role}] ${screen.name}`, async ({ page, crashes }) => {
    for (const allowance of rowOf(screen).allow?.(screen.role) ?? []) crashes.allow(allowance)
    const path = meta.paths[screen.name]
    expect(path, `${screen.name} is not in har/meta.json -- re-record`).toBeTruthy()
    await page.routeFromHAR(harOf(screen.role), { url: /\/api\//, notFound: 'abort' })
    await page.clock.setFixedTime(meta.recordedAt)
    // Any token: the HAR answers /users/me. (The real one is not needed, and
    // not stored.)
    await page.addInitScript(([key]) => localStorage.setItem(key!, 'visual'), [SESSION_TOKEN_KEY])
    const tracker = trackApi(page)
    await page.goto(path!)
    await settle(page, tracker)
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({
      path: resolve(OUT, `${screen.name}.png`),
      animations: 'disabled',
      caret: 'hide',
    })
  })
}
