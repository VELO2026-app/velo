// =============================================================================
// VELO Frontend -- AdminSupportView Screen Tests (PROMPT №713)
// =============================================================================
//
// PATTERN: list-with-ladder + cursor pagination, mirrors AdminReportsView's
// own test shape (no store fetch, no filter modal here -- support has
// neither). Seams mocked: @/api/support (auto-mock, vi.mocked per call) and
// @/stores/auth (only .user.id matters, for the triage-badge "У меня" case).
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AdminSupportView from '@/views/admin/AdminSupportView.vue'
import * as supportApi from '@/api/support'
import type { SupportThread } from '@/api/support'

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

function thread(overrides: Partial<SupportThread> = {}): SupportThread {
  return {
    id: 't_1',
    client: 'u_1',
    operator_kind: 'section',
    operator_value: 'sec_1',
    assignee: null,
    kind: 'dm',
    status: 'open',
    subject_type: null,
    subject_id: null,
    title: null,
    priority: null,
    last_message_at: new Date(Date.now() - 5 * 60000).toISOString(),
    created_at: new Date(Date.now() - 60 * 60000).toISOString(),
    opener: { user_id: 'u_1', name: 'Алекс', avatar_url: null },
    ...overrides,
  }
}

function page(threads: SupportThread[], next_cursor: string | null = null) {
  return { threads, next_cursor }
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(AdminSupportView)
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
  vi.mocked(supportApi.listAdminSupportThreads)
    .mockReset()
    .mockResolvedValue(page([thread()]))
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.restoreAllMocks()
})

describe('AdminSupportView', () => {
  it('renders the opener name and the topic (title) on a card', async () => {
    vi.mocked(supportApi.listAdminSupportThreads).mockResolvedValue(
      page([
        thread({
          opener: { user_id: 'u_1', name: 'Дана', avatar_url: null },
          title: 'Жалоба на мастера',
        }),
      ]),
    )
    mount()
    await flush()

    const card = cardByOpener('Дана')
    expect(card).toBeDefined()
    expect(card?.querySelector('.scard__topic')?.textContent?.trim()).toBe('Жалоба на мастера')
  })

  it('falls back to "Пользователь" when opener is null', async () => {
    vi.mocked(supportApi.listAdminSupportThreads).mockResolvedValue(
      page([thread({ opener: null })]),
    )
    mount()
    await flush()

    expect(cardByOpener('Пользователь')).toBeDefined()
  })

  it('does not render a topic line when title is null', async () => {
    vi.mocked(supportApi.listAdminSupportThreads).mockResolvedValue(
      page([thread({ title: null, opener: { user_id: 'u_1', name: 'Ева', avatar_url: null } })]),
    )
    mount()
    await flush()

    expect(cardByOpener('Ева')?.querySelector('.scard__topic')).toBeNull()
  })

  describe('triage badge -- one per row, no unread count', () => {
    it('unclaimed -> "Не взято"', async () => {
      vi.mocked(supportApi.listAdminSupportThreads).mockResolvedValue(
        page([thread({ assignee: null, status: 'open' })]),
      )
      mount()
      await flush()
      expect(host?.textContent).toContain('Не взято')
    })

    it('claimed by the viewing admin -> "У меня"', async () => {
      vi.mocked(supportApi.listAdminSupportThreads).mockResolvedValue(
        page([thread({ assignee: 'admin_me', status: 'open' })]),
      )
      mount()
      await flush()
      expect(host?.textContent).toContain('У меня')
    })

    it('claimed by a DIFFERENT admin -> "Занято"', async () => {
      vi.mocked(supportApi.listAdminSupportThreads).mockResolvedValue(
        page([thread({ assignee: 'someone_else', status: 'open' })]),
      )
      mount()
      await flush()
      expect(host?.textContent).toContain('Занято')
    })

    it('resolved overrides assignee state -> "Решено"', async () => {
      vi.mocked(supportApi.listAdminSupportThreads).mockResolvedValue(
        page([thread({ assignee: 'admin_me', status: 'resolved' })]),
      )
      mount()
      await flush()
      expect(host?.textContent).toContain('Решено')
      expect(host?.textContent).not.toContain('У меня')
    })
  })

  it('a card click navigates to the detail route with a deep-cloned state hand-off', async () => {
    const t = thread({ id: 't_click' })
    vi.mocked(supportApi.listAdminSupportThreads).mockResolvedValue(page([t]))
    mount()
    await flush()

    cardByOpener('Алекс')?.click()
    await flush()

    expect(push).toHaveBeenCalledWith({
      name: 'admin-support-detail',
      params: { id: 't_click' },
      state: { thread: JSON.parse(JSON.stringify(t)) },
    })
  })

  it('shows the retry empty-state on a load failure, and retry re-fetches', async () => {
    vi.mocked(supportApi.listAdminSupportThreads).mockRejectedValueOnce(new Error('boom'))
    mount()
    await flush()

    expect(retryBtn()).toBeDefined()
    expect(toastError).toHaveBeenCalled()

    vi.mocked(supportApi.listAdminSupportThreads).mockResolvedValue(page([thread()]))
    retryBtn()?.click()
    await flush()

    expect(cards()).toHaveLength(1)
  })

  it('shows the empty state when there are no threads at all', async () => {
    vi.mocked(supportApi.listAdminSupportThreads).mockResolvedValue(page([]))
    mount()
    await flush()

    expect(host?.textContent).toContain('Обращений нет')
  })

  it('"Показать ещё" only renders when next_cursor is set, and paginates on click', async () => {
    vi.mocked(supportApi.listAdminSupportThreads).mockResolvedValueOnce(
      page(
        [thread({ id: 't_1', opener: { user_id: 'u_1', name: 'Первый', avatar_url: null } })],
        'cursor-2',
      ),
    )
    mount()
    await flush()

    expect(moreBtn()).toBeDefined()

    vi.mocked(supportApi.listAdminSupportThreads).mockResolvedValueOnce(
      page(
        [thread({ id: 't_2', opener: { user_id: 'u_2', name: 'Второй', avatar_url: null } })],
        null,
      ),
    )
    moreBtn()?.click()
    await flush()

    expect(supportApi.listAdminSupportThreads).toHaveBeenLastCalledWith(20, 'cursor-2')
    expect(cardByOpener('Первый')).toBeDefined()
    expect(cardByOpener('Второй')).toBeDefined()
    expect(moreBtn()).toBeUndefined()
  })
})
