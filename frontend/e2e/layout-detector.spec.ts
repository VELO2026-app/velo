/**
 * Self-checks of the layout detector (FE-240), on the API mocks.
 *
 * Mutations. The pilot screen: the student dashboard with the nearest
 * practice card (the card of FE-173), launched as Telegram on an iPhone in
 * fullscreen -- the host of the `sweep-layout-<width>` projects -- and LOADED
 * at the size it is judged at, as the sweep loads it. Unchanged, the detector
 * finds nothing there at any size (after LAYOUT_ALLOWLIST, as in the sweep).
 * Then each check breaks the layout one way and asserts POSITIVELY that the
 * detector reports that rule: a rule that stopped seeing its breakage turns
 * its check red.
 *
 * Exemptions and the allowlist. Small synthetic pages prove what the
 * detector lets pass on purpose (a carousel, a link in a sentence) and how an
 * allowlist entry narrows itself (route, width, smallest side), each next to
 * the case it still reports.
 */
// eslint-disable-next-line no-restricted-imports -- the last check attaches the watcher by hand
import { expect, test as bare, type Page } from '@playwright/test'
import { mockApi } from './support/api'
import { watchCrashes } from './support/crashes'
import {
  IPHONE_HOST,
  NOW,
  atHour,
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
  layoutSignals,
  type LayoutAllowance,
  type LayoutFinding,
  type LayoutRule,
  type LayoutSize,
} from './support/layout'
import { checkAllowances, deadAllowances } from './support/layout-allowance'
import { LAYOUT_ALLOWLIST } from './support/layout-allowlist'
import { sizeLabel } from './support/layout-sizes'
import { settle, trackApi } from './support/settle'
import { test } from './support/test'

/** The pilot's route name in the sweep table (its allowlist entries apply). */
const ROUTE = 'user-dashboard'

const [COMMON, NARROW] = LAYOUT_SIZES as [LayoutSize, LayoutSize, LayoutSize]

/** Open the pilot screen at `size`, as the layout sweep opens a screen. */
async function openPilot(page: Page, size: LayoutSize): Promise<void> {
  await page.setViewportSize(size)
  const api = await mockApi(page)
  const user = makeUser()
  mockSignedIn(api, user)
  api.on('POST', '/api/v1/auth/telegram', { session_token: 'tg-token', user })
  // The two nearest practices the dashboard shows (today, after the frozen
  // clock): on a narrow phone the screen scrolls past them.
  api.on(
    'GET',
    '/api/v1/bookings/me/upcoming',
    [10, 12].map((hour, i) => ({
      id: `00000000-0000-4000-8000-0000000000c${i}`,
      practice_id: `00000000-0000-4000-8000-0000000000a${i}`,
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
      practice: makePractice({
        id: `00000000-0000-4000-8000-0000000000a${i}`,
        title: hour === 10 ? 'Morning Breathwork' : 'Midday Stretch',
        scheduled_at: atHour(hour),
        is_booked: true,
      }),
    })),
  )
  await freezeClock(page)
  await emulateSafeArea(page, IPHONE_HOST.insets!)
  const tracker = trackApi(page)
  await page.goto(await stubTelegram(page, undefined, undefined, IPHONE_HOST))
  await settle(page, tracker)
  await expect(page.locator('.practice-list-card__when').first()).toBeVisible()
}

/** What the sweep would report: the findings LAYOUT_ALLOWLIST does not accept. */
async function findings(page: Page): Promise<LayoutFinding[]> {
  return (await inspectLayout(page, TELEGRAM_BANDS)).filter(
    (f) => !isLayoutAllowed(f, ROUTE, LAYOUT_ALLOWLIST),
  )
}

for (const size of LAYOUT_SIZES) {
  test(`the unchanged pilot screen has no findings at ${sizeLabel(size)}`, async ({ page }) => {
    await openPilot(page, size)

    expect(await findings(page)).toEqual([])
  })
}

/** A breakage: CSS, or a script run in the page, and the rule that must see it. */
interface Mutation {
  name: string
  rule: LayoutRule
  /** Where the finding must land (a part of its element description). */
  element?: string
  css?: string
  script?: () => void
  /** The size it is loaded and judged at; the common one by default. */
  size?: LayoutSize
}

