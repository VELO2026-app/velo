// =============================================================================
// VELO Frontend -- AdminSupportView Screen Tests (PROMPT №713; tickets FE-100)
// =============================================================================
//
// PATTERN: list-with-ladder + cursor pagination, mirrors AdminReportsView's
// own test shape (no store fetch, no filter modal here -- filters are
// delivery B). Seams mocked: @/api/support (auto-mock, vi.mocked per call) and
// @/stores/auth (only .user.id matters, for the "У меня" claim line).
//
// FE-100: the list is TICKETS (GET /support/tickets) -- one row per appeal:
// who wrote, the topic labelled from its CODE, the date of the appeal, who
// took it, one status badge. No status filter is sent: spam stays out by the
// backend's default.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AdminSupportView from '@/views/admin/AdminSupportView.vue'
import * as supportApi from '@/api/support'
import type { AdminSupportTicket } from '@/api/support'

vi.mock('@/api/support')

const back = vi.fn()
const push = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ back, push }),
}))

const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, info: vi.fn(), success: vi.fn() }),
}))

const authState: { user: { id: string } | null } = { user: { id: 'admin_me' } }
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    get user() {
      return authState.user
    },
  }),
}))

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function ticket(overrides: Partial<AdminSupportTicket> = {}): AdminSupportTicket {
  return {
    id: 't_1',
    topic: 'payment',
    category: 'payments',
    status: 'open',
    created_at: new Date(Date.now() - 60 * 60000).toISOString(),
    status_changed_at: new Date(Date.now() - 60 * 60000).toISOString(),
    opener: { user_id: 'u_1', name: 'Алекс', avatar_url: null },
    claimed_by: null,
    history_thread_id: null,
    ...overrides,
  }
}

function page(tickets: AdminSupportTicket[], next_cursor: string | null = null) {
  return { tickets, next_cursor }
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(AdminSupportView).use(createTestI18n())
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

function cards(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('.scard') ?? [])
}
function cardByOpener(name: string): HTMLElement | undefined {
  return cards().find((c) => c.querySelector('.scard__title')?.textContent?.trim() === name)
}
function retryBtn(): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-btn') ?? []).find(
    (b) => b.textContent?.trim() === 'Повторить',
  )
}
function moreBtn(): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-btn') ?? []).find(
    (b) => b.textContent?.trim() === 'Показать ещё',
  )
}

beforeEach(() => {
  back.mockReset()
  push.mockReset()
  toastError.mockReset()
  authState.user = { id: 'admin_me' }
  vi.mocked(supportApi.listAdminTickets)
    .mockReset()
    .mockResolvedValue(page([ticket()]))
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.restoreAllMocks()
})

