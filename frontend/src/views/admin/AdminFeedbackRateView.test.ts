// =============================================================================
// VELO Frontend -- AdminFeedbackRateView Screen Tests (probekit-screen-test)
// =============================================================================
//
// 189 lines. Read-only analytics drill-in from AdminDashboardView's (№474)
// Engagement "Feedback rate" row. ONE seam: getFeedbackMetric (@/api/admin).
// No store, no mutating actions, no dialogs.
//
// CROSS-SCREEN COMPARISON -- full comparison against its two copy-paste
// siblings (AdminCheckinRateView, AdminReturnRateView) is written out in
// AdminCheckinRateView.test.ts's banner; summarized here, not re-derived:
//   - THE NaN SUSPICION: CLEAN NEGATIVE, byte-identical fallback in all three
//     (`Number.isFinite(rawOffset) ? rawOffset : 0`) -- confirmed again by
//     reading THIS file's .vue:101-102, matches.
//   - THE FULL SKELETON (period/offset parsing, rangeLabel, ladder markup,
//     error fallback, onMounted(load)) is byte-identical across all three,
//     modulo the type name and which getXMetric is called -- another
//     instance of the clean negative, not just copied from the sibling's
//     banner: independently re-verified against THIS file's .vue:99-138.
//   - THE ONE STRUCTURAL DIVERGENCE: unlike Checkin/Return, THIS screen has
//     NO client-side list with its own empty-state branch -- its content is
//     three VRatingBar rows that always render (their null-vs-number
//     handling lives inside VRatingBar itself, not as a template branch
//     here). A legitimate content difference, not a missed guard.
//   - NO v-else-if="data": same as the siblings, the content template
//     renders unconditionally past loading/error even if data.value stays
//     null -- every computed already guards with '—' for exactly that case.
//
// THE THREE-BUCKET DISTRIBUTION (.vue:113-124) -- the real assignment on
// this screen. `distributionTotal = fire + good + confused` (0 if no
// distribution at all). `bucketPct(count)`:
//   if (count == null || distributionTotal.value === 0) return null
//   return Math.round((count / distributionTotal.value) * 100)
// TWO DISTINCT falsy-ish outcomes, not one, both asserted below:
//   - NO reviews at all (distributionTotal === 0, even if a count is
//     literally 0): bucketPct returns null for ALL three buckets -> VRatingBar
//     renders "—" (its own hasValue check, read from VRatingBar.vue).
//   - a bucket that IS 0 but the total is NOT zero (some reviews exist, this
//     bucket just got none of them): count=0 is NOT `== null`, so bucketPct
//     returns the real number 0 -> VRatingBar renders "0%", a real value, not
//     a dash. These are semantically different ("no data yet" vs "measured,
//     zero share") and the guard is written to tell them apart on purpose.
// THE FIELD-NAME MAPPING (explicitly checked, not assumed): the THIRD
// bucket's API field is `confused` (FeedbackRatingDistribution.confused,
// generated.ts:539) but the computed is named `questionRate` (.vue:124,
// `bucketPct(data.value?.distribution.confused)`) and rendered under the
// "Есть вопросы" label (.vue:58-65) -- fire->fireRate/"Огонь!",
// good->goodRate/"Хорошо", confused->questionRate/"Есть вопросы". Asserted
// below with three DIFFERENT counts so a mis-wired mapping would actually
// show up as a wrong percentage on a specific bar, not just "some numbers
// somewhere."
//
// Cyrillic fixtures/expected strings below were typed via the Write tool,
// never a shell heredoc.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AdminFeedbackRateView from '@/views/admin/AdminFeedbackRateView.vue'
import * as adminApi from '@/api/admin'
import { ApiResponseError } from '@/api/client'
import type { FeedbackMetricResponse } from '@/api/types'

vi.mock('@/api/admin')

const back = vi.fn()
let routeQuery: Record<string, string> = {}
vi.mock('vue-router', () => ({
  useRouter: () => ({ back, push: vi.fn() }),
  useRoute: () => ({ query: routeQuery }),
}))

