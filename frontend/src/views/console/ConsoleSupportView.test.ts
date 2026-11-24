// =============================================================================
// VELO Frontend -- ConsoleSupportView screen tests (FE-262, slice 2)
// =============================================================================
//
// What the screen decides: which tickets each tab lists, which ticket is open
// next to the list, who may reply (the taker alone), the take / release /
// hand-over / status / reopen actions with their conflict handling, the
// translation polling, the history, the month statistics, and the one-pane
// layout on a narrow window. Real Pinia + Pinia Colada and a real memory
// router; @/api/support is the mocked boundary with a small fake server behind
// it (a take sets `claimed_by`, a reply joins the feed). SUPPORT_CLOSING_STATUSES
// stays REAL: an auto-mock would empty the array and silently drop the status
// choices.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { PiniaColada, useQueryCache } from '@pinia/colada'
import { DateTime } from 'luxon'
import { coladaOptions } from '@/composables/queries/setup'
import { adminKeys } from '@/composables/queries/adminKeys'
import ConsoleSupportView from '@/views/console/ConsoleSupportView.vue'
import { TICKET_POLL_MS } from '@/components/console/requests/useTicketSession'
import * as supportApi from '@/api/support'
import type { AdminSupportTicket, SupportMessage, SupportPerson, SupportStats } from '@/api/support'
import { ApiResponseError } from '@/api/client'

vi.mock('@/api/support', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/api/support')>()
  return {
    SUPPORT_CLOSING_STATUSES: real.SUPPORT_CLOSING_STATUSES,
    spamWithinRetention: real.spamWithinRetention,
    listAdminTickets: vi.fn(),
    getAdminTicket: vi.fn(),
    getAdminSupportMessages: vi.fn(),
    sendAdminSupportReply: vi.fn(),
    claimSupportThread: vi.fn(),
    setTicketStatus: vi.fn(),
    retrySupportTranslation: vi.fn(),
    assignTicket: vi.fn(),
    releaseTicket: vi.fn(),
    reopenTicket: vi.fn(),
    getSupportStats: vi.fn(),
  }
})

const getUsersList = vi.fn()
vi.mock('@/api/admin', () => ({
  getUsersList: (...args: unknown[]) => getUsersList(...args),
}))

const env = vi.hoisted(() => ({ single: false }))
vi.mock('@/composables/useMediaQuery', () => ({ useMediaQuery: () => ref(env.single) }))

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: toastSuccess, info: vi.fn() }),
}))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ user: { id: 'admin_me', timezone: 'Europe/Berlin' } }),
}))

// -----------------------------------------------------------------------------
// Fixtures: topics and texts differ between tickets, so "the right one is open"
// proves itself
// -----------------------------------------------------------------------------

const ME: SupportPerson = { user_id: 'admin_me', name: 'Me', avatar_url: null }
const OLGA: SupportPerson = { user_id: 'olga', name: 'Olga', avatar_url: null }

function ticket(overrides: Partial<AdminSupportTicket> = {}): AdminSupportTicket {
  return {
    id: 't_free_0001',
    topic: 'technical',
    category: 'tech',
    status: 'open',
    created_at: new Date(Date.now() - 3 * 3600000).toISOString(),
    status_changed_at: new Date(Date.now() - 3 * 3600000).toISOString(),
    opener: { user_id: 'u_dana', name: 'Dana', avatar_url: null },
    claimed_by: null,
    history_thread_id: null,
    resolved_by: null,
    rating: null,
    ...overrides,
  }
}

const T_FREE = ticket()
const T_MINE = ticket({
  id: 't_mine_0002',
  topic: 'payment',
  category: 'payments',
  opener: { user_id: 'u_pavel', name: 'Pavel', avatar_url: null },
  claimed_by: ME,
})
const T_OTHER = ticket({
  id: 't_other_0003',
  topic: 'other',
  category: 'other',
  opener: { user_id: 'u_elena', name: 'Elena', avatar_url: null },
  claimed_by: OLGA,
  history_thread_id: 'h_0003',
})
const T_DONE = ticket({
  id: 't_done_0004',
  topic: 'practices',
  category: 'practices',
  status: 'resolved',
  opener: { user_id: 'u_ivan', name: 'Ivan', avatar_url: null },
  resolved_by: OLGA,
  rating: {
    stars: 4,
    comment: 'Quick help, thanks',
    comment_locale: 'ru',
    rated_at: null,
    rated_resolver: OLGA,
  },
})
const T_SPAM = ticket({
  id: 't_spam_0005',
  topic: 'add_direction',
  category: 'other',
  status: 'spam',
})

function message(threadId: string, overrides: Partial<SupportMessage> = {}): SupportMessage {
  const body = overrides.body ?? 'Please help with the link'
  return {
    id: `m_${threadId}_1`,
    thread_id: threadId,
    sender: 'u_dana',
    body,
    original: body,
    translation: null,
    created_at: '2026-11-24T10:00:00Z',
    ...overrides,
  }
}

const server = {
  tickets: {} as Record<string, AdminSupportTicket>,
  feeds: {} as Record<string, SupportMessage[]>,
}