const MUTATIONS: Mutation[] = [
  {
    // FE-173 as it was: the date cell no wider than its column, the label
    // runs on over the time next to it.
    name: 'the date runs over the time (FE-173)',
    rule: 'overlap',
    element: 'practice-list-card__when',
    css: `.practice-list-card__when { width: 12px !important; min-width: 0 !important;
      flex: none !important; white-space: nowrap !important; }`,
  },
  {
    name: 'a card wider than the screen',
    rule: 'overflow',
    css: '.practice-list-card { min-width: 520px !important; }',
  },
  {
    name: 'a title cut off mid-word by its card',
    rule: 'overflow',
    element: 'text cut off',
    css: `.practice-list-card__title { white-space: nowrap !important; overflow: hidden !important;
      text-overflow: clip !important; width: 40px !important; }`,
  },
  {
    // The bell is 36 px with a 44 px hit area around it (::after); without
    // that area it is too small.
    name: 'a button without its hit area',
    rule: 'small-target',
    element: 'dashboard__bell',
    css: '.dashboard__bell::after { display: none !important; }',
  },
  {
    name: 'a transparent layer over the card',
    rule: 'covered-target',
    element: 'practice-list-card',
    script: () => {
      const item = document.querySelector<HTMLElement>('.dashboard__nearest-item')!
      item.style.position = 'relative'
      const veil = document.createElement('div')
      veil.style.cssText = 'position:absolute;inset:0;z-index:5'
      item.append(veil)
    },
  },
  {
    // The whole screen is judged, not its first view: the last control of
    // the screen, below the fold on a narrow phone, under a veil.
    name: 'a layer over the last control, below the fold',
    rule: 'covered-target',
    size: NARROW,
    script: () => {
      const controls = document.querySelectorAll<HTMLElement>('main button, main a[href]')
      const last = controls[controls.length - 1]!
      if (last.getBoundingClientRect().top < window.innerHeight) {
        throw new Error('the last control is not below the fold')
      }
      last.parentElement!.style.position = 'relative'
      const veil = document.createElement('div')
      veil.style.cssText = 'position:absolute;inset:0;z-index:5'
      last.parentElement!.append(veil)
    },
  },
  {
    name: 'no bottom clearance for the tab bar',
    rule: 'tabbar',
    css: '.mobile-layout__main { padding-bottom: 0 !important; }',
    size: NARROW,
  },
  {
    name: 'no top inset: the header under Telegram controls',
    rule: 'safe-area',
    css: '.app-frame { padding-top: 0 !important; }',
  },
  {
    name: 'the tab bar on the home indicator',
    rule: 'safe-area',
    element: 'v-tabbar',
    css: '.v-tabbar { bottom: 4px !important; }',
  },
]

for (const m of MUTATIONS) {
  test(`detector reports ${m.rule}: ${m.name}`, async ({ page }) => {
    await openPilot(page, m.size ?? COMMON)
    if (m.css) await page.addStyleTag({ content: m.css })
    if (m.script) await page.evaluate(m.script)

    const found = (await findings(page))
      .filter((f) => f.rule === m.rule)
      .map((f) => `${f.element} -- ${f.detail}`)

    expect(found.length, `no ${m.rule} finding`).toBeGreaterThan(0)
    if (m.element) expect(found.join('\n')).toContain(m.element)
  })
}

bare('a finding reaches the crash detector as a layout signal', async ({ page }) => {
  const watch = await watchCrashes(page)
  await openPilot(page, COMMON)
  await page.addStyleTag({ content: MUTATIONS[0]!.css! })

  await checkLayout(page, watch.crashes, ROUTE)

  expect(watch.crashes.signals()).toContainEqual(
    expect.objectContaining({
      kind: 'layout',
      message: expect.stringMatching(/^overlap @390x844/),
    }),
  )
})

// --- exemptions, on small synthetic pages ------------------------------------------------

/** The findings of `html` at the common size, with nothing allowed. */
async function scan(page: Page, html: string): Promise<LayoutFinding[]> {
  await page.setViewportSize(COMMON)
  await page.setContent(
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      `<body style="margin:0;font:16px sans-serif">${html}</body>`,
  )
  return inspectLayout(page, { top: 0, bottom: 0 })
}

const rules = (list: LayoutFinding[]): LayoutRule[] => list.map((f) => f.rule)

test('a carousel may be wider than the screen; a row that is not one may not', async ({ page }) => {
  const row = (overflow: string): string =>
    `<div style="display:flex;gap:8px;overflow-x:${overflow}">` +
    '<button style="flex:none;width:200px;height:48px">One</button>'.repeat(4) +
    '</div>'

  expect(rules(await scan(page, row('auto')))).not.toContain('overflow')
  expect(rules(await scan(page, row('visible')))).toContain('overflow')
})

