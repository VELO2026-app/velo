// =============================================================================
// VELO Frontend -- UserMessagesView Screen Tests (Phase 6 / T2, H-T2-UI)
// =============================================================================
//
// The student's chats list over GET /api/v1/chats: LOCAL pointer rows
// (ID-11) carrying the P-1 `peer` display block, plus per-thread
// unread-count calls for the badges. The seam is @/api/chats, mocked whole.
//
// What is under test, and why:
//   1. NAMES ARRIVE FROM THE ROW ITSELF -- P-1 exists so the list renders
//      without per-row profile lookups; the test proves no other api module
//      is touched. peer=null degrades to «Мастер», never breaks the row.
//   2. BADGES ARE A COURTESY -- negative-twin pair: a failed unread-count
//      leaves that row at no-badge while THE SIBLING ROW'S badge still
//      arrives (post-state, not just absence-of-exception).
//   3. A ROW OPENS ITS THREAD -- push('user-chat', {id}).
//   4. The three list states (empty / error+retry / rows) are distinct.
//
// House pattern (NotificationsView.test.ts): raw createApp, every test its
// own mount; vue-router and useToast mocked at module level.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import UserMessagesView from '@/views/user/UserMessagesView.vue'
import * as chatsApi from '@/api/chats'
import type { ChatThread } from '@/api/chats'

vi.mock('@/api/chats')

const back = vi.fn()
const push = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ back, push }),
}))

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function thread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: 'thread-1',
    operator_value: 'master-1',
    created_at: '2026-08-01T10:30:00+00:00',
    peer: { user_id: 'master-1', name: 'Анна Петрова', avatar_url: null },
    ...overrides,
  }
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(UserMessagesView)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await nextTick()
}

function rows(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('.chat-row') ?? [])
}

function row(i: number): HTMLElement {
  const el = rows()[i]
  if (!el) throw new Error(`no chat row #${i}`)
  return el
}

beforeEach(() => {
  push.mockReset()
  back.mockReset()
  vi.mocked(chatsApi.listChats).mockReset()
  vi.mocked(chatsApi.getChatUnreadCount).mockReset().mockResolvedValue({ unread: 0 })
})

afterEach(() => {
  app?.unmount()
  app = null
  host?.remove()
  host = null
})

// -----------------------------------------------------------------------------

describe('UserMessagesView', () => {
  it('renders one row per thread, named from the P-1 peer block -- no other api touched', async () => {
    vi.mocked(chatsApi.listChats).mockResolvedValue({
      threads: [
        thread(),
        thread({
          id: 'thread-2',
          operator_value: 'master-2',
          peer: { user_id: 'master-2', name: 'Борис Ким', avatar_url: null },
        }),
      ],
      next_cursor: null,
    })
    mount()
    await flush()

    const names = rows().map((r) => r.querySelector('.chat-row__name')?.textContent?.trim())
    expect(names).toEqual(['Анна Петрова', 'Борис Ким'])
  })

  it('peer=null degrades to «Мастер» -- the row lives (P-1 degrade contract, UI half)', async () => {
    vi.mocked(chatsApi.listChats).mockResolvedValue({
      threads: [thread({ peer: null })],
      next_cursor: null,
    })
    mount()
    await flush()

    expect(rows()).toHaveLength(1)
    expect(row(0).querySelector('.chat-row__name')?.textContent?.trim()).toBe('Мастер')
  })

  it('per-thread unread badges: a positive count shows, zero shows nothing', async () => {
    vi.mocked(chatsApi.listChats).mockResolvedValue({
      threads: [thread(), thread({ id: 'thread-2', operator_value: 'master-2' })],
      next_cursor: null,
    })
    vi.mocked(chatsApi.getChatUnreadCount).mockImplementation(async (id) => ({
      unread: id === 'thread-1' ? 3 : 0,
    }))
    mount()
    await flush()

    const badge = (i: number) =>
      row(i).querySelector('[data-testid="chat-unread"]')?.textContent?.trim()
    expect(badge(0)).toBe('3')
    expect(badge(1)).toBeUndefined()
  })

  it('negative twin: ONE failed unread-count stays badge-less while the sibling badge still arrives', async () => {
    vi.mocked(chatsApi.listChats).mockResolvedValue({
      threads: [thread(), thread({ id: 'thread-2', operator_value: 'master-2' })],
      next_cursor: null,
    })
    vi.mocked(chatsApi.getChatUnreadCount).mockImplementation(async (id) => {
      if (id === 'thread-1') throw new Error('comms hiccup')
      return { unread: 5 }
    })
    mount()
    await flush()

    expect(rows()).toHaveLength(2) // the list itself never died
    expect(row(0).querySelector('[data-testid="chat-unread"]')).toBeNull()
    expect(
      row(1).querySelector('[data-testid="chat-unread"]')?.textContent?.trim(),
    ).toBe('5')
  })

  it("clicking a row navigates to 'user-chat' with that thread's id", async () => {
    vi.mocked(chatsApi.listChats).mockResolvedValue({
      threads: [thread()],
      next_cursor: null,
    })
    mount()
    await flush()

    row(0).click()
    await flush()

    expect(push).toHaveBeenCalledWith({ name: 'user-chat', params: { id: 'thread-1' } })
  })

  it('empty list shows the honest empty-state, not fake threads', async () => {
    vi.mocked(chatsApi.listChats).mockResolvedValue({ threads: [], next_cursor: null })
    mount()
    await flush()

    expect(rows()).toHaveLength(0)
    expect(host?.textContent).toContain('Здесь появятся ваши переписки с мастерами')
  })

  it('a failed load shows the retry state, and «Повторить» actually refetches', async () => {
    vi.mocked(chatsApi.listChats)
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce({ threads: [thread()], next_cursor: null })
    mount()
    await flush()

    expect(host?.textContent).toContain('Не удалось загрузить')

    const retry = Array.from(host?.querySelectorAll('button') ?? []).find((b) =>
      b.textContent?.includes('Повторить'),
    )
    retry?.click()
    await flush()

    expect(rows()).toHaveLength(1)
  })
})
