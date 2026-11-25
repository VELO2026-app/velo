// =============================================================================
// VELO Frontend -- ConsoleMastersView tests (FE-262, slice 1)
// =============================================================================
//
// What the screen decides: which masters a tab asks for, where the tab and the
// page live (the URL), what a row does, how a failed load reads, and that the
// invite dialog mints a link. Real Pinia + Pinia Colada and a real router with
// the console route names; @/api/admin is the mocked boundary.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { PiniaColada, useQueryCache } from '@pinia/colada'
import { adminKeys } from '@/composables/queries/adminKeys'
import { coladaOptions } from '@/composables/queries/setup'
import ConsoleMastersView from '@/views/console/people/ConsoleMastersView.vue'
import * as adminApi from '@/api/admin'
import type { AdminMasterListItem } from '@/api/admin'
import { ApiResponseError } from '@/api/client'
import { errorMessage } from '@/composables/useApiError'

vi.mock('@/api/admin')

// The instance options: the payout balance is the payments option's.
const options = vi.hoisted(() => ({ payments: true }))
vi.mock('@/platform/instance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/platform/instance')>()),
  isOptionEnabled: (name: string) => (name === 'payments' ? options.payments : true),
}))

vi.mock('@/utils/methodTaxonomy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/methodTaxonomy')>()
  return { ...actual, primeMethodTaxonomyCatalog: vi.fn().mockResolvedValue(undefined) }
})

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: toastSuccess, info: vi.fn() }),
}))

function master(overrides: Partial<AdminMasterListItem> = {}): AdminMasterListItem {
  return {
    id: 'm1',
    telegram_id: 101,
    first_name: 'Anna',
    last_name: 'Lebedeva',
    avatar_url: null,
    role: 'master',
    is_active: true,
    master_status: 'verified',
    methods: [],
    practices_count: 12,
    students_count: 40,
    schools_count: 0,
    available_cents: 2500,
    can_create_schools: false,
    ...overrides,
  }
}

const VERIFIED = master({ id: 'm1', first_name: 'Anna', last_name: 'Lebedeva' })
const PENDING = master({
  id: 'm2',
  first_name: 'Boris',
  last_name: 'Petrov',
  master_status: 'pending',
})
const REJECTED = master({
  id: 'm3',
  first_name: 'Clara',
  last_name: 'Sokolova',
  master_status: 'rejected',
})
const BY_STATUS: Record<string, AdminMasterListItem[]> = {
  all: [VERIFIED, PENDING, REJECTED],
  pending: [PENDING],
  rejected: [REJECTED],
}

let app: App | null = null
let root: HTMLElement | null = null
let router: Router
let pinia: Pinia

/** The server: every tab's masters, and the one-row total request of a tab. */
async function serve(status?: string, limit?: number) {
  const items = BY_STATUS[status ?? 'all'] ?? []
  return {
    items: limit === 1 ? [] : items,
    total: items.length,
    limit: limit ?? 100,
    offset: 0,
  }
}

/** Colada asks the stale lists again on focus and visibilitychange; the entries are asked the same way here. */
async function askAgain(): Promise<void> {
  await useQueryCache(pinia)
    .invalidateQueries({ key: adminKeys.masters() })
    .catch(() => {})
}

async function mount(url = '/console/masters', expectRows = true): Promise<HTMLElement> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/console/masters', name: 'console-masters', component: ConsoleMastersView },
      {
        path: '/console/masters/:id',
        name: 'console-masters-detail',
        component: { render: () => null },
      },
    ],
  })
  await router.push(url)
  pinia = createPinia()
  setActivePinia(pinia)
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp({ template: '<RouterView />' })
    .use(createTestI18n())
    .use(pinia)
    .use(PiniaColada, coladaOptions)
    .use(router)
  app.mount(root)
  if (expectRows) await vi.waitFor(() => expect(rows().length).toBeGreaterThan(0))
  return root
}

function rows(): HTMLElement[] {
  return Array.from(root?.querySelectorAll<HTMLElement>('[data-testid="console-table-row"]') ?? [])
}

function tabLabels(): string[] {
  return Array.from(root?.querySelectorAll('[role="tab"]') ?? []).map(
    (el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  )
}

function button(text: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent?.trim() === text,
  )
}

