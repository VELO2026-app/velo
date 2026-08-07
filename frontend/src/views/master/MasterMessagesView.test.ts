// =============================================================================
// VELO Frontend -- MasterMessagesView Screen Tests (Phase 6 / T2, H-T2-UI)
// =============================================================================
//
// The master's chats list: the comms operator-scoped list passed through
// GET /api/v1/chats (full _thread_out shape with `client`), each thread
// enriched with the P-1 `peer` block by the proxy. The chat is a pre-sale
// channel, so a peer may be nobody's student -- the enrichment is the ONLY
// name source, and a null peer must degrade to «Ученик», never break.
//
// Sibling of UserMessagesView.test.ts (same seam, same states); what is
// DIFFERENT here and therefore tested here: the comms thread shape renders
// as-is, and the fallback wording is the master's («Ученик», not «Мастер»).
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import MasterMessagesView from '@/views/master/MasterMessagesView.vue'
import * as chatsApi from '@/api/chats'
import type { ChatThread } from '@/api/chats'

vi.mock('@/api/chats')

const back = vi.fn()
const push = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ back, push }),
}))

// -----------------------------------------------------------------------------
// Fixtures: the comms _thread_out shape as the proxy forwards it (P-1 added)
// -----------------------------------------------------------------------------

function commsThread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: 'thread-1',
    client: 'student-1',
    operator_value: 'master-me',
    kind: 'dm',
    status: 'open',
    last_message_at: '2026-08-07T09:00:00+00:00',
    created_at: '2026-08-01T10:30:00+00:00',
    peer: { user_id: 'student-1', name: 'Вера Соколова', avatar_url: null },
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
  app = createApp(MasterMessagesView)
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

describe('MasterMessagesView', () => {
  it('renders the comms-shaped list with P-1 peer names, in comms order (activity-ordered upstream)', async () => {
    vi.mocked(chatsApi.listChats).mockResolvedValue({
      threads: [
        commsThread(),
        commsThread({
          id: 'thread-2',
          client: 'student-2',
          peer: { user_id: 'student-2', name: 'Глеб Орлов', avatar_url: null },
        }),
      ],
      next_cursor: null,
    })
    mount()
    await flush()

    const names = rows().map((r) => r.querySelector('.chat-row__name')?.textContent?.trim())
    expect(names).toEqual(['Вера Соколова', 'Глеб Орлов'])
  })

  it('P-1 degrade, UI half: peer=null (a client velo could not resolve) renders «Ученик», the row lives', async () => {
    vi.mocked(chatsApi.listChats).mockResolvedValue({
      threads: [commsThread({ peer: null })],
      next_cursor: null,
    })
    mount()
    await flush()

    expect(rows()).toHaveLength(1)
    expect(row(0).querySelector('.chat-row__name')?.textContent?.trim()).toBe('Ученик')
  })

  it('unread badge renders per thread', async () => {
    vi.mocked(chatsApi.listChats).mockResolvedValue({
      threads: [commsThread()],
      next_cursor: null,
    })
    vi.mocked(chatsApi.getChatUnreadCount).mockResolvedValue({ unread: 2 })
    mount()
    await flush()

    expect(
      row(0).querySelector('[data-testid="chat-unread"]')?.textContent?.trim(),
    ).toBe('2')
  })

  it("clicking a row navigates to 'master-chat' with that thread's id", async () => {
    vi.mocked(chatsApi.listChats).mockResolvedValue({
      threads: [commsThread()],
      next_cursor: null,
    })
    mount()
    await flush()

    row(0).click()
    await flush()

    expect(push).toHaveBeenCalledWith({ name: 'master-chat', params: { id: 'thread-1' } })
  })

  it('empty list shows the honest empty-state', async () => {
    vi.mocked(chatsApi.listChats).mockResolvedValue({ threads: [], next_cursor: null })
    mount()
    await flush()

    expect(rows()).toHaveLength(0)
    expect(host?.textContent).toContain('Здесь появятся переписки с учениками')
  })
})