function resetServer(): void {
  server.tickets = Object.fromEntries(
    [T_FREE, T_MINE, T_OTHER, T_DONE, T_SPAM].map((t) => [t.id, { ...t }]),
  )
  server.feeds = {
    t_free_0001: [message('t_free_0001', { body: 'The Zoom link did not arrive' })],
    t_mine_0002: [message('t_mine_0002', { body: 'The payment failed twice', sender: 'u_pavel' })],
    t_other_0003: [message('t_other_0003', { body: 'How to become a master', sender: 'u_elena' })],
    t_done_0004: [message('t_done_0004', { body: 'A closed conversation', sender: 'u_ivan' })],
    h_0003: [
      message('h_0003', { id: 'old_1', body: 'An older talk before tickets', sender: 'u_elena' }),
    ],
  }
}

function fakeServer(): void {
  vi.mocked(supportApi.listAdminTickets).mockImplementation(async (query = {}) => ({
    tickets: Object.values(server.tickets).filter((t) => t.status === (query.status ?? 'open')),
    next_cursor: null,
  }))
  vi.mocked(supportApi.getAdminTicket).mockImplementation(async (id) => {
    const found = server.tickets[id]
    if (!found) throw new ApiResponseError(404, 'not found')
    return { ...found }
  })
  vi.mocked(supportApi.getAdminSupportMessages).mockImplementation(async (threadId) => ({
    messages: [...(server.feeds[threadId] ?? [])].reverse(),
    next_cursor: null,
  }))
  vi.mocked(supportApi.claimSupportThread).mockImplementation(async (id) => {
    server.tickets[id] = { ...must(server.tickets[id]), claimed_by: ME }
    return { claimed: true }
  })
  vi.mocked(supportApi.releaseTicket).mockImplementation(async (id) => {
    server.tickets[id] = { ...must(server.tickets[id]), claimed_by: null }
    return { ...must(server.tickets[id]) }
  })
  vi.mocked(supportApi.assignTicket).mockImplementation(async (id, to) => {
    server.tickets[id] = { ...must(server.tickets[id]), claimed_by: { ...OLGA, user_id: to } }
    return { ...must(server.tickets[id]) }
  })
  vi.mocked(supportApi.reopenTicket).mockImplementation(async (id) => {
    server.tickets[id] = { ...must(server.tickets[id]), status: 'open' }
    return { ...must(server.tickets[id]) }
  })
  vi.mocked(supportApi.setTicketStatus).mockImplementation(async (id, status) => {
    server.tickets[id] = { ...must(server.tickets[id]), status }
    return { ...must(server.tickets[id]) }
  })
  vi.mocked(supportApi.sendAdminSupportReply).mockImplementation(async (threadId, body) => {
    const sent = message(threadId, { id: 'm_sent', sender: 'admin_me', body })
    server.feeds[threadId] = [...(server.feeds[threadId] ?? []), sent]
    const { original: _o, translation: _t, ...thin } = sent
    return thin
  })
  getUsersList.mockResolvedValue({
    items: [
      { id: 'admin_me', first_name: 'Me' },
      { id: 'olga', first_name: 'Olga', last_name: 'Ivanova' },
    ],
    total: 2,
    limit: 100,
    offset: 0,
  })
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

/** The value, or a clear failure: tests read maps and arrays that must hold the key. */
function must<T>(value: T | undefined | null, what = 'value'): T {
  if (value == null) throw new Error(`missing ${what}`)
  return value
}

let app: App | null = null
let host: HTMLElement | null = null
let router: Router

async function mount(path = '/console/support'): Promise<HTMLElement> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/console/support', name: 'console-support', component: ConsoleSupportView }],
  })
  await router.push(path)
  host = document.createElement('div')
  document.body.appendChild(host)
  const pinia = createPinia()
  setActivePinia(pinia)
  app = createApp(RouterView).use(createTestI18n()).use(pinia).use(PiniaColada, coladaOptions)
  app.use(router)
  app.mount(host)
  await flush()
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await nextTick()
  // One macrotask for Colada's settled requests (fake timers advance it).
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0)
  else await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

function byId(id: string): HTMLElement | null {
  return host?.querySelector(`[data-testid="${id}"]`) ?? null
}
function rows(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('[data-testid="ticket-row"]') ?? [])
}
function rowTitles(): string[] {
  return rows().map((r) => r.querySelector('.ticket-row__title')?.textContent?.trim() ?? '')
}
function feedText(): string {
  return byId('ticket-feed')?.textContent ?? ''
}
function button(label: string): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent?.trim() === label,
  )
  if (!found) throw new Error(`no button "${label}"`)
  return found
}
function hasButton(label: string): boolean {
  return Array.from(document.body.querySelectorAll('button')).some(
    (b) => b.textContent?.trim() === label,
  )
}
async function click(el: HTMLElement): Promise<void> {
  el.click()
  await flush()
}
function composer(): HTMLTextAreaElement | null {
  return host?.querySelector('textarea') ?? null
}
function typeInto(el: HTMLTextAreaElement | null, value: string): void {
  if (!el) throw new Error('no textarea')
  el.value = value
  el.dispatchEvent(new Event('input'))
}
async function rowClick(title: string): Promise<void> {
  const row = rows().find((r) => r.textContent?.includes(title))
  if (!row) throw new Error(`no ticket row "${title}"`)
  await click(row)
}

