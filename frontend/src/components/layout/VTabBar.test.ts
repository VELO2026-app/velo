// =============================================================================
// VELO Frontend -- VTabBar Component Tests (FE-11/FE-12)
// =============================================================================
//
// The dock gained a presence-dot slot: a tab item with a truthy `badge`
// renders the coral dot (the user zone's bell tab). This file guards exactly
// that change and the bar's existing public contract:
//   1. One button per item, labelled for screen readers, active state by `active`.
//   2. A truthy badge renders the decorative dot (aria-hidden, NO number --
//      presence-only by owner ruling); no badge / 0 renders nothing.
//   3. A tap emits `navigate` with the item's path.
//
// Layout claims (pill geometry, dot placement over the 56px target) are
// happy-dom-unprovable -- browser verification, per house rules.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import VTabBar, { type TabItem } from '@/components/layout/VTabBar.vue'
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

  it('a truthy badge renders the presence dot -- decorative, no number', async () => {
    mount([...ITEMS, { icon: IconHome, label: 'Уведомления', to: '/user/notifications', badge: 1 }])
    await flush()

    const bell = buttons()[2]
    expect(bell).toBeDefined()
    const dot = bell?.querySelector<HTMLElement>('.v-tabbar__badge')
    expect(dot).not.toBeNull()
    expect(dot?.getAttribute('aria-hidden')).toBe('true')
    expect(dot?.textContent).toBe('') // presence only -- never a count
  })

  it('no badge (or 0) renders no dot', async () => {
    mount([...ITEMS, { icon: IconHome, label: 'Уведомления', to: '/user/notifications' }])
    await flush()

    expect(buttons()[2]?.querySelector('.v-tabbar__badge')).toBeNull()

    app?.unmount()
    mount([...ITEMS, { icon: IconHome, label: 'Уведомления', to: '/user/notifications', badge: 0 }])
    await flush()

    expect(buttons()[2]?.querySelector('.v-tabbar__badge')).toBeNull()
  })

  it('a tap emits navigate with the item path', async () => {
    mount(ITEMS, '/user/dashboard')
    await flush()

    buttons()[1]?.click()
    await flush()

    expect(navigate).toHaveBeenCalledWith('/user/calendar')
  })
})
