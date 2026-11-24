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
import { PiniaColada, useQueryCache } from '@pinia/colada'
import { coladaOptions } from '@/composables/queries/setup'
import { adminKeys } from '@/composables/queries/adminKeys'
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
  'masters',
  'moderation',
  'support',
  'finance',
  'analytics',
  'practices',
] as const

async function mount(): Promise<HTMLElement> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      ...MODULE_ROUTES.map((key) => ({
        path: `/console/${key}`,
        name: `console-${key}`,
        component: { render: () => null },
      })),
      {
        path: '/console/practices/:id',
        name: 'console-practices-detail',
        component: { render: () => null },
      },
    ],
  })
  await router.push('/console/masters')
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
function retryButton(): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-btn') ?? []).find(
    (b) => b.textContent?.trim() === 'Повторить',
  )
}
function range(): string {
  return host?.querySelector('[data-testid="period-range"]')?.textContent?.trim() ?? ''
}
/** A background refetch of the window on screen, as a return to the app does. */
async function refetchOverviewInBackground(): Promise<void> {
  useQueryCache(pinia)
    .invalidateQueries({ key: adminKeys.overview('week', 0) })
    .catch(() => {})
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
      ['verifications', '2', '/console/masters'],
      ['complaints', '3', '/console/moderation?tab=complaints'],
      ['methods', '1', '/console/moderation?tab=methods'],
      ['tickets', '5', '/console/support?tab=open'],
      ['payouts', '4', '/console/finance'],
    ])
    expect(adminApi.getAdminWithdrawals).toHaveBeenCalledWith('pending', 1, 0)
    expect(supportApi.listAdminTickets).toHaveBeenCalledWith({ status: 'open', limit: 100 })
  })

  it('a queue is a link to its module', async () => {
    await mount()

    queue('complaints').click()
    await flush()

    expect(router.currentRoute.value.fullPath).toBe('/console/moderation?tab=complaints')
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

  it('a ticket count that failed reads a dash and is told once', async () => {
    vi.mocked(supportApi.listAdminTickets).mockRejectedValue(new Error('down'))
    await mount()

    expect(queueCount('tickets')).toBe(UNKNOWN)
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastError).toHaveBeenCalledWith('Не удалось загрузить очереди')
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

  it('the month tab asks the month; the stepper asks the periods before it, and stops at the current one', async () => {
    await mount()
    const weekRange = range()
    expect(step('Следующий период').disabled).toBe(true)

    periodTab('Месяц').click()
    await flush()
    expect(adminApi.getAdminStatsOverview).toHaveBeenLastCalledWith('month', 0)
    expect(range()).not.toBe(weekRange)

    step('Предыдущий период').click()
    await flush()
    expect(adminApi.getAdminStatsOverview).toHaveBeenLastCalledWith('month', -1)
    expect(step('Следующий период').disabled).toBe(false)

    step('Следующий период').click()
    await flush()
    expect(adminApi.getAdminStatsOverview).toHaveBeenLastCalledWith('month', 0)
    expect(step('Следующий период').disabled).toBe(true)

    // Back to the week: its own window, from the current period.
    periodTab('Неделя').click()
    await flush()
    expect(adminApi.getAdminStatsOverview).toHaveBeenLastCalledWith('week', 0)
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
    let resolveMonth!: (value: AdminStatsOverviewResponse) => void
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
    expect(link?.getAttribute('href')).toBe(
      '/console/analytics?metric=feedback&period=week&offset=0',
    )

    periodTab('Месяц').click()
    await flush()
    step('Предыдущий период').click()
    await flush()
    expect(
      host
        ?.querySelector<HTMLAnchorElement>('[data-testid="engagement-return"]')
        ?.getAttribute('href'),
    ).toBe('/console/analytics?metric=return&period=month&offset=-1')
  })

  it('a failed read shows the error and Retry recovers', async () => {
    vi.mocked(adminApi.getAdminStatsOverview).mockRejectedValueOnce(new Error('down'))
    await mount()

    expect(host?.textContent).toContain('Не удалось загрузить показатели')
    expect(tiles()).toEqual([])

    retryButton()?.click()
    await flush()

    expect(host?.textContent).not.toContain('Не удалось загрузить показатели')
    expect(tiles()).toHaveLength(4)
  })

  describe('background refetch (a return to the app)', () => {
    it('keeps the figures on screen while it runs, then shows the fresh answer', async () => {
      await mount()
      expect(tiles()[1]).toContain('312')

      let resolveFresh!: (value: AdminStatsOverviewResponse) => void
      vi.mocked(adminApi.getAdminStatsOverview).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveFresh = resolve
          }),
      )
      await refetchOverviewInBackground()

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

      await refetchOverviewInBackground()
      await refetchOverviewInBackground()

      expect(toastError).toHaveBeenCalledTimes(1)
      expect(toastError).toHaveBeenCalledWith('Не удалось загрузить показатели')
      expect(tiles()[1]).toContain('312')
      expect(host?.textContent).not.toContain('Не удалось загрузить показатели')

      // An answer arrives, then a new failure is told again.
      vi.mocked(adminApi.getAdminStatsOverview).mockResolvedValue(overview())
      await refetchOverviewInBackground()
      vi.mocked(adminApi.getAdminStatsOverview).mockImplementation(() =>
        Promise.reject(new Error('down again')),
      )
      await refetchOverviewInBackground()

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

  it('a failed read shows the error inside the card and Retry recovers; the rest of the screen stays', async () => {
    vi.mocked(adminApi.getAdminPractices).mockRejectedValueOnce(new Error('down'))
    await mount()

    const card = host?.querySelector('[data-testid="today-card"]')
    expect(card?.textContent).toContain('Не удалось загрузить практики')
    // Figures are not held by it.
    expect(tiles()).toHaveLength(4)

    Array.from(card?.querySelectorAll<HTMLButtonElement>('.v-btn') ?? [])
      .find((b) => b.textContent?.trim() === 'Повторить')
      ?.click()
    await flush()

    expect(todayTitles()).toHaveLength(1)
  })
})
