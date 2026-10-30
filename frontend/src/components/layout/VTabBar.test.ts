// =============================================================================
// VELO Frontend -- VTabBar Component Tests
// =============================================================================
//
// The bar's public contract:
//   1. One button per item, labelled for screen readers, active state by `active`.
//   2. A tap emits `navigate` with the item's path.
//   3. The active state follows the TAP at once (optimistic), hands over to
//      the route's `active`, and falls back if the navigation never lands.
//   4. Finger-down emits `intent` (the shell warms that screen's chunk).
//
// Layout claims (pill geometry) are happy-dom-unprovable -- browser
// verification, per house rules.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'
import VTabBar from '@/components/layout/VTabBar.vue'
import type { TabItem } from '@/router/tabs'
import { IconHome, IconCalendar, IconDiary } from '@/components/icons'

const ITEMS: TabItem[] = [
  { icon: IconHome, label: 'Дашборд', to: '/user/dashboard' },
  { icon: IconCalendar, label: 'Календарь', to: '/user/calendar' },
  { icon: IconDiary, label: 'Дневник', to: '/user/diary' },
]

let app: App | null = null
let host: HTMLElement | null = null
const navigate = vi.fn()

const intent = vi.fn()
const activeProp = ref<string | undefined>(undefined)

function mount(items: TabItem[], active?: string): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  activeProp.value = active
  app = createApp({
    render: () =>
      h(VTabBar, { items, active: activeProp.value, onNavigate: navigate, onIntent: intent }),
  }).use(createTestI18n())
  app.mount(host)
  return host
}

function current(): string | null {
  const btn = buttons().find((b) => b.getAttribute('aria-current') === 'page')
  return btn?.getAttribute('aria-label') ?? null
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextTick()
}

function buttons(): HTMLButtonElement[] {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-tabbar__item') ?? [])
}

beforeEach(() => {
  navigate.mockReset()
  intent.mockReset()
})

afterEach(() => {
  app?.unmount()
  app = null
  host?.remove()
  host = null
})

describe('VTabBar', () => {
  it('renders one labelled button per item; active gets aria-current', async () => {
    mount(ITEMS, '/user/dashboard')
    await flush()

    expect(buttons()).toHaveLength(3)
    expect(buttons()[0]?.getAttribute('aria-label')).toBe('Дашборд')
    expect(buttons()[0]?.getAttribute('aria-current')).toBe('page')
    expect(buttons()[1]?.getAttribute('aria-current')).toBeNull()
    expect(buttons()[2]?.getAttribute('aria-current')).toBeNull()
  })

  it('a tap emits navigate with the item path', async () => {
    mount(ITEMS, '/user/dashboard')
    await flush()

    buttons()[1]?.click()
    await flush()

    expect(navigate).toHaveBeenCalledWith('/user/calendar')
  })

  it('the active state follows the tap at once, then hands over to the route', async () => {
    vi.useFakeTimers()
    try {
      mount(ITEMS, '/user/dashboard')
      await flush()

      buttons()[1]?.click()
      await flush()
      // Before the router has answered: the tapped tab is already active.
      expect(current()).toBe('Календарь')

      activeProp.value = '/user/calendar'
      await flush()
      vi.advanceTimersByTime(5000)
      await flush()
      expect(current()).toBe('Календарь')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a navigation that never lands hands the active state back', async () => {
    vi.useFakeTimers()
    try {
      mount(ITEMS, '/user/dashboard')
      await flush()

      buttons()[1]?.click()
      await flush()
      expect(current()).toBe('Календарь')

      // A slow first chunk (dev tunnel) must not bounce it back early...
      vi.advanceTimersByTime(3000)
      await flush()
      expect(current()).toBe('Календарь')

      // ...only a navigation that never lands at all.
      vi.advanceTimersByTime(5000)
      await flush()
      expect(current()).toBe('Дашборд')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a guard redirect to an untapped tab hands the active state over at once', async () => {
    mount(ITEMS, '/user/dashboard')
    await flush()

    buttons()[1]?.click()
    await flush()
    activeProp.value = '/user/diary' // redirected
    await flush()
    expect(current()).toBe('Дневник')
  })

  it('rapid double tap: an intermediate route does not bounce the active state back', async () => {
    mount(ITEMS, '/user/dashboard')
    await flush()

    buttons()[1]?.click()
    buttons()[2]?.click()
    await flush()
    expect(current()).toBe('Дневник')

    // The first navigation lands first (or is reported on the way).
    activeProp.value = '/user/calendar'
    await flush()
    expect(current()).toBe('Дневник')

    activeProp.value = '/user/diary'
    await flush()
    expect(current()).toBe('Дневник')
    expect(navigate.mock.calls.map((c) => c[0])).toEqual(['/user/calendar', '/user/diary'])
  })

  it('a tap on the already active tab still emits navigate (the layout scrolls to top)', async () => {
    mount(ITEMS, '/user/dashboard')
    await flush()

    buttons()[0]?.click()
    await flush()

    expect(navigate).toHaveBeenCalledWith('/user/dashboard')
    expect(current()).toBe('Дашборд')
  })

  it('finger-down emits intent with the item path (chunk warm-up)', async () => {
    mount(ITEMS, '/user/dashboard')
    await flush()

    buttons()[2]?.dispatchEvent(new Event('pointerdown'))
    expect(intent).toHaveBeenCalledWith('/user/diary')
    expect(navigate).not.toHaveBeenCalled()
  })

  it('without layout (unmeasured) the active button paints its own fill', async () => {
    mount(ITEMS, '/user/dashboard')
    await flush()

    // happy-dom has no layout: the travelling disc cannot be placed, the
    // bar falls back to the per-button fill instead of showing none.
    expect(host?.querySelector('.v-tabbar')?.classList.contains('v-tabbar--unmeasured')).toBe(true)
    expect(host?.querySelector('.v-tabbar__indicator')).toBeTruthy()
  })

  // =========================================================================
  // Owner 2026-10-12: the first-paint hold (owner 2026-10-04's tabs-pending)
  // is gone with the diary gate -- the bar has no pending state anymore. The
  // unconditional dock paints complete on the first render.
  // =========================================================================
})
