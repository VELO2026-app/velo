// =============================================================================
// VELO Frontend -- AdminReturnRateView Screen Tests (probekit-screen-test)
// =============================================================================
//
// 160 lines. Read-only analytics drill-in from AdminDashboardView's (№474)
// Engagement "Return rate" row. ONE seam: getReturnMetric (@/api/admin). No
// store, no mutating actions, no dialogs.
//
// CROSS-SCREEN COMPARISON -- full comparison against its two copy-paste
// siblings (AdminCheckinRateView, AdminFeedbackRateView) is written out in
// AdminCheckinRateView.test.ts's banner; summarized here, independently
// re-verified against THIS file, not copy-pasted from the sibling's banner:
//   - THE NaN SUSPICION: CLEAN NEGATIVE. This file's .vue:74-75 --
//     `Number.isFinite(rawOffset) ? rawOffset : 0` -- byte-identical to both
//     siblings. A missing offset -> NaN -> falls back to 0, present here too.
//   - THE FULL SKELETON (.vue:68-107: period/offset parsing, rangeLabel, the
//     data/loading/error refs, load()'s try/catch/finally, the error
//     fallback string, onMounted(load), the 3-rung ladder markup) is
//     byte-identical to both siblings modulo the type name and which
//     getXMetric is called. Another confirmed instance of the clean
//     negative -- THE HABIT did NOT repeat a sixth time in this batch.
//   - STRUCTURAL SHAPE: this screen matches AdminCheckinRateView, not
//     AdminFeedbackRateView -- a client list (loyalUsers) with its OWN
//     `v-if="list.length"` / `v-else "Данных пока нет"` branch (.vue:41-44),
//     same shape as lowPractices. (AdminFeedbackRateView has no such list at
//     all -- three always-rendering VRatingBar rows instead.)
//   - NO v-else-if="data": same as both siblings, content renders
//     unconditionally past loading/error even if data.value stays null.
//
// loyalUsers (.vue:87-93) HAS NO CLIENT-SIDE PREDICATE either, same as
// Checkin's lowPractices: `(data.value?.top_users ?? []).map(...)` -- a pure
// `.map()`, no `.filter()`/threshold. "Top"/"loyal" is decided server-side;
// nothing to test on the frontend beyond the display mapping itself.
//
// Cyrillic fixtures/expected strings below were typed via the Write tool,
// never a shell heredoc.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AdminReturnRateView from '@/views/admin/AdminReturnRateView.vue'
import * as adminApi from '@/api/admin'
import { ApiResponseError } from '@/api/client'
import type { ReturnMetricResponse, TopUser } from '@/api/types'

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

function topUser(overrides: Partial<TopUser> = {}): TopUser {
  return { id: 'u_1', name: 'Анна Иванова', practices_count: 12, ...overrides }
}

