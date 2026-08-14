// =============================================================================
// VELO Frontend -- PracticeReviewsView Screen Tests
// =============================================================================
//
// The screen a master lands on after tapping a past practice in AnalyticsView.
// It is a VERDICT on a piece of their work: what share of the room checked in,
// what share left feedback, and how those feedbacks split three ways. Eleven
// computeds turn one PracticeInsightsResponse + one PracticeResponse into every
// number on it, and NOTHING downstream contradicts a wrong one -- there is no
// second view of the same figures to notice a disagreement. So every assertion
// below is on the VALUE a computed produced («70%» / «50% (3)» / «8/20»), never
// on the fact that a fetch fired (SC-02).
//
// THE NUMBERS ARE PERCENTAGES, NOT COUNTS -- and that is easy to get backwards
// from a glance at the .vue, because PracticeReviewsView passes RAW COUNTS to
// VRatingDistribution (.vue:47-51 -- `:fire="feedbackCounts.fire"`). The
// percentage maths lives one level DOWN, inside the child
// (VRatingDistribution.vue:72-82), which renders «NN% (count)» -- BOTH, the
// percentage first. Reading only this screen's template you would assert «3»;
// the DOM says «60% (3)». Follow the call one level down (velo-idiom §2 --
// children are not stubbed, so the child's maths is on trial here too).
//
// PATTERN: A (store-backed) for the DATA half + B (local-ref) for the REVIEWS
// half, in one screen. Called out because mocking one layer for both would gut
// the test:
//   - STATS + DISTRIBUTION come from a REAL useDiaryStore's reactive
//     insightsCache (.vue:122-123). The screen grabs that Map by reference at
//     setup and derives `insights` from it, so a hand-rolled fake Map is exactly
//     the thing that is quietly non-reactive -- the test would then prove the
//     fixture rather than the screen. A real store with `@/api/diary` mocked
//     seams it honestly, and keeps the warm-cache path (loadInsights skips a
//     cached id, stores/diary.ts:364) reachable. Precedent: AnalyticsView.test.ts.
//   - REVIEWS are the screen's OWN refs -- reviews / reviewsTotal /
//     reviewsLoading / reviewsError (.vue:188-191) -- fed by direct
//     getPracticeReviews calls (.vue:200-226). `@/api/practices` is that seam,
//     auto-mocked; it also carries getPractice for the hero card.
// ONE real Pinia instance goes to setActivePinia AND app.use (SC-03).
//
// NO TIME IS PINNED, deliberately. Verified, not assumed: this screen never
// reads the wall clock (grep: zero `Date.now()` / `new Date()`). Its only date
// is formatShortDate(scheduled_at, timezone) (utils/format.ts:118-130), which is
// Intl over the fixture's own ISO string -- the same output on any day, in any
// CI timezone. Every fixture still carries `timezone: 'UTC'` so the render
// cannot drift with the host TZ. vi.setSystemTime here would be cargo (SC-04 is
// about screens that DO read the clock; this one does not).
//
// NO MONEY IS FORMATTED HERE -- formatMoney is not imported (grep: zero hits),
// so the ru NBSP trap (velo-idiom §11) does not bite. norm() is kept anyway
// because Intl emits U+00A0 from the DATE formatters on some ICU builds and the
// guard costs nothing. It is written as ESCAPES, never literal characters: a
// literal NBSP is invisible in a diff and the next editor "tidies" it into a
// plain space without ever seeing what they broke.
//
// NO OVERLAY REAP (SC-13), and that is a checked claim rather than an omission:
// this screen opens no modal and no bottom sheet, and none of its nine children
// teleports to body (grep: only VHeader has a Teleport at all, and it is
// `:disabled="!floating"` targeting `.mobile-layout__island` -- with no
// MobileLayout ancestor above a bare createApp mount, useFloatingHeader() injects
// its `false` default and the header renders INLINE). Nothing can park on
// document.body, so there is nothing to purge. Add the purge the day this screen
// grows a dialog.
//
// NO SCOPED PANES (SC-14): every branch here is v-if/v-else-if (grep: zero
// v-show), so the DOM really does hold one rung at a time and a host-wide
// query cannot silently span two states.
//
// No order dependence: every test mounts its own app, and beforeEach rebuilds
// the pinia, the fixtures and the mocks.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import PracticeReviewsView from '@/views/master/PracticeReviewsView.vue'
import { useDiaryStore } from '@/stores/diary'
import * as practicesApi from '@/api/practices'
import * as diaryApi from '@/api/diary'
import { ApiResponseError } from '@/api/client'
import type { PracticeResponse, PracticeInsightsResponse, ReviewItem } from '@/api/types'

