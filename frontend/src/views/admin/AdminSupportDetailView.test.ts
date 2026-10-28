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
import type { UserResponse } from '@/api/types'
import { ApiResponseError } from '@/api/client'

vi.mock('@/api/support', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/api/support')>()
  return {
    SUPPORT_CLOSING_STATUSES: real.SUPPORT_CLOSING_STATUSES,
    // REAL here too: the «Не спам» visibility math is part of what is tested.
    spamWithinRetention: real.spamWithinRetention,
    getAdminTicket: vi.fn(),
    getAdminSupportMessages: vi.fn(),
    sendAdminSupportReply: vi.fn(),
    claimSupportThread: vi.fn(),
    setTicketStatus: vi.fn(),
    retrySupportTranslation: vi.fn(),
    assignTicket: vi.fn(),
    releaseTicket: vi.fn(),
    reopenTicket: vi.fn(),
  }
})

const getUsersList = vi.fn()
vi.mock('@/api/admin', () => ({
  getUsersList: (...args: unknown[]) => getUsersList(...args),
}))

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

/** The roster rows of GET /admin/users?role=admin (FE-108: «Назначить»). */
const OLGA_USER = {
  id: 'other_admin',
  first_name: 'Ольга',
  last_name: 'Иванова',
} as unknown as UserResponse
const NAMELESS_USER = { id: 'a_2', first_name: null, last_name: null } as unknown as UserResponse
const ME_USER = { id: 'admin_me', first_name: 'Я' } as unknown as UserResponse

function roster(...items: UserResponse[]): unknown {
  return { items, total: items.length, limit: 100, offset: 0 }
}

/** An ISO moment `days` in the past -- the spam retention edge is live math. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

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
  const merged = {
    id: 'm_1',
    thread_id: 't_1',
    sender: 'u_1',
    body: 'Помогите пожалуйста',
    created_at: '2026-10-25T10:00:00Z',
    ...overrides,
  }
  return { original: merged.body, translation: null, ...merged }
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
  return Array.from(host?.querySelectorAll<HTMLElement>('.bubble') ?? [])
}

// FE-100: the status actions live in the ⋯ menu (a teleported VBottomSheet).
// FE-108 added a SECOND sheet -- «Назначить»'s roster; the helpers below
// tell them apart by the roster's own container class.
function menuButton(): HTMLButtonElement | null {
  return host?.querySelector<HTMLButtonElement>('.support-detail__menu') ?? null
}
function sheetOverlays(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>('.v-sheet__overlay')).filter(
    (o) => !o.classList.contains('v-sheet-leave-active'),
  )
}
function menuRows(): HTMLElement[] {
  return sheetOverlays()
    .filter((o) => !o.querySelector('.support-detail__assign'))
    .flatMap((o) => Array.from(o.querySelectorAll<HTMLElement>('.v-menu-row')))
}
/** The rows of the «Назначить» roster sheet. */
function assignRows(): HTMLElement[] {
  return sheetOverlays()
    .filter((o) => o.querySelector('.support-detail__assign'))
    .flatMap((o) => Array.from(o.querySelectorAll<HTMLElement>('.v-menu-row')))
}
function assignSheetOpen(): boolean {
  return sheetOverlays().some((o) => o.querySelector('.support-detail__assign'))
}
/** The sheet is open: present and not leaving (its Transition keeps the
 *  element through the leave animation). */
function sheetOpen(): boolean {
  const el = document.body.querySelector<HTMLElement>('.v-sheet__overlay')
  return !!el && !el.classList.contains('v-sheet-leave-active')
}
/** What the ⋯ menu offers: opens it, reads the rows, closes it again. No
 *  menu button -> nothing is offered. */