const TOPIC_TECH = 'Технические проблемы'
const TOPIC_PAYMENT = 'Проблема с оплатой / транзакцией'

beforeEach(() => {
  env.single = false
  resetServer()
  fakeServer()
  toastError.mockReset()
  toastSuccess.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  app?.unmount()
  host?.remove()
  document.body.querySelectorAll('.v-modal__overlay, .v-modal__scrim').forEach((el) => el.remove())
  app = null
  host = null
  vi.clearAllMocks()
})

describe('ConsoleSupportView: the tabs', () => {
  it('lists the open tickets with the first one open and its conversation read', async () => {
    await mount()

    expect(supportApi.listAdminTickets).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'open' }),
    )
    expect(rowTitles()).toEqual([TOPIC_TECH, TOPIC_PAYMENT, 'Другое'])
    expect(feedText()).toContain('The Zoom link did not arrive')
    expect(byId('ticket-detail')?.textContent).toContain(TOPIC_TECH)
  })

  it('lists on the mine tab only the open tickets this admin holds', async () => {
    await mount('/console/support?tab=mine')

    expect(rowTitles()).toEqual([TOPIC_PAYMENT])
    expect(feedText()).toContain('The payment failed twice')
  })

  it('lists resolved tickets on the closed tab and another closing status through the chips', async () => {
    await mount('/console/support?tab=closed')

    expect(supportApi.listAdminTickets).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'resolved' }),
    )
    expect(rowTitles()).toEqual(['Вопрос по практикам'])

    await click(button('Спам'))

    expect(supportApi.listAdminTickets).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'spam' }),
    )
    expect(rowTitles()).toEqual(['Добавить направление практики'])
  })

  it('opens the ticket that is clicked and keeps it in the URL', async () => {
    await mount()

    await rowClick(TOPIC_PAYMENT)

    expect(feedText()).toContain('The payment failed twice')
    expect(router.currentRoute.value.query.ticket).toBe('t_mine_0002')
  })

  it('says a ticket named in the URL is not found when the server has none', async () => {
    await mount('/console/support?ticket=t_missing')

    expect(byId('ticket-detail')?.textContent).toContain('Обращение не найдено')
  })
})

describe('ConsoleSupportView: taking a ticket and replying', () => {
  it('shows a notice instead of the reply field until the ticket is taken, then the field', async () => {
    await mount()
    expect(byId('claim-notice')).not.toBeNull()
    expect(composer()).toBeNull()

    await click(button('Взять себе'))

    expect(supportApi.claimSupportThread).toHaveBeenCalledWith('t_free_0001')
    expect(byId('claim-notice')).toBeNull()
    expect(composer()).not.toBeNull()
    expect(byId('ticket-taker')?.textContent).toBe('У меня')
  })

  it('tells that another admin took it first, and still offers no reply field', async () => {
    vi.mocked(supportApi.claimSupportThread).mockRejectedValueOnce(
      new ApiResponseError(409, 'taken'),
    )
    await mount()

    await click(button('Взять себе'))

    expect(toastError).toHaveBeenCalledWith('Уже взято другим администратором')
    expect(composer()).toBeNull()
  })

  it('sends the trimmed reply once, shows it in the feed and clears the field', async () => {
    await mount('/console/support?tab=mine')
    expect(byId('ticket-send')?.hasAttribute('disabled')).toBe(true)

    typeInto(composer(), '  We are on it  ')
    await flush()
    await click(byId('ticket-send') as HTMLElement)

    expect(supportApi.sendAdminSupportReply).toHaveBeenCalledTimes(1)
    expect(supportApi.sendAdminSupportReply).toHaveBeenCalledWith(
      't_mine_0002',
      'We are on it',
      expect.stringMatching(/\S/),
    )
    expect(feedText()).toContain('We are on it')
    expect(composer()?.value).toBe('')
  })

  it.each([
    { after: 'a lost connection', failure: new ApiResponseError(500, 'boom'), sameKey: true },
    { after: 'a refusal', failure: new ApiResponseError(403, 'no'), sameKey: false },
  ])('sends the text again under the same key: $sameKey, after $after', async (c) => {
    vi.mocked(supportApi.sendAdminSupportReply).mockRejectedValueOnce(c.failure)
    await mount('/console/support?tab=mine')
    typeInto(composer(), 'Same text')
    await flush()

    await click(byId('ticket-send') as HTMLElement)
    await click(byId('ticket-send') as HTMLElement)

    const keys = vi.mocked(supportApi.sendAdminSupportReply).mock.calls.map((call) => call[2])
    expect(keys).toHaveLength(2)
    expect(keys[0] === keys[1]).toBe(c.sameKey)
  })

  it('keeps the draft and tells it when the reply fails', async () => {
    vi.mocked(supportApi.sendAdminSupportReply).mockRejectedValueOnce(
      new ApiResponseError(403, 'no'),
    )
    await mount('/console/support?tab=mine')

    typeInto(composer(), 'Draft text')
    await flush()
    await click(byId('ticket-send') as HTMLElement)

    expect(toastError).toHaveBeenCalledTimes(1)
    expect(composer()?.value).toBe('Draft text')
  })
})