test('a link in a sentence may be small; the same link alone may not', async ({ page }) => {
  const link = '<a href="#x" style="display:inline">terms</a>'

  expect(rules(await scan(page, `<p>Read the <span>${link}</span> first.</p>`))).not.toContain(
    'small-target',
  )
  expect(rules(await scan(page, `<p>${link}</p>`))).toContain('small-target')
})

test('text cut off at a side is reported; lines a clamp hides are not', async ({ page }) => {
  const box = (css: string): string =>
    `<div style="width:120px;overflow:hidden;${css}">` +
    'A long line of words that does not fit its box</div>'

  expect(rules(await scan(page, box('white-space:nowrap')))).toContain('overflow')
  expect(
    rules(
      await scan(page, box('display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:1')),
    ),
  ).not.toContain('overflow')
})

test('a hit area grown by ::after counts; one that ignores the pointer does not', async ({
  page,
}) => {
  const button = (events: string): string =>
    `<style>b{position:relative;display:inline-block}b::after{content:"";position:absolute;` +
    `inset:-8px;pointer-events:${events}}</style>` +
    '<div style="padding:40px"><b role="button" style="width:32px;height:32px">x</b></div>'

  expect(rules(await scan(page, button('auto')))).not.toContain('small-target')
  expect(rules(await scan(page, button('none')))).toContain('small-target')
})

/** A small-target finding of `element` measured `side` px square. */
const small = (element: string, side: number, size = '390x844'): LayoutFinding => ({
  rule: 'small-target',
  element,
  detail: `${side}x${side} px, under 44x44`,
  measured: { width: side, height: side },
  size,
})

const ENTRY: LayoutAllowance = {
  task: 'FE-1',
  reason: 'a test entry',
  rules: ['small-target'],
  routes: ['user-dashboard'],
  element: /^button\.chip(\.|\s|$)/,
  widths: [390],
  minSide: 20,
}

test('an allowance accepts only its route, element, width and sizes', () => {
  expect(isLayoutAllowed(small('button.chip "A"', 30), 'user-dashboard', [ENTRY])).toBe(true)
  expect(isLayoutAllowed(small('button.chip "A"', 30), 'user-calendar', [ENTRY])).toBe(false)
  expect(isLayoutAllowed(small('button.chip-x "A"', 30), 'user-dashboard', [ENTRY])).toBe(false)
  expect(isLayoutAllowed(small('button.chip "A"', 30, '320x568'), 'user-dashboard', [ENTRY])).toBe(
    false,
  )
  expect(isLayoutAllowed(small('button.chip "A"', 10), 'user-dashboard', [ENTRY])).toBe(false)
})

test('an allowance needs a task key, a reason, and a smallest side for small targets', () => {
  const { minSide: _, ...noSide } = ENTRY

  expect(() => checkAllowances([ENTRY])).not.toThrow()
  expect(() => checkAllowances([{ ...noSide, rules: ['overflow'] }])).not.toThrow()
  expect(() => checkAllowances([{ ...ENTRY, task: 'later' }])).toThrow(/not a task key/)
  expect(() => checkAllowances([{ ...ENTRY, reason: ' ' }])).toThrow(/no reason/)
  expect(() => checkAllowances([noSide])).toThrow(/without minSide/)
})

test('an entry is dead when the screens it covers ran and none needed it', () => {
  const at = (width: number, used: number[]) => ({
    route: 'user-dashboard',
    width,
    skin: undefined,
    used,
  })

  // In scope (390) and used there; in scope and unused; out of scope (320).
  expect(deadAllowances([ENTRY], [at(390, [0]), at(390, [])])).toEqual([])
  expect(deadAllowances([ENTRY], [at(390, [])])).toEqual([0])
  expect(deadAllowances([ENTRY], [at(320, [])])).toEqual([])
})

test('signals stop at the limit per rule and count the rest', () => {
  const list = [small('button.a', 30), small('button.b', 30), small('button.c', 30)]

  const messages = layoutSignals(list, '/x', 2).map((s) => s.message)

  expect(messages).toEqual([
    'small-target @390x844: button.a -- 30x30 px, under 44x44',
    'small-target @390x844: button.b -- 30x30 px, under 44x44',
    'small-target: and 1 more',
  ])
})
