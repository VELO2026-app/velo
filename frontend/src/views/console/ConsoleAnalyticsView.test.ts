// =============================================================================
// VELO Frontend -- ConsoleAnalyticsView screen tests (FE-268, FE-262 slice 5)
// =============================================================================
//
// The screen reads the three engagement metrics of one window
// (getCheckinMetric / getFeedbackMetric / getReturnMetric) and the overview of
// the same window for the deltas (getAdminStatsOverview), each a Pinia Colada
// query over the mocked @/api/admin seam. It mounts with a real router
// (memory history: the metric, the period and the offset live in the URL), a
// real Pinia and Colada. The clock is frozen so the period label never
// depends on the day the suite runs.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { coladaOptions } from '@/composables/queries/setup'
import ConsoleAnalyticsView from '@/views/console/ConsoleAnalyticsView.vue'
import * as adminApi from '@/api/admin'
import type {
  AdminStatsOverviewResponse,
  CheckinMetricResponse,
  FeedbackMetricResponse,
  ReturnMetricResponse,
} from '@/api/types'

vi.mock('@/api/admin')

const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, info: vi.fn(), success: vi.fn() }),
}))

const NOW = new Date('2026-11-24T10:00:00Z')

function checkin(overrides: Partial<CheckinMetricResponse> = {}): CheckinMetricResponse {
  return {
    rate_pct: 78,
    total_records: 412,
    checked_in: 321,
    series: [
      { label: '23 нояб', value: 70 },
      { label: '24 нояб', value: 35 },
    ],
    low_practices: [{ id: 'p_low', title: 'Утренняя медитация', checkin_rate_pct: 33, total: 12 }],
    ...overrides,
  }
}
function feedback(overrides: Partial<FeedbackMetricResponse> = {}): FeedbackMetricResponse {
  return {
    rate_pct: 65,
    visited: 200,
    left_review: 130,
    distribution: { bad: 1, low: 2, neutral: 3, good: 4, fire: 10 },
    ...overrides,
  }
}
function returning(overrides: Partial<ReturnMetricResponse> = {}): ReturnMetricResponse {
  return {
    rate_pct: 42,
    total_users: 300,
    returning: 126,
    top_users: [{ id: 'u_1', name: 'Ирина Волкова', practices_count: 7 }],
    ...overrides,
  }
}
function overview(overrides: Partial<AdminStatsOverviewResponse> = {}): AdminStatsOverviewResponse {
  return {
    new_users: 0,
    new_users_delta_pct: null,
    new_masters: 0,
    new_masters_delta_pct: null,
    practices_count: 0,
    practices_delta_pct: null,
    revenue_cents: 0,
    revenue_delta_pct: null,
    commission_cents: 0,
    checkin_rate_pct: 78,
    checkin_rate_delta: 4,
    feedback_rate_pct: 65,
    feedback_rate_delta: -2,
    return_rate_pct: 42,
    return_rate_delta: null,
    pending_reports: 0,
    ...overrides,
  }
}

let app: App | null = null
let host: HTMLElement | null = null
let router: Router

async function mount(url = '/admin/analytics'): Promise<HTMLElement> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/admin/analytics', name: 'console-analytics', component: { render: () => null } },
    ],
  })
  await router.push(url)
  await router.isReady()
  host = document.createElement('div')
  document.body.appendChild(host)
  const pinia = createPinia()
  setActivePinia(pinia)
  app = createApp(ConsoleAnalyticsView)
    .use(createTestI18n())
    .use(router)
    .use(pinia)
    .use(PiniaColada, coladaOptions)
  app.mount(host)
  await flush()
  return host
}

async function flush(): Promise<void> {
  for (let n = 0; n < 6; n++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

/** Text without any space (JS `\s` covers the NBSP the locale puts in numbers). */
function norm(text: string | null | undefined): string {
  return (text ?? '').replace(/\s/g, '')
}
function card(key: string): HTMLButtonElement {
  const el = host?.querySelector<HTMLButtonElement>(`[data-testid="metric-${key}"]`)
  if (!el) throw new Error(`no metric ${key}`)
  return el
}
function cardText(key: string): string {
  return norm(card(key).textContent)
}
function detail(): HTMLElement | null {
  return host?.querySelector<HTMLElement>('[data-testid^="metric-detail-"]') ?? null
}
function periodTab(label: string): HTMLButtonElement {
  const found = Array.from(host?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []).find(
    (el) => el.textContent?.trim() === label,
  )
  if (!found) throw new Error(`no tab ${label}`)
  return found
}
function step(label: 'Предыдущий период' | 'Следующий период'): HTMLButtonElement {
  const el = host?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!el) throw new Error(`no button ${label}`)
  return el
}
function retryButton(): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-btn') ?? []).find(
    (b) => b.textContent?.trim() === 'Повторить',
  )
}
/** A return to the app: the page becomes visible again and every stale query on screen is asked again. */
async function returnToApp(): Promise<void> {
  document.dispatchEvent(new Event('visibilitychange'))
  await flush()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  toastError.mockReset()
  vi.mocked(adminApi.getCheckinMetric).mockReset().mockResolvedValue(checkin())
  vi.mocked(adminApi.getFeedbackMetric).mockReset().mockResolvedValue(feedback())
  vi.mocked(adminApi.getReturnMetric).mockReset().mockResolvedValue(returning())
  vi.mocked(adminApi.getAdminStatsOverview).mockReset().mockResolvedValue(overview())
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.useRealTimers()
})