// -----------------------------------------------------------------------------
// Fixtures -- factory functions (read-only screen, no in-place mutation, same
// discipline as the other two siblings regardless).
// -----------------------------------------------------------------------------

function feedbackMetric(overrides: Partial<FeedbackMetricResponse> = {}): FeedbackMetricResponse {
  return {
    rate_pct: 61.3,
    visited: 200,
    left_review: 123,
    distribution: { fire: 5, good: 3, confused: 2 },
    ...overrides,
  }
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null

function mount(query: Record<string, string> = {}): HTMLElement {
  routeQuery = query
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(AdminFeedbackRateView)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

function retryBtn(): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-btn') ?? []).find(
    (b) => b.textContent?.trim() === 'Повторить',
  )
}

function errorDesc(): string {
  return host?.querySelector('.v-empty__desc')?.textContent?.trim() ?? ''
}

function heroValue(): string {
  return host?.querySelector('.v-metric-hero__value')?.textContent?.trim() ?? ''
}

function statValue(label: string): string {
  const cards = Array.from(host?.querySelectorAll<HTMLElement>('.v-stat') ?? [])
  const card = cards.find((c) => c.querySelector('.v-stat__label')?.textContent?.trim() === label)
  if (!card) throw new Error(`no stat card labelled «${label}»`)
  return card.querySelector('.v-stat__value')?.textContent?.trim() ?? ''
}

