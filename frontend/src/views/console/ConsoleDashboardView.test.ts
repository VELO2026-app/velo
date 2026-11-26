// =============================================================================
// VELO Frontend -- ConsoleDashboardView screen tests (FE-268, FE-262 slice 5)
// =============================================================================
//
// The screen reads five things, each a Pinia Colada query over a mocked API
// seam: the counters (getAdminStats + getReports), the open tickets
// (listAdminTickets), the pending payouts (getAdminWithdrawals), the
// overview of the selected window (getAdminStatsOverview) and the upcoming
// practices (getAdminPractices). It mounts with a real router (memory
// history: the queues and the rows link to other modules), a real Pinia and
// Colada, as in production. The clock is frozen so "today" and the period
// label never depend on the day the suite runs.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { coladaOptions } from '@/composables/queries/setup'
import ConsoleDashboardView from '@/views/console/ConsoleDashboardView.vue'
import * as adminApi from '@/api/admin'
import * as supportApi from '@/api/support'
import type { AdminSupportTicket } from '@/api/support'
import type {
  AdminPracticeListItem,
  AdminStatsOverviewResponse,
  AdminStatsResponse,
} from '@/api/types'

vi.mock('@/api/admin')
vi.mock('@/api/support')

const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, info: vi.fn(), success: vi.fn() }),
}))

// The instance options: the payout queue is the payments option's.
const options = vi.hoisted(() => ({ payments: true }))
vi.mock('@/platform/instance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/platform/instance')>()),
  isOptionEnabled: (name: string) => (name === 'payments' ? options.payments : true),
}))

// Tuesday 24 Nov 2026: the week is 23-29 Nov, the month November 2026.
const NOW = new Date('2026-11-24T10:00:00Z')

function stats(overrides: Partial<AdminStatsResponse> = {}): AdminStatsResponse {
  return {
    users_count: 0,
    masters_count: 0,
    practices_count: 0,
    pending_verifications: 2,
    pending_method_changes: 1,
    ...overrides,
  }
}

function overview(overrides: Partial<AdminStatsOverviewResponse> = {}): AdminStatsOverviewResponse {
  return {
    new_users: 128,
    new_users_delta_pct: null,
    new_masters: 3,
    new_masters_delta_pct: -2,
    practices_count: 312,
    practices_delta_pct: 8,
    revenue_cents: 1842000,
    revenue_delta_pct: 12,
    commission_cents: 0,
    checkin_rate_pct: 78,
    checkin_rate_delta: 4,
    feedback_rate_pct: 65,
    feedback_rate_delta: -2,
    return_rate_pct: 42,
    return_rate_delta: 0,
    pending_reports: 0,
    ...overrides,
  }
}

function practice(overrides: Partial<AdminPracticeListItem> = {}): AdminPracticeListItem {
  return {
    id: 'p_1',
    title: 'Утренняя медитация',
    direction: 'meditation',
    master_name: 'Анна Лебедева',
    master_verified: true,
    scheduled_at: '2026-11-24T15:00:00Z',
    duration_minutes: 60,
    booked: 12,
    capacity: 15,
    status: 'upcoming',
    timezone: 'Europe/Moscow',
    ...overrides,
  }
}

function tickets(count: number, more = false): supportApi.AdminSupportTicketList {
  return {
    tickets: Array.from({ length: count }, (_, i) => ({ id: `t_${i}` }) as AdminSupportTicket),
    next_cursor: more ? 'next' : null,
  }
}

/** Page of the upcoming scope as the API answers it: newest first. */
let upcoming: AdminPracticeListItem[]

let app: App | null = null
let host: HTMLElement | null = null
let router: Router
let pinia: Pinia

const MODULE_ROUTES = [
  'dashboard',
  'masters',
  'moderation',
  'support',
  'finance',
  'analytics',
  'practices',
] as const

async function mount(url = '/admin/dashboard'): Promise<HTMLElement> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      ...MODULE_ROUTES.map((key) => ({
        path: `/admin/${key}`,
        name: `console-${key}`,
        component: { render: () => null },
      })),
      {
        path: '/admin/practices/:id',
        name: 'console-practices-detail',
        component: { render: () => null },
      },
    ],
  })
  await router.push(url)
  await router.isReady()
  host = document.createElement('div')
  document.body.appendChild(host)
  pinia = createPinia()
  setActivePinia(pinia)
  app = createApp(ConsoleDashboardView)
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