describe('ConsoleSupportView: moving a ticket on', () => {
  it('closes an open ticket with the chosen status, and stays on it to show the result', async () => {
    await mount()
    await rowClick(TOPIC_TECH)

    await click(button('Закрыть'))
    await click(document.body.querySelector('[data-testid="close-resolved"]') as HTMLElement)

    expect(supportApi.setTicketStatus).toHaveBeenCalledWith('t_free_0001', 'resolved')
    expect(toastSuccess).toHaveBeenCalledWith('Статус изменён')
    expect(hasButton('Закрыть')).toBe(false)
    expect(hasButton('Вернуть в работу')).toBe(true)
  })

  it('tells that the ticket changed meanwhile and reads it again', async () => {
    vi.mocked(supportApi.setTicketStatus).mockRejectedValueOnce(new ApiResponseError(409, 'moved'))
    await mount()
    const reads = vi.mocked(supportApi.getAdminTicket).mock.calls.length

    await click(button('Закрыть'))
    await click(document.body.querySelector('[data-testid="close-spam"]') as HTMLElement)

    expect(toastError).toHaveBeenCalledWith('Обращение изменилось — проверьте статус')
    expect(vi.mocked(supportApi.getAdminTicket).mock.calls.length).toBeGreaterThan(reads)
  })

  it('hands a ticket over to another admin, the caller not offered', async () => {
    await mount('/console/support?tab=mine&ticket=t_mine_0002')

    await click(button('Назначить'))
    const offered = Array.from(document.body.querySelectorAll('.v-menu-row')).map((r) =>
      r.textContent?.trim(),
    )
    expect(offered).toEqual(['Olga Ivanova'])
    await click(document.body.querySelector('.v-menu-row') as HTMLElement)

    expect(supportApi.assignTicket).toHaveBeenCalledWith('t_mine_0002', 'olga')
    expect(byId('ticket-taker')?.textContent).toBe('Взял: Olga')
  })

  it('gives a held ticket back to the pool', async () => {
    await mount('/console/support?tab=mine&ticket=t_mine_0002')

    await click(button('Освободить'))

    expect(supportApi.releaseTicket).toHaveBeenCalledWith('t_mine_0002')
    expect(byId('ticket-taker')?.textContent).toBe('Не взято')
  })

  it('brings a resolved ticket back to work', async () => {
    await mount('/console/support?tab=closed')

    await click(button('Вернуть в работу'))

    expect(supportApi.reopenTicket).toHaveBeenCalledWith('t_done_0004')
    expect(toastSuccess).toHaveBeenCalledWith('Обращение снова открыто')
  })

  it('offers not-spam only inside the retention, not past it', async () => {
    server.tickets.t_spam_0005 = {
      ...T_SPAM,
      status_changed_at: new Date(Date.now() - 40 * 86400000).toISOString(),
    }
    await mount('/console/support?tab=closed')
    await click(button('Спам'))
    expect(hasButton('Не спам')).toBe(false)

    app?.unmount()
    host?.remove()
    server.tickets.t_spam_0005 = { ...T_SPAM, status_changed_at: new Date().toISOString() }
    await mount('/console/support?tab=closed')
    await click(button('Спам'))
    expect(hasButton('Не спам')).toBe(true)
  })
})

describe('ConsoleSupportView: the person', () => {
  it("shows the person's name, the taker and the rating from the ticket", async () => {
    await mount('/console/support?tab=closed')

    const aside = byId('ticket-aside')?.textContent ?? ''
    expect(aside).toContain('Ivan')
    expect(aside).toContain('Решена')
    expect(byId('ticket-rating')?.textContent).toContain('Quick help, thanks')
    expect(byId('ticket-rating')?.textContent).toContain('оценка работе: Olga')
  })

  it("reads the person's earlier conversation on demand, read-only", async () => {
    await mount()
    await rowClick('Другое')
    expect(feedText()).not.toContain('An older talk before tickets')

    await click(button('История обращений'))

    expect(supportApi.getAdminSupportMessages).toHaveBeenCalledWith('h_0003')
    expect(feedText()).toContain('An older talk before tickets')
  })
})

