// =============================================================================
// VELO Frontend -- VTabBar Component Tests
// =============================================================================
//
// The bar's public contract:
//   1. One button per item, labelled for screen readers, active state by `active`.
//   2. A tap emits `navigate` with the item's path.
//
// Layout claims (pill geometry) are happy-dom-unprovable -- browser
// verification, per house rules.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import VTabBar from '@/components/layout/VTabBar.vue'
import type { TabItem } from '@/router/tabs'
import { IconHome, IconCalendar } from '@/components/icons'

const ITEMS: TabItem[] = [
  { icon: IconHome, label: 'Дашборд', to: '/user/dashboard' },
  { icon: IconCalendar, label: 'Календарь', to: '/user/calendar' },
]

let app: App | null = null
let host: HTMLElement | null = null
const navigate = vi.fn()

function mount(items: TabItem[], active?: string, pending?: boolean): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(VTabBar, { items, active, pending, onNavigate: navigate })
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextTick()
}

function buttons(): HTMLButtonElement[] {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-tabbar__item') ?? [])
}

beforeEach(() => {
  navigate.mockReset()
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

    expect(buttons()).toHaveLength(2)
    expect(buttons()[0]?.getAttribute('aria-label')).toBe('Дашборд')
    expect(buttons()[0]?.getAttribute('aria-current')).toBe('page')
    expect(buttons()[1]?.getAttribute('aria-current')).toBeNull()
  })

  it('a tap emits navigate with the item path', async () => {
    mount(ITEMS, '/user/dashboard')
    await flush()

    buttons()[1]?.click()
    await flush()

    expect(navigate).toHaveBeenCalledWith('/user/calendar')
  })

  // =========================================================================
  // First-paint hold (owner 2026-10-04): while the caller's conditional-tab
  // answer (schoolsHub.curatorAnswerPending) is in flight, the dock is
  // invisible + inert -- no conditional tab (the diary's) can flash and then
  // vanish. Layout claims are happy-dom-unprovable; what IS provable: the
  // class flips, the items stay mounted (the hold is CSS, not an unmount),
  // and the hold never swallows taps.
  // =========================================================================
  it('pending holds the first paint: v-tabbar--pending, items still mounted', async () => {
    mount(ITEMS, '/user/dashboard', true)
    await flush()

    const bar = host?.querySelector('.v-tabbar')
    expect(bar?.classList.contains('v-tabbar--pending')).toBe(true)
    // The hold is CSS visibility, not an unmount -- the paint flips once,
    // complete, when the answer lands. (The inertness -- pointer-events:none
    // -- is part of that CSS rule; happy-dom does not model it, so the tap
    // suppression itself is browser verification, per house rules.)
    expect(buttons()).toHaveLength(2)
  })

  it('without pending the dock paints normally (no hold class, taps live)', async () => {
    mount(ITEMS, '/user/dashboard')
    await flush()

    expect(host?.querySelector('.v-tabbar')?.classList.contains('v-tabbar--pending')).toBe(false)

    buttons()[1]?.click()
    await flush()
    expect(navigate).toHaveBeenCalledWith('/user/calendar')
  })
})
