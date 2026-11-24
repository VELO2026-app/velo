// =============================================================================
// VELO Frontend -- ConsoleUsersView tests (FE-262, slice 1)
// =============================================================================
//
// The role tab decides what the server is asked for; "Make a master" is only
// on member rows and only after a confirm. Real Pinia + Pinia Colada and a
// real router; @/api/admin is the mocked boundary.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { PiniaColada, useQueryCache } from '@pinia/colada'
import { adminKeys } from '@/composables/queries/adminKeys'
import { coladaOptions } from '@/composables/queries/setup'
import ConsoleUsersView from '@/views/console/people/ConsoleUsersView.vue'
import * as adminApi from '@/api/admin'
import type { UserResponse } from '@/api/admin'

vi.mock('@/api/admin')

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: toastSuccess, info: vi.fn() }),
}))

function user(overrides: Partial<UserResponse> = {}): UserResponse {
  return {
    id: 'u1',
    telegram_id: 501,
    role: 'user',
    first_name: 'Ksenia',
    last_name: 'Morozova',
    avatar_url: null,
    timezone: 'UTC',
    language: 'ru',
    is_active: true,
    balance_cents: 0,
    created_at: '2026-11-02T10:00:00Z',
    last_login_at: null,
    onboarding_completed: true,
    master_onboarding_completed: true,
    phone: null,
    bio: null,
    email: null,
    birth_date: null,
    goals: [],
    goals_custom: null,
    role_switch: null,
    ...overrides,
  }
}

const MEMBER = user({ id: 'u1', first_name: 'Ksenia', last_name: 'Morozova', role: 'user' })
const MASTER = user({ id: 'u2', first_name: 'Anna', last_name: 'Lebedeva', role: 'master' })
const ADMIN = user({ id: 'u3', first_name: 'Daria', last_name: 'Ershova', role: 'admin' })
const ALL = [MEMBER, MASTER, ADMIN]

let app: App | null = null
let root: HTMLElement | null = null
let router: Router
let pinia: Pinia

/** The server: every user, or one role, or only the active; and the one-row total request. */
async function serve(role?: string, limit?: number, _offset?: number, isActive?: boolean) {
  const items = ALL.filter(
    (u) => (role === undefined || u.role === role) && (isActive === undefined || isActive),
  )
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
    .invalidateQueries({ key: adminKeys.users() })
    .catch(() => {})
}

async function mount(url = '/console/users', expectRows = true): Promise<HTMLElement> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/console/users', name: 'console-users', component: ConsoleUsersView }],
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

function rowButton(row: HTMLElement | undefined, text: string): HTMLButtonElement | undefined {
  return Array.from(row?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (b) => b.textContent?.trim() === text,
  )
}

function dialogButton(text: string): HTMLButtonElement | undefined {
  return Array.from(
    document.body.querySelectorAll<HTMLButtonElement>('.v-modal__overlay button'),
  ).find((b) => b.textContent?.trim() === text)
}

beforeEach(() => {
  toastError.mockReset()
  toastSuccess.mockReset()
  vi.mocked(adminApi.getUsersList).mockReset().mockImplementation(serve)
  vi.mocked(adminApi.makeMaster).mockReset()
})

afterEach(() => {
  app?.unmount()
  root?.remove()
  document.body.querySelectorAll('.v-modal__overlay, .v-modal__scrim').forEach((el) => el.remove())
  app = null
  root = null
})