// The hero card + the reviews list (.vue:96). Auto-mocked: nothing in this
// module needs preserving -- ApiResponseError lives in @/api/client, which stays
// REAL so the swallowed-detail assertion below runs against the real class.
vi.mock('@/api/practices')
// The seam UNDER the real diary store (stores/diary.ts:40) -- mocking it drives
// the store's insightsCache through its own real write path.
vi.mock('@/api/diary')

const push = vi.fn()
const back = vi.fn()
const routeParams: { id: string } = { id: 'p1' }
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back }),
  useRoute: () => ({ params: routeParams }),
}))

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function practice(overrides: Partial<PracticeResponse> = {}): PracticeResponse {
  return {
    id: 'p1',
    master_id: 'm1',
    master_name: 'Мастер',
    practice_type: 'live',
    status: 'completed',
    title: 'Утренняя практика',
    description: null,
    what_to_prepare: null,
    contraindications: null,
    scheduled_at: '2026-07-18T12:00:00Z',
    duration_minutes: 60,
    // UTC on purpose: formatShortDate cuts the day in THIS zone (format.ts:118),
    // so a fixture in a real zone would render a different day in a CI box east
    // or west of here.
    timezone: 'UTC',
    max_participants: 20,
    current_participants: 8,
    parent_practice_id: null,
    is_free: true,
    price_cents: 0,
    currency: 'EUR',
    direction: 'yoga',
    created_at: '2026-07-01T00:00:00Z',
    updated_at: null,
    ...overrides,
  } as PracticeResponse
}

function insights(
  participants: number,
  checkins: { high: number; mid: number; low: number },
  feedbacks: { fire: number; good: number; confused: number },
): PracticeInsightsResponse {
  return { practice_id: 'p1', participants, checkins, feedbacks, comments_count: 0 }
}

// 10 participants; 4+2+1 = 7 check-ins -> 70%; 3+1+1 = 5 feedbacks -> 50%.
// Distribution over those 5: fire 60% (3) / good 20% (1) / confused 20% (1).
// Every one of the five figures is DIFFERENT on purpose -- equal numbers would
// let two computeds be wired to each other's source and still pass.
const INSIGHTS = insights(10, { high: 4, mid: 2, low: 1 }, { fire: 3, good: 1, confused: 1 })

function review(n: number, overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    user_id: `u${n}`,
    reviewer_name: `Рецензент ${n}`,
    avatar_url: null,
    rating: 'fire',
    comment: null,
    created_at: '2026-07-19T10:00:00Z',
    ...overrides,
  }
}

const RV_FIRE = review(1, { reviewer_name: 'Анна', rating: 'fire', comment: 'Очень понравилось' })
const RV_GOOD = review(2, { reviewer_name: 'Борис', rating: 'good', comment: null })
const RV_CONFUSED = review(3, {
  reviewer_name: 'Вера',
  rating: 'confused',
  comment: 'Было сложно успевать',
})

function reviewsPage(items: ReviewItem[], total = items.length, offset = 0) {
  return { items, total, limit: 20, offset }
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null
let pinia: Pinia

// ONE pinia instance to setActivePinia and app.use (SC-03): two instances means
// the test seeds one insightsCache while the screen renders another, and every
// assertion passes while proving nothing.
function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(PracticeReviewsView)
  app.use(pinia)
  app.mount(host)
  return host
}

// COUNTED, not copied (velo-idiom §3, SC-08). onMounted (.vue:232-243) spends:
//   (1) await diaryStore.loadInsights -> inside it, await getPracticeInsights
//   (2) loadInsights resumes, writes the cache, runs its finally
//   (3) onMounted resumes -> fires `void loadReviews()` (not awaited) and then
//       awaits getPractice
//   (4) getPracticeReviews resolves -> loadReviews assigns reviews/total
//   (5) loadReviews' finally flips reviewsLoading
//   (6) getPractice resolves -> practice.value is assigned
//   (7) the final re-render.
// Seven on the deepest path. Ten, because over-counting is free (velo-idiom §3)
// and this chain grows the moment anything joins that onMounted.
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await nextTick()
}

