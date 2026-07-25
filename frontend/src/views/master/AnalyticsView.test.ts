// =============================================================================
// VELO Frontend -- AnalyticsView Screen Tests
// =============================================================================
//
// The master's analytics hub: what their practices scored, and what they earned.
// It computes rather than displays -- 16 computeds turn two raw distributions and
// a ledger into the percentages a master reads to judge their own work and their
// own income. Every number on this screen is DERIVED, so a wrong one is silent:
// nothing downstream contradicts it. That is why these tests assert VALUES the
// computeds produce (50% / «1 234,56» / «+23%»), not that a fetch fired.
//
// PATTERN C (hybrid) -- and both halves are driven, per the skill's warning that
// mocking one layer for both guts the test:
//   - DATA HALF (Отзывы): past practices come from a REAL useMasterStore, and
//     per-practice insights from a REAL useDiaryStore's reactive insightsCache
//     (.vue:268-272). Real stores, not mocked ones: the screen's aggregates hang
//     off that reactive Map, and a hand-rolled fake Map is exactly the kind of
//     thing that is quietly non-reactive -- the test would then prove the
//     fixture, not the screen. Both stores read their data from `@/api/masters`
//     and `@/api/diary`, so mocking those two modules seams BOTH halves at once.
//   - LOCAL-REF HALF (Платежи): income / transactions / paymentsLoading /
//     paymentsError are the screen's own refs, fed by direct getIncome +
//     getTransactions calls (.vue:449-499). Same `@/api/masters` seam.
// One real Pinia instance goes to setActivePinia AND app.use (SC-03).
//
// TIME IS PINNED to 2026-07-20T12:00:00Z. The screen reads the WALL CLOCK twice
// -- `periodPractices` (.vue:307) and `attentionItems` (.vue:418) both cut on
// `Date.now() - PERIOD_DAYS[period] * 86_400_000`. Unpinned, every period
// assertion below is a test that passes today and fails at some future midnight,
// differently in CI (SC-04). All fixtures are LITERAL dates chosen relative to
// that frozen instant, never `Date.now() + n`. The timezone cannot leak either:
// every fixture carries `timezone: 'UTC'`, formatShortDate defaults to 'UTC'
// (utils/format.ts:118), and formatMoney is called with an explicit 'ru'.
//
// TRAP -- v-show, not v-if: BOTH tab panes are permanently in the DOM
// (.vue:54,175). `host.textContent` therefore contains the Платежи pane's text
// while Отзывы is on screen, and `.analytics__loader` matches in either pane. So
// every assertion here is scoped to reviewsPane() / paymentsPane(), and
// "is this tab showing?" is `style.display !== 'none'`. A whole-host toContain()
// on this screen is a test that cannot fail.
//
// TRAP -- the aggregates do NOT cover what is cached: loadVisibleInsights()
// (.vue:524-526) eager-loads insights for ALL past practices, but `periodInsights`
// (.vue:310-312) only maps the ones inside the period. P_ANCIENT below carries
// deliberately enormous insights (100 participants / 100 fires) precisely so a
// broken period filter cannot hide -- it would blow every percentage apart.
//
// NBSP: formatMoney is Intl ru currency (utils/format.ts:27-40), which groups
// thousands with U+00A0 -- «1 234,56 €» is not the space on your keyboard, and a
// normally-typed assertion fails on every amount over 999. norm() flattens it.
// U+2212 (MINUS SIGN, not the ASCII hyphen) and U+2014 (EM DASH) are matched
// through the MINUS / DASH constants for the same reason: written as escapes,
// because the glyphs are indistinguishable from their lookalikes in a diff.
//
// SC-13: SendMessageModal (.vue:228) wraps VModal, which teleports
// `.v-modal__overlay` to document.body -- a CLOSED one outlives app.unmount().
// afterEach purges it unconditionally.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import AnalyticsView from '@/views/master/AnalyticsView.vue'
import * as mastersApi from '@/api/masters'
import * as diaryApi from '@/api/diary'
import { ApiResponseError } from '@/api/client'
import type {
  PracticeResponse,
  PracticeInsightsResponse,
  MasterReviewItem,
  MasterTransactionItem,
  IncomeResponse,
} from '@/api/types'

// Both stores under this screen read from these two modules, so mocking them
// seams the store-backed half and the local-ref half in one move.
vi.mock('@/api/masters')
vi.mock('@/api/diary')

const push = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back: vi.fn() }),
}))

// -----------------------------------------------------------------------------
// The frozen instant, and the characters that lie in a diff
// -----------------------------------------------------------------------------

const NOW = new Date('2026-07-20T12:00:00Z')

/** U+2212 MINUS SIGN -- the screen's negative sign (.vue:465,470), NOT '-'. */
const MINUS = '\u2212'
/** U+2014 EM DASH -- the "no data yet" placeholder (.vue:346,352,458). */
const DASH = '—'

// -----------------------------------------------------------------------------
// Fixtures. Dates are literals picked against NOW: week cuts at 2026-07-13T12:00Z
// (7d), month at 2026-06-20T12:00Z (30d).
// -----------------------------------------------------------------------------

function practice(id: string, overrides: Partial<PracticeResponse> = {}): PracticeResponse {
  return {
    id,
    master_id: 'm1',
    practice_type: 'live',
    status: 'completed',
    title: `Практика ${id}`,
    description: null,
    scheduled_at: '2026-07-18T12:00:00Z',
    duration_minutes: 60,
    timezone: 'UTC',
    max_participants: 20,
    current_participants: 10,
    zoom_link: null,
    parent_practice_id: null,
    is_free: true,
    price_cents: 0,
    currency: 'EUR',
    created_at: '2026-07-01T00:00:00Z',
    updated_at: null,
    ...overrides,
  }
}