/** Text without any space (JS `\s` covers the NBSP the locale puts in numbers and money). */
function norm(text: string | null | undefined): string {
  return (text ?? '').replace(/\s/g, '')
}

function queue(key: string): HTMLAnchorElement {
  const el = host?.querySelector<HTMLAnchorElement>(`[data-testid="attention-${key}"]`)
  if (!el) throw new Error(`no queue ${key}`)
  return el
}
/** A count that is not known: the dash and its text for a screen reader. */
const UNKNOWN = '—нетданных'
function queueCount(key: string): string {
  return norm(queue(key).querySelector('[data-testid="attention-count"]')?.textContent)
}
function tiles(): string[] {
  return Array.from(host?.querySelectorAll('[data-testid="figure-tile"]') ?? []).map((el) =>
    norm(el.textContent),
  )
}
function rates(): string[] {
  return Array.from(host?.querySelectorAll('[data-testid="engagement-rate"]') ?? []).map((el) =>
    norm(el.textContent),
  )
}
function todayTitles(): string[] {
  return Array.from(
    host?.querySelectorAll('[data-testid="today-card"] [data-testid="console-table-row"]') ?? [],
  ).map((row) => norm(row.textContent))
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
function queueRetry(key: string): HTMLButtonElement | null {
  return host?.querySelector<HTMLButtonElement>(`[data-testid="attention-retry-${key}"]`) ?? null
}
function engagementRetry(): HTMLButtonElement | undefined {
  return Array.from(
    host?.querySelectorAll<HTMLButtonElement>('[data-testid="engagement-card"] .v-btn') ?? [],
  ).find((b) => b.textContent?.trim() === 'Повторить')
}
function retryButton(): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-btn') ?? []).find(
    (b) => b.textContent?.trim() === 'Повторить',
  )
}
function range(): string {
  return host?.querySelector('[data-testid="period-range"]')?.textContent?.trim() ?? ''
}
/** A return to the app: the page becomes visible again and every stale query on screen is asked again. */
async function returnToApp(): Promise<void> {
  document.dispatchEvent(new Event('visibilitychange'))
  await flush()
}

beforeEach(() => {
  options.payments = true
  upcoming = [practice()]
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  toastError.mockReset()
  vi.mocked(adminApi.getAdminStats).mockReset().mockResolvedValue(stats())
  vi.mocked(adminApi.getReports)
    .mockReset()
    .mockResolvedValue({ items: [], total: 3, limit: 1, offset: 0 })
  vi.mocked(adminApi.getAdminWithdrawals)
    .mockReset()
    .mockResolvedValue({ items: [], total: 4, limit: 1, offset: 0 })
  vi.mocked(supportApi.listAdminTickets).mockReset().mockResolvedValue(tickets(5))
  vi.mocked(adminApi.getAdminStatsOverview).mockReset().mockResolvedValue(overview())
  vi.mocked(adminApi.getAdminPractices)
    .mockReset()
    .mockImplementation(async (_scope = 'all', limit = 20, offset = 0) => ({
      items: upcoming.slice(offset, offset + limit),
      total: upcoming.length,
      limit,
      offset,
    }))
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.useRealTimers()
})