/** VRatingBar's own rendered value text, found by its label (.v-rating-bar__label). */
function ratingValue(label: string): string {
  const bars = Array.from(host?.querySelectorAll<HTMLElement>('.v-rating-bar') ?? [])
  const bar = bars.find(
    (b) => b.querySelector('.v-rating-bar__label')?.textContent?.trim() === label,
  )
  if (!bar) throw new Error(`no rating bar labelled «${label}»`)
  return bar.querySelector('.v-rating-bar__value')?.textContent?.trim() ?? ''
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(adminApi.getFeedbackMetric).mockReset().mockResolvedValue(feedbackMetric())
  back.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('AdminFeedbackRateView', () => {
  // ===========================================================================
  describe('ladder (THREE rungs -- see banner)', () => {
    it('loading -> content', async () => {
      let resolveGet!: (v: FeedbackMetricResponse) => void
      vi.mocked(adminApi.getFeedbackMetric)
        .mockReset()
        .mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveGet = resolve
            }),
        )
      mount()
      await nextTick()

      expect(host?.querySelector('.v-loader')).not.toBeNull()

      resolveGet(feedbackMetric())
      await flush()

      expect(host?.querySelector('.v-loader')).toBeNull()
      expect(heroValue()).toBe('61%')
    })

    it('failure (generic Error): falls back to "Ошибка загрузки"', async () => {
      vi.mocked(adminApi.getFeedbackMetric).mockRejectedValue(new Error('ECONNRESET'))
      mount()
      await flush()

      expect(errorDesc()).toBe('Ошибка загрузки')
    })

    it('failure (ApiResponseError): shows the generic fallback (unmapped code)', async () => {
      // B8 (PROMPT №747): 'server_error' is not a real backend code --
      // unmapped, lands on the call site's own fallback (.vue:132).
      vi.mocked(adminApi.getFeedbackMetric).mockRejectedValue(
        new ApiResponseError(500, 'Сервис метрик недоступен', 'server_error'),
      )
      mount()
      await flush()

      expect(errorDesc()).toBe('Ошибка загрузки')
    })

    it('«Повторить» recovers to content after a failure', async () => {
      vi.mocked(adminApi.getFeedbackMetric).mockRejectedValueOnce(new Error('ECONNRESET'))
      mount()
      await flush()

      expect(retryBtn()).toBeDefined()
      vi.mocked(adminApi.getFeedbackMetric).mockResolvedValueOnce(feedbackMetric())
      retryBtn()?.click()
      await flush()

      expect(host?.querySelector('.v-empty')).toBeNull()
      expect(heroValue()).toBe('61%')
      expect(adminApi.getFeedbackMetric).toHaveBeenCalledTimes(2)
    })
  })

  // ===========================================================================
  describe('query-driven fetch args (.vue:100-102) -- exact (period, offset) reaching the api mock', () => {
    it('?period=month&offset=3 -> getFeedbackMetric("month", 3)', async () => {
      mount({ period: 'month', offset: '3' })
      await flush()

      expect(adminApi.getFeedbackMetric).toHaveBeenCalledWith('month', 3)
    })

    it('?period=week&offset=-1 -> getFeedbackMetric("week", -1)', async () => {
      mount({ period: 'week', offset: '-1' })
      await flush()

      expect(adminApi.getFeedbackMetric).toHaveBeenCalledWith('week', -1)
    })

    it('no query at all -> defaults to getFeedbackMetric("week", 0)', async () => {
      mount()
      await flush()

      expect(adminApi.getFeedbackMetric).toHaveBeenCalledWith('week', 0)
    })

    it('garbage period AND garbage offset both fall back -- getFeedbackMetric("week", 0), the NaN case', async () => {
      mount({ period: 'nonsense', offset: 'abc' })
      await flush()

      expect(adminApi.getFeedbackMetric).toHaveBeenCalledWith('week', 0)
    })
  })

  // ===========================================================================
  describe('"—" fallbacks when data stays null (content rung with no v-else-if="data" -- see banner)', () => {
    it('a resolved-but-empty response renders every label as "—" and every rating bar as "—"', async () => {
      // @ts-expect-error -- deliberately violating the non-null return type to
      // simulate a malformed/empty backend response.
      vi.mocked(adminApi.getFeedbackMetric).mockResolvedValue(null)
      mount()
      await flush()

      expect(host?.querySelector('.v-loader')).toBeNull()
      expect(host?.querySelector('.v-empty')).toBeNull() // not the error rung
      expect(heroValue()).toBe('—')
      expect(statValue('Посетили')).toBe('—')
      expect(statValue('Оставили отзыв')).toBe('—')
      expect(ratingValue('Огонь!')).toBe('—')
      expect(ratingValue('Хорошо')).toBe('—')
      expect(ratingValue('Есть вопросы')).toBe('—')
    })
  })

  // ===========================================================================
  describe('the three-bucket distribution (.vue:113-124) -- mapping + bucketPct edge behaviour (see banner)', () => {
    it('THE FIELD-NAME MAPPING: three DIFFERENT counts land on the right bars -- confused -> "Есть вопросы"/questionRate, not crossed with fire/good', async () => {
      vi.mocked(adminApi.getFeedbackMetric).mockResolvedValue(
        feedbackMetric({ distribution: { fire: 5, good: 3, confused: 2 } }), // total 10
      )
      mount()
      await flush()

      expect(ratingValue('Огонь!')).toBe('50%') // fire
      expect(ratingValue('Хорошо')).toBe('30%') // good
      expect(ratingValue('Есть вопросы')).toBe('20%') // confused -> questionRate
    })

    it('NO reviews at all (distributionTotal === 0): all three bars show "—", not "0%"', async () => {
      vi.mocked(adminApi.getFeedbackMetric).mockResolvedValue(
        feedbackMetric({ distribution: { fire: 0, good: 0, confused: 0 } }),
      )
      mount()
      await flush()

      expect(ratingValue('Огонь!')).toBe('—')
      expect(ratingValue('Хорошо')).toBe('—')
      expect(ratingValue('Есть вопросы')).toBe('—')
    })

    it('a bucket that IS zero while the total is NOT zero shows "0%", a real measured value, not "—"', async () => {
      vi.mocked(adminApi.getFeedbackMetric).mockResolvedValue(
        feedbackMetric({ distribution: { fire: 6, good: 4, confused: 0 } }), // total 10, confused=0
      )
      mount()
      await flush()

      expect(ratingValue('Есть вопросы')).toBe('0%') // real zero share, not "no data"
      expect(ratingValue('Огонь!')).toBe('60%')
      expect(ratingValue('Хорошо')).toBe('40%')
    })
  })
})
