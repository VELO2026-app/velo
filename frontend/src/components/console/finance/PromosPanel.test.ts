// =============================================================================
// VELO Frontend -- PromosPanel tests (FE-267)
// =============================================================================
//
// The promo codes of the web console: the table with its three tabs, the
// status of each code, deactivation after a confirmation, and the form that
// creates a company promo. A promo is money given away, so what matters is
// that a deactivation or a creation reaches the API once and with the right
// data, a refused input sends nothing, and the table catches up afterwards.
//
// The panel mounts with a real router (memory history: the tab and the page
// live in the URL), a real Pinia and Pinia Colada, as in production. The seam
// mocked is @/api/admin. `server` below is the backend: every promo newest
// first, filtered by type, sliced by limit and offset; a deactivation or a
// creation changes it. The clock is frozen so a promo's "expired" status never
// depends on the day the suite runs.
// =============================================================================

import { t } from '@/locales'
import { createTestI18n } from '@/locales/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { PiniaColada, useQueryCache } from '@pinia/colada'
import { coladaOptions } from '@/composables/queries/setup'
import { adminKeys } from '@/composables/queries/adminKeys'
import PromosPanel from '@/components/console/finance/PromosPanel.vue'
import * as adminApi from '@/api/admin'
import { ApiResponseError } from '@/api/client'
import type { AdminPromoResponse } from '@/api/admin'

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

const NOW = new Date('2026-11-25T12:00:00Z')

function promo(id: string, overrides: Partial<AdminPromoResponse> = {}): AdminPromoResponse {
  return {
    id,
    code: `CODE_${id}`,
    type: 'company',
    master_id: null,
    practice_id: null,
    discount_percent: 25,
    max_uses: 200,
    used_count: 84,
    valid_from: '2026-11-01T00:00:00Z',
    // Midday UTC: 02:00 on 1 January in the viewer's zone.
    valid_until: '2026-12-31T12:00:00Z',
    first_purchase_only: false,
    is_active: true,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: null,
    master_first_name: null,
    master_last_name: null,
    ...overrides,
  }
}

/** `count` distinguishable company promos, newest first (codes numbered from `count` down to 1). */
function companyPromos(count: number): AdminPromoResponse[] {
  return Array.from({ length: count }, (_, i) => {
    const n = count - i
    return promo(`p_${n}`, { code: `PROMO${n}` })
  })
}

/** The backend: every promo, newest first. */
let server: AdminPromoResponse[]

let app: App | null = null
let host: HTMLElement | null = null
let router: Router
let pinia: Pinia

async function mount(url = '/admin/finance?tab=promos'): Promise<HTMLElement> {
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
  app = createApp(PromosPanel)
    .use(createTestI18n())
    .use(router)
    .use(pinia)
    .use(PiniaColada, coladaOptions)
  app.mount(host)
  await flush()
  return host
}

async function flush(): Promise<void> {
  for (let n = 0; n < 6; n++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

/** The item at an index; a test that reaches past its fixture fails loudly. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index]
  if (item === undefined) throw new Error(`no item at ${index}`)
  return item
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
function codes(): string[] {
  return Array.from(host?.querySelectorAll('.promos__code') ?? []).map((el) => words(el))
}
function tab(label: string): HTMLButtonElement {
  const found = Array.from(host?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []).find(
    (el) => words(el) === label,
  )
  if (!found) throw new Error(`no tab ${label}`)
  return found
}
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
function field(label: string): HTMLInputElement | HTMLSelectElement {
  const labelEl = Array.from(dialog().querySelectorAll('label')).find((l) =>
    words(l).startsWith(label),
  )
  const id = labelEl?.getAttribute('for')
  const input = id
    ? dialog().querySelector<HTMLInputElement | HTMLSelectElement>(`#${CSS.escape(id)}`)
    : null
  if (!input) throw new Error(`no field ${label}`)
  return input
}
function fill(label: string, value: string): void {
  const input = field(label)
  input.value = value
  input.dispatchEvent(
    new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
  )
}
/** A background refetch of every list held, as a return to the app does. */
async function refetchInBackground(): Promise<void> {
  useQueryCache(pinia)
    .invalidateQueries({ key: adminKeys.promoPagesAll() })
    .catch(() => {})
  await flush()
}

type Page = Awaited<ReturnType<typeof adminApi.getAdminPromos>>
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
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  server = [
    promo('p_c', { code: 'WINTER25' }),
    promo('p_m', {
      code: 'ANNA50',
      type: 'master',
      master_id: 'm1',
      discount_percent: 50,
      max_uses: null,
      used_count: 23,
      valid_until: null,
      master_first_name: 'Анна',
      master_last_name: 'Лебедева',
    }),
  ]
  vi.mocked(adminApi.getAdminPromos)
    .mockReset()
    .mockImplementation(async (type, _isActive, limit = 20, offset = 0) => {
      const all = server.filter((p) => type === undefined || p.type === type)
      // A fresh copy per answer, as a response body is.
      return {
        items: structuredClone(all.slice(offset, offset + limit)),
        total: all.length,
        limit,
        offset,
      }
    })
  vi.mocked(adminApi.deactivateAdminPromo)
    .mockReset()
    .mockImplementation(async (id) => {
      const found = server.find((p) => p.id === id)
      if (!found) throw new Error(`no promo ${id}`)
      found.is_active = false
      return found
    })
  vi.mocked(adminApi.createCompanyPromo)
    .mockReset()
    .mockImplementation(async (body) => {
      const created = promo('p_new', {
        code: body.code.toUpperCase(),
        discount_percent: body.discount_percent,
        max_uses: body.max_uses ?? null,
        used_count: 0,
        valid_until: body.valid_until ?? null,
        first_purchase_only: body.first_purchase_only ?? false,
      })
      server.unshift(created)
      return created
    })
  toastError.mockReset()
  toastSuccess.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.useRealTimers()
  // A closed window leaks past unmount (see dialog()): the next test must not meet it.
  document.body.querySelectorAll('.v-modal__overlay, .v-modal__scrim').forEach((el) => el.remove())
})