describe('ConsoleSupportView: translation', () => {
  it('reads the feed again while a message is being translated, until it is ready', async () => {
    vi.useFakeTimers()
    server.feeds.t_free_0001 = [
      message('t_free_0001', {
        body: 'The Zoom link did not arrive',
        translation: { locale: 'ru', state: 'preparing', source_locale: 'en', retryable: false },
      }),
    ]
    await mount()
    expect(feedText()).toContain('Переводится…')
    const reads = vi.mocked(supportApi.getAdminSupportMessages).mock.calls.length

    server.feeds.t_free_0001 = [
      message('t_free_0001', {
        body: 'Ссылка на Zoom не пришла',
        original: 'The Zoom link did not arrive',
        translation: { locale: 'ru', state: 'ready', source_locale: 'en', retryable: false },
      }),
    ]
    await vi.advanceTimersByTimeAsync(TICKET_POLL_MS)
    await flush()

    expect(vi.mocked(supportApi.getAdminSupportMessages).mock.calls.length).toBeGreaterThan(reads)
    expect(feedText()).toContain('Ссылка на Zoom не пришла')
    expect(feedText()).not.toContain('Переводится…')

    // Nothing is in flight now: no further reads.
    const settled = vi.mocked(supportApi.getAdminSupportMessages).mock.calls.length
    await vi.advanceTimersByTimeAsync(TICKET_POLL_MS * 3)
    expect(vi.mocked(supportApi.getAdminSupportMessages).mock.calls.length).toBe(settled)
  })

  it('asks again for a failed translation and polls for the result', async () => {
    server.feeds.t_free_0001 = [
      message('t_free_0001', {
        translation: { locale: 'ru', state: 'impossible', source_locale: 'en', retryable: true },
      }),
    ]
    vi.mocked(supportApi.retrySupportTranslation).mockResolvedValue({
      message_id: 'm_t_free_0001_1',
      locale: 'ru',
      attempt: 2,
      state: 'preparing',
    })
    await mount()

    await click(button('Повторить'))

    expect(supportApi.retrySupportTranslation).toHaveBeenCalledWith(
      't_free_0001',
      'm_t_free_0001_1',
    )
    expect(toastSuccess).toHaveBeenCalledWith('Перевод запрошен снова')
    expect(feedText()).toContain('Переводится…')
  })
})

describe('ConsoleSupportView: statistics', () => {
  function stats(total: number): SupportStats {
    return {
      period: { created_from: '', created_to: '' },
      categories: [
        { category: 'payments', tickets: 40, rated: 3, average: 5, share_4_5: 1 },
        { category: 'tech', tickets: 30, rated: 1, average: 3, share_4_5: 0 },
        { category: 'other', tickets: 10, rated: 0, average: null, share_4_5: null },
      ],
      total,
      spam: 6,
      resolvers: [{ admin: OLGA, rated: 4, average: 4.5, share_4_5: 0.75 }],
    }
  }
  const monthStart = () => DateTime.now().setZone('Europe/Berlin').startOf('month')

  it('shows the running month, its rating and its admins, without a comparison', async () => {
    vi.mocked(supportApi.getSupportStats).mockResolvedValue(stats(80))
    await mount('/console/support?tab=stats')

    const tile = (id: string) => byId(id)?.textContent?.replace(/\s+/g, ' ') ?? ''
    expect(tile('stats-tile-total')).toContain('80')
    expect(tile('stats-tile-total')).not.toContain('к прошлому месяцу')
    expect(tile('stats-tile-spam')).toContain('6')
    expect(tile('stats-tile-rating')).toContain('4.5')
    expect(tile('stats-tile-rating')).toContain('4 с оценкой')
    expect(tile('stats-tile-share')).toContain('75%')
    expect(host?.querySelectorAll('[data-testid="stats-category-row"]')).toHaveLength(3)
    expect(host?.textContent).toContain('50%')
    expect(host?.textContent).toContain('Olga')
    // The running month is not read against the month before at all.
    const asked = vi
      .mocked(supportApi.getSupportStats)
      .mock.calls.map(([from]) => DateTime.fromISO(from).toMillis())
    expect(asked).toEqual([monthStart().toMillis()])
  })

  it('compares a finished month with the month before it', async () => {
    const october = monthStart().minus({ months: 1 }).toMillis()
    vi.mocked(supportApi.getSupportStats).mockImplementation(async (from) =>
      DateTime.fromISO(from).toMillis() === october ? stats(80) : stats(68),
    )
    await mount('/console/support?tab=stats')

    await click(byId('stats-prev') as HTMLElement)

    expect(byId('stats-tile-total')?.textContent).toContain('80')
    expect(byId('stats-tile-total')?.textContent).toContain('+12 к прошлому месяцу')
  })

  it('gives the running month no comparison again after a step back and forward', async () => {
    vi.mocked(supportApi.getSupportStats).mockResolvedValue(stats(80))
    await mount('/console/support?tab=stats')
    await click(byId('stats-prev') as HTMLElement)
    expect(byId('stats-tile-total')?.textContent).toContain('к прошлому месяцу')

    await click(byId('stats-next') as HTMLElement)

    expect(byId('stats-tile-total')?.textContent).not.toContain('к прошлому месяцу')
  })

  it('steps back one month at a time and never past the current one', async () => {
    vi.mocked(supportApi.getSupportStats).mockResolvedValue(stats(80))
    await mount('/console/support?tab=stats')
    const next = byId('stats-next') as HTMLButtonElement
    expect(next.disabled).toBe(true)

    await click(byId('stats-prev') as HTMLElement)

    const asked = vi
      .mocked(supportApi.getSupportStats)
      .mock.calls.map(([from]) => DateTime.fromISO(from).toMillis())
    expect(asked).toContain(monthStart().minus({ months: 1 }).toMillis())
    expect((byId('stats-next') as HTMLButtonElement).disabled).toBe(false)
  })

  it('has no average and no share, only dashes, in a month nobody rated', async () => {
    vi.mocked(supportApi.getSupportStats).mockResolvedValue({
      ...stats(10),
      categories: [{ category: 'tech', tickets: 10, rated: 0, average: null, share_4_5: null }],
      resolvers: [],
    })
    await mount('/console/support?tab=stats')

    expect(byId('stats-tile-rating')?.textContent).toContain('—')
    expect(byId('stats-tile-share')?.textContent).toContain('—')
    expect(host?.textContent).toContain('Оценок за этот период пока нет')
  })
})