// Intl groups/spaces with U+00A0 / U+202F / U+2009 depending on the Node/ICU
// build, so all three are flattened rather than pinning one and breaking on a
// runtime upgrade. ESCAPES, never literal characters -- see the banner.
function norm(s: string | null | undefined): string {
  return (s ?? '').replace(/[\u00A0\u202F\u2009]/g, ' ')
}

function text(): string {
  return norm(host?.textContent)
}

/** A stat card's value, found by its LABEL -- the three cards are positional otherwise. */
function stat(label: string): string {
  const card = Array.from(host?.querySelectorAll<HTMLElement>('.v-stat') ?? []).find(
    (c) => c.querySelector('.v-stat__label')?.textContent?.trim() === label,
  )
  return norm(card?.querySelector('.v-stat__value')?.textContent).trim()
}

/**
 * A distribution bar's «NN% (count)» meta, found by its bucket label.
 *
 * This is the child's render (VRatingDistribution.vue:30), not this screen's:
 * the screen hands it raw counts and the child divides. Asserting here is
 * deliberate -- children are not stubbed (velo-idiom §2), and what the master
 * actually reads is the percentage.
 */
function distMeta(label: string): string {
  const row = Array.from(host?.querySelectorAll<HTMLElement>('.v-rating-dist__row') ?? []).find(
    (r) => r.querySelector('.v-rating-dist__head')?.textContent?.includes(label),
  )
  return norm(row?.querySelector('.v-rating-dist__meta')?.textContent).trim()
}

function heroMeta(): string {
  return norm(host?.querySelector('.hero-card__meta')?.textContent).replace(/\s+/g, ' ').trim()
}

function reviewCards(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('.practice-reviews__review') ?? [])
}

function reviewNames(): string[] {
  return reviewCards().map(
    (c) => c.querySelector('.practice-reviews__review-name')?.textContent?.trim() ?? '',
  )
}

/** The inline colour the screen stamped on a review's rating icon (.vue:76). */
function reviewIconColors(): string[] {
  return reviewCards().map(
    (c) =>
      c.querySelector('.practice-reviews__review-ident svg')?.getAttribute('style')?.trim() ?? '',
  )
}

/**
 * Each review icon's viewBox -- the only thing that distinguishes the three
 * IconRating* components from the DOM (they are otherwise three <svg fill=
 * "currentColor"> of the same shape). Asserted for DISTINCTNESS rather than for
 * literal values: the claim under test is that RATING_ICON (.vue:194-198) maps
 * the rating to a DIFFERENT component per bucket, and pinning the three
 * viewBoxes would fail on an icon redesign that broke nothing.
 */
function reviewIconShapes(): string[] {
  return reviewCards().map(
    (c) =>
      c.querySelector('.practice-reviews__review-ident svg')?.getAttribute('viewBox')?.trim() ?? '',
  )
}