describe('ConsoleDashboardView: needs attention', () => {
  it('shows each queue with its count and the module that works it', async () => {
    await mount()

    expect(
      ['verifications', 'complaints', 'methods', 'tickets', 'payouts'].map((key) => [
        key,
        queueCount(key),
        queue(key).getAttribute('href'),
      ]),
    ).toEqual([
      ['verifications', '2', '/admin/masters?tab=pending'],
      ['complaints', '3', '/admin/moderation?tab=complaints'],
      ['methods', '1', '/admin/moderation?tab=methods'],
      ['tickets', '5', '/admin/support?tab=open'],
      ['payouts', '4', '/admin/finance'],
    ])
    expect(adminApi.getAdminWithdrawals).toHaveBeenCalledWith('pending', 1, 0)
    expect(supportApi.listAdminTickets).toHaveBeenCalledWith({ status: 'open', limit: 100 })
  })

  it('a full page of open tickets reads "100+"; a page that is not full reads its count', async () => {
    vi.mocked(supportApi.listAdminTickets).mockResolvedValue(tickets(100, true))
    await mount()

    expect(queueCount('tickets')).toBe('100+')
    // The other queues carry no "more".
    expect(queueCount('verifications')).toBe('2')
  })

  it('an empty queue reads zero', async () => {
    vi.mocked(adminApi.getAdminStats).mockResolvedValue(
      stats({ pending_verifications: 0, pending_method_changes: 0 }),
    )
    await mount()

    expect(queueCount('verifications')).toBe('0')
    expect(queueCount('methods')).toBe('0')
  })

  it('without the payments option there is no payout queue and no request for it', async () => {
    options.payments = false
    await mount()

    expect(host?.querySelector('[data-testid="attention-payouts"]')).toBeNull()
    expect(adminApi.getAdminWithdrawals).not.toHaveBeenCalled()
    // The others stay.
    expect(queueCount('tickets')).toBe('5')
  })

  it('counters that could not be read show dashes with Retry; Retry brings the numbers', async () => {
    vi.mocked(adminApi.getAdminStats).mockRejectedValueOnce(new Error('down'))
    await mount()

    expect(host?.querySelector('[data-testid="counters-error"]')).not.toBeNull()
    expect(queueCount('verifications')).toBe(UNKNOWN)
    expect(queueCount('complaints')).toBe(UNKNOWN)
    // A queue with a request of its own still answers.
    expect(queueCount('tickets')).toBe('5')

    retryButton()?.click()
    await flush()

    expect(host?.querySelector('[data-testid="counters-error"]')).toBeNull()
    expect(queueCount('verifications')).toBe('2')
  })

  it('a ticket count that failed reads a dash and is told once; its own Retry brings the number, the other queues stay', async () => {
    vi.mocked(supportApi.listAdminTickets).mockRejectedValueOnce(new Error('down'))
    await mount()

    expect(queueCount('tickets')).toBe(UNKNOWN)
    // A failed queue is no link: its Retry is the tile's control.
    expect(queue('tickets').getAttribute('href')).toBeNull()
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastError).toHaveBeenCalledWith('Не удалось загрузить очереди')
    // Not the counters' failure: the others answer, the banner is not up.
    expect(queueCount('payouts')).toBe('4')
    expect(queueRetry('payouts')).toBeNull()
    expect(host?.querySelector('[data-testid="counters-error"]')).toBeNull()

    queueRetry('tickets')?.click()
    await flush()

    expect(queueCount('tickets')).toBe('5')
    expect(queue('tickets').getAttribute('href')).toBe('/admin/support?tab=open')
    expect(queueRetry('tickets')).toBeNull()
  })

  it('a payout count that failed has a Retry of its own too', async () => {
    vi.mocked(adminApi.getAdminWithdrawals).mockRejectedValueOnce(new Error('down'))
    await mount()

    expect(queueCount('payouts')).toBe(UNKNOWN)
    expect(queueCount('tickets')).toBe('5')

    queueRetry('payouts')?.click()
    await flush()

    expect(queueCount('payouts')).toBe('4')
    expect(queue('payouts').getAttribute('href')).toBe('/admin/finance')
  })
})