describe('ConsoleSupportView: narrow window', () => {
  it('shows the list alone until a ticket is picked, and the way back', async () => {
    env.single = true
    await mount()

    expect(rows()).toHaveLength(3)
    expect(byId('ticket-detail')).toBeNull()

    await rowClick(TOPIC_PAYMENT)
    expect(byId('ticket-detail')).not.toBeNull()
    expect(rows()).toHaveLength(0)

    await click(byId('tickets-back') as HTMLElement)
    expect(rows()).toHaveLength(3)
    expect(byId('ticket-detail')).toBeNull()
  })
})

describe('ConsoleSupportView: empty and failed reads', () => {
  it('says there are no tickets when the list is empty', async () => {
    server.tickets = {}
    await mount()

    expect(rows()).toHaveLength(0)
    expect(host?.textContent).toContain('Обращений нет')
    expect(host?.textContent).toContain('Обращение не выбрано')
  })

  it('shows the list error with a retry that asks again', async () => {
    vi.mocked(supportApi.listAdminTickets).mockRejectedValueOnce(new ApiResponseError(500, 'boom'))
    await mount()
    expect(rows()).toHaveLength(0)
    expect(host?.textContent).toContain('Не удалось загрузить')

    await click(button('Повторить'))

    expect(rows()).toHaveLength(3)
  })

  it('shows the ticket error with a retry that reads the ticket again', async () => {
    vi.mocked(supportApi.getAdminTicket).mockRejectedValueOnce(new ApiResponseError(500, 'boom'))
    await mount('/console/support?ticket=t_done_0004')
    expect(byId('ticket-detail')?.textContent).toContain('Ошибка загрузки')

    await click(button('Повторить'))

    expect(byId('ticket-detail')?.textContent).toContain('Вопрос по практикам')
  })

  it('shows the feed error with a retry while the ticket itself stays on screen', async () => {
    vi.mocked(supportApi.getAdminSupportMessages).mockRejectedValueOnce(
      new ApiResponseError(500, 'boom'),
    )
    await mount()
    expect(feedText()).toContain('Не удалось загрузить сообщения')
    expect(byId('ticket-detail')?.textContent).toContain(TOPIC_TECH)

    await click(button('Повторить'))

    expect(feedText()).toContain('The Zoom link did not arrive')
  })
})

describe('ConsoleSupportView: handover conflicts', () => {
  it('tells that the ticket changed hands meanwhile and reads it again', async () => {
    vi.mocked(supportApi.assignTicket).mockRejectedValueOnce(new ApiResponseError(409, 'moved'))
    await mount('/console/support?tab=mine&ticket=t_mine_0002')
    await click(button('Назначить'))
    const reads = vi.mocked(supportApi.getAdminTicket).mock.calls.length

    await click(document.body.querySelector('.v-menu-row') as HTMLElement)

    expect(toastError).toHaveBeenCalledWith('Обращение изменилось — проверьте, у кого оно')
    expect(vi.mocked(supportApi.getAdminTicket).mock.calls.length).toBeGreaterThan(reads)
  })

  it('keeps the roster open and reads it again when the chosen admin stopped being one', async () => {
    vi.mocked(supportApi.assignTicket).mockRejectedValueOnce(new ApiResponseError(422, 'no'))
    await mount('/console/support?tab=mine&ticket=t_mine_0002')

    await click(button('Назначить'))
    const reads = getUsersList.mock.calls.length
    await click(document.body.querySelector('.v-menu-row') as HTMLElement)

    expect(toastError).toHaveBeenCalledWith('Выбранный пользователь не администратор')
    expect(getUsersList.mock.calls.length).toBeGreaterThan(reads)
    expect(document.body.querySelector('.v-menu-row')).not.toBeNull()
  })

  it('tells that a release met a change and reads the ticket again', async () => {
    vi.mocked(supportApi.releaseTicket).mockRejectedValueOnce(new ApiResponseError(409, 'moved'))
    await mount('/console/support?tab=mine&ticket=t_mine_0002')

    const reads = vi.mocked(supportApi.getAdminTicket).mock.calls.length
    await click(button('Освободить'))

    expect(toastError).toHaveBeenCalledWith('Обращение изменилось — проверьте, у кого оно')
    expect(vi.mocked(supportApi.getAdminTicket).mock.calls.length).toBeGreaterThan(reads)
  })

  it('shows the not-found state, with no toast, when the spam bin emptied a ticket under a reopen', async () => {
    vi.mocked(supportApi.reopenTicket).mockRejectedValueOnce(new ApiResponseError(404, 'gone'))
    await mount('/console/support?tab=closed&ticket=t_done_0004')

    await click(button('Вернуть в работу'))

    expect(byId('ticket-detail')?.textContent).toContain('Обращение не найдено')
    expect(toastError).not.toHaveBeenCalled()
  })

  it('tells that a retry of a translation met nothing to retry, and reads the feed again', async () => {
    server.feeds.t_free_0001 = [
      message('t_free_0001', {
        translation: { locale: 'ru', state: 'impossible', source_locale: 'en', retryable: true },
      }),
    ]
    vi.mocked(supportApi.retrySupportTranslation).mockRejectedValueOnce(
      new ApiResponseError(409, 'running'),
    )
    await mount()
    const reads = vi.mocked(supportApi.getAdminSupportMessages).mock.calls.length

    await click(button('Повторить'))

    expect(toastError).toHaveBeenCalledWith('Повторять нечего — перевод уже идёт или готов')
    expect(vi.mocked(supportApi.getAdminSupportMessages).mock.calls.length).toBeGreaterThan(reads)
  })
})

