// =============================================================================
// VELO Frontend -- TimezoneSettingsView: the language switcher warms its rows
// =============================================================================
// FE-157 s2: App.vue no longer loads every locale two seconds after boot; the
// switcher warms the catalogs itself -- every offered locale once the screen
// is idle (skipped on a constrained link), and a row's locale on finger-down.
// Warming must never switch the language.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createTestI18n } from '@/locales/testing'
import TimezoneSettingsView from '@/views/user/TimezoneSettingsView.vue'

vi.mock('@/api/users')
vi.mock('vue-router', () => ({ useRouter: () => ({ back: vi.fn() }) }))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: vi.fn(), info: vi.fn(), success: vi.fn() }),
}))

const net = vi.hoisted(() => ({ constrained: false, idle: [] as Array<() => void> }))
vi.mock('@/platform/dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/platform/dom')>()),
  isConstrainedNetwork: () => net.constrained,
  whenIdle: (fn: () => void) => net.idle.push(fn),
}))

const locales = vi.hoisted(() => ({ warm: vi.fn(), set: vi.fn() }))
vi.mock('@/locales', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/locales')>()
  return {
    ...real,
    warmLocale: (code: string) => locales.warm(code),
    setLocale: (code: string) => {
      locales.set(code)
      return Promise.resolve()
    },
  }
})

let app: App | null = null
let host: HTMLElement | null = null

async function mount(): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(TimezoneSettingsView).use(createTestI18n()).use(createPinia())
  app.mount(host)
  for (let i = 0; i < 4; i++) await nextTick()
  return host
}

beforeEach(() => {
  setActivePinia(createPinia())
  net.constrained = false
  net.idle = []
  locales.warm.mockReset()
  locales.set.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('TimezoneSettingsView -- language warm-up', () => {
  it('warms every offered locale once the screen is idle, never before', async () => {
    await mount()
    expect(locales.warm).not.toHaveBeenCalled()

    for (const fn of net.idle) fn()
    const warmed = locales.warm.mock.calls.map((c) => c[0] as string)
    expect(warmed.length).toBeGreaterThan(1)
    expect(warmed).toContain('en')
    expect(locales.set).not.toHaveBeenCalled()
  })

  it('a constrained link skips the idle warm-up', async () => {
    net.constrained = true
    await mount()
    expect(net.idle).toHaveLength(0)
    expect(locales.warm).not.toHaveBeenCalled()
  })

  it("finger-down on a row warms that row's locale without switching", async () => {
    net.constrained = true
    const el = await mount()
    const rows = el.querySelectorAll<HTMLElement>('.tz-settings__lang')
    const row = Array.from(rows).find((r) => r.textContent?.includes('English'))
    expect(row).toBeDefined()
    row!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(locales.warm).toHaveBeenCalledWith('en')
    expect(locales.set).not.toHaveBeenCalled()
  })
})
