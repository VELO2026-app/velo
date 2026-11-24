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

/** The card of the practice with this title. */
function cardOf(title: string): HTMLElement {
  const card = Array.from(host?.querySelectorAll<HTMLElement>('.conducted-practice') ?? []).find(
    (c) => c.querySelector('.conducted-practice__title')?.textContent?.trim() === title,
  )
  if (!card) throw new Error(`no card for ${title}`)
  return card
}

/** The heading line of one block of a card: its title with the "N of M" count beside it. */
function blockLine(card: HTMLElement, heading: string): string {
  const h2 = Array.from(card.querySelectorAll('h2')).find((h) => h.textContent?.trim() === heading)
  if (!h2?.parentElement) throw new Error(`no block ${heading}`)
  return (h2.parentElement.textContent ?? '').replace(/\s+/g, ' ').trim()
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

function practice(
  id: string,
  title: string,
  day: string,
  over: Partial<PracticeAnalyticsSummary> = {},
): PracticeAnalyticsSummary {
  return {
    practice_id: id,
    title,
    direction: 'meditation',
    scheduled_at: `2026-07-${day}T10:00:00+00:00`,
    timezone: 'UTC',
    attended: 10,
    before: zones(0, 2, 3, 2, 0),
    after: zones(0, 0, 1, 2, 2),
    pairs_total: 4,
    reviews_total: 3,
    ...over,
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
    // Two practices with DIFFERENT numbers in every block, and every number of a
    // card differs from the others', so a block fed from the wrong field
    // (pairs_total from the sum of `before`, reviews from the ratings) fails:
    //   Meditation: came 10 -- before 7, after 5, came-left 4, reviews with text 3
    //   Breathing:  came  8 -- before 6, after 4, came-left 5, reviews with text 2
    conducted_practices: [
      practice('p2', 'Медитация', '19'),
      practice('p1', 'Дыхание', '18', {
        attended: 8,
        before: zones(1, 1, 2, 2, 0),
        after: zones(0, 0, 1, 1, 2),
        pairs_total: 5,
        reviews_total: 2,
      }),
    ],
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

  it('each card shows the numbers of its own practice in each block, "N из M"', async () => {
    mount()
    await flush()

    expect(text()).toContain('Практики недели')

    const meditation = cardOf('Медитация')
    expect(meditation.textContent).toContain('Ученики: 10')
    expect(meditation.textContent).toContain('Фидбеки: 5')
    expect(blockLine(meditation, 'До практики')).toContain('7 из 10')
    expect(blockLine(meditation, 'После практики')).toContain('5 из 10')
    expect(blockLine(meditation, 'Пришел → ушел')).toContain('4 из 10')
    // Reviews with text, not the five ratings of `after`.
    expect(blockLine(meditation, 'Отзывы')).toContain('3 из 10')

    const breathing = cardOf('Дыхание')
    expect(breathing.textContent).toContain('Ученики: 8')
    expect(breathing.textContent).toContain('Фидбеки: 4')
    expect(blockLine(breathing, 'До практики')).toContain('6 из 8')
    expect(blockLine(breathing, 'После практики')).toContain('4 из 8')
    expect(blockLine(breathing, 'Пришел → ушел')).toContain('5 из 8')
    expect(blockLine(breathing, 'Отзывы')).toContain('2 из 8')
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

  it('Enter and Space on a practice summary open its analytics', async () => {
    mount()
    await flush()
    const summary = cardOf('Медитация').querySelector<HTMLElement>('.conducted-practice__summary')!

    summary.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(push).toHaveBeenLastCalledWith({
      name: 'master-practice-reviews',
      params: { id: 'p2' },
    })

    push.mockClear()
    summary.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    expect(push).toHaveBeenLastCalledWith({
      name: 'master-practice-reviews',
      params: { id: 'p2' },
    })
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

  it('a failed attention read shows an error with Retry, not a hidden block; Retry recovers (FE-242)', async () => {
    vi.mocked(mastersApi.getMasterReviews).mockRejectedValueOnce(new TypeError('boom'))
    mount()
    await flush()

    expect(host?.querySelector('[data-testid="screen-error"]')).not.toBeNull()

    vi.mocked(mastersApi.getMasterReviews).mockResolvedValue({
      items: [attentionReview()],
      total: 1,
      limit: 20,
      offset: 0,
    } as never)
    Array.from(host!.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Повторить'))!
      .click()
    await flush()

    expect(host?.querySelector('[data-testid="screen-error"]')).toBeNull()
    expect(text()).toContain('Анна')
  })
})
