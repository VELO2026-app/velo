// =============================================================================
// VELO Frontend -- AnalyticsView Screen Tests (master analytics, FE-190)
// =============================================================================
//
// The master's analytics screen, built after the school's: one server aggregate
// per calendar period (GET /masters/me/analytics, BE-34; the practices list is
// BE-222). Every number is the server's -- the screen divides nothing -- so the
// tests assert what the screen PUTS ON SCREEN for a given payload, and the
// rules the ticket sets for the period slider:
//   - the slider names the period and refetches; the first fetch is the week;
//   - while another period loads, no earlier period's numbers stay under the
//     new label (the loader stands in), and a failed request is the retry state;
//   - the practices of the period come as cards with their four blocks, the
//     first three shown and the rest behind the reveal;
//   - the needs-attention section is gone when there is nobody to show.
//
// TIME IS PINNED to 2026-07-20T12:00:00Z: the attention section cuts reviews on
// the period's days from the wall clock. Fixtures carry LITERAL dates.
// The payments tab is parked (PAYMENTS_TAB_ENABLED = false): not rendered.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { coladaOptions } from '@/composables/queries/setup'
import AnalyticsView from '@/views/master/AnalyticsView.vue'
import * as mastersApi from '@/api/masters'
import type {
  MasterAnalyticsResponse,
  MasterReviewItem,
  PracticeAnalyticsSummary,
  ScoreZoneCounts,
} from '@/api/types'

vi.mock('@/api/masters')

const push = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
  useRoute: () => ({ params: {}, name: 'master-analytics' }),
}))

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  const pinia = createPinia()
  app = createApp(AnalyticsView).use(createTestI18n()).use(pinia).use(PiniaColada, coladaOptions)
  setActivePinia(pinia)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

function text(): string {
  return (host?.textContent ?? '').replace(/\u00a0/g, ' ')
}

function clickText(label: string): void {
  const el = Array.from(
    host?.querySelectorAll<HTMLElement>('button, [role="tab"], [role="radio"]') ?? [],
  ).find((b) => b.textContent?.trim() === label)
  if (!el) throw new Error(`no control labelled ${label}`)
  el.click()
}

const zones = (bad = 0, low = 0, neutral = 0, good = 0, fire = 0): ScoreZoneCounts => ({
  bad,
  low,
  neutral,
  good,
  fire,
})

function practice(id: string, title: string, day: string): PracticeAnalyticsSummary {
  return {
    practice_id: id,
    title,
    direction: 'meditation',
    scheduled_at: `2026-07-${day}T10:00:00+00:00`,
    timezone: 'UTC',
    attended: 10,
    before: zones(0, 1, 3, 2, 0),
    // `after` holds every review left: its sum (5) is the card's "feedbacks".
    after: zones(0, 0, 1, 2, 2),
    pairs_total: 6,
    // Reviews with text only: fewer than the five ratings.
    reviews_total: 3,
  }
}

function analytics(over: Partial<MasterAnalyticsResponse> = {}): MasterAnalyticsResponse {
  return {
    practices_count: 2,
    practices_delta_pct: null,
    bookings_count: 20,
    bookings_delta_pct: null,
    checkins_count: 16,
    checkins_delta_pct: null,
    feedbacks_count: 8,
    feedbacks_delta_pct: null,
    checkin_rate_pct: 80,
    checkin_rate_delta_pp: null,
    feedback_rate_pct: 40,
    feedback_rate_delta_pp: null,
    checkins: zones(0, 1, 5, 6, 4),
    feedbacks: zones(1, 0, 2, 3, 2),
    conducted_practices: [practice('p2', 'Медитация', '19'), practice('p1', 'Дыхание', '18')],
    ...over,
  }
}

function attentionReview(): MasterReviewItem {
  return {
    user_id: 'u1',
    reviewer_name: 'Анна',
    practice_title: 'Дыхание',
    rating: 'low',
    comment: 'Было тяжело',
    created_at: '2026-07-18T10:00:00+00:00',
  } as unknown as MasterReviewItem
}

