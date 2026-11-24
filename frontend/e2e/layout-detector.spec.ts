/**
 * Mutation checks of the layout detector (FE-240), on the API mocks.
 *
 * The pilot screen: the student dashboard with the nearest practice card (the
 * card of FE-173), launched as Telegram on an iPhone in fullscreen -- the host
 * of the `sweep-layout` project. Unchanged, the detector finds nothing there
 * (after LAYOUT_ALLOWLIST, as in the sweep). Then each check breaks the
 * layout one way and asserts POSITIVELY that the detector reports that rule:
 * a rule that stopped seeing its breakage turns its check red.
 */
// eslint-disable-next-line no-restricted-imports -- the last check attaches the watcher by hand
import { expect, test as bare, type Page } from '@playwright/test'
import { mockApi } from './support/api'
import { watchCrashes } from './support/crashes'
import {
  IPHONE_HOST,
  NOW,
  emulateSafeArea,
  freezeClock,
  makePractice,
  makeUser,
  mockSignedIn,
  stubTelegram,
} from './support/fixtures'
import {
  LAYOUT_SIZES,
  TELEGRAM_BANDS,
  checkLayout,
  inspectLayout,
  isLayoutAllowed,
  type LayoutFinding,
  type LayoutRule,
  type LayoutSize,
} from './support/layout'
import { LAYOUT_ALLOWLIST } from './support/layout-allowlist'
import { settle, trackApi } from './support/settle'
import { test } from './support/test'

/** The pilot's route name in the sweep table (its allowlist entries apply). */
const ROUTE = 'user-dashboard'

/** The narrow size: the screen scrolls there, so the tab bar has content to cover. */
const NARROW: LayoutSize = { width: 320, height: 568 }

/** A mutation is judged at one size (the common one unless it says otherwise). */
const COMMON: LayoutSize = LAYOUT_SIZES[0]!

/** Open the pilot screen as the layout sweep opens a screen. */
async function openPilot(page: Page): Promise<void> {
  const api = await mockApi(page)
  const user = makeUser()
  mockSignedIn(api, user)
  api.on('POST', '/api/v1/auth/telegram', { session_token: 'tg-token', user })
  // The nearest practice: today, two hours after the frozen clock.
  api.on('GET', '/api/v1/bookings/me/upcoming', [
    {
      id: '00000000-0000-4000-8000-0000000000c1',
      practice_id: '00000000-0000-4000-8000-0000000000a1',
      user_id: user.id,
      status: 'confirmed',
      purchase_id: null,
      cancelled_at: null,
      cancellation_reason: null,
      joined_at: null,
      left_at: null,
      checkin_skipped: false,
      created_at: NOW.toISOString(),
      updated_at: null,
      has_feedback: false,
      has_checkin: false,
      has_reflection: false,
      practice: makePractice({ is_booked: true }),
    },
  ])
  await freezeClock(page)
  await emulateSafeArea(page, IPHONE_HOST.insets!)
  const tracker = trackApi(page)
  await page.goto(await stubTelegram(page, undefined, undefined, IPHONE_HOST))
  await settle(page, tracker)
  await expect(page.locator('.practice-list-card__when')).toBeVisible()
}

/** What the sweep would report: the findings LAYOUT_ALLOWLIST does not accept. */
async function findings(
  page: Page,
  sizes: readonly LayoutSize[] = LAYOUT_SIZES,
): Promise<LayoutFinding[]> {
  return (await inspectLayout(page, TELEGRAM_BANDS, sizes)).filter(
    (f) => !isLayoutAllowed(f, ROUTE, LAYOUT_ALLOWLIST),
  )
}

test('the unchanged pilot screen has no findings at any size', async ({ page }) => {
  await openPilot(page)

  expect(await findings(page)).toEqual([])
})

/** A breakage: CSS, or a script run in the page, and the rule that must see it. */
interface Mutation {
  name: string
  rule: LayoutRule
  css?: string
  script?: () => void
  sizes?: readonly LayoutSize[]
}

const MUTATIONS: Mutation[] = [
  {
    // FE-173 as it was: the date cell no wider than its column, the label
    // runs on over the time next to it.
    name: 'the date runs over the time (FE-173)',
    rule: 'overlap',
    css: `.practice-list-card__when { width: 12px !important; min-width: 0 !important;
      flex: none !important; white-space: nowrap !important; }`,
  },
  {
    name: 'a card wider than the screen',
    rule: 'overflow',
    css: '.practice-list-card { min-width: 520px !important; }',
  },
  {
    // The bell is 36 px with a 44 px hit area around it (::after); without
    // that area it is too small.
    name: 'a button without its hit area',
    rule: 'small-target',
    css: '.dashboard__bell::after { display: none !important; }',
  },
  {
    name: 'a transparent layer over the card',
    rule: 'covered-target',
    script: () => {
      const item = document.querySelector<HTMLElement>('.dashboard__nearest-item')!
      item.style.position = 'relative'
      const veil = document.createElement('div')
      veil.style.cssText = 'position:absolute;inset:0;z-index:5'
      item.append(veil)
    },
  },
  {
    name: 'no bottom clearance for the tab bar',
    rule: 'tabbar',
    css: '.mobile-layout__main { padding-bottom: 0 !important; }',
    sizes: [NARROW],
  },
  {
    name: 'no top inset: the header under Telegram controls',
    rule: 'safe-area',
    css: '.app-frame { padding-top: 0 !important; }',
  },
  {
    name: 'the tab bar on the home indicator',
    rule: 'safe-area',
    css: '.v-tabbar { bottom: 4px !important; }',
  },
]

for (const m of MUTATIONS) {
  test(`detector reports ${m.rule}: ${m.name}`, async ({ page }) => {
    await openPilot(page)
    if (m.css) await page.addStyleTag({ content: m.css })
    if (m.script) await page.evaluate(m.script)

    const rules = (await findings(page, m.sizes ?? [COMMON])).map((f) => f.rule)

    expect(rules).toContain(m.rule)
  })
}

bare('a finding reaches the crash detector as a layout signal', async ({ page }) => {
  const watch = await watchCrashes(page)
  await openPilot(page)
  await page.addStyleTag({ content: MUTATIONS[0]!.css! })

  await checkLayout(page, watch.crashes, ROUTE, [COMMON])

  expect(watch.crashes.signals()).toContainEqual(
    expect.objectContaining({ kind: 'layout', message: expect.stringMatching(/^overlap @/) }),
  )
})
