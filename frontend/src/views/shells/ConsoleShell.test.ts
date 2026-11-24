// =============================================================================
// VELO Frontend -- ConsoleShell tests (guard-adjacent, like AdminShell.test.ts)
// =============================================================================
//
// What the shell decides: where the console opens (stub inside Telegram and
// in a narrow window, the menu otherwise), which menu item is current, and
// the live counters on the menu. Real Pinia + Pinia Colada with @/api/admin
// mocked underneath; a small real router with the console route names. The
// platform and the window width are the mocked boundaries.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { coladaOptions } from '@/composables/queries/setup'
import ConsoleShell from '@/views/shells/ConsoleShell.vue'
import * as adminApi from '@/api/admin'
import type { AdminStatsResponse } from '@/api/types'
import { CONSOLE_MODULES } from '@/views/console/consoleNav'

vi.mock('@/api/admin')

const env = vi.hoisted(() => ({ name: 'standalone' as 'standalone' | 'telegram', wide: true }))
vi.mock('@/platform', () => ({
  platform: {
    get name() {
      return env.name
    },
    openLink: vi.fn(),
  },
}))
vi.mock('@/composables/useMediaQuery', () => ({ useMediaQuery: () => ref(env.wide) }))

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
        path: `/console/${m.key}`,
        name: `console-${m.key}`,
        component: StubChild,
      })),
      { path: '/', name: 'user-dashboard', component: StubChild },
      { path: '/admin', name: 'admin-dashboard', component: StubChild },
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

async function mount(routeName: string): Promise<HTMLElement> {
  const router = buildRouter()
  await router.push({ name: routeName })
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(ConsoleShell).use(createTestI18n())
  app.use(pinia)
  app.use(PiniaColada, coladaOptions)
  app.use(router)
  app.mount(root)
  for (let i = 0; i < 5; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
  return root
}

function navItem(key: string): HTMLElement | null {
  return root?.querySelector<HTMLElement>(`[data-testid="console-nav-${key}"]`) ?? null
}

beforeEach(() => {
  env.name = 'standalone'
  env.wide = true
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
})

describe('ConsoleShell', () => {
  it('shows the Telegram stub instead of the console inside Telegram', async () => {
    env.name = 'telegram'
    const el = await mount('console-dashboard')

    expect(el.querySelector('[data-testid="console-stub"]')?.getAttribute('data-reason')).toBe(
      'telegram',
    )
    expect(el.querySelector('[data-testid="console-shell"]')).toBeNull()
  })

  it('shows the narrow-window stub in a browser window narrower than a computer screen', async () => {
    env.wide = false
    const el = await mount('console-dashboard')

    expect(el.querySelector('[data-testid="console-stub"]')?.getAttribute('data-reason')).toBe(
      'narrow',
    )
  })

  it('shows the menu with the current module marked in a wide browser window', async () => {
    const el = await mount('console-masters')

    expect(el.querySelector('[data-testid="console-shell"]')).not.toBeNull()
    expect(navItem('masters')?.getAttribute('aria-current')).toBe('page')
    expect(navItem('dashboard')?.getAttribute('aria-current')).toBeNull()
  })

  it('puts the live counters on Masters and Moderation, none at zero', async () => {
    vi.mocked(adminApi.getAdminStats).mockResolvedValue(stats({ pending_verifications: 3 }))
    vi.mocked(adminApi.getReports).mockResolvedValue({ items: [], total: 7, limit: 1, offset: 0 })
    await mount('console-dashboard')

    expect(navItem('masters')?.querySelector('.console-sidebar__count')?.textContent?.trim()).toBe(
      '3',
    )
    expect(
      navItem('moderation')?.querySelector('.console-sidebar__count')?.textContent?.trim(),
    ).toBe('7')
    expect(navItem('users')?.querySelector('.console-sidebar__count')).toBeNull()
  })

  it('tells the admin when the counters fail to load', async () => {
    vi.mocked(adminApi.getAdminStats).mockRejectedValue(new Error('down'))
    await mount('console-dashboard')

    expect(toastError).toHaveBeenCalled()
  })
})