// 2 days back -- inside week and month.
const P_NEW = practice('p1', {
  title: 'Утренняя практика',
  scheduled_at: '2026-07-18T12:00:00Z',
  current_participants: 10,
})
// 5 days back -- inside week and month.
const P_MID = practice('p2', {
  title: 'Вечерняя практика',
  scheduled_at: '2026-07-15T12:00:00Z',
  current_participants: 10,
})
// 15 days back -- month ONLY. The lever that makes the period toggle observable.
const P_MONTH = practice('p3', {
  title: 'Дыхание',
  scheduled_at: '2026-07-05T12:00:00Z',
  current_participants: 5,
})
// Tomorrow, and not completed -- must never reach the past list.
const P_FUTURE = practice('p4', {
  title: 'Завтрашняя практика',
  status: 'scheduled',
  scheduled_at: '2026-07-21T12:00:00Z',
})
// 45 days back -- outside BOTH periods, with absurd insights (below) so that a
// broken period filter is unmissable rather than a plausible-looking number.
const P_ANCIENT = practice('p5', {
  title: 'Древняя практика',
  scheduled_at: '2026-06-05T12:00:00Z',
  current_participants: 100,
})

// Deliberately unsorted: the screen must sort newest-first itself (.vue:296-300).
const PRACTICES = [P_MONTH, P_NEW, P_ANCIENT, P_FUTURE, P_MID]

function insights(
  practiceId: string,
  participants: number,
  checkins: { high: number; mid: number; low: number },
  feedbacks: { fire: number; good: number; confused: number },
): PracticeInsightsResponse {
  return {
    practice_id: practiceId,
    participants,
    checkins,
    feedbacks,
    comments_count: 0,
  }
}

// Week (p1+p2): 20 participants, 10 check-ins -> 50%; 8 feedbacks -> 40%.
//               fire 4 / good 3 / confused 1  (total 8)
// Month (+p3):  25 participants, 15 check-ins -> 60%; 11 feedbacks -> 44%.
//               fire 4 / good 4 / confused 3  (total 11)
// The two periods differ on EVERY figure on purpose -- equal numbers would let a
// toggle that does nothing pass.
const INSIGHTS: Record<string, PracticeInsightsResponse> = {
  p1: insights('p1', 10, { high: 4, mid: 2, low: 1 }, { fire: 3, good: 1, confused: 1 }),
  p2: insights('p2', 10, { high: 2, mid: 1, low: 0 }, { fire: 1, good: 2, confused: 0 }),
  p3: insights('p3', 5, { high: 5, mid: 0, low: 0 }, { fire: 0, good: 1, confused: 2 }),
  p5: insights('p5', 100, { high: 100, mid: 0, low: 0 }, { fire: 100, good: 0, confused: 0 }),
}

function review(overrides: Partial<MasterReviewItem> = {}): MasterReviewItem {
  return {
    user_id: 'u1',
    reviewer_name: 'Анна',
    avatar_url: null,
    rating: 'confused',
    comment: null,
    practice_title: 'Утренняя практика',
    created_at: '2026-07-19T12:00:00Z',
    ...overrides,
  }
}

// 1 day back -- inside week and month.
const RV_RECENT = review({
  user_id: 'u1',
  reviewer_name: 'Анна',
  comment: 'Было сложно успевать',
  created_at: '2026-07-19T12:00:00Z',
})
// 20 days back -- month ONLY.
const RV_OLD = review({
  user_id: 'u2',
  reviewer_name: 'Борис',
  comment: null,
  practice_title: 'Дыхание',
  created_at: '2026-06-30T12:00:00Z',
})
// Recent, but a POSITIVE rating. The endpoint is called with attention=true so
// the backend already narrows to `confused` -- but the screen re-filters on
// rating client-side (.vue:419-421), and this fixture is what holds that filter
// honest if the server contract ever loosens.
const RV_HAPPY = review({
  user_id: 'u3',
  reviewer_name: 'Вера',
  rating: 'fire',
  comment: 'Отлично',
  practice_title: 'Вечерняя практика',
  created_at: '2026-07-19T12:00:00Z',
})

const INCOME_WEEK: IncomeResponse = {
  income_cents: 123456,
  prev_income_cents: 100000,
  delta_pct: 23.456,
}
const INCOME_MONTH: IncomeResponse = {
  income_cents: 500000,
  prev_income_cents: 600000,
  delta_pct: -16.7,
}

function txn(overrides: Partial<MasterTransactionItem> = {}): MasterTransactionItem {
  return {
    title: 'Оплата за практику',
    practice_title: null,
    created_at: '2026-07-19T10:00:00Z',
    counterparty_name: null,
    amount_cents: 1000,
    ...overrides,
  }
}

const TX_SALE = txn({
  title: 'Оплата за практику',
  practice_title: 'Утренняя практика',
  counterparty_name: 'Анна',
  amount_cents: 250000,
})
const TX_FEE = txn({
  title: 'Комиссия платформы',
  practice_title: null,
  created_at: '2026-07-18T10:00:00Z',
  counterparty_name: null,
  amount_cents: -50000,
})

function practicesPage(items: PracticeResponse[], total = items.length, offset = 0) {
  return { items, total, limit: 20, offset }
}