describe('ConsoleSupportView: statistics failure', () => {
  it('shows the error with a retry that asks the month again', async () => {
    vi.mocked(supportApi.getSupportStats).mockRejectedValueOnce(new ApiResponseError(500, 'boom'))
    vi.mocked(supportApi.getSupportStats).mockResolvedValue({
      period: { created_from: '', created_to: '' },
      categories: [],
      total: 5,
      spam: 1,
      resolvers: [],
    })
    await mount('/console/support?tab=stats')
    expect(byId('stats-tile-total')).toBeNull()
    expect(host?.textContent).toContain('Не удалось загрузить')

    await click(button('Повторить'))

    expect(byId('stats-tile-total')?.textContent).toContain('5')
  })
})

// -----------------------------------------------------------------------------
// The list filters, the URL and the background refetch
// -----------------------------------------------------------------------------

function pill(key: 'category' | 'rating' | 'period'): HTMLElement {
  return must(byId(`filter-${key}`), `the ${key} pill`)
}
function choiceByText(label: string): HTMLElement {
  const found = Array.from(
    host?.querySelectorAll<HTMLElement>('[data-testid="filter-choices"] button') ?? [],
  ).find((b) => b.textContent?.trim() === label)
  return must(found, `the choice ${label}`)
}
function lastListQuery(): supportApi.AdminTicketQuery | undefined {
  return vi.mocked(supportApi.listAdminTickets).mock.lastCall?.[0]
}
function urlQuery(): Record<string, unknown> {
  return { ...router.currentRoute.value.query }
}

describe('ConsoleSupportView: filters', () => {
  it('filters by the complaints category, which asks for both complaint categories', async () => {
    await mount()

    await click(pill('category'))
    await click(choiceByText('Жалобы'))

    expect(lastListQuery()).toMatchObject({
      status: 'open',
      categories: ['complaint_master', 'complaint_user'],
    })
    expect(urlQuery().cat).toBe('complaints')
    expect(pill('category').textContent).toContain('Жалобы')
    expect(byId('filter-choices')).toBeNull()
  })

  it('filters by any of the chosen ratings and drops one when it is chosen again', async () => {
    await mount()

    await click(pill('rating'))
    await click(choiceByText('5 ★'))
    await click(choiceByText('4 ★'))
    await click(choiceByText('Без оценки'))
    expect(lastListQuery()?.ratings).toEqual(['4', '5', 'none'])
    expect(urlQuery().rating).toBe('4,5,none')
    expect(byId('filter-choices')).not.toBeNull()

    await click(choiceByText('5 ★'))
    expect(lastListQuery()?.ratings).toEqual(['4', 'none'])
  })

  it('filters by a period of whole days in the admin timezone', async () => {
    await mount()

    await click(pill('period'))
    await click(choiceByText('7 дней'))

    const { createdFrom, createdTo } = lastListQuery() ?? {}
    const days = DateTime.fromISO(createdTo ?? '').diff(DateTime.fromISO(createdFrom ?? ''), 'days')
    expect(Math.round(days.days)).toBe(7)
    expect(createdFrom).toMatch(/T00:00:00\.000[+-]\d\d:\d\d$/)
    expect(urlQuery().period).toBe('week')
  })

  it('resets a filter with "all"', async () => {
    await mount('/console/support?cat=payments')
    expect(lastListQuery()).toMatchObject({ categories: ['payments'] })

    await click(pill('category'))
    await click(choiceByText('Все'))

    expect(lastListQuery()).toEqual({ status: 'open', limit: 20 })
    expect(urlQuery().cat).toBeUndefined()
  })

  it('reads the filters from the URL on load and ignores values it does not know', async () => {
    await mount('/console/support?cat=payments&rating=5&period=today')
    expect(lastListQuery()).toMatchObject({
      status: 'open',
      categories: ['payments'],
      ratings: ['5'],
    })
    expect(lastListQuery()?.createdFrom).toBeDefined()

    app?.unmount()
    host?.remove()
    vi.mocked(supportApi.listAdminTickets).mockClear()
    await mount('/console/support?cat=bogus&rating=9&period=year')
    expect(lastListQuery()).toEqual({ status: 'open', limit: 20 })
  })

  it('lets go of the open ticket when a filter changes, and keeps the filters across the tabs', async () => {
    await mount('/console/support?ticket=t_mine_0002&cat=payments')

    await click(pill('rating'))
    await click(choiceByText('5 ★'))
    expect(urlQuery()).toMatchObject({ cat: 'payments', rating: '5' })
    expect(urlQuery().ticket).toBeUndefined()

    await click(
      must(
        Array.from(host?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []).find((t) =>
          t.textContent?.includes('Закрытые'),
        ),
      ),
    )
    expect(urlQuery()).toMatchObject({ tab: 'closed', cat: 'payments', rating: '5' })
  })

  it('says nothing matches the filters, and closes the choices on Escape', async () => {
    vi.mocked(supportApi.listAdminTickets).mockResolvedValue({ tickets: [], next_cursor: null })
    await mount('/console/support?cat=payments')
    expect(host?.textContent).toContain('По выбранным фильтрам ничего не найдено')

    await click(pill('period'))
    expect(byId('filter-choices')).not.toBeNull()
    byId('ticket-filters')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    await flush()

    expect(byId('filter-choices')).toBeNull()
  })
})

