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
import type { UserResponse, UserRole } from '@/api/types'

const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: vi.fn(), info: vi.fn() }),
}))

let app: App | null = null
let root: HTMLElement | null = null
let router: Router

const Stub = { render: () => null }

async function mount(role: UserRole, allowed: UserRole[]): Promise<HTMLElement> {
  setActivePinia(createPinia())
  const auth = useAuthStore()
  auth.user = {
    id: 'u1',
    role,
    role_switch: { allowed_roles: allowed },
  } as unknown as UserResponse
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

    expect(rows()).toHaveLength(2)
  })

  it('shows nothing when there is no other role', async () => {
    const el = await mount('user', ['user'])

    expect(el.querySelector('.role-switch')).toBeNull()
  })

  it('switches to admin, drops the user-mode preview and opens the console dashboard', async () => {
    await mount('user', ['user', 'admin'])
    const auth = useAuthStore()
    const switchRole = vi.spyOn(auth, 'switchRole').mockResolvedValue({} as UserResponse)
    useUiStore().setUiMode('user')

    rows()[0]?.click()
    await settle()

    expect(switchRole).toHaveBeenCalledWith('admin')
    expect(useUiStore().uiMode).toBe('default')
    expect(router.currentRoute.value.name).toBe('console-dashboard')
  })

  it('takes a freshly verified user through the approval screen once, without a switch', async () => {
    await mount('user', ['user', 'master'])
    const switchRole = vi.spyOn(useAuthStore(), 'switchRole')

    rows()[0]?.click()
    await settle()

    expect(router.currentRoute.value.name).toBe('master-pending')
    expect(switchRole).not.toHaveBeenCalled()
  })

  it('switches a user who has seen the approval straight to the master dashboard', async () => {
    localStorage.setItem(masterApprovedSeenKey('u1'), '1')
    await mount('user', ['user', 'master'])
    vi.spyOn(useAuthStore(), 'switchRole').mockResolvedValue({} as UserResponse)

    rows()[0]?.click()
    await settle()

    expect(router.currentRoute.value.name).toBe('master-dashboard')
  })

  it('tells a failed switch and stays', async () => {
    await mount('master', ['master', 'user'])
    vi.spyOn(useAuthStore(), 'switchRole').mockRejectedValue(new Error('down'))

    rows()[0]?.click()
    await settle()

    expect(toastError).toHaveBeenCalledTimes(1)
    expect(router.currentRoute.value.path).toBe('/')
  })
})
