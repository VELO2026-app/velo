// =============================================================================
// VELO Frontend -- AdminCheckinRateView Screen Tests (probekit-screen-test)
// =============================================================================
//
// 162 lines. Read-only analytics drill-in from AdminDashboardView's (№474)
// Engagement "Check-in rate" row. ONE seam: getCheckinMetric (@/api/admin).
// No store, no mutating actions, no dialogs.
//
// CROSS-SCREEN COMPARISON (this screen is one of THREE copy-paste siblings --
// AdminCheckinRateView / AdminFeedbackRateView / AdminReturnRateView -- read
// and compared line-by-line, not assumed identical because they look alike):
//
//   THE SUSPICION (rawOffset parses a possibly-absent query param -> NaN on a
//   missing offset) -- MEASURED, CLEAN NEGATIVE, identical in all three:
//     const rawOffset = Number.parseInt(String(route.query.offset ?? ''), 10)
//     const offset = Number.isFinite(rawOffset) ? rawOffset : 0
//   A missing offset -> Number.parseInt('') -> NaN -> Number.isFinite(NaN) is
//   false -> falls back to 0. Present, byte-identical, in ALL THREE files.
//
//   THE FULL SKELETON -- period/offset parsing, rangeLabel, the data/loading/
//   error refs, the load() try/catch/finally shape, the error fallback string
//   ('Ошибка загрузки' / ApiResponseError -> e.detail), onMounted(load), and
//   the 3-rung ladder markup (loading / VEmptyState error+Повторить / content,
//   IDENTICAL VEmptyState title "Не удалось загрузить метрику" in all three)
//   -- is BYTE-IDENTICAL across all three modulo the type name and which
//   getXMetric function is called. A GENUINE CLEAN NEGATIVE for THE HABIT this
//   zone has otherwise found five times: nothing is present on one sibling and
//   forgotten on another here. Verified by reading all three files in full,
//   not by grepping one and assuming.
//
//   THE ONE STRUCTURAL DIVERGENCE (not a bug, a legitimate content
//   difference): AdminCheckinRateView and AdminReturnRateView both render a
//   client list with its own `v-if="list.length"` / `v-else` empty card
//   ("Данных пока нет") -- lowPractices / loyalUsers. AdminFeedbackRateView
//   has NO such list; its content is three VRatingBar rows that always
//   render (their own null-vs-number handling lives INSIDE the component,
//   not as a template branch on this screen). So the ladder's outer THREE
//   rungs (loading/error/content) are identical across all three, but the
//   CONTENT rung's internal branching is 2-of-3, not 3-of-3 -- a legitimate
//   difference in what each screen displays, not a missed guard.
//
//   NO v-else-if="data" ON THE CONTENT BLOCK, in any of the three: `template
//   v-else` (after loading/error) renders unconditionally once loading is
//   done and there's no error -- even if `data.value` is still null (e.g. a
//   malformed/empty successful response). Every count/rate computed already
//   guards with `?? '—'` for exactly this reason, so this isn't a fourth
//   "not found" rung like AdminPracticeDetailView's -- it's the SAME content
//   template rendering entirely in its '—'/empty fallback shape. Asserted
//   below directly (data resolves to null).
//
//   lowPractices HAS NO CLIENT-SIDE PREDICATE: `(data.value?.low_practices ??
//   []).map(...)` -- a pure `.map()`, no `.filter()`. "Low" is decided
//   server-side (the backend only ever sends what belongs in this list); the
//   screen has no threshold logic of its own to test. Read, not assumed.
//
// Cyrillic fixtures/expected strings below were typed via the Write tool,
// never a shell heredoc.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AdminCheckinRateView from '@/views/admin/AdminCheckinRateView.vue'
import * as adminApi from '@/api/admin'
import { ApiResponseError } from '@/api/client'
import type { CheckinMetricResponse, SeriesPoint, LowCheckinPractice } from '@/api/types'

vi.mock('@/api/admin')

const back = vi.fn()
let routeQuery: Record<string, string> = {}
vi.mock('vue-router', () => ({
  useRouter: () => ({ back, push: vi.fn() }),
  useRoute: () => ({ query: routeQuery }),
}))

// -----------------------------------------------------------------------------
// Fixtures -- factory functions. This screen never mutates the loaded object
// in place (read-only, no actions at all), so the №482 shared-fixture trap
// doesn't literally apply, but factories keep the same discipline.
// -----------------------------------------------------------------------------

function seriesPoint(overrides: Partial<SeriesPoint> = {}): SeriesPoint {
  return { label: 'Пн', value: 10, ...overrides }
}

function lowPractice(overrides: Partial<LowCheckinPractice> = {}): LowCheckinPractice {
  return {
    id: 'lp_1',
    title: 'Утренняя медитация',
    checkin_rate_pct: 42.4,
    total: 25,
    ...overrides,
  }
}

