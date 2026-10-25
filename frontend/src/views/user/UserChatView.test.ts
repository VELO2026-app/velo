// =============================================================================
// VELO Frontend -- UserChatView Screen Tests (FE-104, item 3)
// =============================================================================
//
// The view resolves WHICH row a route id opens (one GET /api/v1/chats), then
// hands over to ChatThreadScreen. BE-162 made a person's support threads --
// a ticket each, plus the pre-ticket history -- ONE row: `id` is the newest
// thread, `thread_ids` all of them. A push (`open_thread__<id>`) and the
// "translation unavailable" notice name the thread the message is IN, which
// need not be the newest -- so the row is found by `id` OR by `thread_ids`
// (api/chats.ts::chatRowFor, used here REAL; only listChats is mocked).
//
// ChatThreadScreen is stubbed: what this file asserts is the hand-over --
// which id, and whether the screen is told it is support.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import UserChatView from '@/views/user/UserChatView.vue'
import type { ChatThread } from '@/api/chats'

const back = vi.fn()
const routeParams: { id: string } = { id: '' }
vi.mock('vue-router', () => ({
  useRouter: () => ({ back }),
  useRoute: () => ({ params: routeParams }),
}))

const listChats = vi.fn()
vi.mock('@/api/chats', async (importOriginal) => ({
  chatRowFor: (await importOriginal<typeof import('@/api/chats')>()).chatRowFor,
  listChats: (...args: unknown[]) => listChats(...args),
}))

vi.mock('@/components/shared/ChatThreadScreen.vue', () => ({
  default: defineComponent({
    props: {
      threadId: { type: String, required: true },
      support: { type: Boolean, default: false },
      peerFallback: { type: String, default: '' },
      peer: { type: Object, default: null },
    },
    setup(props) {
      return () =>
        h('div', {
          class: 'thread-stub',
          'data-thread-id': props.threadId,
          'data-support': String(props.support),
          'data-fallback': props.peerFallback,
        })
    },
  }),
}))

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function supportRow(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: 'ticket_new',
    channel: 'support',
    created_at: '2026-10-25T09:00:00Z',
    last_message: null,
    peer: null,
    thread_ids: ['ticket_new', 'ticket_old', 'history_1'],
    ...overrides,
  }
}

function chatRow(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: 'dm_1',
    channel: 'chat',
    created_at: '2026-10-25T09:00:00Z',
    last_message: null,
    peer: { user_id: 'p_1', name: 'Анна', avatar_url: null },
    ...overrides,
  }
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null

function mount(id: string): HTMLElement {
  routeParams.id = id
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(UserChatView).use(createTestI18n())
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

function stub(): HTMLElement | null {
  return host?.querySelector<HTMLElement>('.thread-stub') ?? null
}

function notFound(): boolean {
  return (host?.textContent ?? '').includes('Переписка не найдена')
}

beforeEach(() => {
  back.mockReset()
  listChats.mockReset().mockResolvedValue({
    threads: [chatRow(), supportRow()],
    next_cursor: null,
  })
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('UserChatView -- which row a route id opens', () => {
  it('the id of the support row itself opens the support conversation', async () => {
    mount('ticket_new')
    await flush()

    expect(notFound()).toBe(false)
    expect(stub()?.dataset.threadId).toBe('ticket_new')
    expect(stub()?.dataset.support).toBe('true')
    expect(stub()?.dataset.fallback).toBe('Поддержка VELO')
  })

  it('the id of an OLDER ticket (a push about it) opens the same support conversation, not «not found»', async () => {
    mount('ticket_old')
    await flush()

    expect(notFound()).toBe(false)
    expect(stub()?.dataset.threadId).toBe('ticket_old')
    expect(stub()?.dataset.support).toBe('true')
  })

  it('the id of the pre-ticket history opens it too', async () => {
    mount('history_1')
    await flush()

    expect(stub()?.dataset.support).toBe('true')
  })

  it('an id that is the row id AND in thread_ids is one row -- the support one', async () => {
    listChats.mockResolvedValue({
      threads: [supportRow({ id: 'ticket_new', thread_ids: ['ticket_new'] })],
      next_cursor: null,
    })
    mount('ticket_new')
    await flush()

    expect(stub()?.dataset.support).toBe('true')
  })

  it('a DM row still opens by its id, as a chat -- rows without thread_ids are no obstacle', async () => {
    mount('dm_1')
    await flush()

    expect(notFound()).toBe(false)
    expect(stub()?.dataset.threadId).toBe('dm_1')
    expect(stub()?.dataset.support).toBe('false')
  })

  it('an id in no row id and no thread_ids -> «not found»', async () => {
    mount('someone_elses')
    await flush()

    expect(stub()).toBeNull()
    expect(notFound()).toBe(true)
  })

  it('an EMPTY thread_ids on the support row matches nothing but its own id', async () => {
    listChats.mockResolvedValue({
      threads: [supportRow({ id: 'ticket_new', thread_ids: [] })],
      next_cursor: null,
    })
    mount('ticket_old')
    await flush()

    expect(notFound()).toBe(true)
  })
})
