// RoleSwitchSection: the roles a person may switch to, and where a switch
// lands (FE-272: the admin role lands on the web console's dashboard).
import { createTestI18n } from '@/locales/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import RoleSwitchSection from '@/components/shared/RoleSwitchSection.vue'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { masterApprovedSeenKey } from '@/utils/constants'
import { switchRole } from '@/api/users'
import type { UserResponse, UserRole } from '@/api/types'

vi.mock('@/api/users', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/users')>()),
  switchRole: vi.fn(),
}))

const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: vi.fn(), info: vi.fn() }),
}))

let app: App | null = null
let root: HTMLElement | null = null
let router: Router

const Stub = { render: () => null }

function person(role: UserRole, allowed: UserRole[]): UserResponse {
  return {
    id: 'u1',
    telegram_id: null,
    role,
    first_name: 'Anna',
    last_name: null,
    avatar_url: null,
    timezone: 'Europe/Moscow',
    language: 'ru',
    is_active: true,
    balance_cents: 0,
    created_at: '2026-11-01T00:00:00Z',
    last_login_at: null,
    onboarding_completed: true,
    master_onboarding_completed: true,
    phone: null,
    bio: null,
    email: null,
    birth_date: null,
    goals: [],
    goals_custom: null,
    role_switch: { allowed_roles: allowed },
  }
}

async function mount(role: UserRole, allowed: UserRole[]): Promise<HTMLElement> {
  setActivePinia(createPinia())
  useAuthStore().user = person(role, allowed)
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Stub },
      { path: '/user/dashboard', name: 'user-dashboard', component: Stub },
      { path: '/master/dashboard', name: 'master-dashboard', component: Stub },
      { path: '/master/pending', name: 'master-pending', component: Stub },
      { path: '/admin/dashboard', name: 'console-dashboard', component: Stub },
    ],
  })
  await router.push('/')
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(RoleSwitchSection).use(createTestI18n()).use(router)
  app.mount(root)
  await nextTick()
  return root
}

function rows(): HTMLButtonElement[] {
  return Array.from(root?.querySelectorAll<HTMLButtonElement>('button') ?? [])
}

async function settle(): Promise<void> {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

beforeEach(() => {
  toastError.mockReset()
  vi.mocked(switchRole).mockReset()
  localStorage.clear()
})

afterEach(() => {
  app?.unmount()
  root?.remove()
  app = null
  root = null
})

describe('RoleSwitchSection', () => {
  it('offers every allowed role but the current one', async () => {
    await mount('user', ['user', 'master', 'admin'])

    expect(rows().map((row) => row.textContent?.trim())).toEqual([
      'Режим мастера',
      'Режим администратора',
    ])
  })

  it('shows nothing when there is no other role', async () => {
    const el = await mount('user', ['user'])

    expect(el.querySelector('.role-switch')).toBeNull()
  })

  it('switches to admin, drops the user-mode preview and opens the console dashboard', async () => {
    await mount('user', ['user', 'admin'])
    vi.mocked(switchRole).mockResolvedValue(person('admin', ['user', 'admin']))
    useUiStore().setUiMode('user')

    rows()[0]?.click()
    await settle()

    expect(switchRole).toHaveBeenCalledWith('admin')
    expect(useAuthStore().user?.role).toBe('admin')
    expect(useUiStore().uiMode).toBe('default')
    expect(router.currentRoute.value.name).toBe('console-dashboard')
  })

  it('takes a freshly verified user through the approval screen once, without a switch', async () => {
    await mount('user', ['user', 'master'])

    rows()[0]?.click()
    await settle()

    expect(router.currentRoute.value.name).toBe('master-pending')
    expect(switchRole).not.toHaveBeenCalled()
  })

  it('switches a user who has seen the approval straight to the master dashboard', async () => {
    localStorage.setItem(masterApprovedSeenKey('u1'), '1')
    await mount('user', ['user', 'master'])
    vi.mocked(switchRole).mockResolvedValue(person('master', ['user', 'master']))

    rows()[0]?.click()
    await settle()

    expect(router.currentRoute.value.name).toBe('master-dashboard')
  })

  it('tells a failed switch and stays', async () => {
    await mount('master', ['master', 'user'])
    vi.mocked(switchRole).mockRejectedValue(new Error('down'))

    rows()[0]?.click()
    await settle()

    expect(toastError).toHaveBeenCalledTimes(1)
    expect(router.currentRoute.value.path).toBe('/')
  })
})