// T22-5 (ПРОМТ №561): the server now owns the completed-only, most-recent-
// first ordering -- pastPractices no longer re-sorts client-side (.vue), so
// the fake server must actually behave like one. This screen only ever
// fetches the "past" bucket (fetchPastPractices), but the helper mirrors
// both bucket semantics from listing_service.py for consistency with the
// other master-store test files.
function mockBucketedPractices(items: PracticeResponse[]): void {
  vi.mocked(mastersApi.getMyPractices).mockImplementation(
    async (bucket: 'upcoming' | 'past', limit = 20, offset = 0) => {
      const filtered = items
        .filter((p) =>
          bucket === 'upcoming'
            ? p.status === 'draft' || p.status === 'scheduled' || p.status === 'live'
            : p.status === 'completed',
        )
        .sort((a, b) => {
          const diff = new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime()
          return bucket === 'upcoming' ? diff : -diff
        })
      return practicesPage(filtered.slice(offset, offset + limit), filtered.length, offset)
    },
  )
}
function txPage(items: MasterTransactionItem[], total = items.length, offset = 0) {
  return { items, total, limit: 20, offset }
}
function reviewsPage(items: MasterReviewItem[], total = items.length) {
  return { items, total, limit: 20, offset: 0 }
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null
let pinia: Pinia

// The SAME pinia instance goes to setActivePinia and app.use (SC-03): two
// instances means the test drives one store while the screen renders another,
// and every assertion passes while proving nothing.
function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(AnalyticsView)
  app.use(pinia)
  app.mount(host)
  return host
}

// COUNTED, not copied (velo-idiom §3, SC-08). The deepest chain onMounted
// (.vue:542-547) kicks off is the SEQUENTIAL practices -> insights one:
//   (1) await getMyPractices inside usePagination.loadMore
//   (2) loadMore's continuation resolves -> (3) refresh's -> (4) fetchMyPractices'
//   (5) onMounted resumes and calls loadVisibleInsights
//   (6) await getPracticeInsights -> (7) loadInsights resolves
//   (8) the Promise.all over them -> (9) onMounted resumes -> (10) re-render.
// The fire-and-forget loadPayments()/loadReviews() run alongside and are
// shallower (~5). Twelve, not ten: over-counting is free, and this chain grows
// the moment anything joins that onMounted.
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await nextTick()
}

// Intl groups thousands with U+00A0 / U+202F / U+2009 depending on the Node/ICU
// build, so all three are flattened rather than pinning one and breaking on a
// runtime upgrade. Written as ESCAPES, never as literal characters: a literal
// NBSP is invisible in a diff and the next editor "tidies" it into a plain space
// without ever seeing what they broke.
function norm(s: string | null | undefined): string {
  return (s ?? '').replace(/[\u00A0\u202F\u2009]/g, ' ')
}

// -----------------------------------------------------------------------------
// Scoped queries. MANDATORY on this screen: both panes are v-show, so they are
// BOTH always in the DOM and a host-wide query silently spans both tabs.
// -----------------------------------------------------------------------------

function panes(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('.analytics__body') ?? [])
}
function reviewsPane(): HTMLElement {
  const pane = panes()[0]
  if (!pane) throw new Error('the Отзывы pane did not render')
  return pane
}
function paymentsPane(): HTMLElement {
  const pane = panes()[1]
  if (!pane) throw new Error('the Платежи pane did not render')
  return pane
}
/** v-show writes `display:none` inline, so the inline style IS the observable. */
function shown(el: HTMLElement): boolean {
  return el.style.display !== 'none'
}
function paneText(el: HTMLElement): string {
  return norm(el.textContent)
}

/** A control in the chrome (tab strip / period toggle), outside both panes. */
function chromeButton(label: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-segment-track__btn') ?? []).find(
    (b) => b.textContent?.trim() === label,
  )
}

function buttonIn(root: ParentNode, label: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
    b.textContent?.includes(label),
  )
}

/** A stat card's value, found by its LABEL -- the three cards are positional otherwise. */
function stat(label: string): string {
  const card = Array.from(reviewsPane().querySelectorAll<HTMLElement>('.v-stat')).find(
    (c) => c.querySelector('.v-stat__label')?.textContent?.trim() === label,
  )
  return norm(card?.querySelector('.v-stat__value')?.textContent).trim()
}

/** A «Общая статистика» bar's «NN% (count)» meta, found by its bucket label. */
function distMeta(label: string): string {
  const row = Array.from(reviewsPane().querySelectorAll<HTMLElement>('.v-rating-dist__row')).find(
    (r) => r.querySelector('.v-rating-dist__head')?.textContent?.includes(label),
  )
  return norm(row?.querySelector('.v-rating-dist__meta')?.textContent).trim()
}

function pcards(): HTMLElement[] {
  return Array.from(reviewsPane().querySelectorAll<HTMLElement>('.analytics__pcard'))
}
function pcardTitles(): string[] {
  return pcards().map((c) => c.querySelector('.analytics__pcard-title')?.textContent?.trim() ?? '')
}
function badgesOf(card: HTMLElement): string[] {
  return Array.from(card.querySelectorAll('.v-rating-badges__badge')).map((b) =>
    norm(b.textContent).trim(),
  )
}

function attentionCards(): HTMLElement[] {
  return Array.from(reviewsPane().querySelectorAll<HTMLElement>('.analytics__attention'))
}
function attentionNames(): string[] {
  return attentionCards().map(
    (c) => c.querySelector('.analytics__attention-name')?.textContent?.trim() ?? '',
  )
}

function txnRows(): HTMLElement[] {
  return Array.from(paymentsPane().querySelectorAll<HTMLElement>('.analytics__txn'))
}
function incomeValue(): string {
  return norm(paymentsPane().querySelector('.analytics__income-value')?.textContent).trim()
}
function incomeDeltaEl(): HTMLElement | null {
  return paymentsPane().querySelector<HTMLElement>('.analytics__income-delta')
}

/**
 * Whether the send-message modal has been DISMISSED.
 *
 * Deliberately not `querySelector('.v-modal__overlay') === null` (SC-13b): that
 * is the obvious assertion and it fails while the product is correct. VModal's
 * overlay is `v-if="open"` inside a <Transition> (VModal.vue:21-22), so flipping
 * `open` to false starts a LEAVE that Vue finishes on a transitionend happy-dom
 * never fires -- the node lingers, stamped `v-modal-leave-active`. The real
 * observable is the leave STARTING. Pinned false while open below, so the
 * assertion cannot vacuously always-pass.
 */