describe('ConsoleDashboardView: figures', () => {
  it('shows revenue, practices, new users and new masters with their change', async () => {
    await mount()

    expect(tiles()).toEqual([
      'Выручка18420,00€+12%кпрошломупериоду',
      'Практики312+8%кпрошломупериоду',
      // No base to compare with: a dash, never a made-up zero.
      'Новыепользователи128—нетданныхдлясравнения',
      'Новыемастера3-2%кпрошломупериоду',
    ])
    expect(adminApi.getAdminStatsOverview).toHaveBeenCalledWith('week', 0)
  })

  it('without the payments option the revenue tile is not there, the other three stay', async () => {
    options.payments = false
    await mount()

    expect(tiles()).toEqual([
      'Практики312+8%кпрошломупериоду',
      'Новыепользователи128—нетданныхдлясравнения',
      'Новыемастера3-2%кпрошломупериоду',
    ])
  })

  it('the month tab asks the month; the stepper asks the periods before it, and stops at the current one', async () => {
    await mount()
    const weekRange = range()
    expect(step('Следующий период').disabled).toBe(true)

    periodTab('Месяц').click()
    await flush()
    expect(adminApi.getAdminStatsOverview).toHaveBeenLastCalledWith('month', 0)
    expect(router.currentRoute.value.query).toEqual({ period: 'month' })
    expect(range()).not.toBe(weekRange)

    step('Предыдущий период').click()
    await flush()
    expect(adminApi.getAdminStatsOverview).toHaveBeenLastCalledWith('month', -1)
    expect(router.currentRoute.value.query).toEqual({ period: 'month', offset: '-1' })
    expect(step('Следующий период').disabled).toBe(false)

    step('Следующий период').click()
    await flush()
    expect(adminApi.getAdminStatsOverview).toHaveBeenLastCalledWith('month', 0)
    expect(step('Следующий период').disabled).toBe(true)

    // Back to the week: its own window, from the current period; this week leaves no mark in the URL.
    periodTab('Неделя').click()
    await flush()
    expect(adminApi.getAdminStatsOverview).toHaveBeenLastCalledWith('week', 0)
    expect(router.currentRoute.value.query).toEqual({})
  })

  it('the window comes from the URL: a link or a return from the analytics keeps it; what it cannot mean is this week', async () => {
    await mount('/admin/dashboard?period=month&offset=-2')
    expect(adminApi.getAdminStatsOverview).toHaveBeenLastCalledWith('month', -2)
    expect(adminApi.getAdminStatsOverview).toHaveBeenCalledTimes(1)
    expect(step('Следующий период').disabled).toBe(false)
  })

  it('a window the URL cannot mean is this week', async () => {
    await mount('/admin/dashboard?period=year&offset=3')
    expect(adminApi.getAdminStatsOverview).toHaveBeenLastCalledWith('week', 0)
    expect(step('Следующий период').disabled).toBe(true)
  })

  it('a press on the tab already open keeps the period the stepper chose', async () => {
    await mount()
    periodTab('Месяц').click()
    await flush()
    step('Предыдущий период').click()
    await flush()
    const chosen = range()

    periodTab('Месяц').click()
    await flush()

    expect(range()).toBe(chosen)
    expect(adminApi.getAdminStatsOverview).toHaveBeenLastCalledWith('month', -1)
  })

  it('a switch of the period shows the loader, not the numbers of the old window', async () => {
    await mount()
    let resolveMonth: (value: AdminStatsOverviewResponse) => void = () => {}
    vi.mocked(adminApi.getAdminStatsOverview).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMonth = resolve
        }),
    )

    periodTab('Месяц').click()
    await flush()
    expect(host?.querySelector('[data-testid="figures-loading"]')).not.toBeNull()
    expect(tiles()).toEqual([])

    resolveMonth(overview({ practices_count: 999 }))
    await flush()
    expect(tiles()[1]).toContain('999')
  })

  it('shows the engagement rates and links each to its metric in the analytics, same window', async () => {
    await mount()

    expect(rates()).toEqual(['78%', '65%', '42%'])
    const link = host?.querySelector<HTMLAnchorElement>('[data-testid="engagement-feedback"]')
    expect(link?.getAttribute('href')).toBe('/admin/analytics?metric=feedback')

    periodTab('Месяц').click()
    await flush()
    step('Предыдущий период').click()
    await flush()
    expect(
      host
        ?.querySelector<HTMLAnchorElement>('[data-testid="engagement-return"]')
        ?.getAttribute('href'),
    ).toBe('/admin/analytics?metric=return&period=month&offset=-1')
  })

  it('a failed read shows the error in the figures and in the rates, with Retry; the day stays on screen', async () => {
    vi.mocked(adminApi.getAdminStatsOverview).mockRejectedValueOnce(new Error('down'))
    await mount()

    expect(host?.querySelector('[data-testid="figure-tile"]')).toBeNull()
    expect(rates()).toEqual([])
    expect(host?.querySelector('[data-testid="engagement-card"]')?.textContent).toContain(
      'Не удалось загрузить показатели',
    )
    // The day is its own block: it did not wait for the figures and the failure does not take it.
    expect(todayTitles()).toHaveLength(1)

    retryButton()?.click()
    await flush()

    expect(host?.textContent).not.toContain('Не удалось загрузить показатели')
    expect(tiles()).toHaveLength(4)
    expect(rates()).toEqual(['78%', '65%', '42%'])
  })

  it('the Retry of the rates asks the same window again', async () => {
    vi.mocked(adminApi.getAdminStatsOverview).mockRejectedValueOnce(new Error('down'))
    await mount()

    engagementRetry()?.click()
    await flush()

    expect(adminApi.getAdminStatsOverview).toHaveBeenCalledTimes(2)
    expect(rates()).toEqual(['78%', '65%', '42%'])
    expect(tiles()).toHaveLength(4)
  })

  it('a switch of the period leaves the day alone: no loader, no new request for it', async () => {
    await mount()
    const askedForPractices = vi.mocked(adminApi.getAdminPractices).mock.calls.length
    vi.mocked(adminApi.getAdminStatsOverview).mockImplementation(() => new Promise(() => {}))

    periodTab('Месяц').click()
    await flush()

    expect(host?.querySelector('[data-testid="figures-loading"]')).not.toBeNull()
    expect(host?.querySelector('[data-testid="today-loading"]')).toBeNull()
    expect(todayTitles()).toHaveLength(1)
    expect(vi.mocked(adminApi.getAdminPractices).mock.calls).toHaveLength(askedForPractices)
  })

  describe('background refetch (a return to the app)', () => {
    it('keeps the figures on screen while it runs, then shows the fresh answer', async () => {
      await mount()
      expect(tiles()[1]).toContain('312')

      let resolveFresh: (value: AdminStatsOverviewResponse) => void = () => {}
      vi.mocked(adminApi.getAdminStatsOverview).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveFresh = resolve
          }),
      )
      await returnToApp()

      // No loader, the cached figures stay.
      expect(host?.querySelector('[data-testid="figures-loading"]')).toBeNull()
      expect(tiles()[1]).toContain('312')

      resolveFresh(overview({ practices_count: 400 }))
      await flush()
      expect(tiles()[1]).toContain('400')
      expect(toastError).not.toHaveBeenCalled()
    })

    it('failing again and again is told once, until an answer arrives; the figures stay', async () => {
      await mount()
      vi.mocked(adminApi.getAdminStatsOverview).mockImplementation(() =>
        Promise.reject(new Error('down')),
      )

      await returnToApp()
      await returnToApp()

      expect(toastError).toHaveBeenCalledTimes(1)
      expect(toastError).toHaveBeenCalledWith('Не удалось загрузить показатели')
      expect(tiles()[1]).toContain('312')
      expect(host?.textContent).not.toContain('Не удалось загрузить показатели')

      // An answer arrives, then a new failure is told again.
      vi.mocked(adminApi.getAdminStatsOverview).mockResolvedValue(overview())
      await returnToApp()
      vi.mocked(adminApi.getAdminStatsOverview).mockImplementation(() =>
        Promise.reject(new Error('down again')),
      )
      await returnToApp()

      expect(toastError).toHaveBeenCalledTimes(2)
    })
  })
})

