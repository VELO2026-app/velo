// =============================================================================
// VELO Frontend -- WithdrawalsPanel tests (FE-267)
// =============================================================================
//
// The payout queue of the web console. Every row is real money about to leave
// the company, so the properties that matter are: a verdict reaches the API
// once and with the right data, a refused input sends nothing, the queue
// catches up after a verdict, and a failed request neither empties the table
// nor is told twice.
//
// The panel mounts with a real router (memory history: the status and the page
// live in the URL), a real Pinia and Pinia Colada, as in production. The seam
// mocked is @/api/admin. `server` below is the backend: the requests of each
// status, newest first, sliced by limit and offset; a verdict moves a row to
// its new status.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount as vtuMount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { PiniaColada, useQueryCache } from '@pinia/colada'
import { coladaOptions } from '@/composables/queries/setup'
import { adminKeys } from '@/composables/queries/adminKeys'
import WithdrawalsPanel from '@/components/console/finance/WithdrawalsPanel.vue'
import WithdrawalRejectModal from '@/components/console/finance/WithdrawalRejectModal.vue'
import * as adminApi from '@/api/admin'
import { ApiResponseError } from '@/api/client'
import type { AdminWithdrawalResponse, WithdrawalStatus } from '@/api/admin'

vi.mock('@/api/admin')

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: toastSuccess, info: vi.fn() }),
}))

// The viewer's time zone is their profile's. Kiritimati (UTC+14, no daylight
// saving) is no zone a machine or CI runs in, so a date that ignored the
// profile and used the runtime's zone would show a different day.
vi.mock('@/composables/useViewerTimezone', async () => {
  const { ref } = await import('vue')
  return { useViewerTimezone: () => ref('Pacific/Kiritimati') }
})

// The window width classes (composables/useConsoleWidth.ts): happy-dom is
// 1024 px wide, so the test sets them. Default: the wide layout.
const width = vi.hoisted(() => ({ narrow: false, medium: false }))
vi.mock('@/composables/useConsoleWidth', async () => {
  const { ref } = await import('vue')
  return { useConsoleWidth: () => ({ narrow: ref(width.narrow), medium: ref(width.medium) }) }
})

function request(
  id: string,
  overrides: Partial<AdminWithdrawalResponse> = {},
): AdminWithdrawalResponse {
  return {
    id,
    user_id: `user_${id}`,
    master_name: 'Anna Lebedeva',
    amount_cents: 68200,
    fee_cents: 150,
    currency: 'EUR',
    status: 'pending',
    payout_details: {
      method: 'bank_transfer',
      details: { iban: 'DE89 3704 0044 0532 0130 00', account_holder: 'Игорь Петров' },
    },
    admin_id: null,
    admin_note: null,
    approved_at: null,
    rejected_at: null,
    created_at: '2026-11-24T09:12:00Z',
    updated_at: null,
    ...overrides,
  }
}

/** `count` distinguishable pending requests, newest first (holders numbered from `count` down to 1). */
function pendingQueue(count: number): AdminWithdrawalResponse[] {
  return Array.from({ length: count }, (_, i) => {
    const n = count - i
    return request(`w_${n}`, { amount_cents: n * 1000, payout_details: holder(`Мастер ${n}`) })
  })
}

function holder(name: string): AdminWithdrawalResponse['payout_details'] {
  return {
    method: 'bank_transfer',
    details: { iban: 'DE89 3704 0044 0532 0130 00', account_holder: name },
  }
}

/** The backend: each status's requests, newest first. */
let server: Record<WithdrawalStatus, AdminWithdrawalResponse[]>

/** A verdict as the backend applies it: the row leaves pending and heads the new status. */
function decide(
  id: string,
  status: 'approved' | 'rejected',
  note: string | null,
): AdminWithdrawalResponse {
  const at = server.pending.findIndex((w) => w.id === id)
  const row = server.pending.splice(at, 1)[0]
  if (row === undefined) throw new Error(`no pending request ${id}`)
  const decided: AdminWithdrawalResponse = {
    ...row,
    status,
    admin_note: note,
    ...(status === 'approved'
      ? { approved_at: '2026-11-25T10:00:00Z' }
      : { rejected_at: '2026-11-25T10:00:00Z' }),
  }
  server[status].unshift(decided)
  return decided
}