function modalDismissed(): boolean {
  const overlay = document.body.querySelector('.v-modal__overlay')
  return overlay === null || overlay.classList.contains('v-modal-leave-active')
}
function modalText(): string {
  return norm(document.body.querySelector('.v-modal__overlay')?.textContent)
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  vi.setSystemTime(NOW)
  pinia = createPinia()
  setActivePinia(pinia)

  vi.mocked(mastersApi.getMyPractices).mockReset()
  mockBucketedPractices(PRACTICES)
  vi.mocked(mastersApi.getMasterReviews)
    .mockReset()
    .mockResolvedValue(reviewsPage([RV_RECENT, RV_OLD, RV_HAPPY]))
  vi.mocked(mastersApi.getIncome)
    .mockReset()
    .mockImplementation(async (period) => (period === 'month' ? INCOME_MONTH : INCOME_WEEK))
  vi.mocked(mastersApi.getTransactions).mockReset().mockResolvedValue(txPage([TX_SALE, TX_FEE]))

  // The real store puts whatever this resolves into its reactive cache; a
  // practice with no fixture rejects, which is the honest shape of an insights
  // fetch that failed (stores/diary.ts:363-380 swallows it into insightsErrorMap).
  vi.mocked(diaryApi.getPracticeInsights)
    .mockReset()
    .mockImplementation(async (id: string) => {
      const found = INSIGHTS[id]
      if (!found) throw new ApiResponseError(404, 'Нет данных', 'insights_not_found')
      return found
    })

  push.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null

  // SC-13. A CLOSED teleported overlay outlives app.unmount(): the <Transition>
  // leave waits on a transitionend happy-dom never fires, so the overlay stays
  // parked on document.body, is found FIRST in document order by the next test,
  // and that test then clicks a dead node owned by an unmounted app -- the first
  // modal test passes and every later one fails while the screen is healthy.
  // Unconditional and idempotent: free when unnecessary, load-bearing when not.
  document.body.querySelectorAll('.v-modal__overlay').forEach((el) => el.remove())

  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('AnalyticsView', () => {
  // ===========================================================================
  describe('the two tabs (v-show, so both panes are always mounted)', () => {
    it('opens on Отзывы, with the Платежи pane present but hidden', async () => {
      mount()
      await flush()

      expect(shown(reviewsPane())).toBe(true)
      expect(shown(paymentsPane())).toBe(false)
      expect(chromeButton('Отзывы')?.getAttribute('aria-selected')).toBe('true')
      expect(chromeButton('Платежи')?.getAttribute('aria-selected')).toBe('false')
    })

    it('switching to Платежи shows that pane and hides Отзывы', async () => {
      mount()
      await flush()

      chromeButton('Платежи')?.click()
      await flush()

      expect(shown(paymentsPane())).toBe(true)
      expect(shown(reviewsPane())).toBe(false)
      expect(chromeButton('Платежи')?.getAttribute('aria-selected')).toBe('true')
    })
  })

  // ===========================================================================
  describe('Отзывы -- the past-practice ladder', () => {
    it('loading: shows the loader in the Отзывы pane, and no cards', async () => {
      vi.mocked(mastersApi.getMyPractices).mockReturnValue(new Promise(() => {}))
      mount()
      await flush()

      expect(reviewsPane().querySelector('.analytics__loader')).not.toBeNull()
      expect(pcards()).toHaveLength(0)
      expect(paneText(reviewsPane())).not.toContain('За выбранный период практик нет')
    })

    it('empty: a master with only FUTURE practices is told the period is empty', async () => {
      mockBucketedPractices([P_FUTURE])
      mount()
      await flush()

      expect(pcards()).toHaveLength(0)
      expect(paneText(reviewsPane())).toContain('За выбранный период практик нет')
    })

    it('empty: completed practices that all fall OUTSIDE the period read as empty', async () => {
      // P_ANCIENT is completed and loaded -- it is the 7-day cut that hides it,
      // which is a different thing from having no practices at all.
      mockBucketedPractices([P_ANCIENT])
      mount()
      await flush()

      expect(pcards()).toHaveLength(0)
      expect(paneText(reviewsPane())).toContain('За выбранный период практик нет')
    })

    it('content: renders each in-period practice with its date and participant count', async () => {
      mount()
      await flush()

      expect(pcardTitles()).toEqual(['Утренняя практика', 'Вечерняя практика'])
      const meta = pcards()[0]?.querySelector('.analytics__pcard-meta')?.textContent ?? ''
      expect(meta).toContain('18 июля')
      expect(meta).toContain('10 участников')
    })

    it('sorts newest-first, regardless of the order the API returned', async () => {
      // PRACTICES is deliberately shuffled (p3, p1, p5, p4, p2). Read on МЕСЯЦ so
      // all three in-period practices are visible at once -- the week holds two,
      // and a two-item list is a weak sort assertion.
      mount()
      await flush()
      chromeButton('Месяц')?.click()
      await flush()

      expect(pcardTitles()).toEqual(['Утренняя практика', 'Вечерняя практика', 'Дыхание'])
    })

    it('excludes practices that are not completed', async () => {
      mount()
      await flush()

      expect(pcardTitles()).not.toContain('Завтрашняя практика')
    })

    it('a FAILED practices load shows the EMPTY state, not an error (known gap)', async () => {
      // Asserted because it is what the screen does, NOT because it is right.
      // usePagination catches into `error` (composables/usePagination.ts:67-70)
      // and useMasterStore re-exports it as practicesError -- but this template
      // never binds it (.vue:113-124), so a network failure is rendered as the
      // factual claim «За выбранный период практик нет». Reported as a finding;
      // this test is the tripwire for the day it is repaired.
      vi.mocked(mastersApi.getMyPractices).mockRejectedValue(new TypeError('network down'))
      mount()
      await flush()

      expect(paneText(reviewsPane())).toContain('За выбранный период практик нет')
      expect(reviewsPane().querySelector('.analytics__loader')).toBeNull()
    })
  })

  // ===========================================================================
  describe('Отзывы -- aggregate derivations (the point of the screen)', () => {
    it('week: check-in 50%, feedback 40%, 8 отзывов -- over the period, not the cache', async () => {
      // p1 (10 participants, 7 check-ins, 5 feedbacks) + p2 (10, 3, 3).
      // P_ANCIENT's insights ARE cached -- loadVisibleInsights eager-loads every
      // past practice (.vue:524-526) -- and carry 100 participants / 100 fires.
      // If periodInsights leaked them, none of these numbers would survive.
      mount()
      await flush()

      // Proof, not prose: p5 really IS fetched into the cache. Without this the
      // exclusion claim above is untested -- the numbers would look identical if
      // loadVisibleInsights simply never loaded it, and the test would be
      // asserting a coincidence.
      expect(diaryApi.getPracticeInsights).toHaveBeenCalledWith('p5')

      expect(stat('Check-in')).toBe('50%')
      expect(stat('Feedback')).toBe('40%')
      expect(stat('Отзывов')).toBe('8')
    })

    it('month: every figure moves -- check-in 60%, feedback 44%, 11 отзывов', async () => {
      mount()
      await flush()

      chromeButton('Месяц')?.click()
      await flush()

      expect(stat('Check-in')).toBe('60%')
      expect(stat('Feedback')).toBe('44%')
      expect(stat('Отзывов')).toBe('11')
    })

    it('reads «—» rather than «0%» when the period holds no participants at all', async () => {
      // aggregateTotalParticipants === 0 (.vue:345-348,351-354). 0% would be a
      // claim that nobody checked in; the em dash says there is nothing to rate.
      mockBucketedPractices([P_FUTURE])
      mount()
      await flush()

      expect(stat('Check-in')).toBe(DASH)
      expect(stat('Feedback')).toBe(DASH)
      expect(stat('Отзывов')).toBe('0')
    })

    it('«—» too when in-period practices exist but their insights never arrived', async () => {
      // A cache miss must not be reported as a zero score.
      vi.mocked(diaryApi.getPracticeInsights).mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()

      expect(pcards()).toHaveLength(2)
      expect(stat('Check-in')).toBe(DASH)
      expect(stat('Отзывов')).toBe('0')
    })

    it('the distribution bars sum the period feedbacks: 50% (4) / 38% (3) / 13% (1)', async () => {
      // fire 3+1, good 1+2, confused 1+0 over a total of 8.
      mount()
      await flush()

      expect(distMeta('Огонь!')).toBe('50% (4)')
      expect(distMeta('Хорошо')).toBe('38% (3)')
      expect(distMeta('Есть вопросы')).toBe('13% (1)')
    })

    it('the distribution follows the period: month is 36% (4) / 36% (4) / 27% (3)', async () => {
      mount()
      await flush()

      chromeButton('Месяц')?.click()
      await flush()

      expect(distMeta('Огонь!')).toBe('36% (4)')
      expect(distMeta('Хорошо')).toBe('36% (4)')
      expect(distMeta('Есть вопросы')).toBe('27% (3)')
    })

    it('renders 0% bars rather than nothing when the period has no feedback', async () => {
      mockBucketedPractices([P_FUTURE])
      mount()
      await flush()

      expect(distMeta('Огонь!')).toBe('0% (0)')
      expect(distMeta('Есть вопросы')).toBe('0% (0)')
    })
  })

  // ===========================================================================
  describe('Отзывы -- the inline per-practice badges', () => {
    it('renders each card its OWN percentages, not the aggregate', async () => {
      // p1: 3/1/1 of 5 -> 60/20/20.  p2: 1/2/0 of 3 -> 33/67/0.
      mount()
      await flush()

      expect(badgesOf(pcards()[0]!)).toEqual(['60%', '20%', '20%'])
      expect(badgesOf(pcards()[1]!)).toEqual(['33%', '67%', '0%'])
    })

    it('shows no badges on a practice whose insights failed to load', async () => {
      // `insightsCache.has(p.id)` (.vue:148). An absent fetch must not render as
      // a 0/0/0 verdict on the practice.
      vi.mocked(diaryApi.getPracticeInsights).mockImplementation(async (id: string) => {
        const found = INSIGHTS[id]
        if (!found || id === 'p2') throw new ApiResponseError(404, 'Нет данных', 'nope')
        return found
      })
      mount()
      await flush()

      expect(badgesOf(pcards()[0]!)).toEqual(['60%', '20%', '20%'])
      expect(badgesOf(pcards()[1]!)).toEqual([])
    })

    it('shows no badges when insights arrived but nobody left feedback', async () => {
      // `totalFeedbacks(p.id) > 0` (.vue:148) -- a practice with check-ins but
      // zero feedback would otherwise show a confident 0%/0%/0% trio.
      vi.mocked(diaryApi.getPracticeInsights).mockResolvedValue(
        insights('p1', 10, { high: 4, mid: 0, low: 0 }, { fire: 0, good: 0, confused: 0 }),
      )
      mount()
      await flush()

      expect(pcards()).toHaveLength(2)
      expect(badgesOf(pcards()[0]!)).toEqual([])
    })
  })

  // ===========================================================================
  describe('Отзывы -- the 3-card preview and its reveal', () => {
    const FIVE = [
      practice('a1', { title: 'Практика A', scheduled_at: '2026-07-19T12:00:00Z' }),
      practice('a2', { title: 'Практика B', scheduled_at: '2026-07-18T12:00:00Z' }),
      practice('a3', { title: 'Практика C', scheduled_at: '2026-07-17T12:00:00Z' }),
      practice('a4', { title: 'Практика D', scheduled_at: '2026-07-16T12:00:00Z' }),
      practice('a5', { title: 'Практика E', scheduled_at: '2026-07-15T12:00:00Z' }),
    ]

    it('caps the list at 3 and offers «+ ещё 2 практик»', async () => {
      mockBucketedPractices(FIVE)
      mount()
      await flush()

      expect(pcards()).toHaveLength(3)
      expect(pcardTitles()).toEqual(['Практика A', 'Практика B', 'Практика C'])
      expect(paneText(reviewsPane())).toContain('+ ещё 2 практик')
    })

    it('the reveal expands to the whole period', async () => {
      mockBucketedPractices(FIVE)
      mount()
      await flush()

      buttonIn(reviewsPane(), '+ ещё 2 практик')?.click()
      await flush()

      expect(pcards()).toHaveLength(5)
      expect(paneText(reviewsPane())).not.toContain('+ ещё 2 практик')
    })

    it('offers no reveal when the period fits in the preview', async () => {
      mount()
      await flush()

      expect(pcards()).toHaveLength(2)
      expect(paneText(reviewsPane())).not.toContain('+ ещё')
    })

    it('once expanded, «Показать ещё» pages the store AND loads the new insights', async () => {
      // onLoadMore (.vue:528-531) must re-run loadVisibleInsights, or the newly
      // paged-in cards render with no badges until something else re-triggers it.
      // A custom mock (not mockBucketedPractices) here: total=6 while only 5
      // are loaded, to simulate a 6th completed practice still on the server.
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(practicesPage(FIVE, 6, 0))
      mount()
      await flush()
      buttonIn(reviewsPane(), '+ ещё 2 практик')?.click()
      await flush()

      const NEXT = practice('a6', { title: 'Практика F', scheduled_at: '2026-07-14T12:00:00Z' })
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(practicesPage([NEXT], 6, 5))
      vi.mocked(diaryApi.getPracticeInsights).mockClear()

      buttonIn(reviewsPane(), 'Показать ещё')?.click()
      await flush()

      expect(mastersApi.getMyPractices).toHaveBeenLastCalledWith('past', 20, 5)
      expect(pcards()).toHaveLength(6)
      expect(pcardTitles()).toContain('Практика F')
      expect(diaryApi.getPracticeInsights).toHaveBeenCalledWith('a6')
    })

    it('changing the period collapses the reveal back to the preview', async () => {
      // watch(period) resets pastExpanded (.vue:509-515): a month's worth of
      // cards left expanded from a week's «показать все» is a different list.
      mockBucketedPractices(FIVE)
      mount()
      await flush()
      buttonIn(reviewsPane(), '+ ещё 2 практик')?.click()
      await flush()
      expect(pcards()).toHaveLength(5)

      chromeButton('Месяц')?.click()
      await flush()

      expect(pcards()).toHaveLength(3)
      expect(paneText(reviewsPane())).toContain('+ ещё 2 практик')
    })
  })

  // ===========================================================================
  describe('Требуют внимания', () => {
    it('lists only CONFUSED reviews inside the period', async () => {
      // RV_HAPPY is recent but positive; RV_OLD is confused but 20 days old.
      mount()
      await flush()

      expect(attentionNames()).toEqual(['Анна'])
      expect(paneText(reviewsPane())).toContain('Требуют внимания')
    })

    it('month widens the window to the older confused review', async () => {
      mount()
      await flush()

      chromeButton('Месяц')?.click()
      await flush()

      expect(attentionNames()).toEqual(['Анна', 'Борис'])
    })

    it('renders the reviewer, the practice and the quoted comment', async () => {
      mount()
      await flush()

      const card = attentionCards()[0]!
      expect(card.querySelector('.analytics__attention-pr')?.textContent).toContain(
        'Утренняя практика',
      )
      expect(card.querySelector('.analytics__attention-quote')?.textContent).toContain(
        'Было сложно успевать',
      )
    })

    it('renders no quote line when the review carried no comment', async () => {
      vi.mocked(mastersApi.getMasterReviews).mockResolvedValue(reviewsPage([RV_OLD]))
      mount()
      await flush()
      chromeButton('Месяц')?.click()
      await flush()

      expect(attentionNames()).toEqual(['Борис'])
      expect(attentionCards()[0]?.querySelector('.analytics__attention-quote')).toBeNull()
    })

    it('hides the section AND its heading when nothing needs attention', async () => {
      vi.mocked(mastersApi.getMasterReviews).mockResolvedValue(reviewsPage([RV_HAPPY]))
      mount()
      await flush()

      expect(attentionCards()).toHaveLength(0)
      expect(paneText(reviewsPane())).not.toContain('Требуют внимания')
    })

    it('a failed reviews fetch leaves the section silent, and the rest of the tab alive', async () => {
      // loadReviews swallows (.vue:410-412). The past-practice list and the
      // aggregates are unrelated data and must survive.
      vi.mocked(mastersApi.getMasterReviews).mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()

      expect(attentionCards()).toHaveLength(0)
      expect(paneText(reviewsPane())).not.toContain('Требуют внимания')
      expect(pcards()).toHaveLength(2)
      expect(stat('Check-in')).toBe('50%')
    })

    it('asks the backend for the negative bucket, not a mixed page', async () => {
      // attention=true (.vue:408) -- a mixed page can be all-positive and leave
      // the block empty while confused reviews exist further down the feed. The
      // ONE call-shape assertion in this file, because the argument is the
      // behaviour: nothing rendered can distinguish it.
      mount()
      await flush()

      expect(mastersApi.getMasterReviews).toHaveBeenCalledWith(20, 0, true)
    })
  })

  // ===========================================================================
  describe('Требуют внимания -- navigation and the message modal', () => {
    it('tapping a card opens that reviewer\'s student profile', async () => {
      mount()
      await flush()

      attentionCards()[0]?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({
        name: 'master-student-profile',
        params: { id: 'u1' },
        query: { name: 'Анна' },
      })
    })

    it('the message button opens the modal WITHOUT navigating', async () => {
      // @click.stop (.vue:102). Without it the card's own handler also fires and
      // the master is thrown to the profile instead of the message sheet.
      mount()
      await flush()

      expect(modalDismissed()).toBe(true)

      attentionCards()[0]
        ?.querySelector<HTMLButtonElement>('.analytics__attention-msg')
        ?.click()
      await flush()

      expect(push).not.toHaveBeenCalled()
      expect(modalText()).toContain('Анна')
      expect(modalDismissed()).toBe(false)
    })

    it('«Отмена» dismisses the modal', async () => {
      mount()
      await flush()
      attentionCards()[0]
        ?.querySelector<HTMLButtonElement>('.analytics__attention-msg')
        ?.click()
      await flush()
      // Pinned open first, so modalDismissed() cannot always-pass (SC-13b).
      expect(modalDismissed()).toBe(false)

      const overlay = document.body.querySelector('.v-modal__overlay')!
      Array.from(overlay.querySelectorAll<HTMLButtonElement>('button'))
        .find((b) => b.textContent?.includes('Отмена'))
        ?.click()
      await flush()

      expect(modalDismissed()).toBe(true)
    })
  })

  // ===========================================================================
  describe('Платежи -- the ladder', () => {
    it('loading: shows the loader in the Платежи pane and no income yet', async () => {
      vi.mocked(mastersApi.getIncome).mockReturnValue(new Promise(() => {}))
      mount()
      await flush()

      expect(paymentsPane().querySelector('.analytics__loader')).not.toBeNull()
      expect(paymentsPane().querySelector('.analytics__income')).toBeNull()
    })

    it('error: surfaces the REAL backend detail, not a fallback', async () => {
      // paymentsError = e.detail for an ApiResponseError (.vue:495), rendered
      // straight into the card (.vue:179).
      vi.mocked(mastersApi.getTransactions).mockRejectedValue(
        new ApiResponseError(503, 'Реестр платежей недоступен', 'ledger_down'),
      )
      mount()
      await flush()

      expect(paymentsPane().querySelector('.analytics__pay-error')).not.toBeNull()
      expect(paneText(paymentsPane())).toContain('Реестр платежей недоступен')
    })

    it('error: falls back to a generic message on a non-API error', async () => {
      vi.mocked(mastersApi.getIncome).mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()

      expect(paneText(paymentsPane())).toContain('Ошибка загрузки')
      expect(paneText(paymentsPane())).not.toContain('boom')
    })

    it('error: «Повторить» recovers the tab into real content', async () => {
      vi.mocked(mastersApi.getIncome).mockRejectedValueOnce(new TypeError('boom'))
      mount()
      await flush()
      expect(paneText(paymentsPane())).toContain('Ошибка загрузки')

      buttonIn(paymentsPane(), 'Повторить')?.click()
      await flush()

      expect(paymentsPane().querySelector('.analytics__pay-error')).toBeNull()
      expect(incomeValue()).toContain('1 234,56')
      expect(txnRows()).toHaveLength(2)
    })

    it('empty: no transactions is not an error -- the income still stands', async () => {
      vi.mocked(mastersApi.getTransactions).mockResolvedValue(txPage([]))
      mount()
      await flush()

      expect(txnRows()).toHaveLength(0)
      expect(paneText(paymentsPane())).toContain('Данных пока нет')
      expect(incomeValue()).toContain('1 234,56')
    })
  })

  // ===========================================================================
  describe('Платежи -- money', () => {
    it('renders the period income (NBSP-grouped) with its signed delta', async () => {
      mount()
      await flush()

      expect(mastersApi.getIncome).toHaveBeenCalledWith('week')
      expect(incomeValue()).toContain('1 234,56')
      expect(norm(incomeDeltaEl()?.textContent).trim()).toBe('+23%')
      expect(incomeDeltaEl()?.className).toContain('analytics__income-delta--up')
    })

    it('a zero income reads «0,00 €», NOT «Бесплатно»', async () => {
      // formatMoney is called with allowZero=true (.vue:458) precisely because a
      // real master really can earn nothing this week -- and «Бесплатно»
      // (utils/format.ts:33) is a price label, not an income of zero.
      vi.mocked(mastersApi.getIncome).mockResolvedValue({
        income_cents: 0,
        prev_income_cents: 0,
        delta_pct: null,
      })
      mount()
      await flush()

      expect(incomeValue()).toContain('0,00')
      expect(paneText(paymentsPane())).not.toContain('Бесплатно')
    })

    it('hides the delta entirely when the backend sends null', async () => {
      // delta_pct is null when the previous period had no turnover (.vue:462-467).
      // Rendering «+0%» there would claim flat, when the truth is "no baseline".
      vi.mocked(mastersApi.getIncome).mockResolvedValue({
        income_cents: 500,
        prev_income_cents: 0,
        delta_pct: null,
      })
      mount()
      await flush()

      expect(incomeDeltaEl()).toBeNull()
    })

    it('renders «+0%» for a flat period, and tags it as up', async () => {
      // `d >= 0` (.vue:460,465) -- zero is not a decline.
      vi.mocked(mastersApi.getIncome).mockResolvedValue({
        income_cents: 500,
        prev_income_cents: 500,
        delta_pct: 0,
      })
      mount()
      await flush()

      expect(norm(incomeDeltaEl()?.textContent).trim()).toBe('+0%')
      expect(incomeDeltaEl()?.className).toContain('analytics__income-delta--up')
    })

    it('renders each transaction signed, tagged, and named after its practice', async () => {
      // M5 (.vue:478-481): practice_title wins over the generic stored label.
      mount()
      await flush()

      const [sale, fee] = txnRows()
      expect(sale?.querySelector('.analytics__txn-title')?.textContent).toBe('Утренняя практика')
      expect(norm(sale?.querySelector('.analytics__txn-amt')?.textContent).trim()).toBe(
        '+2 500,00 €',
      )
      expect(sale?.querySelector('.analytics__txn-amt')?.className).toContain(
        'analytics__txn-amt--in',
      )
      expect(norm(sale?.querySelector('.analytics__txn-meta')?.textContent)).toContain('19 июля')
      expect(norm(sale?.querySelector('.analytics__txn-meta')?.textContent)).toContain('Анна')

      expect(fee?.querySelector('.analytics__txn-title')?.textContent).toBe('Комиссия платформы')
      expect(norm(fee?.querySelector('.analytics__txn-amt')?.textContent).trim()).toBe(
        `${MINUS}500,00 €`,
      )
      expect(fee?.querySelector('.analytics__txn-amt')?.className).toContain(
        'analytics__txn-amt--out',
      )
    })

    it('a platform-side row shows no counterparty separator', async () => {
      mount()
      await flush()

      expect(norm(txnRows()[1]?.querySelector('.analytics__txn-meta')?.textContent).trim()).toBe(
        '18 июля',
      )
    })

    it('offers «Показать ещё» only while loaded < total, and appends from the offset', async () => {
      vi.mocked(mastersApi.getTransactions).mockResolvedValue(txPage([TX_SALE], 2))
      mount()
      await flush()
      expect(buttonIn(paymentsPane(), 'Показать ещё')).toBeDefined()

      vi.mocked(mastersApi.getTransactions).mockResolvedValue(txPage([TX_FEE], 2, 1))
      buttonIn(paymentsPane(), 'Показать ещё')?.click()
      await flush()

      expect(mastersApi.getTransactions).toHaveBeenLastCalledWith(20, 1)
      expect(txnRows()).toHaveLength(2)
      expect(buttonIn(paymentsPane(), 'Показать ещё')).toBeUndefined()
    })

    it('hides «Показать ещё» when the first page is everything', async () => {
      mount()
      await flush()

      expect(buttonIn(paymentsPane(), 'Показать ещё')).toBeUndefined()
    })
  })

  // ===========================================================================
  describe('the period toggle drives income, and only income', () => {
    it('re-fetches income for the new period and renders ITS figures', async () => {
      mount()
      await flush()
      expect(incomeValue()).toContain('1 234,56')

      chromeButton('Месяц')?.click()
      await flush()

      expect(mastersApi.getIncome).toHaveBeenLastCalledWith('month')
      expect(incomeValue()).toContain('5 000,00')
      expect(norm(incomeDeltaEl()?.textContent).trim()).toBe(`${MINUS}17%`)
      expect(incomeDeltaEl()?.className).toContain('analytics__income-delta--down')
    })

    it('does NOT re-fetch the transaction feed -- it is not period-scoped', async () => {
      // watch(period) calls loadIncome only (.vue:509-515). Re-paging the ledger
      // on a toggle would silently reset a master's «показать ещё» progress.
      mount()
      await flush()
      expect(mastersApi.getTransactions).toHaveBeenCalledTimes(1)

      chromeButton('Месяц')?.click()
      await flush()

      expect(mastersApi.getTransactions).toHaveBeenCalledTimes(1)
      expect(txnRows()).toHaveLength(2)
    })

    it('re-picking the CURRENT period does nothing', async () => {
      // The watch fires on CHANGE only.
      mount()
      await flush()
      expect(mastersApi.getIncome).toHaveBeenCalledTimes(1)

      chromeButton('Неделя')?.click()
      await flush()

      expect(mastersApi.getIncome).toHaveBeenCalledTimes(1)
    })

    it('a failed income refetch KEEPS the previous figure rather than blanking it', async () => {
      // The watch's `.catch(() => {})` (.vue:512-514) is deliberate. Note what it
      // costs: the number on screen is now the WEEK's while the toggle reads
      // «Месяц», and nothing says so. Asserted as the behaviour it is.
      mount()
      await flush()
      expect(incomeValue()).toContain('1 234,56')

      vi.mocked(mastersApi.getIncome).mockRejectedValue(new TypeError('boom'))
      chromeButton('Месяц')?.click()
      await flush()

      expect(incomeValue()).toContain('1 234,56')
      expect(paymentsPane().querySelector('.analytics__pay-error')).toBeNull()
    })
  })

  // ===========================================================================
  describe('navigation', () => {
    it('tapping a past practice opens its reviews', async () => {
      mount()
      await flush()

      pcards()[1]?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({
        name: 'master-practice-reviews',
        params: { id: 'p2' },
      })
    })
  })

  // ===========================================================================
  // NOT COVERED, deliberately
  //
  // - The «Платежи» link to the full finance screen: the template has no such
  //   control. The header comment (.vue:29) promises one ("Full finance ... lives
  //   on /master/finance -> link"), and it is not there. A comment, not a
  //   behaviour -- reported, not faked.
  // - VStatCard / VRatingDistribution / VRatingBadges / VShowMore / VSegmentTrack
  //   internals: DS primitives with their own homes. Asserted here only through
  //   the values this screen feeds them.
  // - The insights LRU eviction and the "skip if already cached" guard
  //   (stores/diary.ts:363-380): store behaviour, and probekit-unit-test's ground.
  // - «Отправить» in the send-message modal: a documented stub that toasts
  //   (SendMessageModal.vue:45-48). It belongs to that component's own test, not
  //   to a screen test that would be asserting a placeholder (SC-09).
  // - The income «—» placeholder (.vue:457-459): unreachable honestly. The
  //   backend always returns an IncomeResponse, so incomeData is null only on the
  //   pre-onMounted first paint -- which app.mount() flushes past synchronously,
  //   before any assertion can see it. Forcing it through with a null cast
  //   would assert the cast, not the screen. It becomes testable the day
  //   income gets its own independent loading state.
  // - Keyboard activation of the attention card (@keydown.enter.space): the
  //   handler is the same goStudent already covered through the click path;
  //   a second test would assert Vue's modifier, not this screen.
  // ===========================================================================
})
