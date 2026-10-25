// =============================================================================
// VELO Frontend -- AdminSupportDetailView Screen Tests (PROMPT №713; tickets FE-100)
// =============================================================================
//
// PATTERN: route-param detail screen (state hand-off, same shape as
// AdminReportDetailView) + a message feed + a claim-gated composer + the
// ticket's status actions + the person's read-only history. Seams mocked:
// @/api/support (getAdminTicket -- the one-ticket read --, the feed, reply,
// claim, status; SUPPORT_CLOSING_STATUSES stays REAL -- an auto-mock would
// empty the array and silently drop every status button) and @/stores/auth
// (myId drives canReply/bubble alignment).
//
// THE STATE-SEED CHECK, same discipline as AdminReportDetailView.test.ts:
// a MATCHING seeded ticket id skips the read; a MISMATCHED one (stale object
// from a previous navigation) is ignored and GET /support/tickets/{id} runs
// instead. Seeded via window.history.replaceState() BEFORE mount.
//
// The one-ticket route is BE-162's FIX (delivered with this front): its
// contract -- the list row, spam included, 404 for a history thread or an
// unknown id -- is what the mocks below return.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AdminSupportDetailView from '@/views/admin/AdminSupportDetailView.vue'
import * as supportApi from '@/api/support'
import type { AdminSupportTicket, SupportMessage, SupportPerson } from '@/api/support'
import { ApiResponseError } from '@/api/client'

vi.mock('@/api/support', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/api/support')>()
  return {
    SUPPORT_CLOSING_STATUSES: real.SUPPORT_CLOSING_STATUSES,
    getAdminTicket: vi.fn(),
    getAdminSupportMessages: vi.fn(),
    sendAdminSupportReply: vi.fn(),
    claimSupportThread: vi.fn(),
    setTicketStatus: vi.fn(),
  }
})

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

const ME: SupportPerson = { user_id: 'admin_me', name: 'Я', avatar_url: null }
const OTHER: SupportPerson = { user_id: 'other_admin', name: 'Ольга', avatar_url: null }

function ticket(overrides: Partial<AdminSupportTicket> = {}): AdminSupportTicket {
  return {
    id: 't_1',
    topic: 'complaint_master',
    category: 'complaint_master',
    status: 'open',
    created_at: '2026-10-25T09:00:00Z',
    status_changed_at: '2026-10-25T09:00:00Z',
    opener: { user_id: 'u_1', name: 'Дана', avatar_url: null },
    claimed_by: null,
    history_thread_id: null,
    ...overrides,
  }
}

function message(overrides: Partial<SupportMessage> = {}): SupportMessage {
  return {
    id: 'm_1',
    thread_id: 't_1',
    sender: 'u_1',
    body: 'Помогите пожалуйста',
    created_at: '2026-10-25T10:00:00Z',
    ...overrides,
  }
}