describe('AdminSupportView', () => {
  // Was: the topic was comms' free-text `title`. BE-162 stores a CODE; the
  // label comes from the one front table (supportTopics).
  it('renders the opener name and the topic LABELLED from its code', async () => {
    vi.mocked(supportApi.listAdminTickets).mockResolvedValue(
      page([
        ticket({
          opener: { user_id: 'u_1', name: 'Дана', avatar_url: null },
          topic: 'complaint_master',
        }),
      ]),
    )
    mount()
    await flush()

    const card = cardByOpener('Дана')
    expect(card).toBeDefined()
    expect(card?.querySelector('.scard__topic')?.textContent?.trim()).toBe('Жалоба на мастера')
  })

  it('labels the master-only complaint code too («Жалоба на пользователя»)', async () => {
    vi.mocked(supportApi.listAdminTickets).mockResolvedValue(
      page([ticket({ topic: 'complaint_user' })]),
    )
    mount()
    await flush()

    expect(cardByOpener('Алекс')?.querySelector('.scard__topic')?.textContent?.trim()).toBe(
      'Жалоба на пользователя',
    )
  })

  it('falls back to "Пользователь" when opener is null', async () => {
    vi.mocked(supportApi.listAdminTickets).mockResolvedValue(page([ticket({ opener: null })]))
    mount()
    await flush()

    expect(cardByOpener('Пользователь')).toBeDefined()
  })

  it('falls back to "Пользователь" when the opener has no name', async () => {
    vi.mocked(supportApi.listAdminTickets).mockResolvedValue(
      page([ticket({ opener: { user_id: 'u_1', name: null, avatar_url: null } })]),
    )
    mount()
    await flush()

    expect(cardByOpener('Пользователь')).toBeDefined()
  })

  it('asks for the list WITHOUT a status filter -- spam stays out by default', async () => {
    mount()
    await flush()

    expect(supportApi.listAdminTickets).toHaveBeenCalledWith(20)
  })

  // Was: one triage badge from comms' `assignee` / `status` (resolved,
  // closed). BE-162: the status is ours (five values) and the taker is
  // velo's `claimed_by` -- two facts, a badge and a line.
  describe('status badge -- one per row, five statuses', () => {
    it.each([
      ['open', 'Открыта'],
      ['resolved', 'Решена'],
      ['rejected', 'Отклонена'],
      ['duplicate', 'Дубликат'],
      ['spam', 'Спам'],
    ] as const)('status "%s" -> «%s»', async (status, label) => {
      vi.mocked(supportApi.listAdminTickets).mockResolvedValue(page([ticket({ status })]))
      mount()
      await flush()

      expect(cardByOpener('Алекс')?.querySelector('.v-badge')?.textContent?.trim()).toBe(label)
    })
  })

  describe('who took it', () => {
    function claimLine(): string | undefined {
      const subs = cardByOpener('Алекс')?.querySelectorAll('.scard__sub')
      return subs?.[subs.length - 1]?.textContent?.trim()
    }

    it('nobody -> «Не взято»', async () => {
      mount()
      await flush()
      expect(claimLine()).toBe('Не взято')
    })

    it('the viewing admin -> «У меня»', async () => {
      vi.mocked(supportApi.listAdminTickets).mockResolvedValue(
        page([ticket({ claimed_by: { user_id: 'admin_me', name: 'Я', avatar_url: null } })]),
      )
      mount()
      await flush()
      expect(claimLine()).toBe('У меня')
    })

    it('another admin -> their name', async () => {
      vi.mocked(supportApi.listAdminTickets).mockResolvedValue(
        page([ticket({ claimed_by: { user_id: 'admin_2', name: 'Ольга', avatar_url: null } })]),
      )
      mount()
      await flush()
      expect(claimLine()).toBe('Взял: Ольга')
    })

    it('another admin without a name -> «Администратор»', async () => {
      vi.mocked(supportApi.listAdminTickets).mockResolvedValue(
        page([ticket({ claimed_by: { user_id: 'admin_2', name: null, avatar_url: null } })]),
      )
      mount()
      await flush()
      expect(claimLine()).toBe('Взял: Администратор')
    })
  })

  it('a card click navigates to the detail route with a deep-cloned state hand-off', async () => {
    const t = ticket({ id: 't_click' })
    vi.mocked(supportApi.listAdminTickets).mockResolvedValue(page([t]))
    mount()
    await flush()

    cardByOpener('Алекс')?.click()
    await flush()

    expect(push).toHaveBeenCalledWith({
      name: 'admin-support-detail',
      params: { id: 't_click' },
      state: { ticket: JSON.parse(JSON.stringify(t)) },
    })
  })

  it('shows the retry empty-state on a load failure, and retry re-fetches', async () => {
    vi.mocked(supportApi.listAdminTickets).mockRejectedValueOnce(new Error('boom'))
    mount()
    await flush()

    expect(retryBtn()).toBeDefined()
    expect(toastError).toHaveBeenCalled()

    vi.mocked(supportApi.listAdminTickets).mockResolvedValue(page([ticket()]))
    retryBtn()?.click()
    await flush()

    expect(cards()).toHaveLength(1)
  })

  it('shows the empty state when there are no tickets at all', async () => {
    vi.mocked(supportApi.listAdminTickets).mockResolvedValue(page([]))
    mount()
    await flush()

    expect(host?.textContent).toContain('Обращений нет')
  })

  it('"Показать ещё" only renders when next_cursor is set, and paginates on click', async () => {
    vi.mocked(supportApi.listAdminTickets).mockResolvedValueOnce(
      page(
        [ticket({ id: 't_1', opener: { user_id: 'u_1', name: 'Первый', avatar_url: null } })],
        'cursor-2',
      ),
    )
    mount()
    await flush()

    expect(moreBtn()).toBeDefined()

    vi.mocked(supportApi.listAdminTickets).mockResolvedValueOnce(
      page(
        [ticket({ id: 't_2', opener: { user_id: 'u_2', name: 'Второй', avatar_url: null } })],
        null,
      ),
    )
    moreBtn()?.click()
    await flush()

    expect(supportApi.listAdminTickets).toHaveBeenLastCalledWith(20, 'cursor-2')
    expect(cardByOpener('Первый')).toBeDefined()
    expect(cardByOpener('Второй')).toBeDefined()
    expect(moreBtn()).toBeUndefined()
  })

  it('two «Показать ещё» taps before the page lands ask for ONE page', async () => {
    vi.mocked(supportApi.listAdminTickets).mockResolvedValueOnce(page([ticket()], 'cursor-2'))
    mount()
    await flush()

    let resolvePage!: (v: Awaited<ReturnType<typeof supportApi.listAdminTickets>>) => void
    vi.mocked(supportApi.listAdminTickets).mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePage = resolve
      }),
    )
    // Both taps land before a re-render: the button is not disabled yet, so
    // only the in-flight guard in loadMore can keep this to one call.
    moreBtn()?.click()
    moreBtn()?.click()
    await flush()

    expect(supportApi.listAdminTickets).toHaveBeenCalledTimes(2) // initial + ONE page
    resolvePage(page([ticket({ id: 't_2' })], null))
    await flush()
  })
})