function returnMetric(overrides: Partial<ReturnMetricResponse> = {}): ReturnMetricResponse {
  return {
    rate_pct: 44.7,
    total_users: 300,
    returning: 134,
    top_users: [topUser()],
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
  app = createApp(AdminReturnRateView)
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
  vi.mocked(adminApi.getReturnMetric).mockReset().mockResolvedValue(returnMetric())
  back.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('AdminReturnRateView', () => {
  // ===========================================================================
  describe('ladder (THREE rungs -- see banner)', () => {
    it('loading -> content', async () => {
      let resolveGet!: (v: ReturnMetricResponse) => void
      vi.mocked(adminApi.getReturnMetric)
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

      resolveGet(returnMetric())
      await flush()

      expect(host?.querySelector('.v-loader')).toBeNull()
      expect(heroValue()).toBe('45%')
    })

    it('failure (generic Error): falls back to "Ошибка загрузки"', async () => {
      vi.mocked(adminApi.getReturnMetric).mockRejectedValue(new Error('ECONNRESET'))
      mount()
      await flush()

      expect(errorDesc()).toBe('Ошибка загрузки')
    })

    it('failure (ApiResponseError): shows the generic fallback (unmapped code)', async () => {
      // B8 (PROMPT №747): 'server_error' is not a real backend code --
      // unmapped, lands on the call site's own fallback (.vue:101).
      vi.mocked(adminApi.getReturnMetric).mockRejectedValue(
        new ApiResponseError(500, 'Сервис метрик недоступен', 'server_error'),
      )
      mount()
      await flush()

      expect(errorDesc()).toBe('Ошибка загрузки')
    })

    it('«Повторить» recovers to content after a failure', async () => {
      vi.mocked(adminApi.getReturnMetric).mockRejectedValueOnce(new Error('ECONNRESET'))
      mount()
      await flush()

      expect(retryBtn()).toBeDefined()
      vi.mocked(adminApi.getReturnMetric).mockResolvedValueOnce(returnMetric())
      retryBtn()?.click()
      await flush()

      expect(host?.querySelector('.v-empty')).toBeNull()
      expect(heroValue()).toBe('45%')
      expect(adminApi.getReturnMetric).toHaveBeenCalledTimes(2)
    })
  })

  // ===========================================================================
  describe('query-driven fetch args (.vue:73-75) -- exact (period, offset) reaching the api mock', () => {
    it('?period=month&offset=3 -> getReturnMetric("month", 3)', async () => {
      mount({ period: 'month', offset: '3' })
      await flush()

      expect(adminApi.getReturnMetric).toHaveBeenCalledWith('month', 3)
    })

    it('?period=week&offset=-1 -> getReturnMetric("week", -1)', async () => {
      mount({ period: 'week', offset: '-1' })
      await flush()

      expect(adminApi.getReturnMetric).toHaveBeenCalledWith('week', -1)
    })

    it('no query at all -> defaults to getReturnMetric("week", 0)', async () => {
      mount()
      await flush()

      expect(adminApi.getReturnMetric).toHaveBeenCalledWith('week', 0)
    })

    it('garbage period AND garbage offset both fall back -- getReturnMetric("week", 0), the NaN case', async () => {
      mount({ period: 'nonsense', offset: 'abc' })
      await flush()

      expect(adminApi.getReturnMetric).toHaveBeenCalledWith('week', 0)
    })
  })

  // ===========================================================================
  describe('"—" fallbacks when data stays null (content rung with no v-else-if="data" -- see banner)', () => {
    it('a resolved-but-empty response renders every label as "—" and the loyal-users list as its own empty state', async () => {
      // @ts-expect-error -- deliberately violating the non-null return type to
      // simulate a malformed/empty backend response.
      vi.mocked(adminApi.getReturnMetric).mockResolvedValue(null)
      mount()
      await flush()

      expect(host?.querySelector('.v-loader')).toBeNull()
      expect(host?.querySelector('.v-empty')).toBeNull() // not the error rung
      expect(heroValue()).toBe('—')
      expect(statValue('Всего пользователей')).toBe('—')
      expect(statValue('Повторно')).toBe('—')
      expect(text()).toContain('Данных пока нет') // loyalUsers empty card
    })
  })

  // ===========================================================================
  describe('loyalUsers (.vue:87-93)', () => {
    it('maps name + a "practices_count практик" subtitle', async () => {
      vi.mocked(adminApi.getReturnMetric).mockResolvedValue(
        returnMetric({
          top_users: [topUser({ id: 'u_a', name: 'Борис Кузнецов', practices_count: 27 })],
        }),
      )
      mount()
      await flush()

      const row = host?.querySelector('.v-list-row')
      expect(row?.querySelector('.v-list-row__title')?.textContent?.trim()).toBe('Борис Кузнецов')
      expect(row?.querySelector('.v-list-row__sub')?.textContent?.trim()).toBe('27 практик')
    })

    it('an empty top_users list shows the "Данных пока нет" card, not the list', async () => {
      vi.mocked(adminApi.getReturnMetric).mockResolvedValue(returnMetric({ top_users: [] }))
      mount()
      await flush()

      expect(host?.querySelector('.v-list-row')).toBeNull()
      const card = host?.querySelector('.v-card p.admin-detail__empty')
      expect(card?.textContent?.trim()).toBe('Данных пока нет')
    })
  })
})