beforeEach(() => {
  options.payments = true
  toastError.mockReset()
  toastSuccess.mockReset()
  vi.mocked(adminApi.getMastersList).mockReset().mockImplementation(serve)
  vi.mocked(adminApi.inviteMaster).mockReset()
})

afterEach(() => {
  app?.unmount()
  root?.remove()
  document.body.querySelectorAll('.v-modal__overlay, .v-modal__scrim').forEach((el) => el.remove())
  app = null
  root = null
})

describe('ConsoleMastersView', () => {
  it('shows one row per master of the tab, with the total of every tab on its label', async () => {
    await mount()

    expect(rows().map((r) => r.textContent)).toEqual([
      expect.stringContaining('Anna Lebedeva'),
      expect.stringContaining('Boris Petrov'),
      expect.stringContaining('Clara Sokolova'),
    ])
    await vi.waitFor(() =>
      expect(tabLabels()).toEqual(['Все · 3', 'На проверке · 1', 'Отклонённые · 1']),
    )
  })

  it('shows the payout balance column, and drops it on an instance without payments', async () => {
    await mount()
    expect(root?.textContent).toContain('К выводу')

    app?.unmount()
    root?.remove()
    options.payments = false
    await mount()
    expect(root?.textContent).not.toContain('К выводу')
  })

  it('words each status the same way every console screen does', async () => {
    await mount()

    expect(rows().map((r) => r.querySelector('.people-pill')?.textContent?.trim())).toEqual([
      'Верифицирован',
      'Ожидает верификации',
      'Отклонён',
    ])
  })

  it('asks the server for the status of the tab and keeps the tab in the URL', async () => {
    await mount()

    root?.querySelectorAll<HTMLElement>('[role="tab"]')[1]?.click()

    await vi.waitFor(() => expect(rows().length).toBe(1))
    expect(rows()[0]?.textContent).toContain('Boris Petrov')
    expect(adminApi.getMastersList).toHaveBeenCalledWith('pending', 20, 0)
    expect(router.currentRoute.value.query).toEqual({ tab: 'pending' })
  })

  it('opens the tab and the page named by the URL', async () => {
    await mount('/console/masters?tab=rejected&page=2')

    expect(adminApi.getMastersList).toHaveBeenCalledWith('rejected', 20, 20)
  })

  it('opens the master card of a clicked row', async () => {
    await mount()

    rows()[1]?.click()

    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('console-masters-detail'))
    expect(router.currentRoute.value.params).toEqual({ id: 'm2' })
  })

  it('tells a failed load with an error state, and Retry asks again', async () => {
    vi.mocked(adminApi.getMastersList).mockRejectedValue(new Error('down'))
    await mount('/console/masters', false)
    await vi.waitFor(() =>
      expect(root?.querySelector('[data-testid="screen-error"]')).not.toBeNull(),
    )
    expect(toastError).toHaveBeenCalled()

    vi.mocked(adminApi.getMastersList).mockImplementation(async (status) => ({
      items: BY_STATUS[status ?? 'all'] ?? [],
      total: 3,
      limit: 20,
      offset: 0,
    }))
    root?.querySelector<HTMLButtonElement>('[data-testid="screen-error"] button')?.click()

    await vi.waitFor(() => expect(rows().length).toBe(3))
  })

  it('mints a one-time invite link and shows it', async () => {
    vi.mocked(adminApi.inviteMaster).mockResolvedValue({
      invite_link: 'https://t.me/bot?start=abc',
      issued_at: '2026-11-24T10:00:00Z',
    })
    await mount()

    button('Пригласить мастера')?.click()
    await vi.waitFor(() => expect(button('Создать ссылку')).toBeDefined())
    button('Создать ссылку')?.click()

    await vi.waitFor(() =>
      expect(document.body.querySelector('[data-testid="master-invite-link"]')?.textContent).toBe(
        'https://t.me/bot?start=abc',
      ),
    )
  })

  describe('background refetch', () => {
    it('keeps the table on screen while a refetch runs, then shows what it brings', async () => {
      await mount()
      let release: (page: Awaited<ReturnType<typeof serve>>) => void = () => {}
      vi.mocked(adminApi.getMastersList).mockImplementation((status, limit) =>
        limit === 1
          ? serve(status, limit)
          : new Promise((resolve) => {
              release = resolve
            }),
      )

      vi.mocked(adminApi.getMastersList).mockClear()
      const refetch = askAgain()
      await vi.waitFor(() => expect(adminApi.getMastersList).toHaveBeenCalledWith(undefined, 20, 0))

      expect(rows()).toHaveLength(3)
      expect(root?.querySelector('[data-testid="people-loading"]')).toBeNull()

      release({ items: [PENDING], total: 1, limit: 20, offset: 0 })
      await refetch
      await vi.waitFor(() => expect(rows()).toHaveLength(1))
    })

    it('failing again and again is told once, until an answer arrives', async () => {
      await mount()
      const fail = () =>
        vi
          .mocked(adminApi.getMastersList)
          .mockImplementation((status, limit) =>
            limit === 1 ? serve(status, limit) : Promise.reject(new Error('down')),
          )
      fail()

      await askAgain()
      await askAgain()
      expect(toastError).toHaveBeenCalledTimes(1)
      expect(rows()).toHaveLength(3)

      vi.mocked(adminApi.getMastersList).mockImplementation(serve)
      await askAgain()
      fail()
      await askAgain()

      expect(toastError).toHaveBeenCalledTimes(2)
    })
  })

  describe('the invite dialog', () => {
    const LINK = 'https://t.me/bot?start=abc'
    const writeText = vi.fn()

    async function openWithLink(): Promise<void> {
      vi.mocked(adminApi.inviteMaster).mockResolvedValue({
        invite_link: LINK,
        issued_at: '2026-11-24T10:00:00Z',
      })
      await mount()
      button('Пригласить мастера')?.click()
      await vi.waitFor(() => expect(button('Создать ссылку')).toBeDefined())
      button('Создать ссылку')?.click()
      await vi.waitFor(() => expect(button('Скопировать')).toBeDefined())
    }

    beforeEach(() => {
      writeText.mockReset()
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    })

    it('copies the link and says so', async () => {
      writeText.mockResolvedValue(undefined)
      await openWithLink()

      button('Скопировать')?.click()

      await vi.waitFor(() => expect(toastSuccess).toHaveBeenCalled())
      expect(writeText).toHaveBeenCalledWith(LINK)
    })

    it('tells a failed copy', async () => {
      writeText.mockRejectedValue(new Error('denied'))
      await openWithLink()

      button('Скопировать')?.click()

      await vi.waitFor(() => expect(toastError).toHaveBeenCalled())
      expect(toastSuccess).not.toHaveBeenCalled()
    })

    it('starts from the form again when it is opened a second time', async () => {
      await openWithLink()

      document.body.querySelector<HTMLElement>('.v-modal__close')?.click()
      await vi.waitFor(() => expect(document.body.querySelector('.v-modal__overlay')).toBeNull())
      button('Пригласить мастера')?.click()

      await vi.waitFor(() => expect(button('Создать ссылку')).toBeDefined())
      expect(document.body.querySelector('[data-testid="master-invite-link"]')).toBeNull()
    })

    it('names the server setup gap when the bot link is not configured', async () => {
      vi.mocked(adminApi.inviteMaster).mockRejectedValue(
        new ApiResponseError(503, 'not configured', 'bot_url_not_configured'),
      )
      await mount()

      button('Пригласить мастера')?.click()
      await vi.waitFor(() => expect(button('Создать ссылку')).toBeDefined())
      button('Создать ссылку')?.click()

      await vi.waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(errorMessage('bot_url_not_configured')),
      )
      expect(document.body.querySelector('[data-testid="master-invite-link"]')).toBeNull()
    })

    it('tells any other failure and shows no link', async () => {
      vi.mocked(adminApi.inviteMaster).mockRejectedValue(new Error('500'))
      await mount()

      button('Пригласить мастера')?.click()
      await vi.waitFor(() => expect(button('Создать ссылку')).toBeDefined())
      button('Создать ссылку')?.click()

      await vi.waitFor(() => expect(toastError).toHaveBeenCalled())
      expect(toastError).not.toHaveBeenCalledWith(errorMessage('bot_url_not_configured'))
      expect(document.body.querySelector('[data-testid="master-invite-link"]')).toBeNull()
    })
  })
})
