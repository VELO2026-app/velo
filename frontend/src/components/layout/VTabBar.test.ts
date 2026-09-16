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

function mount(items: TabItem[], active?: string): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(VTabBar, { items, active, onNavigate: navigate })
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
})