describe('ConsoleDashboardView: today', () => {
  it('lists the practices of today only, nearest first: time, practice, master, seats', async () => {
    // The API lists newest first: tomorrow's practice, then the two of today.
    upcoming = [
      practice({ id: 'p_tomorrow', title: 'Завтрашняя', scheduled_at: '2026-11-25T07:00:00Z' }),
      practice({
        id: 'p_evening',
        title: 'Звуковая медитация',
        master_name: 'Олег Ким',
        scheduled_at: '2026-11-24T17:00:00Z',
        booked: 6,
        capacity: 20,
      }),
      practice({ id: 'p_noon', title: 'Дыхание по Бутейко', scheduled_at: '2026-11-24T10:30:00Z' }),
    ]
    await mount()

    // Moscow time: 13:30 and 20:00 (the table reads the page nearest first).
    expect(todayTitles()).toEqual([
      '13:30ДыханиепоБутейкоАннаЛебедева12/15',
      '20:00ЗвуковаямедитацияОлегКим6/20',
    ])
    expect(norm(host?.querySelector('[data-testid="today-card"]')?.textContent)).toContain(
      'ещё2практики',
    )
  })

  /** `count` practices of today, five minutes apart from 10:05Z, newest first as the API lists them. */
  function busyDay(count: number): AdminPracticeListItem[] {
    return Array.from({ length: count }, (_, i) =>
      practice({
        id: `p_today_${i}`,
        title: `Практика ${i}`,
        scheduled_at: new Date(Date.UTC(2026, 10, 24, 10, 5 + 5 * i)).toISOString(),
      }),
    ).reverse()
  }

  it('a busy day is listed whole, past one page of practices (FE-260)', async () => {
    upcoming = [
      practice({ id: 'p_tomorrow', scheduled_at: '2026-11-25T07:00:00Z' }),
      ...busyDay(35),
    ]
    await mount()

    const titles = todayTitles()
    expect(titles).toHaveLength(35)
    expect(titles[0]).toContain('Практика0')
    expect(titles[34]).toContain('Практика34')
    expect(norm(host?.querySelector('[data-testid="today-card"]')?.textContent)).toContain(
      'ещё35практик',
    )
  })

  it('a busy day listed nearest first by the API (BE-257) is the same list', async () => {
    upcoming = [
      ...busyDay(35).reverse(),
      practice({ id: 'p_tomorrow', scheduled_at: '2026-11-25T07:00:00Z' }),
    ]
    await mount()

    const titles = todayTitles()
    expect(titles).toHaveLength(35)
    expect(titles[0]).toContain('Практика0')
    expect(titles[34]).toContain('Практика34')
  })

  it('a day past the read cap says "N+", not a count that looks whole (FE-260)', async () => {
    upcoming = busyDay(120)
    await mount()

    expect(todayTitles()).toHaveLength(100)
    expect(norm(host?.querySelector('[data-testid="today-card"]')?.textContent)).toContain(
      'ещё100+практик',
    )
  })

  it('a day of exactly the cap is counted whole, without "+"', async () => {
    upcoming = [
      practice({ id: 'p_tomorrow', scheduled_at: '2026-11-25T07:00:00Z' }),
      ...busyDay(100),
    ]
    await mount()

    expect(todayTitles()).toHaveLength(100)
    const text = norm(host?.querySelector('[data-testid="today-card"]')?.textContent)
    expect(text).toContain('ещё100практик')
    expect(text).not.toContain('100+')
  })

  it('says so when no practice is left today', async () => {
    upcoming = [practice({ id: 'p_tomorrow', scheduled_at: '2026-11-25T07:00:00Z' })]
    await mount()

    expect(todayTitles()).toEqual([])
    const card = host?.querySelector('[data-testid="today-card"]')
    expect(card?.textContent).toContain('На сегодня больше нет практик')
    // The count after the title is for a day that has practices.
    expect(card?.querySelector('.console-card__note')).toBeNull()
  })

  it('a row opens the practice', async () => {
    await mount()

    host
      ?.querySelector<HTMLElement>('[data-testid="today-card"] [data-testid="console-table-row"]')
      ?.click()
    await flush()

    expect(router.currentRoute.value.name).toBe('console-practices-detail')
    expect(router.currentRoute.value.params.id).toBe('p_1')
  })

  it('"all practices" opens the practices module', async () => {
    await mount()

    Array.from(host?.querySelectorAll<HTMLAnchorElement>('[data-testid="today-card"] a') ?? [])
      .find((a) => a.textContent?.includes('Все практики'))
      ?.click()
    await flush()

    expect(router.currentRoute.value.name).toBe('console-practices')
  })

  it('a refetch of the day that fails over the list shown is told once and keeps the list', async () => {
    await mount()
    vi.mocked(adminApi.getAdminPractices).mockImplementation(() =>
      Promise.reject(new Error('down')),
    )

    await returnToApp()
    await returnToApp()

    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastError).toHaveBeenCalledWith('Не удалось загрузить практики')
    expect(todayTitles()).toHaveLength(1)
    expect(host?.querySelector('[data-testid="today-card"] .v-empty__title')).toBeNull()
  })

  it('a failed read shows the error inside the card and Retry recovers; the rest of the screen stays', async () => {
    vi.mocked(adminApi.getAdminPractices).mockRejectedValueOnce(new Error('down'))
    await mount()

    const card = host?.querySelector('[data-testid="today-card"]')
    expect(card?.textContent).toContain('Не удалось загрузить практики')
    // The error rung is the message: a first load that fails is not also a toast.
    expect(toastError).not.toHaveBeenCalled()
    // Figures are not held by it.
    expect(tiles()).toHaveLength(4)

    Array.from(card?.querySelectorAll<HTMLButtonElement>('.v-btn') ?? [])
      .find((b) => b.textContent?.trim() === 'Повторить')
      ?.click()
    await flush()

    expect(todayTitles()).toHaveLength(1)
  })
})
