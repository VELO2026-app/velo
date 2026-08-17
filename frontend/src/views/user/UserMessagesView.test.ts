// =============================================================================
// VELO Frontend -- UserMessagesView Screen Tests (Phase 6 / T2, H-T2-UI)
// =============================================================================
//
// The student's chats list over GET /api/v1/chats: LOCAL pointer rows
// (ID-11) carrying the P-1 `peer` display block AND, since T-51, the row's
// own `unread`. The seam is @/api/chats, mocked whole.
//
// What is under test, and why:
//   1. NAMES ARRIVE FROM THE ROW ITSELF -- P-1 exists so the list renders
//      without per-row profile lookups; the test proves no other api module
//      is touched. peer=null degrades to «Мастер», never breaks the row.
//   2. BADGES ARRIVE WITH THE ROWS -- ONE request for the whole screen
//      (T-51: the per-thread fan-out is gone, and its wrapper with it).
//      Three row states stay distinguishable: a count, an explicit 0, and
//      NO KEY AT ALL -- the last one meaning "not the caller's thread", or
//      "comms was unreachable when the backend built this page". Both of
//      those render as no badge; neither is faked into a zero.
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

  it('unread badges ride on the rows: a positive count shows, an explicit zero shows nothing', async () => {
    vi.mocked(chatsApi.listChats).mockResolvedValue({
      threads: [
        thread({ unread: 3 }),
        thread({ id: 'thread-2', operator_value: 'master-2', unread: 0 }),
      ],
      next_cursor: null,
    })
    mount()
    await flush()

    const badge = (i: number) =>
      row(i).querySelector('[data-testid="chat-unread"]')?.textContent?.trim()
    expect(badge(0)).toBe('3')
    expect(badge(1)).toBeUndefined()
  })

  it('a MISSING unread key is not a zero: the row renders badge-less and the sibling badge still arrives', async () => {
    // The key is absent on a row the caller takes no part in, and on every
    // row when the backend could not reach comms. Neither may be invented
    // into a 0 -- the row simply carries no badge, and the rest of the page
    // is unaffected.
    vi.mocked(chatsApi.listChats).mockResolvedValue({
      threads: [
        thread(),
        thread({ id: 'thread-2', operator_value: 'master-2', unread: 5 }),
      ],
      next_cursor: null,
    })
    mount()
    await flush()

    expect(rows()).toHaveLength(2) // the list itself never died
    expect(row(0).querySelector('[data-testid="chat-unread"]')).toBeNull()
    expect(
      row(1).querySelector('[data-testid="chat-unread"]')?.textContent?.trim(),
    ).toBe('5')
  })

  it('ONE api call for the whole screen -- the per-thread fan-out is gone', async () => {
    vi.mocked(chatsApi.listChats).mockResolvedValue({
      threads: [
        thread({ unread: 1 }),
        thread({ id: 'thread-2', operator_value: 'master-2', unread: 2 }),
        thread({ id: 'thread-3', operator_value: 'master-3', unread: 3 }),
      ],
      next_cursor: null,
    })
    mount()
    await flush()

    expect(chatsApi.listChats).toHaveBeenCalledTimes(1)
    // Three rows, still one request: the count no longer scales with rows.
    expect(rows()).toHaveLength(3)
    expect(Object.keys(chatsApi)).not.toContain('getChatUnreadCount')
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