describe('ConsoleAnalyticsView', () => {
  it('shows the three rates with their change, and the check-in breakdown open', async () => {
    await mount()

    expect(cardText('checkin')).toBe('Практикисчекином78%+4п.п.кпрошломупериоду')
    expect(cardText('feedback')).toBe('Практикисотзывом65%-2п.п.кпрошломупериоду')
    // No base to compare with: a dash.
    expect(cardText('return')).toBe('Возвращаютсяучастники42%—нетданныхдлясравнения')
    expect(card('checkin').getAttribute('aria-pressed')).toBe('true')
    expect(card('feedback').getAttribute('aria-pressed')).toBe('false')

    // The counts, the trend, the practice with a low check-in.
    expect(norm(detail()?.textContent)).toContain('Всегозаписей412')
    expect(norm(detail()?.textContent)).toContain('Отметились321')
    expect(norm(detail()?.textContent)).toContain('Утренняямедитация33%·12записей')
    // The trend is the kit's chart: the date under each bar, the heights scaled to the highest rate.
    expect(
      Array.from(detail()?.querySelectorAll('.v-bar-chart__label') ?? []).map(
        (el) => el.textContent,
      ),
    ).toEqual(['23 нояб', '24 нояб'])
    expect(
      Array.from(detail()?.querySelectorAll<HTMLElement>('.v-bar-chart__bar') ?? []).map(
        (el) => el.style.height,
      ),
    ).toEqual(['100%', '50%'])
    expect(adminApi.getCheckinMetric).toHaveBeenCalledWith('week', 0)
  })

  it('a change that could not be read says so, not "nothing to compare with"; the rates stay', async () => {
    vi.mocked(adminApi.getAdminStatsOverview).mockRejectedValueOnce(new Error('down'))
    await mount()

    // The rates come from the metrics' own endpoints, the dash from the failed overview.
    expect(cardText('checkin')).toBe('Практикисчекином78%—неудалосьзагрузитьсравнение')
    expect(cardText('return')).toContain('42%')
    expect(cardText('feedback')).toContain('неудалосьзагрузитьсравнение')
    expect(cardText('feedback')).not.toContain('нетданныхдлясравнения')
  })

  it('a card opens its metric: feedback shows the distribution, return the frequent participants', async () => {
    await mount()

    card('feedback').click()
    await flush()
    expect(router.currentRoute.value.query).toEqual({ metric: 'feedback' })
    expect(card('feedback').getAttribute('aria-pressed')).toBe('true')
    expect(norm(detail()?.textContent)).toContain('Посетили200')
    expect(norm(detail()?.textContent)).toContain('Оставилиотзыв130')
    // One bar per zone of the scale, best first: fire 10 of 20 reviews is 50%.
    const ratings = Array.from(detail()?.querySelectorAll('.v-rating-bar') ?? []).map((el) =>
      norm(el.textContent),
    )
    expect(ratings).toHaveLength(5)
    expect(ratings[0]).toContain('50%')

    card('return').click()
    await flush()
    expect(router.currentRoute.value.query).toEqual({ metric: 'return' })
    expect(norm(detail()?.textContent)).toContain('Участниковзапериод300')
    expect(norm(detail()?.textContent)).toContain('ИринаВолкова7практик')

    // Back to the first: the default metric leaves the URL.
    card('checkin').click()
    await flush()
    expect(router.currentRoute.value.query).toEqual({})
  })

  it('the URL says the metric, the period and the offset; the dashboard links open it', async () => {
    await mount('/admin/analytics?metric=return&period=month&offset=-2')

    expect(card('return').getAttribute('aria-pressed')).toBe('true')
    expect(adminApi.getReturnMetric).toHaveBeenCalledWith('month', -2)
    expect(adminApi.getAdminStatsOverview).toHaveBeenCalledWith('month', -2)
    expect(detail()?.getAttribute('data-testid')).toBe('metric-detail-return')
  })

  it('a URL it cannot mean falls back to this week and the check-in', async () => {
    await mount('/admin/analytics?metric=audience&period=year&offset=3')

    expect(card('checkin').getAttribute('aria-pressed')).toBe('true')
    expect(adminApi.getCheckinMetric).toHaveBeenCalledWith('week', 0)
    // A period after the current one does not exist: offset 3 is the current.
    expect(
      vi.mocked(adminApi.getCheckinMetric).mock.calls.map(([, offset]) => offset),
    ).not.toContain(3)
  })

  it('the period switch and the stepper move the window and the URL; the stepper stops at the current period', async () => {
    await mount()
    expect(step('Следующий период').disabled).toBe(true)

    periodTab('Месяц').click()
    await flush()
    expect(router.currentRoute.value.query).toEqual({ period: 'month' })
    expect(adminApi.getCheckinMetric).toHaveBeenLastCalledWith('month', 0)

    step('Предыдущий период').click()
    await flush()
    expect(router.currentRoute.value.query).toEqual({ period: 'month', offset: '-1' })
    expect(adminApi.getCheckinMetric).toHaveBeenLastCalledWith('month', -1)
    expect(step('Следующий период').disabled).toBe(false)

    step('Следующий период').click()
    await flush()
    expect(router.currentRoute.value.query).toEqual({ period: 'month' })
    expect(step('Следующий период').disabled).toBe(true)
  })

  it('a window switch shows the loader, not the breakdown of the old window', async () => {
    await mount()
    let resolveMonth: (value: CheckinMetricResponse) => void = () => {}
    vi.mocked(adminApi.getCheckinMetric).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMonth = resolve
        }),
    )

    periodTab('Месяц').click()
    await flush()
    expect(host?.querySelector('[data-testid="metric-loading"]')).not.toBeNull()
    expect(detail()).toBeNull()

    resolveMonth(checkin({ total_records: 999 }))
    await flush()
    expect(norm(detail()?.textContent)).toContain('Всегозаписей999')
  })

  it('a metric with nothing in it says so', async () => {
    vi.mocked(adminApi.getCheckinMetric).mockResolvedValue(
      checkin({ rate_pct: 0, total_records: 0, checked_in: 0, series: [], low_practices: [] }),
    )
    await mount()

    expect(cardText('checkin')).toContain('0%')
    expect(norm(detail()?.textContent)).toContain('Заэтотпериодданныхнет')
  })

  it('a failed metric shows the error in the breakdown and a dash on its card; Retry recovers', async () => {
    vi.mocked(adminApi.getCheckinMetric).mockRejectedValueOnce(new Error('down'))
    await mount()

    expect(cardText('checkin')).toContain('—')
    expect(host?.querySelector('.v-empty__title')?.textContent).toBe('Не удалось загрузить метрику')
    // The other metrics are not held by it.
    expect(cardText('feedback')).toContain('65%')

    retryButton()?.click()
    await flush()

    expect(host?.querySelector('.v-empty__title')).toBeNull()
    expect(cardText('checkin')).toContain('78%')
  })

  describe('background refetch (a return to the app)', () => {
    it('keeps the breakdown on screen while it runs, then shows the fresh answer', async () => {
      await mount()
      let resolveFresh: (value: CheckinMetricResponse) => void = () => {}
      vi.mocked(adminApi.getCheckinMetric).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveFresh = resolve
          }),
      )
      await returnToApp()

      expect(host?.querySelector('[data-testid="metric-loading"]')).toBeNull()
      expect(norm(detail()?.textContent)).toContain('Всегозаписей412')

      resolveFresh(checkin({ total_records: 500 }))
      await flush()
      expect(norm(detail()?.textContent)).toContain('Всегозаписей500')
      expect(toastError).not.toHaveBeenCalled()
    })

    it('failing again and again is told once, until an answer arrives; the breakdown stays', async () => {
      await mount()
      vi.mocked(adminApi.getCheckinMetric).mockImplementation(() =>
        Promise.reject(new Error('down')),
      )

      await returnToApp()
      await returnToApp()

      expect(toastError).toHaveBeenCalledTimes(1)
      expect(toastError).toHaveBeenCalledWith('Не удалось загрузить метрику')
      expect(norm(detail()?.textContent)).toContain('Всегозаписей412')
      expect(host?.querySelector('.v-empty__title')).toBeNull()

      vi.mocked(adminApi.getCheckinMetric).mockResolvedValue(checkin())
      await returnToApp()
      vi.mocked(adminApi.getCheckinMetric).mockImplementation(() =>
        Promise.reject(new Error('down again')),
      )
      await returnToApp()

      expect(toastError).toHaveBeenCalledTimes(2)
    })

    it('a closed metric that fails is not told: the open one speaks for the outage', async () => {
      await mount()
      vi.mocked(adminApi.getFeedbackMetric).mockImplementation(() =>
        Promise.reject(new Error('down')),
      )

      await returnToApp()

      expect(toastError).not.toHaveBeenCalled()
      // The card keeps its rate: the failed refetch did not wipe it.
      expect(cardText('feedback')).toContain('65%')
    })
  })
})