function checkinMetric(overrides: Partial<CheckinMetricResponse> = {}): CheckinMetricResponse {
  return {
    rate_pct: 76.4,
    total_records: 120,
    checked_in: 92,
    series: [seriesPoint({ label: 'Пн', value: 5 }), seriesPoint({ label: 'Вт', value: 8 })],
    low_practices: [lowPractice()],
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
  app = createApp(AdminCheckinRateView)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

function text(): string {
  return host?.textContent ?? ''
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

// -----------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(adminApi.getCheckinMetric).mockReset().mockResolvedValue(checkinMetric())
  back.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('AdminCheckinRateView', () => {
  // ===========================================================================
  describe('ladder (THREE rungs -- see banner)', () => {
    it('loading -> content', async () => {
      let resolveGet!: (v: CheckinMetricResponse) => void
      vi.mocked(adminApi.getCheckinMetric)
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

      resolveGet(checkinMetric())
      await flush()

      expect(host?.querySelector('.v-loader')).toBeNull()
      expect(heroValue()).toBe('76%')
    })

    it('failure (generic Error): falls back to "Ошибка загрузки"', async () => {
      vi.mocked(adminApi.getCheckinMetric).mockRejectedValue(new Error('ECONNRESET'))
      mount()
      await flush()

      expect(errorDesc()).toBe('Ошибка загрузки')
    })

    it('failure (ApiResponseError): shows the generic fallback (unmapped code)', async () => {
      // B8 (PROMPT №747): 'server_error' is not a real backend code --
      // unmapped, lands on the call site's own fallback (.vue:103).
      vi.mocked(adminApi.getCheckinMetric).mockRejectedValue(
        new ApiResponseError(500, 'Сервис метрик недоступен', 'server_error'),
      )
      mount()
      await flush()

      expect(errorDesc()).toBe('Ошибка загрузки')
    })

    it('«Повторить» recovers to content after a failure', async () => {
      vi.mocked(adminApi.getCheckinMetric).mockRejectedValueOnce(new Error('ECONNRESET'))
      mount()
      await flush()

      expect(retryBtn()).toBeDefined()
      vi.mocked(adminApi.getCheckinMetric).mockResolvedValueOnce(checkinMetric())
      retryBtn()?.click()
      await flush()

      expect(host?.querySelector('.v-empty')).toBeNull()
      expect(heroValue()).toBe('76%')
      expect(adminApi.getCheckinMetric).toHaveBeenCalledTimes(2)
    })
  })

  // ===========================================================================
  describe('query-driven fetch args (.vue:76-78) -- exact (period, offset) reaching the api mock', () => {
    it('?period=month&offset=3 -> getCheckinMetric("month", 3)', async () => {
      mount({ period: 'month', offset: '3' })
      await flush()

      expect(adminApi.getCheckinMetric).toHaveBeenCalledWith('month', 3)
    })

    it('?period=week&offset=-1 (negative offset is legitimate -- a past period) -> getCheckinMetric("week", -1)', async () => {
      mount({ period: 'week', offset: '-1' })
      await flush()

      expect(adminApi.getCheckinMetric).toHaveBeenCalledWith('week', -1)
    })

    it('no query at all -> defaults to getCheckinMetric("week", 0)', async () => {
      mount()
      await flush()

      expect(adminApi.getCheckinMetric).toHaveBeenCalledWith('week', 0)
    })

    it('garbage period AND garbage (non-numeric) offset both fall back -- getCheckinMetric("week", 0), the NaN case', async () => {
      mount({ period: 'nonsense', offset: 'abc' })
      await flush()

      expect(adminApi.getCheckinMetric).toHaveBeenCalledWith('week', 0)
    })
  })

  // ===========================================================================
  describe('"—" fallbacks when data stays null (content rung with no v-else-if="data" -- see banner)', () => {
    it('a resolved-but-empty response renders every label as "—" and every list as its own empty state', async () => {
      // @ts-expect-error -- deliberately violating the non-null return type to
      // simulate a malformed/empty backend response.
      vi.mocked(adminApi.getCheckinMetric).mockResolvedValue(null)
      mount()
      await flush()

      expect(host?.querySelector('.v-loader')).toBeNull()
      expect(host?.querySelector('.v-empty')).toBeNull() // not the error rung
      expect(heroValue()).toBe('—')
      expect(statValue('Всего записей')).toBe('—')
      expect(statValue('Отметились')).toBe('—')
      expect(host?.querySelector('.v-bar-chart__empty')).not.toBeNull()
      expect(text()).toContain('Данных пока нет') // lowPractices empty card
    })
  })

  // ===========================================================================
  describe('weekBars (.vue:88) and lowPractices (.vue:89-95)', () => {
    it('weekBars renders one .v-bar-chart__col per series point, with the right labels', async () => {
      vi.mocked(adminApi.getCheckinMetric).mockResolvedValue(
        checkinMetric({
          series: [
            seriesPoint({ label: 'Пн', value: 4 }),
            seriesPoint({ label: 'Вт', value: 9 }),
            seriesPoint({ label: 'Ср', value: 2 }),
          ],
        }),
      )
      mount()
      await flush()

      const cols = host?.querySelectorAll('.v-bar-chart__col')
      expect(cols?.length).toBe(3)
      const labels = Array.from(cols ?? []).map((c) =>
        c.querySelector('.v-bar-chart__label')?.textContent?.trim(),
      )
      expect(labels).toEqual(['Пн', 'Вт', 'Ср'])
    })

    it('lowPractices maps title + a rounded "rate% · total записей" subtitle', async () => {
      vi.mocked(adminApi.getCheckinMetric).mockResolvedValue(
        checkinMetric({
          low_practices: [
            lowPractice({ id: 'lp_a', title: 'Вечерняя йога', checkin_rate_pct: 33.6, total: 18 }),
          ],
        }),
      )
      mount()
      await flush()

      const row = host?.querySelector('.v-list-row')
      expect(row?.querySelector('.v-list-row__title')?.textContent?.trim()).toBe('Вечерняя йога')
      expect(row?.querySelector('.v-list-row__sub')?.textContent?.trim()).toBe('34% · 18 записей')
    })

    it('an empty low_practices list shows the "Данных пока нет" card, not the list', async () => {
      vi.mocked(adminApi.getCheckinMetric).mockResolvedValue(checkinMetric({ low_practices: [] }))
      mount()
      await flush()

      expect(host?.querySelector('.v-list-row')).toBeNull()
      const card = host?.querySelector('.v-card p.admin-detail__empty')
      expect(card?.textContent?.trim()).toBe('Данных пока нет')
    })
  })
})
