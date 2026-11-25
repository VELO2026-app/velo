/**
 * Record the API answers of the visual screens (FE-162): `pnpm visual:record`
 * against a running stack seeded with the `e2e` profile. One HAR per role,
 * `content: 'embed'` (text, reviewable in a diff), only `/api/` traffic.
 * Afterwards the HAR is scrubbed of credentials and the recording time is
 * saved to har/meta.json for `page.clock.setFixedTime` on replay.
 *
 * VISUAL_ROLES=admin (a comma list) records only those roles: the other HARs
 * are left as they are, and meta.json keeps their recording time (a role
 * recorded later has its own, `roles` in meta.json). A screen of a role not
 * recorded that meta.json does not know yet gets its path only when the path
 * has no parameter (the HAR it needs is already there: the screen asks the API
 * for what the role's other screens ask). No VISUAL_ROLES: every role, one
 * recording time.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readParams, tokenOf } from '../stack/state'
import { SESSION_TOKEN_KEY } from '../support/fixtures'
import { settle, trackApi } from '../support/settle'
import { test } from '../support/test'
import { fillPath, type SweepRole } from '../sweep/routes'
import { HAR_DIR, META_FILE, harOf, type HarMeta } from './har'
import { ROLES, SCREENS, rowOf, viewportOf, VIEWPORT } from './screens'

const recordedAt = new Date().toISOString()
const params = readParams()
const paths: Record<string, string> = {}

const only = (process.env.VISUAL_ROLES ?? '')
  .split(',')
  .map((role) => role.trim())
  .filter(Boolean)
const unknown = only.filter((role) => !(ROLES as string[]).includes(role))
if (unknown.length > 0) throw new Error(`VISUAL_ROLES: no screens for ${unknown.join(', ')}`)
/** The roles this run records. */
const recorded: SweepRole[] = only.length > 0 ? ROLES.filter((role) => only.includes(role)) : ROLES

for (const role of recorded) {
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
      // A screen of an instance variant is shot on the path of its own screen.
      for (const screen of SCREENS.filter((s) => s.role === role && !s.instance)) {
        // Screens that are a signal by design (the 404 screen) say so in the sweep table.
        for (const allowance of rowOf(screen).allow?.(role) ?? []) crashes.allow(allowance)
        const path = fillPath(rowOf(screen), params)
        if (!path) throw new Error(`visual: no params for ${screen.name}`)
        paths[screen.name] = path
        // The window of the replay: a web screen asks for other data in a laptop window.
        await page.setViewportSize(viewportOf(screen))
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
  for (const role of recorded) scrub(harOf(role), tokenOf(role))
  const meta: HarMeta =
    recorded.length === ROLES.length
      ? { recordedAt, paths }
      : partialMeta(JSON.parse(readFileSync(META_FILE, 'utf8')) as HarMeta)
  writeFileSync(META_FILE, JSON.stringify(meta, null, 2) + '\n')
})

/**
 * meta.json after a recording of some roles: theirs is new (own time, new
 * paths), the rest is what it was. A screen the old meta.json does not know
 * (a role not recorded) gets a path if it has no parameter.
 */
function partialMeta(old: HarMeta): HarMeta {
  const merged: Record<string, string> = { ...old.paths, ...paths }
  for (const screen of SCREENS) {
    if (screen.instance || merged[screen.name]) continue
    const row = rowOf(screen)
    if (/:\w+/.test(row.path)) {
      throw new Error(
        `${screen.name} is not in meta.json and has a parameter: record ${screen.role}`,
      )
    }
    merged[screen.name] = row.path
  }
  const roles: HarMeta['roles'] = { ...old.roles }
  for (const role of recorded) roles[role] = recordedAt
  return { recordedAt: old.recordedAt, roles, paths: merged }
}

/** The parts of a HAR the scrub touches. */
interface HarPart {
  headers: Array<{ name: string }>
  cookies: unknown[]
}
interface Har {
  log: { entries: Array<{ request: HarPart; response: HarPart }> }
}

/** Drop auth headers and cookies; blank the session token wherever it shows. */
function scrub(file: string, token: string): void {
  const har = JSON.parse(readFileSync(file, 'utf8')) as Har
  const secret = /^(authorization|cookie|set-cookie|x-telegram-init-data)$/i
  for (const entry of har.log.entries) {
    for (const part of [entry.request, entry.response]) {
      part.headers = part.headers.filter((h) => !secret.test(h.name))
      part.cookies = []
    }
  }
  const text = JSON.stringify(har, null, 1)
    .split(token)
    .join('REDACTED')
    .replace(/(init_?data=)[^"&\\]+/gi, '$1REDACTED')
  writeFileSync(file, text + '\n')
}