let wrapper: VueWrapper | null = null
let host: HTMLElement | null = null
let router: Router
let pinia: Pinia

async function mount(url = '/admin/finance?tab=withdrawals'): Promise<HTMLElement> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/admin/finance', name: 'console-finance', component: { render: () => null } },
    ],
  })
  await router.push(url)
  await router.isReady()
  host = document.createElement('div')
  document.body.appendChild(host)
  pinia = createPinia()
  setActivePinia(pinia)
  wrapper = vtuMount(WithdrawalsPanel, {
    attachTo: host,
    global: { plugins: [createTestI18n(), router, pinia, [PiniaColada, coladaOptions]] },
  })
  await flush()
  return host
}

async function flush(): Promise<void> {
  for (let n = 0; n < 6; n++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

function mountedWrapper(): VueWrapper {
  if (!wrapper) throw new Error('not mounted')
  return wrapper
}
function mounted(): HTMLElement {
  if (!host) throw new Error('not mounted')
  return host
}

/** The text of a node with every run of spaces (a no-break one too) as one plain space. */
function words(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function tableRows(): string[][] {
  return Array.from(host?.querySelectorAll('[data-testid="console-table-row"]') ?? []).map((row) =>
    Array.from(row.querySelectorAll('[role="cell"]')).map((cell) => words(cell)),
  )
}
function holders(): string[] {
  return tableRows().map((cells) => cells[0]?.split(' · ')[0] ?? '')
}
function tab(label: string): HTMLButtonElement {
  const found = Array.from(host?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []).find(
    (el) => words(el).startsWith(label),
  )
  if (!found) throw new Error(`no tab ${label}`)
  return found
}
function tabLabels(): string[] {
  return Array.from(host?.querySelectorAll('[role="tab"]') ?? []).map((el) => words(el))
}
/** A button by its accessible name, in the table (`host`) or in the open dialog. */
function button(name: RegExp | string, root?: ParentNode): HTMLButtonElement {
  const found = Array.from((root ?? mounted()).querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => {
      const label = (b.getAttribute('aria-label') ?? words(b)).replace(/\s+/g, ' ')
      return typeof name === 'string' ? label === name : name.test(label)
    },
  )
  if (!found) throw new Error(`no button ${String(name)}`)
  return found
}
// A closed teleported window leaks in happy-dom (its leave <Transition> never
// ends), so the newest one is the one on screen; whether one IS on screen is
// the kit's own contract: the page under an open window is inert.
function dialog(): HTMLElement {
  const found = Array.from(document.body.querySelectorAll<HTMLElement>('[role="dialog"]')).pop()
  if (!found) throw new Error('no dialog')
  return found
}
function isDialogOpen(): boolean {
  return host?.hasAttribute('inert') ?? false
}
/** The error lines the open window shows: the kit keeps a collapsed line's text in the DOM, aria-hidden. */
function shownErrors(): string[] {
  return Array.from(
    dialog().querySelectorAll('.v-field-error:not([aria-hidden]) .v-field-error__text'),
  ).map((el) => words(el))
}
function pageButton(n: number): HTMLButtonElement | undefined {
  return host?.querySelector<HTMLButtonElement>(`button[aria-label="Страница ${n}"]`) ?? undefined
}
function summary(): string | undefined {
  return host?.querySelector('[data-testid="console-pager-summary"]')?.textContent ?? undefined
}
function type(textarea: HTMLTextAreaElement, text: string): void {
  textarea.value = text
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}
/** A background refetch of every list held, as a return to the app does. */
async function refetchInBackground(): Promise<void> {
  useQueryCache(pinia)
    .invalidateQueries({ key: adminKeys.withdrawals() })
    .catch(() => {})
  await flush()
}

type Page = Awaited<ReturnType<typeof adminApi.getAdminWithdrawals>>
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  width.narrow = false
  width.medium = false
  server = { pending: pendingQueue(2), approved: [], rejected: [] }
  vi.mocked(adminApi.getAdminWithdrawals)
    .mockReset()
    .mockImplementation(async (status = 'pending', limit = 20, offset = 0) => ({
      // A fresh copy per answer, as a response body is.
      items: structuredClone(server[status].slice(offset, offset + limit)),
      total: server[status].length,
      limit,
      offset,
    }))
  vi.mocked(adminApi.approveWithdrawal)
    .mockReset()
    .mockImplementation(async (id) => decide(id, 'approved', null))
  vi.mocked(adminApi.rejectWithdrawal)
    .mockReset()
    .mockImplementation(async (id, note) => decide(id, 'rejected', note))
  toastError.mockReset()
  toastSuccess.mockReset()
})

afterEach(() => {
  wrapper?.unmount()
  host?.remove()
  wrapper = null
  host = null
  // A closed window leaks past unmount (see dialog()): the next test must not meet it.
  document.body.querySelectorAll('.v-modal__overlay, .v-modal__scrim').forEach((el) => el.remove())
})

describe('WithdrawalsPanel', () => {
  describe('the queue', () => {
    it('a pending row says who, how much, to where and when, and offers the two verdicts', async () => {
      server.pending = [
        request('w_a'),
        request('w_b', {
          amount_cents: 50000,
          fee_cents: 200,
          payout_details: { method: 'paypal', details: { email: 'oleg.kim@example.com' } },
        }),
      ]
      await mount()

      const rows = tableRows()
      expect(rows).toHaveLength(2)
      // Master, amount, net, details, requested, actions.
      expect(rows[0]?.slice(0, 4)).toEqual([
        'Игорь Петров',
        '682,00 €',
        '680,50 €',
        'IBAN DE89 •••• 3000',
      ])
      // 09:12 UTC, read in the viewer's zone (UTC+14).
      expect(rows[0]?.[4]).toBe('24.11, 23:12')
      expect(
        Array.from(
          host
            ?.querySelectorAll('[data-testid="console-table-row"]')[0]
            ?.querySelectorAll('button') ?? [],
        ).map((b) => words(b)),
      ).toEqual(['Одобрить', 'Отклонить'])
      // No master name on the request (BE-226): a dash, not another field's value.
      expect(rows[1]?.slice(0, 4)).toEqual(['—', '500,00 €', '498,00 €', 'oleg.kim@example.com'])
      expect(
        Array.from(host?.querySelectorAll('[role="columnheader"]') ?? []).map((el) => words(el)),
      ).toEqual(['Получатель', 'Сумма', 'К выплате', 'Реквизиты', 'Запрошено', 'Действия'])
    })

    it('the pending tab carries the number of requests awaiting a verdict', async () => {
      server.pending = pendingQueue(3)
      await mount()

      expect(tabLabels()).toEqual(['Ожидают · 3', 'Одобрены', 'Отклонены'])
    })

    it('says so when the queue is empty, and shows no pending counter', async () => {
      server.pending = []
      await mount()

      expect(host?.textContent).toContain('Запросов на выплату нет')
      expect(tabLabels()[0]).toBe('Ожидают')
      expect(summary()).toBeUndefined()
    })

    it('a status tab asks that status from its first page and shows what was decided', async () => {
      server.approved = [
        request('w_ok', { status: 'approved', approved_at: '2026-11-21T10:00:00Z' }),
      ]
      server.rejected = [
        request('w_no', {
          status: 'rejected',
          rejected_at: '2026-11-20T09:00:00Z',
          admin_note: 'Реквизиты не совпадают с данными мастера',
        }),
      ]
      await mount()

      tab('Одобрены').click()
      await flush()
      expect(adminApi.getAdminWithdrawals).toHaveBeenCalledWith('approved', 20, 0)
      expect(router.currentRoute.value.query).toEqual({ tab: 'withdrawals', status: 'approved' })
      let cells = tableRows()[0] ?? []
      expect(cells[5]).toBe('Одобрена22.11, 00:00')
      // A decided request has no verdict buttons.
      expect(host?.querySelector('[data-testid="console-table-row"] button')).toBeNull()

      tab('Отклонены').click()
      await flush()
      expect(adminApi.getAdminWithdrawals).toHaveBeenCalledWith('rejected', 20, 0)
      cells = tableRows()[0] ?? []
      expect(cells[5]).toContain('Отклонена')
      expect(cells[5]).toContain('Реквизиты не совпадают с данными мастера')
      expect(host?.querySelector('[data-testid="console-table-row"] button')).toBeNull()
    })

    it('a status the URL cannot mean falls back to pending, and a bad page to the first', async () => {
      await mount('/admin/finance?tab=withdrawals&status=archive&page=-3')

      expect(adminApi.getAdminWithdrawals).toHaveBeenCalledWith('pending', 20, 0)
      expect(
        vi.mocked(adminApi.getAdminWithdrawals).mock.calls.map(([status]) => status),
      ).not.toContain('archive')
      expect(holders()).toEqual(['Мастер 2', 'Мастер 1'])
    })

    it('on a medium window the details and the net amount move under the master and the amount', async () => {
      width.medium = true
      await mount()

      expect(
        Array.from(host?.querySelectorAll('[role="columnheader"]') ?? []).map((el) => words(el)),
      ).toEqual(['Получатель', 'Сумма', 'Запрошено', 'Действия'])
      const rows = tableRows()
      expect(rows[0]?.[0]).toContain('IBAN DE89 •••• 3000')
      expect(rows[0]?.[1]).toBe('20,00 €К выплате 18,50 €')
    })

    it('on a narrow window the date moves under the master too', async () => {
      width.medium = true
      width.narrow = true
      await mount()

      expect(
        Array.from(host?.querySelectorAll('[role="columnheader"]') ?? []).map((el) => words(el)),
      ).toEqual(['Получатель', 'Сумма', 'Действия'])
      expect(tableRows()[0]?.[0]).toContain('24.11, 23:12')
    })
  })

  describe('pages', () => {
    it('pages the queue as the API lists it: a page button loads its offset', async () => {
      server.pending = pendingQueue(45)
      await mount()

      expect(summary()).toBe('Показано 1–20 из 45')
      expect(holders()[0]).toBe('Мастер 45')
      expect(pageButton(3)).toBeDefined()
      expect(pageButton(4)).toBeUndefined()

      pageButton(3)?.click()
      await flush()

      expect(adminApi.getAdminWithdrawals).toHaveBeenLastCalledWith('pending', 20, 40)
      expect(router.currentRoute.value.query).toEqual({ tab: 'withdrawals', page: '3' })
      expect(holders()).toEqual(['Мастер 5', 'Мастер 4', 'Мастер 3', 'Мастер 2', 'Мастер 1'])
      expect(summary()).toBe('Показано 41–45 из 45')
      expect(pageButton(3)?.getAttribute('aria-current')).toBe('page')
    })

    it('one page of results: the summary, no page buttons', async () => {
      await mount()

      expect(summary()).toBe('Показано 1–2 из 2')
      expect(host?.querySelector('.console-pager__pages')).toBeNull()
    })

    it.each([
      // 45 rows are 3 pages: page 9 goes to the last, an empty queue to the first.
      {
        url: '/admin/finance?tab=withdrawals&page=9',
        total: 45,
        query: { tab: 'withdrawals', page: '3' },
        shown: 'Показано 41–45 из 45',
      },
      {
        url: '/admin/finance?tab=withdrawals&page=2',
        total: 0,
        query: { tab: 'withdrawals' },
        shown: undefined,
      },
    ])(
      'a page past the end ($url, $total rows) goes to the last page',
      async ({ url, total, query, shown }) => {
        server.pending = pendingQueue(total)
        await mount(url)

        expect(router.currentRoute.value.query).toEqual(query)
        expect(summary()).toBe(shown)
      },
    )

    it('a status tab starts at its first page', async () => {
      server.pending = pendingQueue(45)
      server.approved = [request('w_ok', { status: 'approved' })]
      await mount('/admin/finance?tab=withdrawals&page=2')

      tab('Одобрены').click()
      await flush()

      expect(router.currentRoute.value.query).toEqual({ tab: 'withdrawals', status: 'approved' })
    })
  })

  describe('approving', () => {
    it('shows the recap, then approves once, tells it, and the queue catches up', async () => {
      server.pending = [request('w_a'), request('w_b', { payout_details: holder('Олег Ким') })]
      await mount()

      button('Одобрить выплату 682,00 €').click()
      await flush()
      // The recap the admin checks before an irreversible payout.
      const recap = Array.from(dialog().querySelectorAll('.cpm__row')).map((row) => [
        words(row.firstElementChild),
        words(row.lastElementChild),
      ])
      expect(recap).toEqual([
        ['Сумма', '682,00 €'],
        ['Комиссия провайдера', '1,50 €'],
        ['К получению', '680,50 €'],
        ['Банк', 'IBAN DE89 •••• 3000'],
        ['Получатель', 'Игорь Петров'],
      ])
      expect(adminApi.approveWithdrawal).not.toHaveBeenCalled()

      button('Одобрить выплату', dialog()).click()
      await flush()

      expect(adminApi.approveWithdrawal).toHaveBeenCalledTimes(1)
      expect(adminApi.approveWithdrawal).toHaveBeenCalledWith('w_a')
      expect(toastSuccess).toHaveBeenCalledWith('Выплата одобрена')
      expect(isDialogOpen()).toBe(false)
      // The request left the queue, the counter went down.
      expect(holders()).toEqual(['Олег Ким'])
      expect(tabLabels()[0]).toBe('Ожидают · 1')
    })

    it('a refused approval is told, the recap stays and the request stays; a retry goes through', async () => {
      server.pending = [request('w_a')]
      vi.mocked(adminApi.approveWithdrawal).mockRejectedValueOnce(
        new ApiResponseError(500, 'Boom', 'server_error'),
      )
      await mount()

      button(/^Одобрить/).click()
      await flush()
      button('Одобрить выплату', dialog()).click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось одобрить выплату')
      expect(toastSuccess).not.toHaveBeenCalled()
      expect(isDialogOpen()).toBe(true)
      expect(holders()).toEqual(['Игорь Петров'])

      button('Одобрить выплату', dialog()).click()
      await flush()

      expect(adminApi.approveWithdrawal).toHaveBeenCalledTimes(2)
      expect(toastSuccess).toHaveBeenCalledWith('Выплата одобрена')
      expect(isDialogOpen()).toBe(false)
      expect(holders()).toEqual([])
    })

    it('a 409 means another admin decided it first: told so, the window closes, the queue is read again', async () => {
      server.pending = [request('w_a'), request('w_b', { payout_details: holder('Олег Ким') })]
      // Another admin approves w_a while this one has the recap open.
      vi.mocked(adminApi.approveWithdrawal).mockImplementation(async () => {
        decide('w_a', 'approved', null)
        throw new ApiResponseError(409, 'Withdrawal is not pending', 'conflict')
      })
      await mount()
      expect(holders()).toEqual(['Игорь Петров', 'Олег Ким'])

      button('Одобрить выплату 682,00 €').click()
      await flush()
      button('Одобрить выплату', dialog()).click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Эту выплату уже обработали')
      expect(toastError).toHaveBeenCalledTimes(1)
      expect(isDialogOpen()).toBe(false)
      // The decided request left the queue and the counter followed.
      expect(holders()).toEqual(['Олег Ким'])
      expect(tabLabels()[0]).toBe('Ожидают · 1')
    })

    it('a second press while the request is in flight sends nothing more; the window keeps open', async () => {
      server.pending = [request('w_a')]
      const inFlight = deferred<AdminWithdrawalResponse>()
      vi.mocked(adminApi.approveWithdrawal).mockImplementation(() => inFlight.promise)
      await mount()

      button(/^Одобрить/).click()
      await flush()
      const confirm = button('Одобрить выплату', dialog())
      confirm.click()
      confirm.click()
      await flush()
      // The × of the window does not close it under a payout in flight.
      dialog().querySelector<HTMLButtonElement>('.v-modal__close')?.click()
      await flush()

      expect(adminApi.approveWithdrawal).toHaveBeenCalledTimes(1)
      expect(isDialogOpen()).toBe(true)

      inFlight.resolve(decide('w_a', 'approved', null))
      await flush()
      expect(isDialogOpen()).toBe(false)
    })

    it('while a verdict is in flight the verdict buttons of every row are off; after it, on again', async () => {
      server.pending = pendingQueue(2)
      const inFlight = deferred<AdminWithdrawalResponse>()
      vi.mocked(adminApi.approveWithdrawal).mockImplementation(() => inFlight.promise)
      await mount()
      const rowButtons = () =>
        Array.from(
          host?.querySelectorAll<HTMLButtonElement>('[data-testid="console-table-row"] button') ??
            [],
        )
      expect(rowButtons().every((b) => !b.disabled)).toBe(true)

      button(/^Одобрить/).click()
      await flush()
      button('Одобрить выплату', dialog()).click()
      await flush()
      expect(rowButtons()).toHaveLength(4)
      expect(rowButtons().every((b) => b.disabled)).toBe(true)

      inFlight.resolve(decide('w_2', 'approved', null))
      await flush()
      expect(rowButtons()).toHaveLength(2)
      expect(rowButtons().every((b) => !b.disabled)).toBe(true)
    })
  })

  describe('rejecting', () => {
    function reasonField(): HTMLTextAreaElement {
      const field = dialog().querySelector('textarea')
      if (!field) throw new Error('no reason field')
      return field
    }

    it('needs a reason: an empty one sends nothing and says so; a reason goes trimmed', async () => {
      server.pending = [request('w_a'), request('w_b', { payout_details: holder('Олег Ким') })]
      await mount()

      button(/^Отклонить/).click()
      await flush()
      button('Отклонить выплату', dialog()).click()
      await flush()

      expect(adminApi.rejectWithdrawal).not.toHaveBeenCalled()
      expect(shownErrors()).toEqual(['Укажите причину отклонения'])
      // Typing blanks keeps the error; typing a reason takes it away at once.
      type(reasonField(), '   ')
      await flush()
      expect(shownErrors()).toEqual(['Укажите причину отклонения'])
      type(reasonField(), '  Реквизиты не совпадают  ')
      await flush()
      expect(shownErrors()).toEqual([])

      button('Отклонить выплату', dialog()).click()
      await flush()

      expect(adminApi.rejectWithdrawal).toHaveBeenCalledTimes(1)
      expect(adminApi.rejectWithdrawal).toHaveBeenCalledWith('w_a', 'Реквизиты не совпадают')
      expect(toastSuccess).toHaveBeenCalledWith('Выплата отклонена')
      expect(isDialogOpen()).toBe(false)
      expect(holders()).toEqual(['Олег Ким'])
    })

    it('a request that was refused is told, the window and the typed reason stay', async () => {
      server.pending = [request('w_a')]
      vi.mocked(adminApi.rejectWithdrawal).mockRejectedValueOnce(
        new ApiResponseError(500, 'Boom', 'server_error'),
      )
      await mount()

      button(/^Отклонить/).click()
      await flush()
      type(reasonField(), 'Не тот IBAN')
      await flush()
      button('Отклонить выплату', dialog()).click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось отклонить выплату')
      expect(isDialogOpen()).toBe(true)
      expect(reasonField().value).toBe('Не тот IBAN')
      expect(holders()).toEqual(['Игорь Петров'])
    })

    it('a 409 on a rejection is the same: told so, the window closes, the queue is read again', async () => {
      server.pending = [request('w_a'), request('w_b', { payout_details: holder('Олег Ким') })]
      vi.mocked(adminApi.rejectWithdrawal).mockImplementation(async () => {
        decide('w_a', 'approved', null)
        throw new ApiResponseError(409, 'Withdrawal is not pending', 'conflict')
      })
      await mount()

      button('Отклонить выплату 682,00 €').click()
      await flush()
      type(reasonField(), 'Не тот IBAN')
      await flush()
      button('Отклонить выплату', dialog()).click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Эту выплату уже обработали')
      expect(isDialogOpen()).toBe(false)
      expect(holders()).toEqual(['Олег Ким'])
    })

    it('the reason field takes no more than the server accepts', async () => {
      await mount()

      button(/^Отклонить/).click()
      await flush()

      expect(reasonField().getAttribute('maxlength')).toBe('1000')
    })

    it('a second confirm while the first is in flight neither sends nor checks the field', async () => {
      server.pending = [request('w_a')]
      const inFlight = deferred<AdminWithdrawalResponse>()
      vi.mocked(adminApi.rejectWithdrawal).mockImplementation(() => inFlight.promise)
      await mount()

      button(/^Отклонить/).click()
      await flush()
      type(reasonField(), 'Не тот IBAN')
      await flush()
      const modal = mountedWrapper().findComponent(WithdrawalRejectModal)
      modal.vm.$emit('confirm')
      await flush()
      // The window's button is off while the request runs, but a confirm can
      // still arrive (a press before the repaint). The field is emptied here:
      // such a confirm must not meet the empty-field check, it would flash an
      // error under a refusal that is already on its way.
      type(reasonField(), '')
      await flush()
      modal.vm.$emit('confirm')
      await flush()

      expect(adminApi.rejectWithdrawal).toHaveBeenCalledTimes(1)
      expect(shownErrors()).toEqual([])

      inFlight.resolve(decide('w_a', 'rejected', 'Не тот IBAN'))
      await flush()
    })

    it('cancel closes the window and sends nothing; the next opening starts with an empty field', async () => {
      await mount()

      button(/^Отклонить/).click()
      await flush()
      type(reasonField(), 'Черновик причины')
      await flush()
      button('Отмена', dialog()).click()
      await flush()
      expect(isDialogOpen()).toBe(false)

      button(/^Отклонить/).click()
      await flush()
      expect(reasonField().value).toBe('')
      expect(adminApi.rejectWithdrawal).not.toHaveBeenCalled()
    })
  })

  describe('load failures', () => {
    it('a failed first load shows the error and Retry recovers', async () => {
      vi.mocked(adminApi.getAdminWithdrawals).mockRejectedValueOnce(
        new ApiResponseError(500, 'Сервер недоступен', 'server_error'),
      )
      await mount()

      expect(host?.querySelector('.v-empty__title')?.textContent).toBe(
        'Не удалось загрузить выплаты',
      )
      expect(holders()).toEqual([])
      // The error state says it; a toast on top would tell it twice.
      expect(toastError).not.toHaveBeenCalled()

      button('Повторить').click()
      await flush()

      expect(host?.querySelector('.v-empty__title')).toBeNull()
      expect(holders()).toEqual(['Мастер 2', 'Мастер 1'])
    })

    it('a status switch shows the loader, never the rows of the other status', async () => {
      server.approved = [
        request('w_ok', { status: 'approved', payout_details: holder('Анна Одобренная') }),
      ]
      await mount()
      const slow = deferred<Page>()
      vi.mocked(adminApi.getAdminWithdrawals).mockImplementation(() => slow.promise)

      tab('Одобрены').click()
      await flush()

      expect(holders()).toEqual([])
      expect(host?.querySelector('[data-testid="finance-loading"]')).not.toBeNull()

      slow.resolve({ items: server.approved, total: 1, limit: 20, offset: 0 })
      await flush()
      expect(holders()).toEqual(['Анна Одобренная'])
    })

    describe('background refetch (a return to the app)', () => {
      it('keeps the rows on screen while it runs, then shows the fresh answer', async () => {
        await mount()
        expect(holders()).toEqual(['Мастер 2', 'Мастер 1'])
        const fresh = deferred<Page>()
        vi.mocked(adminApi.getAdminWithdrawals).mockImplementation(() => fresh.promise)

        await refetchInBackground()

        // No loader, the cached rows stay.
        expect(host?.querySelector('[data-testid="finance-loading"]')).toBeNull()
        expect(holders()).toEqual(['Мастер 2', 'Мастер 1'])

        fresh.resolve({
          items: [request('w_new', { payout_details: holder('Новая заявка') })],
          total: 1,
          limit: 20,
          offset: 0,
        })
        await flush()
        expect(holders()).toEqual(['Новая заявка'])
        expect(toastError).not.toHaveBeenCalled()
      })

      it('failing again and again is told once, until an answer arrives; the rows stay', async () => {
        await mount()
        vi.mocked(adminApi.getAdminWithdrawals).mockImplementation(() =>
          Promise.reject(new Error('down')),
        )

        await refetchInBackground()
        await refetchInBackground()

        expect(toastError).toHaveBeenCalledTimes(1)
        expect(toastError).toHaveBeenCalledWith('Не удалось загрузить выплаты')
        expect(holders()).toEqual(['Мастер 2', 'Мастер 1'])
        expect(host?.querySelector('.v-empty__title')).toBeNull()

        // An answer arrives, then a new failure is told again.
        vi.mocked(adminApi.getAdminWithdrawals).mockImplementation(async (status = 'pending') => ({
          items: server[status],
          total: server[status].length,
          limit: 20,
          offset: 0,
        }))
        await refetchInBackground()
        vi.mocked(adminApi.getAdminWithdrawals).mockImplementation(() =>
          Promise.reject(new Error('down again')),
        )
        await refetchInBackground()

        expect(toastError).toHaveBeenCalledTimes(2)
      })
    })
  })
})