describe('ConsoleSupportView: background refetch', () => {
  /** Ask a held answer again, as a focus return does; a failure is the screen's to tell. */
  async function refetch(key: readonly unknown[]): Promise<void> {
    useQueryCache()
      .invalidateQueries({ key: key as never })
      .catch(() => {})
    await flush()
  }
  function gate(): { wait: Promise<void>; open: () => void } {
    let open = () => {}
    const wait = new Promise<void>((resolve) => {
      open = resolve
    })
    return { wait, open }
  }

  it('keeps the list and the open ticket on screen while the list refetches, then takes the news', async () => {
    await mount()
    const held = gate()
    const real = must(vi.mocked(supportApi.listAdminTickets).getMockImplementation())
    vi.mocked(supportApi.listAdminTickets).mockImplementationOnce(async (query) => {
      await held.wait
      return real(query)
    })
    server.tickets.t_new_0006 = { ...T_FREE, id: 't_new_0006', topic: 'withdrawal' }

    await refetch(adminKeys.supportTicketsAll())

    expect(rows()).toHaveLength(3)
    expect(host?.querySelector('.v-loader')).toBeNull()
    expect(feedText()).toContain('The Zoom link did not arrive')
    held.open()
    await flush()
    expect(rows()).toHaveLength(4)
  })

  it('keeps the feed and the reply draft on screen while the feed refetches', async () => {
    await mount('/console/support?tab=mine')
    typeInto(composer(), 'Half a reply')
    await flush()
    const held = gate()
    const real = must(vi.mocked(supportApi.getAdminSupportMessages).getMockImplementation())
    vi.mocked(supportApi.getAdminSupportMessages).mockImplementationOnce(async (...args) => {
      await held.wait
      return real(...args)
    })

    await refetch(adminKeys.supportMessages('t_mine_0002'))

    expect(feedText()).toContain('The payment failed twice')
    expect(byId('ticket-feed')?.querySelector('.v-loader')).toBeNull()
    expect(composer()?.value).toBe('Half a reply')
    held.open()
    await flush()
    expect(composer()?.value).toBe('Half a reply')
  })

  it('tells a failed list refetch once and keeps the list, until an answer arrives', async () => {
    await mount()
    const real = must(vi.mocked(supportApi.listAdminTickets).getMockImplementation())
    vi.mocked(supportApi.listAdminTickets).mockImplementation(() =>
      Promise.reject(new Error('down')),
    )

    await refetch(adminKeys.supportTicketsAll())
    await refetch(adminKeys.supportTicketsAll())

    expect(rows()).toHaveLength(3)
    expect(toastError).toHaveBeenCalledTimes(1)

    vi.mocked(supportApi.listAdminTickets).mockImplementation(real)
    await refetch(adminKeys.supportTicketsAll())
    vi.mocked(supportApi.listAdminTickets).mockImplementation(() =>
      Promise.reject(new Error('down again')),
    )
    await refetch(adminKeys.supportTicketsAll())
    expect(toastError).toHaveBeenCalledTimes(2)
  })

  it('tells a failed feed refetch once and keeps the feed and the ticket', async () => {
    await mount()
    vi.mocked(supportApi.getAdminSupportMessages).mockImplementation(() =>
      Promise.reject(new Error('down')),
    )

    await refetch(adminKeys.supportMessages('t_free_0001'))
    await refetch(adminKeys.supportMessages('t_free_0001'))

    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastError).toHaveBeenCalledWith('Не удалось загрузить сообщения')
    expect(feedText()).toContain('The Zoom link did not arrive')
    expect(byId('ticket-detail')?.textContent).toContain(TOPIC_TECH)
  })

  it('keeps the not-found state when the missing ticket is read again in the background', async () => {
    await mount('/console/support?ticket=t_missing')
    expect(byId('ticket-detail')?.textContent).toContain('Обращение не найдено')

    await refetch(adminKeys.supportTicket('t_missing'))

    expect(byId('ticket-detail')?.textContent).toContain('Обращение не найдено')
    expect(byId('ticket-detail')?.querySelector('.v-loader')).toBeNull()
  })
})