describe('PromosPanel', () => {
  describe('the table', () => {
    it('a row says the code, whose it is, the discount, the use, the last day and the status', async () => {
      await mount()

      expect(
        Array.from(host?.querySelectorAll('[role="columnheader"]') ?? []).map((el) => words(el)),
      ).toEqual(['Код', 'Чей', 'Скидка', 'Использован', 'До', 'Статус', 'Действия'])
      expect(tableRows()).toEqual([
        [
          'WINTER25',
          `Компания ${t('common.brandName')}`,
          '25%',
          '84 / 200',
          '01.01.2027',
          'Активен',
          'Деактивировать',
        ],
        ['ANNA50', 'Анна Лебедева', '50%', '23', '—', 'Активен', 'Деактивировать'],
      ])
    })

    it('a master without a name is the generic user', async () => {
      server = [promo('p_m', { type: 'master', master_id: 'm1' })]
      await mount()

      expect(tableRows()[0]?.[1]).toBe('Пользователь')
    })

    it.each([
      { name: 'used up', over: { max_uses: 10, used_count: 10 }, status: 'Исчерпан' },
      { name: 'past its end date', over: { valid_until: '2026-11-24T00:00:00Z' }, status: 'Истёк' },
      { name: 'deactivated by hand', over: { is_active: false }, status: 'Деактивирован' },
    ])(
      'a promo that is $name says "$status" and has no deactivate button',
      async ({ over, status }) => {
        server = [promo('p_x', over)]
        await mount()

        const cells = tableRows()[0] ?? []
        expect(cells[5]).toBe(status)
        expect(cells[6]).toBe('')
        expect(host?.querySelector('[data-testid="console-table-row"] button')).toBeNull()
      },
    )

    it('says so when there are no promos', async () => {
      server = []
      await mount()

      expect(host?.textContent).toContain('Промокодов пока нет')
      expect(summary()).toBeUndefined()
    })

    it('on a medium window the owner moves under the code', async () => {
      width.medium = true
      await mount()

      expect(
        Array.from(host?.querySelectorAll('[role="columnheader"]') ?? []).map((el) => words(el)),
      ).toEqual(['Код', 'Скидка', 'Использован', 'До', 'Статус', 'Действия'])
      expect(tableRows()[1]?.[0]).toBe('ANNA50Анна Лебедева')
    })

    it('on a narrow window the end date goes under the use and the button under the status', async () => {
      width.medium = true
      width.narrow = true
      await mount()

      expect(
        Array.from(host?.querySelectorAll('[role="columnheader"]') ?? []).map((el) => words(el)),
      ).toEqual(['Код', 'Скидка', 'Использован', 'Статус'])
      const cells = tableRows()[0] ?? []
      expect(cells[2]).toBe('84 / 200до 01.01.2027')
      expect(cells[3]).toBe('АктивенДеактивировать')
    })
  })

  describe('tabs and pages', () => {
    it('a tab asks its owner from the first page; the old rows do not stand in', async () => {
      server = [...companyPromos(45), at(server, 1)]
      await mount('/admin/finance?tab=promos&page=2')

      const slow = deferred<Page>()
      vi.mocked(adminApi.getAdminPromos).mockImplementation(() => slow.promise)
      tab('Мастера').click()
      await flush()

      expect(adminApi.getAdminPromos).toHaveBeenLastCalledWith('master', undefined, 20, 0)
      expect(router.currentRoute.value.query).toEqual({ tab: 'promos', filter: 'master' })
      expect(codes()).toEqual([])
      expect(host?.querySelector('[data-testid="finance-loading"]')).not.toBeNull()

      slow.resolve({ items: [at(server, 45)], total: 1, limit: 20, offset: 0 })
      await flush()
      expect(codes()).toEqual(['ANNA50'])
    })

    it('the company tab asks for the company promos', async () => {
      await mount()

      tab('Компании').click()
      await flush()

      expect(adminApi.getAdminPromos).toHaveBeenLastCalledWith('company', undefined, 20, 0)
      expect(codes()).toEqual(['WINTER25'])
    })

    it('a tab the URL cannot mean falls back to all, and a bad page to the first', async () => {
      await mount('/admin/finance?tab=promos&filter=inactive&page=0')

      expect(adminApi.getAdminPromos).toHaveBeenCalledWith(undefined, undefined, 20, 0)
      expect(codes()).toEqual(['WINTER25', 'ANNA50'])
    })

    it('pages as the API lists: a page button loads its offset', async () => {
      server = companyPromos(45)
      await mount()

      expect(summary()).toBe('Показано 1–20 из 45')
      expect(codes()[0]).toBe('PROMO45')
      expect(pageButton(3)).toBeDefined()
      expect(pageButton(4)).toBeUndefined()

      pageButton(3)?.click()
      await flush()

      expect(adminApi.getAdminPromos).toHaveBeenLastCalledWith(undefined, undefined, 20, 40)
      expect(router.currentRoute.value.query).toEqual({ tab: 'promos', page: '3' })
      expect(codes()).toEqual(['PROMO5', 'PROMO4', 'PROMO3', 'PROMO2', 'PROMO1'])
      expect(summary()).toBe('Показано 41–45 из 45')
    })

    it('one page of results: the summary, no page buttons', async () => {
      await mount()

      expect(summary()).toBe('Показано 1–2 из 2')
      expect(host?.querySelector('.console-pager__pages')).toBeNull()
    })

    it.each([
      // 45 rows are 3 pages: page 9 goes to the last, an empty list to the first.
      {
        url: '/admin/finance?tab=promos&page=9',
        total: 45,
        query: { tab: 'promos', page: '3' },
        shown: 'Показано 41–45 из 45',
      },
      {
        url: '/admin/finance?tab=promos&page=2',
        total: 0,
        query: { tab: 'promos' },
        shown: undefined,
      },
    ])(
      'a page past the end ($url, $total rows) goes to the last page',
      async ({ url, total, query, shown }) => {
        server = companyPromos(total)
        await mount(url)

        expect(router.currentRoute.value.query).toEqual(query)
        expect(summary()).toBe(shown)
      },
    )
  })

  describe('deactivating', () => {
    it('asks first; a cancel sends nothing', async () => {
      await mount()

      button('Деактивировать промокод WINTER25').click()
      await flush()
      expect(words(dialog())).toContain('Деактивировать промокод WINTER25?')
      button('Отмена', dialog()).click()
      await flush()

      expect(adminApi.deactivateAdminPromo).not.toHaveBeenCalled()
      expect(tableRows()[0]?.[5]).toBe('Активен')
    })

    it('a confirmed deactivation reaches the API once, is told, and the row turns inactive', async () => {
      await mount()

      button('Деактивировать промокод WINTER25').click()
      await flush()
      button('Деактивировать', dialog()).click()
      await flush()

      expect(adminApi.deactivateAdminPromo).toHaveBeenCalledTimes(1)
      expect(adminApi.deactivateAdminPromo).toHaveBeenCalledWith('p_c')
      expect(toastSuccess).toHaveBeenCalledWith('Промокод деактивирован')
      expect(isDialogOpen()).toBe(false)
      // The table caught up with the server: this one is deactivated, the other is not.
      expect(tableRows().map((cells) => cells[5])).toEqual(['Деактивирован', 'Активен'])
    })

    it('a refused deactivation is told, the row stays active, and a retry goes through', async () => {
      vi.mocked(adminApi.deactivateAdminPromo).mockRejectedValueOnce(
        new ApiResponseError(500, 'Boom', 'server_error'),
      )
      await mount()

      button('Деактивировать промокод WINTER25').click()
      await flush()
      button('Деактивировать', dialog()).click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось деактивировать промокод')
      expect(tableRows()[0]?.[5]).toBe('Активен')

      // The lock is released: the same row can be tried again.
      button('Деактивировать промокод WINTER25').click()
      await flush()
      button('Деактивировать', dialog()).click()
      await flush()

      expect(adminApi.deactivateAdminPromo).toHaveBeenCalledTimes(2)
      expect(tableRows()[0]?.[5]).toBe('Деактивирован')
    })

    it('a second press while the request is in flight sends nothing more; the dialog keeps open', async () => {
      const inFlight = deferred<AdminPromoResponse>()
      vi.mocked(adminApi.deactivateAdminPromo).mockImplementation(() => inFlight.promise)
      await mount()

      button('Деактивировать промокод WINTER25').click()
      await flush()
      const confirm = button('Деактивировать', dialog())
      confirm.click()
      confirm.click()
      await flush()
      // Neither cancel nor Escape closes it under a request in flight.
      button('Отмена', dialog()).click()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await flush()

      expect(adminApi.deactivateAdminPromo).toHaveBeenCalledTimes(1)
      expect(isDialogOpen()).toBe(true)

      const first = at(server, 0)
      first.is_active = false
      inFlight.resolve(first)
      await flush()
      expect(isDialogOpen()).toBe(false)
    })
  })

  describe('creating a company promo', () => {
    async function openForm(): Promise<void> {
      button('Создать промокод').click()
      await flush()
    }
    function submit(): void {
      button('Создать промокод', dialog()).click()
    }

    it('sends the code, the discount and the optional limit, last day and first-purchase flag', async () => {
      await mount()
      await openForm()

      fill('Код', '  spring30  ')
      fill('Скидка', '50')
      fill('Лимит', '40')
      fill('Действует до', '2027-03-31')
      dialog().querySelector<HTMLButtonElement>('[role="checkbox"]')?.click()
      await flush()
      submit()
      await flush()

      expect(adminApi.createCompanyPromo).toHaveBeenCalledTimes(1)
      const body = vi.mocked(adminApi.createCompanyPromo).mock.calls[0]?.[0]
      expect(body).toMatchObject({
        code: 'spring30',
        discount_percent: 50,
        max_uses: 40,
        first_purchase_only: true,
      })
      // The last day to its last moment, in the viewer's zone (UTC+14).
      expect(body?.valid_until).toBe('2027-03-31T09:59:59.999Z')
      expect(toastSuccess).toHaveBeenCalledWith('Промокод создан')
      expect(isDialogOpen()).toBe(false)
      // The new promo heads the table.
      expect(codes()[0]).toBe('SPRING30')
    })

    it('a bare form sends only the code, the default discount and the flag off', async () => {
      await mount()
      await openForm()

      fill('Код', 'WELCOME')
      submit()
      await flush()

      expect(adminApi.createCompanyPromo).toHaveBeenCalledWith({
        code: 'WELCOME',
        discount_percent: 25,
        first_purchase_only: false,
      })
    })

    it.each([
      {
        name: 'a code under three characters',
        label: 'Код',
        value: 'ab',
        error: 'Код: от 3 до 50 символов',
      },
      {
        name: 'a code over fifty characters',
        label: 'Код',
        value: 'x'.repeat(51),
        error: 'Код: от 3 до 50 символов',
      },
      {
        name: 'a limit of zero',
        label: 'Лимит',
        value: '0',
        error: 'Укажите целое число от 1 или оставьте пустым',
      },
      {
        name: 'a fractional limit',
        label: 'Лимит',
        value: '2.5',
        error: 'Укажите целое число от 1 или оставьте пустым',
      },
      {
        name: 'a last day in the past',
        label: 'Действует до',
        value: '2026-11-24',
        error: 'Дата не может быть в прошлом',
      },
    ])('refuses $name: shows why and sends nothing', async ({ label, value, error }) => {
      await mount()
      await openForm()

      fill('Код', 'WELCOME')
      fill(label, value)
      submit()
      await flush()

      expect(adminApi.createCompanyPromo).not.toHaveBeenCalled()
      expect(shownErrors()).toEqual([error])
    })

    it('accepts the edges: a code of three, a limit of one, today as the last day', async () => {
      await mount()
      await openForm()

      fill('Код', 'abc')
      fill('Лимит', '1')
      fill('Действует до', '2026-11-26')
      submit()
      await flush()

      expect(shownErrors()).toEqual([])
      expect(adminApi.createCompanyPromo).toHaveBeenCalledTimes(1)
    })

    it("today is the viewer's today: midday UTC on 25.11 is already 26.11 in UTC+14", async () => {
      await mount()
      await openForm()

      fill('Код', 'WELCOME')
      fill('Действует до', '2026-11-25')
      submit()
      await flush()
      expect(shownErrors()).toEqual(['Дата не может быть в прошлом'])
      expect(adminApi.createCompanyPromo).not.toHaveBeenCalled()

      fill('Действует до', '2026-11-26')
      submit()
      await flush()
      expect(adminApi.createCompanyPromo).toHaveBeenCalledTimes(1)
    })

    it('the form open past midnight checks "today" at the submit, not at the opening', async () => {
      // 09:50 UTC on 25.11 is 23:50 on 25.11 in UTC+14.
      vi.setSystemTime(new Date('2026-11-25T09:50:00Z'))
      await mount()
      await openForm()
      fill('Код', 'WELCOME')
      fill('Действует до', '2026-11-25')

      // Twenty minutes on it is 26.11 for the admin: the chosen day has gone.
      vi.setSystemTime(new Date('2026-11-25T10:10:00Z'))
      submit()
      await flush()

      expect(shownErrors()).toEqual(['Дата не может быть в прошлом'])
      expect(adminApi.createCompanyPromo).not.toHaveBeenCalled()
    })

    it('a 400 that names the end date is told as a date problem, next to the field', async () => {
      vi.mocked(adminApi.createCompanyPromo).mockRejectedValueOnce(
        new ApiResponseError(400, 'valid_until must be after valid_from', 'bad_request'),
      )
      await mount()
      await openForm()

      fill('Код', 'WELCOME')
      fill('Действует до', '2026-12-01')
      submit()
      await flush()

      const words = 'Промокод не создан: дата окончания уже прошла'
      expect(toastError).toHaveBeenCalledWith(words)
      expect(shownErrors()).toEqual([words])
      expect(isDialogOpen()).toBe(true)
    })

    it('fixing a field takes its error away at once', async () => {
      await mount()
      await openForm()

      submit()
      await flush()
      expect(shownErrors()).toEqual(['Код: от 3 до 50 символов'])

      fill('Код', 'WELCOME')
      await flush()
      expect(shownErrors()).toEqual([])
    })

    it('a refusal of the server (400) is told in its own words, the form keeps what was typed, and a retry goes through', async () => {
      vi.mocked(adminApi.createCompanyPromo).mockRejectedValueOnce(
        new ApiResponseError(400, 'Promo code exists', 'bad_request'),
      )
      await mount()
      await openForm()

      fill('Код', 'WINTER25')
      submit()
      await flush()

      expect(toastError).toHaveBeenCalledWith(
        'Промокод не создан: такой код уже есть или скидка не разрешена',
      )
      expect(isDialogOpen()).toBe(true)
      expect((field('Код') as HTMLInputElement).value).toBe('WINTER25')

      fill('Код', 'WINTER26')
      submit()
      await flush()

      expect(adminApi.createCompanyPromo).toHaveBeenCalledTimes(2)
      expect(isDialogOpen()).toBe(false)
    })

    it('any other failure is the general one', async () => {
      vi.mocked(adminApi.createCompanyPromo).mockRejectedValueOnce(new Error('network'))
      await mount()
      await openForm()

      fill('Код', 'WELCOME')
      submit()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось создать промокод')
      expect(isDialogOpen()).toBe(true)
    })

    it('a second submit while the request is in flight neither sends nor checks the form; the window keeps open', async () => {
      const inFlight = deferred<AdminPromoResponse>()
      vi.mocked(adminApi.createCompanyPromo).mockImplementation(() => inFlight.promise)
      await mount()
      await openForm()
      const form = dialog().querySelector('form')
      if (!form) throw new Error('no form')
      const submitForm = () =>
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

      fill('Код', 'WELCOME')
      submitForm()
      await flush()
      // The window's button is off while the request runs, but a submit can
      // still arrive (Enter in a field). The code is emptied here: such a
      // submit must not meet the code check, it would flash an error under a
      // promo that is already on its way.
      fill('Код', '')
      await flush()
      submitForm()
      await flush()
      // Neither cancel nor the × closes the window under a request in flight.
      button('Отмена', dialog()).click()
      dialog().querySelector<HTMLButtonElement>('.v-modal__close')?.click()
      await flush()

      expect(adminApi.createCompanyPromo).toHaveBeenCalledTimes(1)
      expect(shownErrors()).toEqual([])
      expect(isDialogOpen()).toBe(true)

      inFlight.resolve(promo('p_new', { code: 'WELCOME' }))
      await flush()
      expect(isDialogOpen()).toBe(false)
    })

    it('every opening starts with a clean form', async () => {
      await mount()
      await openForm()
      fill('Код', 'DRAFT')
      fill('Скидка', '75')
      button('Отмена', dialog()).click()
      await flush()

      await openForm()

      expect((field('Код') as HTMLInputElement).value).toBe('')
      expect((field('Скидка') as HTMLSelectElement).value).toBe('25')
    })

    it.each([
      // The new company promo must be visible: the masters' tab would hide it.
      {
        from: '/admin/finance?tab=promos&filter=master',
        query: { tab: 'promos', filter: 'company' },
      },
      {
        from: '/admin/finance?tab=promos&filter=company',
        query: { tab: 'promos', filter: 'company' },
      },
    ])('after a creation on $from the admin sees the company promos', async ({ from, query }) => {
      await mount(from)
      await openForm()
      fill('Код', 'WELCOME')
      submit()
      await flush()

      expect(router.currentRoute.value.query).toEqual(query)
    })

    it('after a creation from a later page the admin lands on the first page', async () => {
      server = companyPromos(45)
      await mount('/admin/finance?tab=promos&page=3')
      await openForm()
      fill('Код', 'WELCOME')
      submit()
      await flush()

      expect(router.currentRoute.value.query).toEqual({ tab: 'promos' })
      expect(codes()[0]).toBe('WELCOME')
    })
  })

  describe('load failures', () => {
    it('a failed first load shows the error and Retry recovers', async () => {
      vi.mocked(adminApi.getAdminPromos).mockRejectedValueOnce(
        new ApiResponseError(500, 'Сервер недоступен', 'server_error'),
      )
      await mount()

      expect(host?.querySelector('.v-empty__title')?.textContent).toBe(
        'Не удалось загрузить промокоды',
      )
      expect(codes()).toEqual([])
      // The error state says it; a toast on top would tell it twice.
      expect(toastError).not.toHaveBeenCalled()

      button('Повторить').click()
      await flush()

      expect(host?.querySelector('.v-empty__title')).toBeNull()
      expect(codes()).toEqual(['WINTER25', 'ANNA50'])
    })

    describe('background refetch (a return to the app)', () => {
      it('keeps the rows on screen while it runs, then shows the fresh answer', async () => {
        await mount()
        const fresh = deferred<Page>()
        vi.mocked(adminApi.getAdminPromos).mockImplementation(() => fresh.promise)

        await refetchInBackground()

        // No loader, the cached rows stay.
        expect(host?.querySelector('[data-testid="finance-loading"]')).toBeNull()
        expect(codes()).toEqual(['WINTER25', 'ANNA50'])

        fresh.resolve({
          items: [promo('p_new', { code: 'FRESH' })],
          total: 1,
          limit: 20,
          offset: 0,
        })
        await flush()
        expect(codes()).toEqual(['FRESH'])
        expect(toastError).not.toHaveBeenCalled()
      })

      it('failing again and again is told once, until an answer arrives; the rows stay', async () => {
        await mount()
        vi.mocked(adminApi.getAdminPromos).mockImplementation(() =>
          Promise.reject(new Error('down')),
        )

        await refetchInBackground()
        await refetchInBackground()

        expect(toastError).toHaveBeenCalledTimes(1)
        expect(toastError).toHaveBeenCalledWith('Не удалось загрузить промокоды')
        expect(codes()).toEqual(['WINTER25', 'ANNA50'])
        expect(host?.querySelector('.v-empty__title')).toBeNull()

        // An answer arrives, then a new failure is told again.
        vi.mocked(adminApi.getAdminPromos).mockImplementation(async () => ({
          items: server,
          total: server.length,
          limit: 20,
          offset: 0,
        }))
        await refetchInBackground()
        vi.mocked(adminApi.getAdminPromos).mockImplementation(() =>
          Promise.reject(new Error('down again')),
        )
        await refetchInBackground()

        expect(toastError).toHaveBeenCalledTimes(2)
      })
    })
  })
})