function buttonWith(label: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((b) =>
    b.textContent?.includes(label),
  )
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  routeParams.id = 'p1'

  vi.mocked(diaryApi.getPracticeInsights).mockReset().mockResolvedValue(INSIGHTS)
  vi.mocked(practicesApi.getPractice).mockReset().mockResolvedValue(practice())
  vi.mocked(practicesApi.getPracticeReviews)
    .mockReset()
    .mockResolvedValue(reviewsPage([RV_FIRE, RV_GOOD, RV_CONFUSED]))

  push.mockReset()
  back.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('PracticeReviewsView', () => {
  // ===========================================================================
  describe('the practice header card', () => {
    it('renders the practice title, its date and «занято/мест»', async () => {
      mount()
      await flush()

      expect(host!.querySelector('.hero-card__title')?.textContent?.trim()).toBe(
        'Утренняя практика',
      )
      expect(heroMeta()).toContain('18 июля')
      expect(heroMeta()).toContain('8/20')
    })

    it('renders a bare headcount when the practice has no participant cap', async () => {
      // participantsLabel (.vue:135-141): max_participants == null -> no «/N».
      // «8/null» or «8/0» would both be a claim the master never made.
      vi.mocked(practicesApi.getPractice).mockResolvedValue(
        practice({ max_participants: null, current_participants: 8 }),
      )
      mount()
      await flush()

      expect(heroMeta()).toContain('8')
      expect(heroMeta()).not.toContain('/')
    })

    it('a FAILED practice fetch hides the hero card but leaves the stats standing', async () => {
      // onMounted swallows into practice.value = null (.vue:237-242) and the card
      // is `v-if="practice"` (.vue:28). The insights are a SEPARATE fetch and the
      // numbers must survive a header that did not load.
      vi.mocked(practicesApi.getPractice).mockRejectedValue(
        new ApiResponseError(404, 'Практика не найдена', 'practice_not_found'),
      )
      mount()
      await flush()

      expect(host!.querySelector('.hero-card')).toBeNull()
      expect(stat('Check-in')).toBe('70%')
      expect(reviewCards()).toHaveLength(3)
    })
  })

  // ===========================================================================
  describe('the stat cards -- percentages derived from the insights', () => {
    it('check-in 70%, feedback 50%, and 5 отзывов', async () => {
      // 10 participants; checkins 4+2+1 = 7 -> 70% (.vue:147-161);
      // feedbacks 3+1+1 = 5 -> 50% (.vue:152-167); feedbacksLabel is the raw
      // COUNT, not a percentage (.vue:169-171) -- the one number on this row
      // that is not a ratio.
      mount()
      await flush()

      expect(stat('Check-in')).toBe('70%')
      expect(stat('Feedback')).toBe('50%')
      expect(stat('Отзывов')).toBe('5')
    })

    it('rounds to a whole percent rather than trailing decimals', async () => {
      // 2 of 3 = 66.66..% -> «67%» (Math.round, .vue:160). Asserted because the
      // fixture above divides evenly and would not notice a missing round().
      vi.mocked(diaryApi.getPracticeInsights).mockResolvedValue(
        insights(3, { high: 1, mid: 1, low: 0 }, { fire: 1, good: 0, confused: 0 }),
      )
      mount()
      await flush()

      expect(stat('Check-in')).toBe('67%')
      expect(stat('Feedback')).toBe('33%')
    })

    it('reads «—» on every card while the insights have not arrived', async () => {
      // `insights` is null until the store's cache is written (.vue:123), and all
      // three cards fall back to the em dash (.vue:159,165,170). This is also the
      // LOADING rung for the stats half: the screen has no loader here, the dash
      // IS the pre-data state.
      vi.mocked(diaryApi.getPracticeInsights).mockReturnValue(new Promise(() => {}))
      mount()
      await flush()

      expect(stat('Check-in')).toBe('—')
      expect(stat('Feedback')).toBe('—')
      expect(stat('Отзывов')).toBe('—')
    })

    it('reads «—», not «0%», when the insights fetch FAILED', async () => {
      // The store swallows the rejection into insightsErrorMap and never writes
      // the cache (stores/diary.ts:375-377), so the screen sees the same null as
      // above. The distinction that matters: «0%» would be a factual claim that
      // nobody checked in. Nothing was measured at all.
      vi.mocked(diaryApi.getPracticeInsights).mockRejectedValue(
        new ApiResponseError(503, 'Аналитика недоступна', 'insights_down'),
      )
      mount()
      await flush()

      expect(stat('Check-in')).toBe('—')
      expect(stat('Feedback')).toBe('—')
      expect(stat('Отзывов')).toBe('—')
    })

    it('an EMPTY practice: «—» for the ratios but a hard «0» for the count', async () => {
      // The 0/0/0 case, and the two halves of the row diverge on purpose.
      // participants === 0 -> the ratios are undefined (a division by zero), so
      // «—» (.vue:159,165). But feedbacksLabel is gated on `insights` EXISTING,
      // not on participants (.vue:169-171) -- insights DID arrive and they say
      // zero reviews, which is a fact worth stating. «0» here is honest;
      // «0%» above would not have been.
      vi.mocked(diaryApi.getPracticeInsights).mockResolvedValue(
        insights(0, { high: 0, mid: 0, low: 0 }, { fire: 0, good: 0, confused: 0 }),
      )
      mount()
      await flush()

      expect(stat('Check-in')).toBe('—')
      expect(stat('Feedback')).toBe('—')
      expect(stat('Отзывов')).toBe('0')
    })

    it('states a real 0% when there were participants but nobody responded', async () => {
      // The mirror of the case above, and the reason it cannot be folded into it:
      // 10 people in the room and no feedback IS a 0% score, not «no data».
      vi.mocked(diaryApi.getPracticeInsights).mockResolvedValue(
        insights(10, { high: 3, mid: 0, low: 0 }, { fire: 0, good: 0, confused: 0 }),
      )
      mount()
      await flush()

      expect(stat('Check-in')).toBe('30%')
      expect(stat('Feedback')).toBe('0%')
      expect(stat('Отзывов')).toBe('0')
    })
  })

  // ===========================================================================
  describe('«Распределение» -- PERCENTAGES with the count in parentheses', () => {
    it('splits the five feedbacks 60% (3) / 20% (1) / 20% (1)', async () => {
      // The screen passes RAW COUNTS (.vue:47-51); the child divides them by
      // their own total -- 5, NOT the 10 participants (VRatingDistribution.vue:
      // 73-81). So this row is «share of the feedback given», while the Feedback
      // stat card above is «share of the room that gave any». Two different
      // denominators, one screen: 3 of 5 is 60% here and would be 30% there.
      mount()
      await flush()

      expect(distMeta('Огонь!')).toBe('60% (3)')
      expect(distMeta('Хорошо')).toBe('20% (1)')
      expect(distMeta('Есть вопросы')).toBe('20% (1)')
    })

    it('renders 0% bars rather than nothing when the insights never arrived', async () => {
      // feedbackCounts falls back to { fire: 0, good: 0, confused: 0 } (.vue:
      // 178-180) and the child guards its division on `total > 0`
      // (VRatingDistribution.vue:80). A NaN% bar -- 0/0 -- is what a missing
      // guard looks like, and it would render as the string «NaN%».
      vi.mocked(diaryApi.getPracticeInsights).mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()

      expect(distMeta('Огонь!')).toBe('0% (0)')
      expect(distMeta('Хорошо')).toBe('0% (0)')
      expect(distMeta('Есть вопросы')).toBe('0% (0)')
      expect(text()).not.toContain('NaN')
    })

    it('renders 0% bars when the insights arrived carrying an empty distribution', async () => {
      vi.mocked(diaryApi.getPracticeInsights).mockResolvedValue(
        insights(10, { high: 3, mid: 0, low: 0 }, { fire: 0, good: 0, confused: 0 }),
      )
      mount()
      await flush()

      expect(distMeta('Огонь!')).toBe('0% (0)')
      expect(distMeta('Есть вопросы')).toBe('0% (0)')
      expect(text()).not.toContain('NaN')
    })

    it('a single-bucket practice reads 100% (2) / 0% (0) / 0% (0)', async () => {
      vi.mocked(diaryApi.getPracticeInsights).mockResolvedValue(
        insights(4, { high: 2, mid: 0, low: 0 }, { fire: 0, good: 0, confused: 2 }),
      )
      mount()
      await flush()

      expect(distMeta('Есть вопросы')).toBe('100% (2)')
      expect(distMeta('Огонь!')).toBe('0% (0)')
      expect(distMeta('Хорошо')).toBe('0% (0)')
    })
  })

  // ===========================================================================
  describe('the insights cache is shared with AnalyticsView', () => {
    it('renders straight from a WARM cache without re-fetching', async () => {
      // AnalyticsView eager-loads insights for every past practice, so arriving
      // here by tapping a card usually finds the id already cached; loadInsights
      // then returns without a request (stores/diary.ts:364). The screen must
      // render the cached figures anyway -- it has no fetch of its own to fall
      // back on.
      useDiaryStore().insightsCache.set('p1', INSIGHTS)
      mount()
      await flush()

      expect(diaryApi.getPracticeInsights).not.toHaveBeenCalled()
      expect(stat('Check-in')).toBe('70%')
      expect(distMeta('Огонь!')).toBe('60% (3)')
    })

    it('reads the cache entry for THIS practice, not whatever was cached first', async () => {
      // `insightsCache.get(practiceId.value)` (.vue:123). A screen that read the
      // first/only entry would pass every test above and show the wrong
      // practice's verdict the moment the master opened a second one.
      useDiaryStore().insightsCache.set(
        'p9',
        insights(100, { high: 100, mid: 0, low: 0 }, { fire: 100, good: 0, confused: 0 }),
      )
      mount()
      await flush()

      expect(stat('Check-in')).toBe('70%')
      expect(distMeta('Огонь!')).toBe('60% (3)')
    })

    it('asks the store for the id in the route, not a hardcoded one', async () => {
      routeParams.id = 'p42'
      mount()
      await flush()

      expect(diaryApi.getPracticeInsights).toHaveBeenCalledWith('p42')
      expect(practicesApi.getPractice).toHaveBeenCalledWith('p42')
      expect(practicesApi.getPracticeReviews).toHaveBeenCalledWith('p42', 20, 0)
    })
  })

  // ===========================================================================
  describe('«Отзывы» -- the ladder', () => {
    it('loading: shows the loader, and neither cards nor the empty note', async () => {
      vi.mocked(practicesApi.getPracticeReviews).mockReturnValue(new Promise(() => {}))
      mount()
      await flush()

      expect(host!.querySelector('.practice-reviews__rloader')).not.toBeNull()
      expect(reviewCards()).toHaveLength(0)
      expect(text()).not.toContain('Отзывов пока нет')
    })

    it('error: shows the failure state with a «Повторить» way out', async () => {
      vi.mocked(practicesApi.getPracticeReviews).mockRejectedValue(
        new ApiResponseError(503, 'Хранилище отзывов недоступно', 'reviews_down'),
      )
      mount()
      await flush()

      expect(text()).toContain('Не удалось загрузить отзывы')
      expect(buttonWith('Повторить')).toBeDefined()
      expect(reviewCards()).toHaveLength(0)
      expect(host!.querySelector('.practice-reviews__rloader')).toBeNull()
    })

    it('error: the message is the SCREEN\'s constant -- the backend detail is swallowed', async () => {
      // SC-05. loadReviews catches bare (.vue:207-209): `catch { reviewsError =
      // true }` keeps no message, and the template hardcodes its title
      // (.vue:60). So this test proves the screen's own string, and explicitly
      // NOT that a backend message propagates -- it cannot. The negative
      // assertion is the honest half: a master told «не удалось» learns nothing
      // about WHY, and this pins that as the known behaviour rather than
      // letting a future reader assume the detail surfaces.
      vi.mocked(practicesApi.getPracticeReviews).mockRejectedValue(
        new ApiResponseError(503, 'Хранилище отзывов недоступно', 'reviews_down'),
      )
      mount()
      await flush()

      expect(text()).toContain('Не удалось загрузить отзывы')
      expect(text()).not.toContain('Хранилище отзывов недоступно')
    })

    it('error: an insights failure does NOT trip the reviews error state', async () => {
      // Two independent fetches (.vue:235-238). A dead analytics endpoint must
      // not report the reviews as unloadable when they loaded fine.
      vi.mocked(diaryApi.getPracticeInsights).mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()

      expect(text()).not.toContain('Не удалось загрузить отзывы')
      expect(reviewNames()).toEqual(['Анна', 'Борис', 'Вера'])
    })

    it('empty: a practice nobody reviewed says so, without an error', async () => {
      vi.mocked(practicesApi.getPracticeReviews).mockResolvedValue(reviewsPage([]))
      mount()
      await flush()

      expect(host!.querySelector('.v-empty-note')?.textContent?.trim()).toBe('Отзывов пока нет')
      expect(reviewCards()).toHaveLength(0)
      expect(text()).not.toContain('Не удалось загрузить отзывы')
    })

    it('content: renders every reviewer, in the order the backend returned', async () => {
      mount()
      await flush()

      expect(reviewNames()).toEqual(['Анна', 'Борис', 'Вера'])
    })

    it('content: quotes the comment, and renders no quote line without one', async () => {
      // `v-if="r.comment"` (.vue:81). An empty «» on a review with no comment
      // reads as a reviewer who said nothing out loud -- different from one who
      // left no comment at all.
      mount()
      await flush()

      expect(
        reviewCards()[0]?.querySelector('.practice-reviews__review-quote')?.textContent?.trim(),
      ).toBe('«Очень понравилось»')
      expect(reviewCards()[1]?.querySelector('.practice-reviews__review-quote')).toBeNull()
      expect(
        reviewCards()[2]?.querySelector('.practice-reviews__review-quote')?.textContent?.trim(),
      ).toBe('«Было сложно успевать»')
    })

    it('content: each review carries ITS rating\'s icon and accent colour', async () => {
      // RATING_ICON (.vue:194-198) picks the component; RATING_ICON_COLOR
      // (displayHelpers.ts:110-114) the accent. Both are Record<FeedbackRating,…>
      // literals -- a transposed key here paints a confused review as fire, which
      // is precisely the review a master must not miss.
      mount()
      await flush()

      expect(reviewIconColors()).toEqual([
        'color: var(--velo-rating-fire);',
        'color: var(--velo-rating-good);',
        'color: var(--velo-rating-confused);',
      ])

      // Three ratings must resolve to three DIFFERENT components -- a constant
      // icon would satisfy the colour assertion above on its own.
      expect(new Set(reviewIconShapes()).size).toBe(3)
    })

    it('«Повторить» recovers a failed load into real content', async () => {
      vi.mocked(practicesApi.getPracticeReviews).mockRejectedValueOnce(new TypeError('boom'))
      mount()
      await flush()
      expect(text()).toContain('Не удалось загрузить отзывы')

      buttonWith('Повторить')?.click()
      await flush()

      expect(text()).not.toContain('Не удалось загрузить отзывы')
      expect(reviewNames()).toEqual(['Анна', 'Борис', 'Вера'])
    })
  })

  // ===========================================================================
  describe('«Отзывы» -- pagination', () => {
    it('offers «Показать ещё» only while loaded < total', async () => {
      // hasMoreReviews (.vue:192).
      vi.mocked(practicesApi.getPracticeReviews).mockResolvedValue(reviewsPage([RV_FIRE], 3))
      mount()
      await flush()

      expect(buttonWith('Показать ещё')).toBeDefined()
    })

    it('hides «Показать ещё» when the first page is everything', async () => {
      mount()
      await flush()

      expect(reviewCards()).toHaveLength(3)
      expect(buttonWith('Показать ещё')).toBeUndefined()
    })

    it('pages from the loaded OFFSET and APPENDS, rather than replacing', async () => {
      // offset = reviews.value.length (.vue:218) and the result is spread onto
      // the existing list (.vue:219). An offset of 0 would re-fetch page one and
      // silently double every review; a bare assignment would throw page one away.
      vi.mocked(practicesApi.getPracticeReviews).mockResolvedValue(reviewsPage([RV_FIRE], 3))
      mount()
      await flush()

      vi.mocked(practicesApi.getPracticeReviews).mockResolvedValue(
        reviewsPage([RV_GOOD, RV_CONFUSED], 3, 1),
      )
      buttonWith('Показать ещё')?.click()
      await flush()

      expect(practicesApi.getPracticeReviews).toHaveBeenLastCalledWith('p1', 20, 1)
      expect(reviewNames()).toEqual(['Анна', 'Борис', 'Вера'])
      expect(buttonWith('Показать ещё')).toBeUndefined()
    })

    it('keeps the loaded page visible while the next one is in flight', async () => {
      // SC-06 in miniature: the loader is gated on `reviews.length === 0`
      // (.vue:57), so a load-more must NOT blank the list it already has.
      vi.mocked(practicesApi.getPracticeReviews).mockResolvedValue(reviewsPage([RV_FIRE], 3))
      mount()
      await flush()

      vi.mocked(practicesApi.getPracticeReviews).mockReturnValue(new Promise(() => {}))
      buttonWith('Показать ещё')?.click()
      await flush()

      expect(reviewNames()).toEqual(['Анна'])
      expect(host!.querySelector('.practice-reviews__rloader')).toBeNull()
    })

    it('a second tap while a page is in flight does not fire a second request', async () => {
      // The `reviewsLoading` guard (.vue:215). Without it an impatient double-tap
      // fetches the same offset twice and appends the page twice.
      vi.mocked(practicesApi.getPracticeReviews).mockResolvedValue(reviewsPage([RV_FIRE], 3))
      mount()
      await flush()
      expect(practicesApi.getPracticeReviews).toHaveBeenCalledTimes(1)

      vi.mocked(practicesApi.getPracticeReviews).mockReturnValue(new Promise(() => {}))
      buttonWith('Показать ещё')?.click()
      await flush()
      buttonWith('Показать ещё')?.click()
      await flush()

      expect(practicesApi.getPracticeReviews).toHaveBeenCalledTimes(2)
    })

    it('a FAILED load-more keeps the page and the button -- no error state', async () => {
      // loadMoreReviews swallows on purpose (.vue:221-223): the reviews already
      // on screen are still true, so replacing them with «Не удалось загрузить
      // отзывы» would be a lie about the data the master can see. The button
      // stays as the retry.
      vi.mocked(practicesApi.getPracticeReviews).mockResolvedValue(reviewsPage([RV_FIRE], 3))
      mount()
      await flush()

      vi.mocked(practicesApi.getPracticeReviews).mockRejectedValue(new TypeError('boom'))
      buttonWith('Показать ещё')?.click()
      await flush()

      expect(reviewNames()).toEqual(['Анна'])
      expect(text()).not.toContain('Не удалось загрузить отзывы')
      expect(buttonWith('Показать ещё')).toBeDefined()
    })

    it('a failed load-more can be retried into success', async () => {
      vi.mocked(practicesApi.getPracticeReviews).mockResolvedValue(reviewsPage([RV_FIRE], 2))
      mount()
      await flush()

      vi.mocked(practicesApi.getPracticeReviews).mockRejectedValueOnce(new TypeError('boom'))
      buttonWith('Показать ещё')?.click()
      await flush()
      expect(reviewNames()).toEqual(['Анна'])

      vi.mocked(practicesApi.getPracticeReviews).mockResolvedValue(reviewsPage([RV_GOOD], 2, 1))
      buttonWith('Показать ещё')?.click()
      await flush()

      expect(reviewNames()).toEqual(['Анна', 'Борис'])
    })
  })

  // ===========================================================================
  describe('navigation', () => {
    it('tapping a review opens THAT reviewer\'s student profile', async () => {
      // goStudent (.vue:113-119). The id must be the review's user_id, not the
      // practice id in the route -- both are in scope and both are strings.
      mount()
      await flush()

      reviewCards()[2]?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({
        name: 'master-student-profile',
        params: { id: 'u3' },
        query: { name: 'Вера' },
      })
    })

    it('the back button goes back, and does not push a route', async () => {
      // .vue:24 -- `@back="router.back()"`. A push here would grow the history
      // stack the master is trying to unwind.
      mount()
      await flush()

      host!.querySelector<HTMLButtonElement>('button[aria-label="Назад"]')?.click()
      await flush()

      expect(back).toHaveBeenCalledTimes(1)
      expect(push).not.toHaveBeenCalled()
    })
  })

  // ===========================================================================
  // NOT COVERED, deliberately
  //
  // - The «Отзывов» stat card vs the reviews LIST length: they are two different
  //   numbers from two different endpoints (insights.feedbacks vs
  //   getPracticeReviews.total) and the screen never reconciles them. A test
  //   asserting they agree would be asserting the fixtures, not the screen.
  //   Noted rather than tested -- see the report's finding on the divergence.
  // - VStatCard / VEmptyState / VCard / PracticeHeroCard internals: DS
  //   primitives with their own homes. Exercised here only through the values
  //   this screen feeds them. VRatingDistribution is the exception and it is
  //   deliberate: its percentage maths IS this screen's headline number
  //   (see the banner), so it is asserted through the rendered «NN% (count)».
  // - The insights LRU eviction, the "skip if cached" guard and the
  //   insightsErrorMap (stores/diary.ts:363-380): store behaviour, and
  //   probekit-unit-test's ground. Only the screen-visible consequence of the
  //   cache-hit path is asserted above.
  // - A route-param CHANGE while this screen stays mounted (p1 -> p2 without an
  //   unmount). Not tested because it is NOT REACHABLE today, and a test would
  //   have to fabricate the situation to assert on it: the load is onMounted-only
  //   (.vue:232) with no watch on practiceId, so a reused instance would refresh
  //   its STATS (the `insights` computed does track practiceId, .vue:123) while
  //   the hero card and the reviews list stayed on the old practice -- a screen
  //   showing two practices at once. The only navigation into this route comes
  //   from AnalyticsView (.vue:535), a DIFFERENT route, so Vue always unmounts
  //   and onMounted always re-runs. Recorded as the latent trap it is: the day a
  //   second practice-reviews link is added from this screen (a «следующая
  //   практика» control, say), this becomes live and needs a watch + a test.
  // - masterStatusGuard on this route (router/index.ts:255): guard-layer
  //   behaviour, covered bare in router/guards.test.ts. Route meta carries no
  //   role data to assert from here (velo-idiom §6).
  // - The direction icon on the hero card: PracticeHeroCard resolves it through
  //   DIRECTION_ICON, and the screen only forwards `practice.direction`
  //   (.vue:34). Asserting the glyph would test displayHelpers.
  // - Keyboard activation of a review card (VCard's @keydown.enter.space): the
  //   handler is the same goStudent already driven through the click path; a
  //   second test would assert Vue's modifier, not this screen.
  // ===========================================================================
})
