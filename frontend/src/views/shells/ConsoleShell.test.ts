// =============================================================================
// VELO Frontend -- ConsoleShell tests (guard-adjacent, like the other shells' tests)
// =============================================================================
//
// What the console's shell decides: where the console opens (the stub
// inside Telegram and in a small window, the menu otherwise), which menu
// item is current, the live counters on the menu and their failure toast,
// and the two ways out to the user mode. Real Pinia + Pinia Colada with
// @/api/admin mocked underneath; a small real router with the route names
// the shell links to. The platform, the window size and the clipboard are
// the mocked boundaries.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { PiniaColada, useQueryCache } from '@pinia/colada'
import { adminKeys } from '@/composables/queries/adminKeys'
import { coladaOptions } from '@/composables/queries/setup'
import ConsoleShell from '@/views/shells/ConsoleShell.vue'
import * as adminApi from '@/api/admin'
import type { AdminStatsResponse } from '@/api/types'
import { useUiStore } from '@/stores/ui'
import { CONSOLE_MODULES } from '@/utils/console/modules'

vi.mock('@/api/admin')

const env = vi.hoisted(() => ({ name: 'standalone' as 'standalone' | 'telegram', large: true }))
vi.mock('@/platform', () => ({
  platform: {
    get name() {
      return env.name
    },
    openLink: vi.fn(),
  },
}))
vi.mock('@/composables/useMediaQuery', () => ({ useMediaQuery: () => ref(env.large) }))

const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: vi.fn(), info: vi.fn() }),
}))

const StubChild = { template: '<div class="stub-child" />' }

function buildRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      ...CONSOLE_MODULES.map((m) => ({
        path: `/admin/${m.key}`,
        name: `console-${m.key}`,
        component: StubChild,
      })),
      { path: '/', name: 'user-dashboard', component: StubChild },
    ],
  })
}

function stats(overrides: Partial<AdminStatsResponse> = {}): AdminStatsResponse {
  return {
    users_count: 100,
    masters_count: 10,
    practices_count: 50,
    pending_verifications: 0,
    pending_method_changes: 0,
    ...overrides,
  }
}

let app: App | null = null
let root: HTMLElement | null = null
let pinia: Pinia
let router: Router

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

async function mount(routeName: string): Promise<HTMLElement> {
  router = buildRouter()
  await router.push({ name: routeName })
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(ConsoleShell).use(createTestI18n())
  app.use(pinia)
  app.use(PiniaColada, coladaOptions)
  app.use(router)
  app.mount(root)
  await flush()
  return root
}

function byTestId(id: string): HTMLElement | null {
  return root?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null
}

function countOn(key: string): string | null {
  return (
    byTestId(`console-nav-${key}`)
      ?.querySelector('[data-testid="console-nav-count"]')
      ?.textContent?.trim() ?? null
  )
}

beforeEach(() => {
  env.name = 'standalone'
  env.large = true
  pinia = createPinia()
  setActivePinia(pinia)
  vi.mocked(adminApi.getAdminStats).mockReset().mockResolvedValue(stats())
  vi.mocked(adminApi.getReports)
    .mockReset()
    .mockResolvedValue({ items: [], total: 0, limit: 1, offset: 0 })
  toastError.mockReset()
})

afterEach(() => {
  app?.unmount()
  root?.remove()
  app = null
  root = null
  vi.useRealTimers()
})

describe('ConsoleShell: where the console opens', () => {
  it('shows the Telegram stub inside Telegram and asks the server for nothing', async () => {
    env.name = 'telegram'
    await mount('console-dashboard')

    expect(byTestId('console-stub')?.getAttribute('data-reason')).toBe('telegram')
    expect(byTestId('console-shell')).toBeNull()
    expect(adminApi.getAdminStats).not.toHaveBeenCalled()
  })

  it('shows the small-window stub in a browser window smaller than a tablet', async () => {
    env.large = false
    await mount('console-dashboard')

    expect(byTestId('console-stub')?.getAttribute('data-reason')).toBe('narrow')
  })

  it('shows the menu with the current module marked in a large browser window', async () => {
    await mount('console-masters')

    expect(byTestId('console-shell')).not.toBeNull()
    expect(byTestId('console-nav-masters')?.getAttribute('aria-current')).toBe('page')
    expect(byTestId('console-nav-dashboard')?.getAttribute('aria-current')).toBeNull()
  })
})

