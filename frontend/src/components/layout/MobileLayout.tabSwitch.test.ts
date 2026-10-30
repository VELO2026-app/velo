// =============================================================================
// VELO Frontend -- tab switch leaves no trace of the previous screen
// =============================================================================
//
// The on-device bug: pieces of the previous screen stayed on stage during a
// tab switch. Contract proven here with the real shell pieces (MobileLayout,
// RouterView, the router's screen-change orchestration) and views that
// teleport their header into the island like VHeader does: while the old
// screen fades out it is the ONLY screen; once the switch has run, the old
// view and its teleported header are gone, exactly one view root sits in
// the scroller and exactly one header in the island, and no motion class is
// left on <html>.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Teleport, createApp, defineComponent, h, nextTick, type App } from 'vue'
import { RouterView, createMemoryHistory, createRouter, type Router } from 'vue-router'
import MobileLayout from '@/components/layout/MobileLayout.vue'
import type { TabItem } from '@/router/tabs'
import { installViewTransitions } from '@/router/viewTransition'
import { IconHome, IconCalendar } from '@/components/icons'

const TABS: TabItem[] = [
  { icon: IconHome, label: 'Dashboard', to: '/user/dashboard' },
  { icon: IconCalendar, label: 'Calendar', to: '/user/calendar' },
]

function screen(name: string) {
  return defineComponent({
    name,
    render: () => [
      h(Teleport, { to: '.mobile-layout__island', defer: true }, [
        h('header', { class: `hdr hdr-${name}` }, name),
      ]),
      h('section', { class: `view view-${name}` }, [h('p', `${name} body`)]),
    ],
  })
}

let app: App | null = null
let host: HTMLElement | null = null

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

async function mount(): Promise<Router> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/user/dashboard', component: screen('dash') },
      { path: '/user/calendar', component: screen('cal') },
    ],
  })
  installViewTransitions(router)
  await router.push('/user/dashboard')
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({
    render: () =>
      h(
        MobileLayout,
        {
          tabs: TABS,
          activeTab: router.currentRoute.value.path,
          onNavigate: (to: string) => void router.push(to),
        },
        { default: () => h(RouterView) },
      ),
  })
    .use(router)
    .use(createTestI18n())
  app.mount(host)
  await flush()
  return router
}

const count = (sel: string): number => host?.querySelectorAll(sel).length ?? 0
const root = (): DOMTokenList => document.documentElement.classList

describe('MobileLayout tab switch', () => {
  afterEach(() => {
    vi.useRealTimers()
    app?.unmount()
    host?.remove()
    app = null
    host = null
    root().remove('vt-leave', 'vt-fallback', 'vt-tab', 'vt-forward', 'vt-back')
  })

  it('the old screen and its teleported header are fully gone; one view root, one header', async () => {
    vi.useFakeTimers()
    const router = await mount()
    expect(count('.view-dash')).toBe(1)
    expect(count('.mobile-layout__island .hdr-dash')).toBe(1)

    const nav = router.push('/user/calendar')
    await flush()
    // Fading out: still only the old screen, never two.
    expect(count('.view')).toBe(1)
    expect(count('.hdr')).toBe(1)

    await vi.advanceTimersByTimeAsync(100)
    await nav
    await flush()
    expect(router.currentRoute.value.path).toBe('/user/calendar')
    expect(count('.view-dash')).toBe(0)
    expect(count('.hdr-dash')).toBe(0)
    expect(document.querySelectorAll('.hdr-dash')).toHaveLength(0) // nowhere in the document

    await vi.advanceTimersByTimeAsync(600)
    const main = host?.querySelector('.mobile-layout__main')
    const island = host?.querySelector('.mobile-layout__island')
    expect(main?.querySelectorAll(':scope > .view')).toHaveLength(1)
    expect(main?.querySelector('.view-cal')).not.toBeNull()
    expect(island?.querySelectorAll('.hdr')).toHaveLength(1)
    expect(island?.querySelector('.hdr-cal')).not.toBeNull()
    for (const cls of ['vt-leave', 'vt-fallback', 'vt-tab']) {
      expect(root().contains(cls)).toBe(false)
    }
  })

  it('tapping back and forth fast still ends with exactly one screen and one header', async () => {
    vi.useFakeTimers()
    const router = await mount()
    const a = router.push('/user/calendar')
    await flush()
    await vi.advanceTimersByTimeAsync(30)
    const b = router.push('/user/dashboard')
    await flush()
    await vi.advanceTimersByTimeAsync(800)
    await Promise.all([a, b])
    await flush()

    expect(count('.view')).toBe(1)
    expect(count('.hdr')).toBe(1)
    expect(count('.view-dash')).toBe(1)
    expect(root().contains('vt-leave')).toBe(false)
  })
})
