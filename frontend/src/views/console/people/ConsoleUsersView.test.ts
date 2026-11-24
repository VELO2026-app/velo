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
import { createPinia, setActivePinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
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

async function mount(url = '/console/users'): Promise<HTMLElement> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/console/users', name: 'console-users', component: ConsoleUsersView }],
  })
  await router.push(url)
  const pinia = createPinia()
  setActivePinia(pinia)
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp({ template: '<RouterView />' })
    .use(createTestI18n())
    .use(pinia)
    .use(PiniaColada, coladaOptions)
    .use(router)
  app.mount(root)
  await vi.waitFor(() => expect(rows().length).toBeGreaterThan(0))
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
  vi.mocked(adminApi.getUsersList)
    .mockReset()
    .mockImplementation(async (role, limit) => {
      const items = role === undefined ? ALL : ALL.filter((u) => u.role === role)
      return {
        items: limit === 1 ? [] : items,
        total: items.length,
        limit: limit ?? 100,
        offset: 0,
      }
    })
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
  it('asks the server for the role of the tab', async () => {
    await mount()

    root?.querySelectorAll<HTMLElement>('[role="tab"]')[2]?.click()

    await vi.waitFor(() => expect(rows().length).toBe(1))
    expect(rows()[0]?.textContent).toContain('Anna Lebedeva')
    expect(adminApi.getUsersList).toHaveBeenCalledWith('master', 20, 0)
    expect(router.currentRoute.value.query).toEqual({ tab: 'master' })
  })

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
