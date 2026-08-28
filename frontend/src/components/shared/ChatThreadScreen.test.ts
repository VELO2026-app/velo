// =============================================================================
// VELO Frontend -- ChatThreadScreen Tests (Phase 6 / T2, H-T2-UI)
// =============================================================================
//
// THE thread, shared by both roles (UserChatView / MasterChatView are thin
// peer-resolving wrappers). Seam: @/api/chats, mocked whole. Real Pinia for
// the auth store -- bubble alignment keys off authStore.user.id vs sender.
//
// What is under test, and why:
//   1. HISTORY ORDER -- comms feeds NEWEST-first; the screen must reverse
//      to top-down reading order. Asserted on rendered body order, not on
//      internal state.
//   2. READ ON SIGHT -- markChatRead fires on mount (the list badge dies
//      exactly when the messages were actually seen), and AGAIN when the
//      poll delivers new messages.
//   3. SEND -- posts the trimmed body to THIS thread, appends the returned
//      message (comms' copy, not the local draft), clears the draft.
//      Negative twin: a failed send keeps the draft (nothing typed is
//      lost) and appends nothing.
//   4. POLLING -- fake timers: the 12s tick refetches; growth re-reads.
//   5. Bubble alignment: sender===me -> mine, else peer.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import ChatThreadScreen from '@/components/shared/ChatThreadScreen.vue'
import * as chatsApi from '@/api/chats'
import type { ChatMessage } from '@/api/chats'
import { useAuthStore } from '@/stores/auth'
import type { UserResponse } from '@/api/types'

vi.mock('@/api/chats')

const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, info: vi.fn(), success: vi.fn() }),
}))

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const MY_ID = 'me-1'
const THREAD_ID = 'thread-1'

function me(): UserResponse {
  return {
    id: MY_ID,
    telegram_id: 1,
    role: 'user',
    first_name: 'Аня',
    last_name: 'Иванова',
    avatar_url: null,
    timezone: 'Europe/Moscow',
    language: 'ru',
    is_active: true,
    balance_cents: 0,
    created_at: '2026-01-01T00:00:00Z',
    last_login_at: null,
    onboarding_completed: true,
    master_onboarding_completed: false,
    phone: null,
    bio: null,
    email: null,
    role_switch: null,
  } as unknown as UserResponse
}

function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm-1',
    thread_id: THREAD_ID,
    sender: 'peer-1',
    body: 'привет',
    created_at: '2026-08-07T09:00:00+00:00',
    ...overrides,
  }
}

/** comms order: NEWEST first. */
function feed(messages: ChatMessage[]) {
  return { messages, next_cursor: null }
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null
let pinia: Pinia

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(ChatThreadScreen, {
    threadId: THREAD_ID,
    peer: { user_id: 'peer-1', name: 'Анна Петрова', avatar_url: null },
    peerFallback: 'Мастер',
  })
  app.use(pinia)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await nextTick()
}

function bodies(): string[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('.chat-thread__body') ?? []).map(
    (el) => el.textContent?.trim() ?? '',
  )
}

function composerTextarea(): HTMLTextAreaElement {
  const el = host?.querySelector<HTMLTextAreaElement>('.chat-thread__composer textarea')
  if (!el) throw new Error('no composer textarea')
  return el
}

function sendBtn(): HTMLButtonElement {
  const el = host?.querySelector<HTMLButtonElement>('[data-testid="chat-send"]')
  if (!el) throw new Error('no send button')
  return el
}

async function type(text: string): Promise<void> {
  const ta = composerTextarea()
  ta.value = text
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await flush()
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().user = me()

  toastError.mockReset()
  vi.mocked(chatsApi.listChatMessages).mockReset().mockResolvedValue(feed([]))
  vi.mocked(chatsApi.markChatRead).mockReset().mockResolvedValue({ unread: 0 })
  vi.mocked(chatsApi.sendChatMessage).mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  app?.unmount()
  app = null
  host?.remove()
  host = null
})

// -----------------------------------------------------------------------------

