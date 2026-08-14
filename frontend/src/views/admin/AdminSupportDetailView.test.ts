// =============================================================================
// VELO Frontend -- AdminSupportDetailView Screen Tests (PROMPT №713)
// =============================================================================
//
// PATTERN: route-param detail screen (state hand-off, same shape as
// AdminReportDetailView) + a message feed + a claim-gated composer. Seams
// mocked: @/api/support (listAdminSupportThreads for the state-hand-off
// fallback, getAdminSupportMessages, sendAdminSupportReply,
// claimSupportThread) and @/stores/auth (myId drives canReply/bubble
// alignment).
//
// THE STATE-SEED CHECK, same discipline as AdminReportDetailView.test.ts:
// a MATCHING seeded thread id skips the list re-fetch; a MISMATCHED one
// (stale object from a previous navigation) is ignored and the fallback
// list-and-find runs instead. Seeded via window.history.replaceState()
// BEFORE mount (the screen reads it during setup).
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AdminSupportDetailView from '@/views/admin/AdminSupportDetailView.vue'
import * as supportApi from '@/api/support'
import type { SupportThread, SupportMessage } from '@/api/support'

vi.mock('@/api/support')

const push = vi.fn()
const back = vi.fn()
const routeParams: { id: string } = { id: 't_1' }
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back }),
  useRoute: () => ({ params: routeParams }),
}))

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, info: vi.fn(), success: toastSuccess }),
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
    title: 'Жалоба на мастера',
    priority: null,
    last_message_at: '2026-08-14T10:00:00Z',
    created_at: '2026-08-14T09:00:00Z',
    opener: { user_id: 'u_1', name: 'Дана', avatar_url: null },
    ...overrides,
  }
}

function message(overrides: Partial<SupportMessage> = {}): SupportMessage {
  return {
    id: 'm_1',
    thread_id: 't_1',
    sender: 'u_1',
    body: 'Помогите пожалуйста',
    created_at: '2026-08-14T10:00:00Z',
    ...overrides,
  }
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null

function mount(id: string, stateThread: SupportThread | null = null): HTMLElement {
  routeParams.id = id
  window.history.replaceState(stateThread ? { thread: stateThread } : {}, '')
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(AdminSupportDetailView)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

function text(): string {
  return host?.textContent ?? ''
}
function btnByText(t: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-btn') ?? []).find(
    (b) => b.textContent?.trim() === t,
  )
}
function composer(): HTMLElement | null {
  return host?.querySelector('.support-detail__composer') ?? null
}
function draftField(): HTMLTextAreaElement {
  const el = host?.querySelector<HTMLTextAreaElement>('.v-textarea__field')
  if (!el) throw new Error('composer textarea did not render')
  return el
}
function setValue(el: HTMLTextAreaElement, value: string): void {
  el.value = value
  el.dispatchEvent(new Event('input'))
}
function bubbles(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('.support-detail__bubble') ?? [])
}

beforeEach(() => {
  push.mockReset()
  back.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()
  authState.user = { id: 'admin_me' }

  vi.mocked(supportApi.listAdminSupportThreads)
    .mockReset()
    .mockResolvedValue({
      threads: [thread()],
      next_cursor: null,
    })
  vi.mocked(supportApi.getAdminSupportMessages)
    .mockReset()
    .mockResolvedValue({
      messages: [message()],
      next_cursor: null,
    })
  vi.mocked(supportApi.sendAdminSupportReply).mockReset()
  vi.mocked(supportApi.claimSupportThread).mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  window.history.replaceState({}, '')
  vi.clearAllMocks()
})