describe('ConsoleUsersView', () => {
  describe('background refetch', () => {
    it('keeps the table on screen while a refetch runs, then shows what it brings', async () => {
      await mount()
      let release: (page: Awaited<ReturnType<typeof serve>>) => void = () => {}
      vi.mocked(adminApi.getUsersList).mockImplementation((role, limit, offset, isActive) =>
        limit === 1
          ? serve(role, limit, offset, isActive)
          : new Promise((resolve) => {
              release = resolve
            }),
      )

      vi.mocked(adminApi.getUsersList).mockClear()
      const refetch = askAgain()
      await vi.waitFor(() =>
        expect(adminApi.getUsersList).toHaveBeenCalledWith(undefined, 20, 0, undefined),
      )

      expect(rows()).toHaveLength(3)
      expect(root?.querySelector('[data-testid="people-loading"]')).toBeNull()

      release({ items: [MEMBER], total: 1, limit: 20, offset: 0 })
      await refetch
      await vi.waitFor(() => expect(rows()).toHaveLength(1))
    })

    it('failing again and again is told once, until an answer arrives', async () => {
      await mount()
      const fail = () =>
        vi
          .mocked(adminApi.getUsersList)
          .mockImplementation((role, limit, offset, isActive) =>
            limit === 1 ? serve(role, limit, offset, isActive) : Promise.reject(new Error('down')),
          )
      fail()

      await askAgain()
      await askAgain()
      expect(toastError).toHaveBeenCalledTimes(1)
      expect(rows()).toHaveLength(3)

      vi.mocked(adminApi.getUsersList).mockImplementation(serve)
      await askAgain()
      fail()
      await askAgain()

      expect(toastError).toHaveBeenCalledTimes(2)
    })
  })

  it('tells a failed load with an error state, and Retry asks again', async () => {
    vi.mocked(adminApi.getUsersList).mockRejectedValue(new Error('down'))
    await mount('/console/users', false)
    await vi.waitFor(() =>
      expect(root?.querySelector('[data-testid="screen-error"]')).not.toBeNull(),
    )
    expect(toastError).toHaveBeenCalled()

    vi.mocked(adminApi.getUsersList).mockImplementation(serve)
    root?.querySelector<HTMLButtonElement>('[data-testid="screen-error"] button')?.click()

    await vi.waitFor(() => expect(rows().length).toBe(3))
  })

  it('asks the server for the role of the tab', async () => {
    await mount()

    root?.querySelectorAll<HTMLElement>('[role="tab"]')[2]?.click()

    await vi.waitFor(() => expect(rows().length).toBe(1))
    expect(rows()[0]?.textContent).toContain('Anna Lebedeva')
    expect(adminApi.getUsersList).toHaveBeenCalledWith('master', 20, 0, undefined)
    expect(router.currentRoute.value.query).toEqual({ tab: 'master' })
  })

  it.each([
    ['Активные', '1', true],
    ['Неактивные', '0', false],
  ])(
    'asks the server for the %s only and keeps the filter in the URL',
    async (label, mark, flag) => {
      await mount()

      const select = root?.querySelector<HTMLSelectElement>('.users-filter select')
      if (!select) throw new Error('no activity filter')
      select.value =
        Array.from(select.options).find((o) => o.textContent?.trim() === label)?.value ?? ''
      select.dispatchEvent(new Event('change'))

      await vi.waitFor(() =>
        expect(adminApi.getUsersList).toHaveBeenCalledWith(undefined, 20, 0, flag),
      )
      // The tab totals ask under the same filter.
      expect(adminApi.getUsersList).toHaveBeenCalledWith('master', 1, 0, flag)
      expect(router.currentRoute.value.query).toEqual({ active: mark })
    },
  )

  it('offers "Make a master" on a member row only', async () => {
    await mount()

    expect(rowButton(rows()[0], 'Сделать мастером')).toBeDefined()
    expect(rowButton(rows()[1], 'Сделать мастером')).toBeUndefined()
    expect(rowButton(rows()[2], 'Сделать мастером')).toBeUndefined()
  })

  it('makes the user a master after a confirm, and not before', async () => {
    vi.mocked(adminApi.makeMaster).mockResolvedValue({ user_id: 'u1', status: 'verified' })
    await mount()

    rowButton(rows()[0], 'Сделать мастером')?.click()
    await vi.waitFor(() => expect(dialogButton('Назначить')).toBeDefined())
    expect(adminApi.makeMaster).not.toHaveBeenCalled()

    dialogButton('Назначить')?.click()

    await vi.waitFor(() => expect(adminApi.makeMaster).toHaveBeenCalledWith('u1'))
    await vi.waitFor(() => expect(toastSuccess).toHaveBeenCalled())
  })

  it('does not appoint when the confirm is cancelled', async () => {
    await mount()

    rowButton(rows()[0], 'Сделать мастером')?.click()
    await vi.waitFor(() => expect(dialogButton('Отмена')).toBeDefined())
    dialogButton('Отмена')?.click()

    await vi.waitFor(() => expect(document.body.querySelector('.v-modal__overlay')).toBeNull())
    expect(adminApi.makeMaster).not.toHaveBeenCalled()
  })

  it('tells a failed appointment and keeps the dialog for another try', async () => {
    vi.mocked(adminApi.makeMaster).mockRejectedValue(new Error('409'))
    await mount()

    rowButton(rows()[0], 'Сделать мастером')?.click()
    await vi.waitFor(() => expect(dialogButton('Назначить')).toBeDefined())
    dialogButton('Назначить')?.click()

    await vi.waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(dialogButton('Назначить')).toBeDefined()
  })
})