describe('ChatThreadScreen', () => {
  it('renders the NEWEST-first comms feed in top-down reading order, aligned by sender', async () => {
    vi.mocked(chatsApi.listChatMessages).mockResolvedValue(
      feed([
        msg({
          id: 'm-2',
          sender: MY_ID,
          body: 'и вам привет',
          created_at: '2026-08-07T09:05:00+00:00',
        }),
        msg({ id: 'm-1', body: 'привет', created_at: '2026-08-07T09:00:00+00:00' }),
      ]),
    )
    mount()
    await flush()

    // Reversed: the OLDER message reads first.
    expect(bodies()).toEqual(['привет', 'и вам привет'])
    expect(host?.querySelectorAll('[data-testid="bubble-peer"]')).toHaveLength(1)
    expect(host?.querySelectorAll('[data-testid="bubble-mine"]')).toHaveLength(1)
  })

  it('marks the thread read on mount -- the badge dies when the messages were actually seen', async () => {
    vi.mocked(chatsApi.listChatMessages).mockResolvedValue(feed([msg()]))
    mount()
    await flush()

    expect(chatsApi.markChatRead).toHaveBeenCalledWith(THREAD_ID)
  })

  // B49: scrollToBottom() used to run inside reload()'s try-block WHILE
  // `loading` was still true -- the feed's v-else branch (and its `feedEl`
  // ref) does not exist yet on that render, so `if (feedEl.value)` silently
  // skipped the scroll. Only the LATER poll's own scrollToBottom (loading
  // already false by then) ever worked, so a thread opened fresh landed at
  // the top of the history instead of the newest message. happy-dom measures
  // nothing real, so scrollHeight/scrollTop are stubbed on the prototype
  // (WeakMap-backed, per-element) -- what's under test is WHETHER the
  // assignment ran at all, not a real pixel value.
  function stubGlobalScrollMetrics(scrollHeight: number) {
    const tops = new WeakMap<Element, number>()
    const origHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
    const origTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop')
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    })
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get() {
        return tops.get(this as Element) ?? 0
      },
      set(v: number) {
        tops.set(this as Element, v)
      },
    })
    return {
      topOf: (el: Element) => tops.get(el) ?? 0,
      restore: () => {
        if (origHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', origHeight)
        if (origTop) Object.defineProperty(HTMLElement.prototype, 'scrollTop', origTop)
      },
    }
  }

  it('B49: autoscrolls to the newest message on the INITIAL load, not only on a later poll', async () => {
    const metrics = stubGlobalScrollMetrics(500)
    try {
      vi.mocked(chatsApi.listChatMessages).mockResolvedValue(feed([msg()]))
      mount()
      await flush()

      const feedEl = host?.querySelector<HTMLElement>('[data-testid="chat-feed"]')
      if (!feedEl) throw new Error('no feed element')
      expect(metrics.topOf(feedEl)).toBe(500)
    } finally {
      metrics.restore()
    }
  })

  it('the header carries the P-1 peer name; an empty thread invites honestly instead of faking history', async () => {
    mount()
    await flush()

    expect(host?.textContent).toContain('Анна Петрова')
    expect(host?.textContent).toContain('Сообщений пока нет')
  })

  it('send: posts the trimmed body to THIS thread, appends the RETURNED message, clears the draft', async () => {
    vi.mocked(chatsApi.sendChatMessage).mockResolvedValue(
      msg({ id: 'm-9', sender: MY_ID, body: 'вопрос про практику' }),
    )
    mount()
    await flush()

    await type('  вопрос про практику  ')
    sendBtn().click()
    await flush()

    expect(chatsApi.sendChatMessage).toHaveBeenCalledWith(THREAD_ID, 'вопрос про практику')
    expect(bodies()).toEqual(['вопрос про практику'])
    expect(composerTextarea().value).toBe('')
  })

  it('negative twin: a FAILED send toasts, keeps the draft (nothing typed is lost) and appends nothing', async () => {
    vi.mocked(chatsApi.sendChatMessage).mockRejectedValue(new Error('down'))
    mount()
    await flush()

    await type('не потеряй меня')
    sendBtn().click()
    await flush()

    expect(toastError).toHaveBeenCalled()
    expect(bodies()).toEqual([])
    expect(composerTextarea().value).toBe('не потеряй меня')
  })

  // PROMPT №740 (track 2, B48) used to make the send control ABSENT while
  // empty (v-if, not :disabled). [owner pass] That is superseded: the disc is
  // ALWAYS rendered, Telegram-style -- an empty/whitespace tap is a guarded
  // no-op inside onSend, never a send.
  it('send button renders on an empty/whitespace draft too; an empty tap sends nothing', async () => {
    mount()
    await flush()

    expect(host?.querySelector('[data-testid="chat-send"]')).not.toBeNull()
    await type('   ')
    expect(host?.querySelector('[data-testid="chat-send"]')).not.toBeNull()

    sendBtn()!.click()
    await flush()
    expect(chatsApi.sendChatMessage).not.toHaveBeenCalled()

    await type('а')
    expect(sendBtn()).not.toBeNull()
  })

  it('polls the visible thread every 12s; a new tail re-renders AND re-marks read', async () => {
    vi.useFakeTimers()
    vi.mocked(chatsApi.listChatMessages).mockResolvedValue(feed([msg()]))
    mount()
    await vi.advanceTimersByTimeAsync(0)

    expect(chatsApi.listChatMessages).toHaveBeenCalledTimes(1)
    vi.mocked(chatsApi.markChatRead).mockClear()

    // The peer answers between ticks.
    vi.mocked(chatsApi.listChatMessages).mockResolvedValue(
      feed([
        msg({ id: 'm-2', body: 'новое сообщение', created_at: '2026-08-07T09:10:00+00:00' }),
        msg(),
      ]),
    )
    await vi.advanceTimersByTimeAsync(12_000)

    expect(chatsApi.listChatMessages).toHaveBeenCalledTimes(2)
    expect(bodies()).toEqual(['привет', 'новое сообщение'])
    expect(chatsApi.markChatRead).toHaveBeenCalledWith(THREAD_ID)
  })

  // CH-1 (review): the regression the ORIGINAL poll test could not catch,
  // because it asserted the same false invariant the code used (growth of
  // the array length). Past one page an eternal DM is length-pinned:
  // 100 === 100 forever, and a length compare silently blinds the poll to
  // exactly the peer's replies. Detection must key off the newest id.
  it("CH-1: a FULL page whose newest message changed (length pinned at 100) still renders the peer's reply and re-marks read", async () => {
    vi.useFakeTimers()
    const fullPage = (offset: number) =>
      Array.from({ length: 100 }, (_, i) =>
        msg({
          id: `m-${offset + (99 - i)}`, // newest-first, as comms feeds it
          body: `сообщение ${offset + (99 - i)}`,
          created_at: `2026-08-07T09:00:${String(offset + (99 - i)).padStart(2, '0')}+00:00`,
        }),
      )
    vi.mocked(chatsApi.listChatMessages).mockResolvedValue(feed(fullPage(0)))
    mount()
    await vi.advanceTimersByTimeAsync(0)
    vi.mocked(chatsApi.markChatRead).mockClear()

    // The peer answers: the window slides by one -- SAME length, new tail.
    vi.mocked(chatsApi.listChatMessages).mockResolvedValue(feed(fullPage(1)))
    await vi.advanceTimersByTimeAsync(12_000)

    expect(bodies()[bodies().length - 1]).toBe('сообщение 100')
    expect(chatsApi.markChatRead).toHaveBeenCalledWith(THREAD_ID)
  })

  // CH-3 (review): incoming messages must not yank a reader who scrolled up
  // into history; only a reader already at the bottom follows the thread
  // down. happy-dom measures nothing, so the feed's scroll metrics are
  // stubbed -- the REAL wiring (poll -> readerNearBottom -> scrollTop) is
  // still what runs.
  function stubFeedScroll(metrics: {
    scrollTop: number
    scrollHeight: number
    clientHeight: number
  }) {
    const el = host?.querySelector<HTMLElement>('[data-testid="chat-feed"]')
    if (!el) throw new Error('no feed element')
    let top = metrics.scrollTop
    Object.defineProperty(el, 'scrollHeight', {
      configurable: true,
      get: () => metrics.scrollHeight,
    })
    Object.defineProperty(el, 'clientHeight', {
      configurable: true,
      get: () => metrics.clientHeight,
    })
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v
      },
    })
    return {
      get top() {
        return top
      },
    }
  }

  it('CH-3: a reader deep in history is NOT scrolled down by an incoming message', async () => {
    vi.useFakeTimers()
    vi.mocked(chatsApi.listChatMessages).mockResolvedValue(feed([msg()]))
    mount()
    await vi.advanceTimersByTimeAsync(0)

    // 2000px of history, viewport 800, reader parked at the top.
    const scroll = stubFeedScroll({ scrollTop: 0, scrollHeight: 2000, clientHeight: 800 })

    vi.mocked(chatsApi.listChatMessages).mockResolvedValue(
      feed([msg({ id: 'm-2', body: 'входящее' }), msg()]),
    )
    await vi.advanceTimersByTimeAsync(12_000)

    expect(bodies()).toContain('входящее') // the message itself still lands
    expect(scroll.top).toBe(0) // ...but the reader stays where they were
    expect(chatsApi.markChatRead).toHaveBeenCalled() // and it still counts as seen-able
  })

  it('CH-3 twin: a reader AT the bottom follows the conversation down', async () => {
    vi.useFakeTimers()
    vi.mocked(chatsApi.listChatMessages).mockResolvedValue(feed([msg()]))
    mount()
    await vi.advanceTimersByTimeAsync(0)

    // Within the 120px near-bottom band.
    const scroll = stubFeedScroll({ scrollTop: 1150, scrollHeight: 2000, clientHeight: 800 })

    vi.mocked(chatsApi.listChatMessages).mockResolvedValue(
      feed([msg({ id: 'm-2', body: 'входящее' }), msg()]),
    )
    await vi.advanceTimersByTimeAsync(12_000)

    expect(scroll.top).toBe(2000) // scrollToBottom drove it to scrollHeight
  })

  // CH-2 (review, cheap half): the composer mirrors the server's 4000-char
  // limit (chats/router.py MessageCreate max_length) so an over-long draft
  // is stopped at the keyboard, not by a 400 round-trip.
  it('CH-2: the composer textarea carries maxlength=4000 (server limit mirrored)', async () => {
    mount()
    await flush()

    expect(composerTextarea().getAttribute('maxlength')).toBe('4000')
  })

  it('a failed initial load shows the retry state, and «Повторить» refetches', async () => {
    vi.mocked(chatsApi.listChatMessages)
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(feed([msg()]))
    mount()
    await flush()

    expect(host?.textContent).toContain('Не удалось загрузить переписку')

    const retry = Array.from(host?.querySelectorAll('button') ?? []).find((b) =>
      b.textContent?.includes('Повторить'),
    )
    retry?.click()
    await flush()

    expect(bodies()).toEqual(['привет'])
  })
})