describe('ConsoleShell: menu counters', () => {
  it('puts the live counters on Masters and Moderation', async () => {
    vi.mocked(adminApi.getAdminStats).mockResolvedValue(stats({ pending_verifications: 3 }))
    vi.mocked(adminApi.getReports).mockResolvedValue({ items: [], total: 7, limit: 1, offset: 0 })
    await mount('console-dashboard')

    expect(countOn('masters')).toBe('3')
    expect(countOn('moderation')).toBe('7')
  })

  it('shows no counter at zero', async () => {
    await mount('console-dashboard')

    expect(countOn('masters')).toBeNull()
    expect(countOn('moderation')).toBeNull()
  })

  it('tells of failing counters once per run of failures, until an answer arrives', async () => {
    vi.mocked(adminApi.getAdminStats).mockImplementation(() => Promise.reject(new Error('down')))
    await mount('console-dashboard')
    const askAgain = async () => {
      useQueryCache()
        .invalidateQueries({ key: adminKeys.stats() })
        .catch(() => {})
      await flush()
    }
    await askAgain()
    expect(adminApi.getAdminStats).toHaveBeenCalledTimes(2)
    expect(toastError).toHaveBeenCalledTimes(1)

    vi.mocked(adminApi.getAdminStats).mockResolvedValue(stats())
    await askAgain()
    vi.mocked(adminApi.getAdminStats).mockImplementation(() => Promise.reject(new Error('again')))
    await askAgain()

    expect(toastError).toHaveBeenCalledTimes(2)
  })
})

describe('ConsoleShell: the way to the user mode', () => {
  it('switches the UI to the user mode from the menu, then opens the user home', async () => {
    await mount('console-dashboard')

    byTestId('console-user-mode')?.click()
    await flush()

    expect(useUiStore().uiMode).toBe('user')
    expect(router.currentRoute.value.name).toBe('user-dashboard')
  })

  it('switches the UI to the user mode from the stub, then opens the user home', async () => {
    env.large = false
    await mount('console-dashboard')

    byTestId('console-stub-user-mode')?.click()
    await flush()

    expect(useUiStore().uiMode).toBe('user')
    expect(router.currentRoute.value.name).toBe('user-dashboard')
  })
})

describe('ConsoleShell: copying the console link on the stub', () => {
  function stubWithClipboard(writeText: () => Promise<void>): void {
    env.large = false
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  }

  it('copies the address asked for and says so, then reads «copy» again', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    stubWithClipboard(writeText)
    await mount('console-dashboard')
    vi.useFakeTimers()

    byTestId('console-stub-copy')?.click()
    await vi.waitFor(() =>
      expect(byTestId('console-stub-copy')?.textContent?.trim()).toBe('Ссылка скопирована'),
    )
    expect(writeText).toHaveBeenCalledWith(`${location.origin}/admin/dashboard`)

    await vi.advanceTimersByTimeAsync(3000)
    expect(byTestId('console-stub-copy')?.textContent?.trim()).toBe('Скопировать ссылку')
  })

  it('says the copy failed when the clipboard refuses', async () => {
    stubWithClipboard(() => Promise.reject(new Error('denied')))
    await mount('console-dashboard')

    byTestId('console-stub-copy')?.click()

    await vi.waitFor(() =>
      expect(byTestId('console-stub-copy')?.textContent?.trim()).toBe('Не удалось скопировать'),
    )
  })
})