async function statusOffer(): Promise<string[]> {
  const button = menuButton()
  if (!button) return []
  button.click()
  await flush()
  const labels = menuRows().map((r) => r.textContent?.trim() ?? '')
  document.body.querySelectorAll<HTMLElement>('.v-sheet__overlay').forEach((o) => o.click())
  await flush()
  return labels
}
/** Opens the ⋯ menu and taps the row with this label. */
async function pickStatus(label: string): Promise<void> {
  menuButton()?.click()
  await flush()
  menuRows()
    .find((r) => r.textContent?.trim() === label)
    ?.click()
  await flush()
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
  vi.mocked(supportApi.retrySupportTranslation).mockReset()
  vi.mocked(supportApi.assignTicket).mockReset()
  vi.mocked(supportApi.releaseTicket).mockReset()
  vi.mocked(supportApi.reopenTicket).mockReset()
  getUsersList.mockReset().mockResolvedValue(roster())
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  window.history.replaceState({}, '')
  document.body.querySelectorAll('.v-sheet__overlay').forEach((el) => el.remove())
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

  // Was: four buttons stacked in the card (delivery A). FE-100, owner ruling
  // 25.10: the same four statuses, behind ⋯ in the header. FE-108 grew the
  // same menu by the handover entries («Назначить», «Освободить»). What the
  // actions DO is asserted unchanged; only the offer grew.
  describe('status actions (FE-100) -- the ⋯ menu', () => {
    it('an OPEN ticket offers the handover plus the four closing statuses -- to ANY admin, taker or not', async () => {
      mount('t_1', ticket({ claimed_by: OTHER }))
      await flush()

      expect(await statusOffer()).toEqual([
        'Назначить',
        'Освободить',
        'Решена',
        'Отклонена',
        'Дубликат',
        'Спам',
      ])
    })

    it('an open UNCLAIMED ticket offers «Назначить» but not «Освободить»', async () => {
      mount('t_1', ticket())
      await flush()

      expect(await statusOffer()).toEqual(['Назначить', 'Решена', 'Отклонена', 'Дубликат', 'Спам'])
    })

    // Was (FE-100): a closed ticket had no ⋯ at all. FE-108: it keeps ⋯ --
    // «Назначить» and «Вернуть в работу» -- and still shows its status.
    it('a REJECTED ticket keeps ⋯ -- «Назначить» and «Вернуть в работу», no closing statuses', async () => {
      mount('t_1', ticket({ status: 'rejected' }))
      await flush()

      expect(menuButton()).not.toBeNull()
      expect(await statusOffer()).toEqual(['Назначить', 'Вернуть в работу'])
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
        // NOW, not a fixed date: a spam verdict must stay inside the
        // retention for «Не спам» to be offered after the change.
        status_changed_at: new Date().toISOString(),
      })
      mount('t_1', ticket({ claimed_by: ME }))
      await flush()

      await pickStatus(label)

      expect(supportApi.setTicketStatus).toHaveBeenCalledWith('t_1', status)
      expect(sheetOpen()).toBe(false) // the sheet closed on the pick
      expect(badge()).toBe(label)
      // A closed ticket still keeps ⋯ -- the reopen side of the new status.
      // The taker is unchanged (the answer carries no admin fields), so
      // «Освободить» stays offered too.
      const reopenOffer =
        status === 'spam'
          ? ['Назначить', 'Освободить', 'Не спам']
          : ['Назначить', 'Освободить', 'Вернуть в работу']
      expect(await statusOffer()).toEqual(reopenOffer)
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

      // The sheet closes on the first pick; reopen it while the call is in
      // flight -- the ticket is still open, so ⋯ is still there.
      await pickStatus('Решена')
      await pickStatus('Отклонена')

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

      await pickStatus('Спам')

      expect(toastError).toHaveBeenCalledWith('Обращение изменилось — проверьте статус')
      expect(supportApi.getAdminTicket).toHaveBeenCalledWith('t_1')
      expect(badge()).toBe('Решена')
      // The refreshed ticket: still held by the other admin, closed -> the
      // handover entries, no closing statuses.
      expect(await statusOffer()).toEqual(['Назначить', 'Освободить', 'Вернуть в работу'])
    })

    it('a 409 on a ticket that is STILL open (a person wrote meanwhile) leaves the buttons for a retry', async () => {
      vi.mocked(supportApi.setTicketStatus).mockRejectedValueOnce(conflict())
      vi.mocked(supportApi.getAdminTicket).mockResolvedValue(ticket())
      mount('t_1', ticket())
      await flush()

      await pickStatus('Решена')

      expect(supportApi.getAdminTicket).toHaveBeenCalledTimes(1)
      expect(badge()).toBe('Открыта')
      expect(await statusOffer()).toEqual(['Назначить', 'Решена', 'Отклонена', 'Дубликат', 'Спам'])
    })

    it('any other failure toasts and changes nothing -- no re-read', async () => {
      vi.mocked(supportApi.setTicketStatus).mockRejectedValue(new ApiResponseError(502, 'down'))
      mount('t_1', ticket())
      await flush()

      await pickStatus('Решена')

      expect(toastError).toHaveBeenCalled()
      expect(supportApi.getAdminTicket).not.toHaveBeenCalled()
      expect(badge()).toBe('Открыта')
    })
  })

  // ===========================================================================
  // FE-108 (BE-162 delivery 2): «Назначить», «Освободить», «Вернуть в работу»,
  // «Не спам» -- entries of the same TICKET_ACTIONS array. The three routes
  // answer the ticket's FULL row, so their answers replace the card outright;
  // a 409 re-reads, a 404 on reopen is the not-found screen.
  describe('the handover (FE-108) -- «Назначить»', () => {
    it('opens the admin roster (the admin users list, myself not offered) and a pick hands the ticket over', async () => {
      getUsersList.mockResolvedValue(roster(OLGA_USER, NAMELESS_USER, ME_USER))
      vi.mocked(supportApi.assignTicket).mockResolvedValue(ticket({ claimed_by: OTHER }))
      mount('t_1', ticket({ claimed_by: ME }))
      await flush()

      await pickStatus('Назначить')

      expect(getUsersList).toHaveBeenCalledWith('admin')
      expect(assignRows().map((r) => r.textContent?.trim() ?? '')).toEqual([
        'Ольга Иванова',
        'Администратор',
      ])

      assignRows()[0]?.click()
      await flush()

      expect(supportApi.assignTicket).toHaveBeenCalledWith('t_1', 'other_admin')
      expect(toastSuccess).toHaveBeenCalledWith('Обращение передано: Ольга Иванова')
      expect(assignSheetOpen()).toBe(false)
      // The answer row replaced the card (no second read): the caller is no
      // longer the taker, so the composer gave way to the claim notice.
      expect(supportApi.getAdminTicket).not.toHaveBeenCalled()
      expect(composer()).toBeNull()
      expect(text()).toContain('закреплено за другим администратором')
    })

    it('a 422 (the chosen admin stopped being one) toasts and re-reads the roster; the sheet stays for another pick', async () => {
      getUsersList.mockResolvedValue(roster(OLGA_USER))
      vi.mocked(supportApi.assignTicket).mockRejectedValue(
        new ApiResponseError(422, 'The assignee must be an admin'),
      )
      mount('t_1', ticket())
      await flush()

      await pickStatus('Назначить')
      const rosterReads = getUsersList.mock.calls.length
      assignRows()[0]?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Выбранный пользователь не администратор')
      expect(getUsersList.mock.calls.length).toBe(rosterReads + 1)
      expect(assignSheetOpen()).toBe(true)
      expect(supportApi.getAdminTicket).not.toHaveBeenCalled()
    })

    it('a 409 (handed over meanwhile) toasts, closes the sheet and reads the ticket again', async () => {
      getUsersList.mockResolvedValue(roster(OLGA_USER))
      vi.mocked(supportApi.assignTicket).mockRejectedValue(conflict())
      vi.mocked(supportApi.getAdminTicket).mockResolvedValue(ticket({ claimed_by: OTHER }))
      mount('t_1', ticket())
      await flush()

      await pickStatus('Назначить')
      assignRows()[0]?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Обращение изменилось — проверьте, у кого оно')
      expect(supportApi.getAdminTicket).toHaveBeenCalledWith('t_1')
      expect(assignSheetOpen()).toBe(false)
      expect(text()).toContain('закреплено за другим администратором')
    })

    it('no other admins -> the honest empty line, and nothing is sent', async () => {
      mount('t_1', ticket())
      await flush()

      await pickStatus('Назначить')

      expect(assignRows()).toEqual([])
      expect(document.body.textContent).toContain('Других администраторов нет')
      expect(supportApi.assignTicket).not.toHaveBeenCalled()
    })

    it('a failed roster read shows its own retry; the retry re-reads and lists the admins', async () => {
      getUsersList
        .mockRejectedValueOnce(new ApiResponseError(502, 'down'))
        .mockResolvedValueOnce(roster(OLGA_USER))
      mount('t_1', ticket())
      await flush()

      await pickStatus('Назначить')

      expect(document.body.textContent).toContain('Не удалось загрузить администраторов')
      const retry = Array.from(
        document.body.querySelectorAll<HTMLButtonElement>('.v-sheet__overlay .v-btn'),
      ).find((b) => b.textContent?.trim() === 'Повторить')
      retry?.click()
      await flush()

      expect(assignRows().map((r) => r.textContent?.trim() ?? '')).toEqual(['Ольга Иванова'])
    })
  })

  describe('the handover (FE-108) -- «Освободить»', () => {
    it('returns a held ticket to the pool; the answer row replaces the card', async () => {
      vi.mocked(supportApi.releaseTicket).mockResolvedValue(ticket({ claimed_by: null }))
      mount('t_1', ticket({ claimed_by: ME }))
      await flush()

      await pickStatus('Освободить')

      expect(supportApi.releaseTicket).toHaveBeenCalledWith('t_1')
      expect(toastSuccess).toHaveBeenCalledWith('Обращение возвращено в общий список')
      expect(supportApi.getAdminTicket).not.toHaveBeenCalled()
      // Back in the pool: the claim panel offers «Взять в работу» again.
      expect(composer()).toBeNull()
      expect(btnByText('Взять в работу')).toBeDefined()
    })

    it('a 409 (handed over meanwhile) toasts and reads the ticket again', async () => {
      vi.mocked(supportApi.releaseTicket).mockRejectedValue(conflict())
      vi.mocked(supportApi.getAdminTicket).mockResolvedValue(ticket({ claimed_by: OTHER }))
      mount('t_1', ticket({ claimed_by: ME }))
      await flush()

      await pickStatus('Освободить')

      expect(toastError).toHaveBeenCalledWith('Обращение изменилось — проверьте, у кого оно')
      expect(supportApi.getAdminTicket).toHaveBeenCalledWith('t_1')
      expect(text()).toContain('закреплено за другим администратором')
    })

    it('any other failure toasts and changes nothing -- no re-read', async () => {
      vi.mocked(supportApi.releaseTicket).mockRejectedValue(new ApiResponseError(502, 'down'))
      mount('t_1', ticket({ claimed_by: ME }))
      await flush()

      await pickStatus('Освободить')

      expect(toastError).toHaveBeenCalled()
      expect(supportApi.getAdminTicket).not.toHaveBeenCalled()
      expect(composer()).not.toBeNull()
    })
  })

  describe('the handover (FE-108) -- «Вернуть в работу» and «Не спам» (one reopen route)', () => {
    it('«Вернуть в работу» on a RESOLVED ticket -- the card is open again', async () => {
      vi.mocked(supportApi.reopenTicket).mockResolvedValue(
        ticket({ status: 'open', claimed_by: ME }),
      )
      mount('t_1', ticket({ status: 'resolved', claimed_by: ME }))
      await flush()

      await pickStatus('Вернуть в работу')

      expect(supportApi.reopenTicket).toHaveBeenCalledWith('t_1')
      expect(toastSuccess).toHaveBeenCalledWith('Обращение снова открыто')
      expect(badge()).toBe('Открыта')
      expect(host?.querySelector('.support-detail__processed')).toBeNull()
      expect(supportApi.getAdminTicket).not.toHaveBeenCalled()
    })

    it('«Не спам» on a FRESH spam ticket -- the same route, the card is open again', async () => {
      vi.mocked(supportApi.reopenTicket).mockResolvedValue(ticket({ status: 'open' }))
      mount('t_1', ticket({ status: 'spam', status_changed_at: daysAgo(1) }))
      await flush()

      expect(await statusOffer()).toEqual(['Назначить', 'Не спам'])

      await pickStatus('Не спам')

      expect(supportApi.reopenTicket).toHaveBeenCalledWith('t_1')
      expect(badge()).toBe('Открыта')
    })

    it('«Не спам» is NOT offered once the verdict is past the 30-day retention', async () => {
      mount('t_1', ticket({ status: 'spam', status_changed_at: daysAgo(31) }))
      await flush()

      expect(await statusOffer()).toEqual(['Назначить'])
    })

    it('a 409 (open already / changed / spam past the retention) toasts and reads the ticket again', async () => {
      vi.mocked(supportApi.reopenTicket).mockRejectedValue(conflict())
      vi.mocked(supportApi.getAdminTicket).mockResolvedValue(
        ticket({ status: 'spam', status_changed_at: daysAgo(31) }),
      )
      mount('t_1', ticket({ status: 'spam', status_changed_at: daysAgo(1) }))
      await flush()

      await pickStatus('Не спам')

      expect(toastError).toHaveBeenCalledWith(
        'Вернуть не удалось — обращение изменилось или спам старше 30 дней',
      )
      expect(supportApi.getAdminTicket).toHaveBeenCalledWith('t_1')
      // The refreshed row is past the retention -- the offer is gone.
      expect(await statusOffer()).toEqual(['Назначить'])
    })

    it('a 404 (the spam bin emptied it) -> the not-found screen, no toast, no re-read', async () => {
      vi.mocked(supportApi.reopenTicket).mockRejectedValue(
        new ApiResponseError(404, 'Ticket not found'),
      )
      mount('t_1', ticket({ status: 'spam', status_changed_at: daysAgo(1) }))
      await flush()

      await pickStatus('Не спам')

      expect(toastError).not.toHaveBeenCalled()
      expect(supportApi.getAdminTicket).not.toHaveBeenCalled()
      expect(text()).toContain('Обращение не найдено')
      expect(menuButton()).toBeNull()
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

      const rows = Array.from(host?.querySelectorAll<HTMLElement>('.bubble-row') ?? [])
      expect(rows[0]?.classList.contains('bubble-row--mine')).toBe(false)
      expect(rows[1]?.classList.contains('bubble-row--mine')).toBe(true)
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
    // Was: the reply was appended and that was all. FE-100 (BE-166): the
    // send answers comms' message, without the reply's translation for the
    // person -- the card shows it at once AND reads the feed again, so the
    // translation block of the reply comes from the server.
    it('sends, shows the reply at once, clears the draft, and reads the feed again', async () => {
      vi.mocked(supportApi.sendAdminSupportReply).mockResolvedValue({
        id: 'm_new',
        thread_id: 't_1',
        sender: 'admin_me',
        body: 'Здравствуйте',
        created_at: '2026-10-25T10:05:00Z',
      })
      let reads = 0
      vi.mocked(supportApi.getAdminSupportMessages).mockImplementation(() => {
        reads += 1
        return Promise.resolve({
          messages:
            reads === 1
              ? [message()]
              : [message({ id: 'm_new', sender: 'admin_me', body: 'Здравствуйте' }), message()],
          next_cursor: null,
        })
      })
      mount('t_1', ticket({ claimed_by: ME }))
      await flush()

      setValue(draftField(), 'Здравствуйте')
      await flush()
      btnByText('Отправить')?.click()
      await flush()

      expect(supportApi.sendAdminSupportReply).toHaveBeenCalledWith('t_1', 'Здравствуйте')
      expect(supportApi.getAdminSupportMessages).toHaveBeenCalledTimes(2)
      expect(bubbles()).toHaveLength(2) // the seeded message + the new one, once
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

  // ===========================================================================
  // FE-100 (BE-166): the translation in the card -- the marks and buttons
  // themselves are SupportMessageBubble's (its own file); here the card's
  // part: which thread a retry goes to, what a retry answer does, and the
  // poll while a message is on its way.
  describe('translation -- retry and the poll (FE-100)', () => {
    function inFlight(state: 'preparing' | 'not_requested' = 'preparing'): SupportMessage {
      return message({
        body: 'Hello',
        original: 'Hello',
        translation: { locale: 'ru', state, source_locale: null, retryable: false },
      })
    }
    function settled(): SupportMessage {
      return message({
        body: 'Привет',
        original: 'Hello',
        translation: { locale: 'ru', state: 'ready', source_locale: 'en', retryable: false },
      })
    }
    function failed(id = 'm_1', threadId = 't_1'): SupportMessage {
      return message({
        id,
        thread_id: threadId,
        body: 'Hello',
        original: 'Hello',
        translation: { locale: 'ru', state: 'impossible', source_locale: null, retryable: true },
      })
    }
    function feed(...pages: SupportMessage[][]): void {
      let i = 0
      vi.mocked(supportApi.getAdminSupportMessages).mockImplementation(() => {
        const page = pages[Math.min(i, pages.length - 1)] ?? []
        i += 1
        return Promise.resolve({ messages: page, next_cursor: null })
      })
    }
    function retryLink(): HTMLButtonElement | undefined {
      return Array.from(host?.querySelectorAll<HTMLButtonElement>('.bubble__link') ?? []).find(
        (b) => b.textContent?.trim() === 'Повторить',
      )
    }
    async function tick(ms: number): Promise<void> {
      await vi.advanceTimersByTimeAsync(ms)
      await flush()
    }
    function reads(): number {
      return vi.mocked(supportApi.getAdminSupportMessages).mock.calls.length
    }

    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('reads the feed every 5 s while a message is on its way, and stops once it settles', async () => {
      feed([inFlight()], [inFlight()], [settled()])
      mount('t_1', ticket())
      await flush()
      expect(reads()).toBe(1)
      expect(text()).toContain('Переводится…')

      await tick(4999)
      expect(reads()).toBe(1)
      await tick(1)
      expect(reads()).toBe(2)
      await tick(5000)
      expect(reads()).toBe(3)
      expect(text()).toContain('Привет')
      expect(text()).not.toContain('Переводится…')

      await tick(60000)
      expect(reads()).toBe(3)
    })

    it('`not_requested` is on its way too -- it is polled', async () => {
      feed([inFlight('not_requested')], [settled()])
      mount('t_1', ticket())
      await flush()

      await tick(5000)
      expect(reads()).toBe(2)
    })

    it('nothing on its way -> no poll at all', async () => {
      feed([settled()])
      mount('t_1', ticket())
      await flush()

      await tick(60000)
      expect(reads()).toBe(1)
    })

    it('a message that never settles is read at most 24 times, then the poll stops', async () => {
      feed([inFlight()])
      mount('t_1', ticket())
      await flush()

      await tick(5000 * 40)
      expect(reads()).toBe(1 + 24)
    })

    it('leaving the screen stops the poll', async () => {
      feed([inFlight()])
      mount('t_1', ticket())
      await flush()

      app?.unmount()
      app = null
      await tick(60000)
      expect(reads()).toBe(1)
    })

    it('a failed poll read is silent and the poll goes on', async () => {
      let i = 0
      vi.mocked(supportApi.getAdminSupportMessages).mockImplementation(() => {
        i += 1
        if (i === 2) return Promise.reject(new Error('blip'))
        return Promise.resolve({ messages: [i < 3 ? inFlight() : settled()], next_cursor: null })
      })
      mount('t_1', ticket())
      await flush()

      await tick(5000)
      await tick(5000)
      expect(reads()).toBe(3)
      expect(toastError).not.toHaveBeenCalled()
      expect(text()).toContain('Привет')
    })

    it('«Повторить» asks the ticket thread again, marks the message on its way and polls', async () => {
      feed([failed()], [settled()])
      vi.mocked(supportApi.retrySupportTranslation).mockResolvedValue({
        message_id: 'm_1',
        locale: 'ru',
        attempt: 2,
        state: 'preparing',
      })
      mount('t_1', ticket())
      await flush()
      expect(text()).toContain('Ошибка перевода')

      retryLink()?.click()
      await flush()

      expect(supportApi.retrySupportTranslation).toHaveBeenCalledWith('t_1', 'm_1')
      expect(toastSuccess).toHaveBeenCalledWith('Перевод запрошен снова')
      expect(text()).toContain('Переводится…')
      expect(retryLink()).toBeUndefined()

      await tick(5000)
      expect(reads()).toBe(2)
      expect(text()).toContain('Привет')
    })

    it('«Повторить» twice before the answer asks ONCE', async () => {
      feed([failed()])
      vi.mocked(supportApi.retrySupportTranslation).mockReturnValue(new Promise(() => {}))
      mount('t_1', ticket())
      await flush()

      const retry = retryLink()
      retry?.click()
      retry?.click()
      await flush()

      expect(supportApi.retrySupportTranslation).toHaveBeenCalledTimes(1)
    })

    it('a 409 on «Повторить» (nothing to retry) toasts and reads the feed again', async () => {
      feed([failed()], [settled()])
      vi.mocked(supportApi.retrySupportTranslation).mockRejectedValue(
        new ApiResponseError(409, 'The translation is variant, nothing to retry'),
      )
      mount('t_1', ticket())
      await flush()

      retryLink()?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Повторять нечего — перевод уже идёт или готов')
      expect(reads()).toBe(2)
      expect(text()).toContain('Привет')
    })

    it('any other failure of «Повторить» toasts and changes nothing', async () => {
      feed([failed()])
      vi.mocked(supportApi.retrySupportTranslation).mockRejectedValue(
        new ApiResponseError(404, 'Message not found in this thread'),
      )
      mount('t_1', ticket())
      await flush()

      retryLink()?.click()
      await flush()

      expect(toastError).toHaveBeenCalled()
      expect(text()).toContain('Ошибка перевода')
      expect(retryLink()).toBeDefined()
      expect(reads()).toBe(1)
    })

    it('«Повторить» in the history asks the HISTORY thread', async () => {
      vi.mocked(supportApi.getAdminSupportMessages).mockImplementation((id: string) =>
        Promise.resolve({
          messages: id === 'h_1' ? [failed('h_m', 'h_1')] : [settled()],
          next_cursor: null,
        }),
      )
      vi.mocked(supportApi.retrySupportTranslation).mockResolvedValue({
        message_id: 'h_m',
        locale: 'ru',
        attempt: 2,
        state: 'preparing',
      })
      mount('t_1', ticket({ history_thread_id: 'h_1' }))
      await flush()

      btnByText('История обращений')?.click()
      await flush()
      retryLink()?.click()
      await flush()

      expect(supportApi.retrySupportTranslation).toHaveBeenCalledWith('h_1', 'h_m')
    })

    it('a history message on its way is polled -- with the ticket feed', async () => {
      vi.mocked(supportApi.getAdminSupportMessages).mockImplementation((id: string) =>
        Promise.resolve({
          messages: id === 'h_1' ? [inFlight()] : [settled()],
          next_cursor: null,
        }),
      )
      mount('t_1', ticket({ history_thread_id: 'h_1' }))
      await flush()
      btnByText('История обращений')?.click()
      await flush()
      const before = reads()

      await tick(5000)

      const after = vi.mocked(supportApi.getAdminSupportMessages).mock.calls.slice(before)
      expect(after.map((c) => c[0])).toEqual(['t_1', 'h_1'])
    })
  })
})