function conflict(): ApiResponseError {
  return new ApiResponseError(409, 'The ticket changed meanwhile -- read it again')
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null

function mount(id: string, stateTicket: AdminSupportTicket | null = null): HTMLElement {
  routeParams.id = id
  window.history.replaceState(stateTicket ? { ticket: stateTicket } : {}, '')
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(AdminSupportDetailView).use(createTestI18n())
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

function statusButtons(): string[] {
  return Array.from(
    host?.querySelectorAll<HTMLButtonElement>('.support-detail__actions .v-btn') ?? [],
  ).map((b) => b.textContent?.trim() ?? '')
}
function badge(): string | undefined {
  return host?.querySelector('.support-detail__header .v-badge')?.textContent?.trim()
}

beforeEach(() => {
  push.mockReset()
  back.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()
  authState.user = { id: 'admin_me' }

  vi.mocked(supportApi.getAdminTicket).mockReset().mockResolvedValue(ticket())
  vi.mocked(supportApi.getAdminSupportMessages)
    .mockReset()
    .mockResolvedValue({
      messages: [message()],
      next_cursor: null,
    })
  vi.mocked(supportApi.sendAdminSupportReply).mockReset()
  vi.mocked(supportApi.claimSupportThread).mockReset()
  vi.mocked(supportApi.setTicketStatus).mockReset()
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
  // Was: without a hand-off the admin list was re-fetched and searched by id
  // (no one-ticket read existed). BE-162's FIX adds GET /support/tickets/{id};
  // the card reads exactly that ticket -- no list, no search, no ceiling.
  describe('state hand-off and the one-ticket read', () => {
    it('a MATCHING seeded ticket id skips the read entirely', async () => {
      mount('t_1', ticket({ id: 't_1' }))
      await flush()

      expect(supportApi.getAdminTicket).not.toHaveBeenCalled()
      expect(text()).toContain('Дана')
    })

    it('a MISMATCHED seeded id (stale object) is ignored -- the ticket is read by id', async () => {
      mount('t_1', ticket({ id: 't_STALE' }))
      await flush()

      expect(supportApi.getAdminTicket).toHaveBeenCalledWith('t_1')
    })

    it('no seed at all (a deep link, a reload) -- reads the ticket by id and renders it', async () => {
      mount('t_1', null)
      await flush()

      expect(supportApi.getAdminTicket).toHaveBeenCalledTimes(1)
      expect(supportApi.getAdminTicket).toHaveBeenCalledWith('t_1')
      expect(text()).toContain('Дана')
      expect(text()).toContain('Жалоба на мастера')
    })

    it('a spam ticket opened by a deep link renders -- the read returns spam too', async () => {
      vi.mocked(supportApi.getAdminTicket).mockResolvedValue(ticket({ status: 'spam' }))
      mount('t_1', null)
      await flush()

      expect(badge()).toBe('Спам')
    })

    // Was: an id absent from the fallback LIST. Now the read answers 404 --
    // no such ticket, a person's history thread included.
    it('a 404 from the read -> not-found state, and no feed is asked for', async () => {
      vi.mocked(supportApi.getAdminTicket).mockRejectedValue(
        new ApiResponseError(404, 'Ticket not found'),
      )
      mount('t_missing', null)
      await flush()

      expect(text()).toContain('Обращение не найдено')
      expect(supportApi.getAdminSupportMessages).not.toHaveBeenCalled()
    })

    it('any other read failure -> an error state whose retry reads again', async () => {
      vi.mocked(supportApi.getAdminTicket)
        .mockRejectedValueOnce(new ApiResponseError(502, 'comms down'))
        .mockResolvedValue(ticket())
      mount('t_1', null)
      await flush()

      expect(text()).not.toContain('Обращение не найдено')
      btnByText('Повторить')?.click()
      await flush()

      expect(supportApi.getAdminTicket).toHaveBeenCalledTimes(2)
      expect(text()).toContain('Дана')
    })
  })

  describe('the header -- status badge and topic label', () => {
    it('shows the status label and the topic labelled from its code', async () => {
      mount('t_1', ticket({ status: 'duplicate', topic: 'complaint_user' }))
      await flush()

      expect(badge()).toBe('Дубликат')
      expect(host?.querySelector('.support-detail__topic')?.textContent?.trim()).toBe(
        'Жалоба на пользователя',
      )
    })
  })

  describe('status actions (FE-100)', () => {
    it('an OPEN ticket offers the four closing statuses -- to ANY admin, taker or not', async () => {
      mount('t_1', ticket({ claimed_by: OTHER }))
      await flush()

      expect(statusButtons()).toEqual(['Решена', 'Отклонена', 'Дубликат', 'Спам'])
    })

    it('a ticket that is not open offers none -- it shows its status instead', async () => {
      mount('t_1', ticket({ status: 'rejected' }))
      await flush()

      expect(statusButtons()).toEqual([])
      expect(host?.querySelector('.support-detail__processed')?.textContent).toContain('Отклонена')
    })

    it.each([
      ['Решена', 'resolved'],
      ['Отклонена', 'rejected'],
      ['Дубликат', 'duplicate'],
      ['Спам', 'spam'],
    ] as const)('«%s» sends "%s" and the card shows the new status', async (label, status) => {
      vi.mocked(supportApi.setTicketStatus).mockResolvedValue({
        id: 't_1',
        topic: 'complaint_master',
        category: 'complaint_master',
        status,
        created_at: '2026-10-25T09:00:00Z',
        status_changed_at: '2026-10-25T11:00:00Z',
      })
      mount('t_1', ticket({ claimed_by: ME }))
      await flush()

      btnByText(label)?.click()
      await flush()

      expect(supportApi.setTicketStatus).toHaveBeenCalledWith('t_1', status)
      expect(badge()).toBe(label)
      expect(statusButtons()).toEqual([])
      expect(toastSuccess).toHaveBeenCalled()
      // The answer has no admin-only fields; what was read stays.
      expect(text()).toContain('Дана')
      expect(composer()).not.toBeNull()
      expect(supportApi.getAdminTicket).not.toHaveBeenCalled()
    })

    it('a double tap sends ONE status change', async () => {
      let resolveStatus!: (v: Awaited<ReturnType<typeof supportApi.setTicketStatus>>) => void
      vi.mocked(supportApi.setTicketStatus).mockReturnValue(
        new Promise((resolve) => {
          resolveStatus = resolve
        }),
      )
      mount('t_1', ticket())
      await flush()

      btnByText('Решена')?.click()
      btnByText('Отклонена')?.click()
      await flush()

      expect(supportApi.setTicketStatus).toHaveBeenCalledTimes(1)
      resolveStatus({ ...ticket(), status: 'resolved' })
      await flush()
    })

    it('a 409 toasts and reads the ticket again -- another admin closed it meanwhile', async () => {
      vi.mocked(supportApi.setTicketStatus).mockRejectedValue(conflict())
      vi.mocked(supportApi.getAdminTicket).mockResolvedValue(
        ticket({ status: 'resolved', claimed_by: OTHER }),
      )
      mount('t_1', ticket())
      await flush()

      btnByText('Спам')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Обращение изменилось — проверьте статус')
      expect(supportApi.getAdminTicket).toHaveBeenCalledWith('t_1')
      expect(badge()).toBe('Решена')
      expect(statusButtons()).toEqual([])
    })

    it('a 409 on a ticket that is STILL open (a person wrote meanwhile) leaves the buttons for a retry', async () => {
      vi.mocked(supportApi.setTicketStatus).mockRejectedValueOnce(conflict())
      vi.mocked(supportApi.getAdminTicket).mockResolvedValue(ticket())
      mount('t_1', ticket())
      await flush()

      btnByText('Решена')?.click()
      await flush()

      expect(supportApi.getAdminTicket).toHaveBeenCalledTimes(1)
      expect(badge()).toBe('Открыта')
      expect(statusButtons()).toEqual(['Решена', 'Отклонена', 'Дубликат', 'Спам'])
    })

    it('any other failure toasts and changes nothing -- no re-read', async () => {
      vi.mocked(supportApi.setTicketStatus).mockRejectedValue(new ApiResponseError(502, 'down'))
      mount('t_1', ticket())
      await flush()

      btnByText('Решена')?.click()
      await flush()

      expect(toastError).toHaveBeenCalled()
      expect(supportApi.getAdminTicket).not.toHaveBeenCalled()
      expect(badge()).toBe('Открыта')
    })
  })

  // Was: gated on comms' `assignee`, and a lost race was `claimed: false`.
  // BE-162: the taker is velo's `claimed_by`, a ticket held by another admin
  // is comms' 409 -- and after any claim answer the ticket is read again.
  describe('claim gating -- the composer is not just disabled, it is HIDDEN behind a notice', () => {
    it('unclaimed: composer hidden, claim panel + "Взять в работу" shown', async () => {
      mount('t_1', ticket({ claimed_by: null }))
      await flush()

      expect(composer()).toBeNull()
      expect(text()).toContain('не закреплено')
      expect(btnByText('Взять в работу')).toBeDefined()
    })

    it('claimed by SOMEONE ELSE: composer hidden, no claim button (cannot re-claim)', async () => {
      mount('t_1', ticket({ claimed_by: OTHER }))
      await flush()

      expect(composer()).toBeNull()
      expect(text()).toContain('закреплено за другим администратором')
      expect(btnByText('Взять в работу')).toBeUndefined()
    })

    it('claimed by ME: composer shown, no claim panel', async () => {
      mount('t_1', ticket({ claimed_by: ME }))
      await flush()

      expect(composer()).not.toBeNull()
      expect(btnByText('Взять в работу')).toBeUndefined()
    })

    it('a claim answered 200 reads the ticket again and reveals the composer', async () => {
      vi.mocked(supportApi.claimSupportThread).mockResolvedValue({ claimed: true })
      vi.mocked(supportApi.getAdminTicket).mockResolvedValue(ticket({ claimed_by: ME }))
      mount('t_1', ticket({ claimed_by: null }))
      await flush()

      btnByText('Взять в работу')?.click()
      await flush()

      expect(supportApi.claimSupportThread).toHaveBeenCalledWith('t_1')
      expect(supportApi.getAdminTicket).toHaveBeenCalledWith('t_1')
      expect(toastSuccess).toHaveBeenCalled()
      expect(composer()).not.toBeNull()
    })

    it('a claim answered 200 does NOT invent the taker -- the composer follows the read', async () => {
      // The read is the truth: should it still say "nobody" (the claim's
      // write lost on our side, comms said yes), the card does not pretend.
      vi.mocked(supportApi.claimSupportThread).mockResolvedValue({ claimed: true })
      vi.mocked(supportApi.getAdminTicket).mockResolvedValue(ticket({ claimed_by: null }))
      mount('t_1', ticket({ claimed_by: null }))
      await flush()

      btnByText('Взять в работу')?.click()
      await flush()

      expect(composer()).toBeNull()
    })

    it('losing the claim race (409) toasts, reads again and shows the other taker', async () => {
      vi.mocked(supportApi.claimSupportThread).mockRejectedValue(
        new ApiResponseError(409, 'Already claimed'),
      )
      vi.mocked(supportApi.getAdminTicket).mockResolvedValue(ticket({ claimed_by: OTHER }))
      mount('t_1', ticket({ claimed_by: null }))
      await flush()

      btnByText('Взять в работу')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Уже взято другим администратором')
      expect(supportApi.getAdminTicket).toHaveBeenCalledWith('t_1')
      expect(composer()).toBeNull()
      expect(btnByText('Взять в работу')).toBeUndefined()
    })

    it('any other claim failure toasts with no re-read', async () => {
      vi.mocked(supportApi.claimSupportThread).mockRejectedValue(new ApiResponseError(502, 'down'))
      mount('t_1', ticket({ claimed_by: null }))
      await flush()

      btnByText('Взять в работу')?.click()
      await flush()

      expect(toastError).toHaveBeenCalled()
      expect(supportApi.getAdminTicket).not.toHaveBeenCalled()
      expect(btnByText('Взять в работу')).toBeDefined()
    })
  })

  describe('the history (pre-ticket conversation, read-only)', () => {
    it('no history_thread_id -> no history control at all', async () => {
      mount('t_1', ticket({ history_thread_id: null }))
      await flush()

      expect(btnByText('История обращений')).toBeUndefined()
    })

    it('a history_thread_id -> a button; the feed loads only on tap, from THAT thread', async () => {
      vi.mocked(supportApi.getAdminSupportMessages).mockImplementation((id: string) =>
        Promise.resolve({
          messages:
            id === 'h_1'
              ? [message({ id: 'h_m', thread_id: 'h_1', body: 'Старый вопрос' })]
              : [message()],
          next_cursor: null,
        }),
      )
      mount('t_1', ticket({ history_thread_id: 'h_1', claimed_by: ME }))
      await flush()

      expect(supportApi.getAdminSupportMessages).toHaveBeenCalledTimes(1)
      expect(text()).not.toContain('Старый вопрос')

      btnByText('История обращений')?.click()
      await flush()

      expect(supportApi.getAdminSupportMessages).toHaveBeenLastCalledWith('h_1')
      expect(text()).toContain('Старый вопрос')
      // Read-only: still exactly one composer -- the ticket's.
      expect(host?.querySelectorAll('.support-detail__composer')).toHaveLength(1)
    })

    it('a failed history load shows its own retry, and the ticket feed stays', async () => {
      vi.mocked(supportApi.getAdminSupportMessages).mockImplementation((id: string) =>
        id === 'h_1'
          ? Promise.reject(new Error('boom'))
          : Promise.resolve({ messages: [message()], next_cursor: null }),
      )
      mount('t_1', ticket({ history_thread_id: 'h_1' }))
      await flush()

      btnByText('История обращений')?.click()
      await flush()

      expect(text()).toContain('Помогите пожалуйста')
      expect(btnByText('Повторить')).toBeDefined()
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
      mount('t_1', ticket({ claimed_by: ME }))
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
      mount('t_1', ticket())
      await flush()

      expect(text()).toContain('Сообщений пока нет')
    })
  })

  describe('replying', () => {
    it('sends and appends the message locally, clearing the draft', async () => {
      const sent = message({ id: 'm_new', sender: 'admin_me', body: 'Здравствуйте' })
      vi.mocked(supportApi.sendAdminSupportReply).mockResolvedValue(sent)
      mount('t_1', ticket({ claimed_by: ME }))
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
      mount('t_1', ticket({ claimed_by: ME }))
      await flush()

      setValue(draftField(), 'Здравствуйте')
      await flush()
      btnByText('Отправить')?.click()
      await flush()

      expect(toastError).toHaveBeenCalled()
    })

    it('an empty draft cannot be sent', async () => {
      mount('t_1', ticket({ claimed_by: ME }))
      await flush()

      expect(btnByText('Отправить')?.disabled).toBe(true)
    })
  })
})