describe('AnalyticsView (master)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-20T12:00:00Z'))
    vi.mocked(mastersApi.getMasterAnalytics).mockReset().mockResolvedValue(analytics())
    vi.mocked(mastersApi.getMasterReviews)
      .mockReset()
      .mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 } as never)
  })

  afterEach(() => {
    app?.unmount()
    app = null
    host?.remove()
    host = null
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('asks for the week first and shows the server rates and the feedback share', async () => {
    mount()
    await flush()

    expect(vi.mocked(mastersApi.getMasterAnalytics)).toHaveBeenCalledWith('week')
    expect(text()).toContain('80%')
    expect(text()).toContain('Check-in')
    expect(text()).toContain('Feedback')
    // "N of M" on the heading line: 8 reviews out of 20 bookings, the server's percent.
    expect(text()).toContain('Процент фидбеков')
    expect(text()).toContain('40% · 8 из 20')
  })

  it('does not show the old reviews tile or the old rating distribution', async () => {
    mount()
    await flush()

    expect(text()).not.toContain('Общая статистика')
    expect(text()).not.toContain('Прошедшие практики')
    expect(host?.querySelector('.analytics__stats')?.children).toHaveLength(2)
  })

  it('lists the period practices with the four blocks, each "N из M"', async () => {
    mount()
    await flush()

    expect(text()).toContain('Практики недели')
    expect(text()).toContain('Медитация')
    expect(text()).toContain('Дыхание')
    expect(text()).toContain('До практики')
    expect(text()).toContain('После практики')
    expect(text()).toContain('Пришел → ушел')
    expect(text()).toContain('Отзывы')
    // before: 6 check-ins of 10 who came; after: 5 of 10; came -> left: 6 of 10;
    // reviews with text: 3 of 10 (not the 5 ratings -- the server counts texts).
    expect(text()).toContain('6 из 10')
    expect(text()).toContain('5 из 10')
    expect(text()).toContain('3 из 10')
    // The summary line: who came, and every review left.
    expect(text()).toContain('Ученики: 10')
    expect(text()).toContain('Фидбеки: 5')
  })

  it('the slider refetches with the selected period and renames the section', async () => {
    mount()
    await flush()

    clickText('Квартал')
    await flush()

    expect(vi.mocked(mastersApi.getMasterAnalytics)).toHaveBeenLastCalledWith('quarter')
    expect(text()).toContain('Практики квартала')
  })

  it('while another period loads, the earlier numbers do not stay under the new label', async () => {
    mount()
    await flush()
    expect(text()).toContain('Медитация')

    let answer: (v: MasterAnalyticsResponse) => void = () => {}
    vi.mocked(mastersApi.getMasterAnalytics).mockImplementation(
      () => new Promise<MasterAnalyticsResponse>((resolve) => (answer = resolve)),
    )
    clickText('Месяц')
    await flush()

    expect(text()).not.toContain('Медитация')
    expect(text()).not.toContain('80%')

    answer(analytics({ checkin_rate_pct: 55, conducted_practices: [practice('p9', 'Йога', '10')] }))
    await flush()
    expect(text()).toContain('Практики месяца')
    expect(text()).toContain('55%')
    expect(text()).toContain('Йога')
  })

  it('a failed request is the retry state, and retry brings the numbers back', async () => {
    vi.mocked(mastersApi.getMasterAnalytics).mockRejectedValueOnce(new Error('boom'))
    mount()
    await flush()

    expect(text()).toContain('Не удалось загрузить')
    expect(text()).not.toContain('80%')

    clickText('Повторить')
    await flush()
    expect(text()).toContain('80%')
  })

  it('an empty period shows the empty state', async () => {
    vi.mocked(mastersApi.getMasterAnalytics).mockResolvedValue(
      analytics({ conducted_practices: [] }),
    )
    mount()
    await flush()

    expect(text()).toContain('За выбранный период практик нет')
  })

  it('rounds the feedback percent on the heading line', async () => {
    vi.mocked(mastersApi.getMasterAnalytics).mockResolvedValue(
      analytics({ feedback_rate_pct: 33.333333, feedbacks_count: 1, bookings_count: 3 }),
    )
    mount()
    await flush()

    expect(text()).toContain('33% · 1 из 3')
    expect(text()).not.toContain('33.33')
  })

  it('shows three practices, the rest behind the reveal', async () => {
    vi.mocked(mastersApi.getMasterAnalytics).mockResolvedValue(
      analytics({
        conducted_practices: ['01', '02', '03', '04', '05'].map((d) =>
          practice(`p${d}`, `Практика ${d}`, d),
        ),
      }),
    )
    mount()
    await flush()

    expect(text()).toContain('Практика 03')
    expect(text()).not.toContain('Практика 04')
    expect(text()).toContain('ещё 2 практики')

    clickText('+ ещё 2 практики')
    await flush()
    expect(text()).toContain('Практика 05')
  })

  it('a tap on a practice opens its analytics; a tap inside its blocks does not', async () => {
    mount()
    await flush()

    host!.querySelector<HTMLElement>('.conducted-practice__detail')!.click()
    expect(push).not.toHaveBeenCalled()

    host!.querySelector<HTMLElement>('.conducted-practice__summary')!.click()
    expect(push).toHaveBeenCalledWith({ name: 'master-practice-reviews', params: { id: 'p2' } })
  })

  it('the needs-attention section appears only with someone to show', async () => {
    mount()
    await flush()
    expect(text()).not.toContain('Требуют внимания')

    app?.unmount()
    host?.remove()
    vi.mocked(mastersApi.getMasterReviews).mockResolvedValue({
      items: [attentionReview()],
      total: 1,
      limit: 20,
      offset: 0,
    } as never)
    mount()
    await flush()
    expect(text()).toContain('Требуют внимания')
    expect(text()).toContain('Анна')
  })
})