describe('AdminSupportDetailView', () => {
  describe('state hand-off (the archetype bug from BookingConfirmedView)', () => {
    it('a MATCHING seeded thread id skips the list re-fetch entirely', async () => {
      mount('t_1', thread({ id: 't_1' }))
      await flush()

      expect(supportApi.listAdminSupportThreads).not.toHaveBeenCalled()
      expect(text()).toContain('Дана')
    })

    it('a MISMATCHED seeded id (stale object) is ignored -- falls back to the list', async () => {
      mount('t_1', thread({ id: 't_STALE' }))
      await flush()

      expect(supportApi.listAdminSupportThreads).toHaveBeenCalled()
    })

    it('no seed at all -- fetches the admin list and finds the thread by id', async () => {
      mount('t_1', null)
      await flush()

      expect(supportApi.listAdminSupportThreads).toHaveBeenCalled()
      expect(text()).toContain('Дана')
    })

    it('an id absent from the fallback list -> not-found state', async () => {
      vi.mocked(supportApi.listAdminSupportThreads).mockResolvedValue({
        threads: [thread({ id: 'someone_elses' })],
        next_cursor: null,
      })
      mount('t_missing', null)
      await flush()

      expect(text()).toContain('Обращение не найдено')
    })
  })

  describe('claim gating -- the composer is not just disabled, it is HIDDEN behind a notice', () => {
    it('unclaimed: composer hidden, claim panel + "Взять в работу" shown', async () => {
      mount('t_1', thread({ id: 't_1', assignee: null }))
      await flush()

      expect(composer()).toBeNull()
      expect(text()).toContain('Не взято') // triage badge
      expect(text()).toContain('не закреплено') // claim panel copy
      expect(btnByText('Взять в работу')).toBeDefined()
    })

    it('claimed by SOMEONE ELSE: composer hidden, no claim button (cannot re-claim)', async () => {
      mount('t_1', thread({ id: 't_1', assignee: 'other_admin' }))
      await flush()

      expect(composer()).toBeNull()
      expect(text()).toContain('закреплено за другим администратором')
      expect(btnByText('Взять в работу')).toBeUndefined()
    })

    it('claimed by ME: composer shown, no claim panel', async () => {
      mount('t_1', thread({ id: 't_1', assignee: 'admin_me' }))
      await flush()

      expect(composer()).not.toBeNull()
      expect(btnByText('Взять в работу')).toBeUndefined()
    })

    it('clicking "Взять в работу" claims and reveals the composer on success', async () => {
      const claimed = thread({ id: 't_1', assignee: 'admin_me' })
      vi.mocked(supportApi.claimSupportThread).mockResolvedValue({ claimed: true, thread: claimed })
      mount('t_1', thread({ id: 't_1', assignee: null }))
      await flush()

      btnByText('Взять в работу')?.click()
      await flush()

      expect(supportApi.claimSupportThread).toHaveBeenCalledWith('t_1')
      expect(toastSuccess).toHaveBeenCalled()
      expect(composer()).not.toBeNull()
    })

    it('losing the claim race (claimed: false) toasts an error, stays unclaimed-for-me', async () => {
      const wonByOther = thread({ id: 't_1', assignee: 'other_admin' })
      vi.mocked(supportApi.claimSupportThread).mockResolvedValue({
        claimed: false,
        thread: wonByOther,
      })
      mount('t_1', thread({ id: 't_1', assignee: null }))
      await flush()

      btnByText('Взять в работу')?.click()
      await flush()

      expect(toastError).toHaveBeenCalled()
      expect(composer()).toBeNull()
    })
  })

  describe('the feed', () => {
    it('renders a message, mine right-aligned vs the requester left-aligned', async () => {
      // comms returns NEWEST-first; the component reverses to oldest-first
      // for top-down rendering (same contract as ChatThreadScreen.vue) --
      // "mine" was sent after "theirs", so it is listed FIRST here.
      vi.mocked(supportApi.getAdminSupportMessages).mockResolvedValue({
        messages: [
          message({ id: 'm_mine', sender: 'admin_me', body: 'Ответ' }),
          message({ id: 'm_theirs', sender: 'u_1', body: 'Вопрос' }),
        ],
        next_cursor: null,
      })
      mount('t_1', thread({ id: 't_1', assignee: 'admin_me' }))
      await flush()

      const rows = Array.from(host?.querySelectorAll<HTMLElement>('.support-detail__row') ?? [])
      expect(rows[0]?.classList.contains('support-detail__row--mine')).toBe(false)
      expect(rows[1]?.classList.contains('support-detail__row--mine')).toBe(true)
      expect(bubbles()).toHaveLength(2)
    })

    it('an empty feed shows the honest "no messages yet" line, not a fake history', async () => {
      vi.mocked(supportApi.getAdminSupportMessages).mockResolvedValue({
        messages: [],
        next_cursor: null,
      })
      mount('t_1', thread({ id: 't_1' }))
      await flush()

      expect(text()).toContain('Сообщений пока нет')
    })
  })

  describe('replying', () => {
    it('sends and appends the message locally, clearing the draft', async () => {
      const sent = message({ id: 'm_new', sender: 'admin_me', body: 'Здравствуйте' })
      vi.mocked(supportApi.sendAdminSupportReply).mockResolvedValue(sent)
      mount('t_1', thread({ id: 't_1', assignee: 'admin_me' }))
      await flush()

      setValue(draftField(), 'Здравствуйте')
      await flush()
      btnByText('Отправить')?.click()
      await flush()

      expect(supportApi.sendAdminSupportReply).toHaveBeenCalledWith('t_1', 'Здравствуйте')
      expect(bubbles()).toHaveLength(2) // the seeded message + the new one
      expect(draftField().value).toBe('')
    })

    it('a 403 from comms (unclaimed mid-flight) toasts rather than crashing', async () => {
      vi.mocked(supportApi.sendAdminSupportReply).mockRejectedValue(new Error('403'))
      mount('t_1', thread({ id: 't_1', assignee: 'admin_me' }))
      await flush()

      setValue(draftField(), 'Здравствуйте')
      await flush()
      btnByText('Отправить')?.click()
      await flush()

      expect(toastError).toHaveBeenCalled()
    })

    it('an empty draft cannot be sent', async () => {
      mount('t_1', thread({ id: 't_1', assignee: 'admin_me' }))
      await flush()

      expect(btnByText('Отправить')?.disabled).toBe(true)
    })
  })
})
