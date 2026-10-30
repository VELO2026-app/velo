// =============================================================================
// VELO Frontend -- MobileLayout: per-tab scroll + dock behaviour
// =============================================================================
//
// Native tab-bar contract: each tab root keeps its own scroll position
// across dock hops; a NEW screen pushed from a tab starts at the top; a tap
// on the tab already open scrolls it back to the top instead of a no-op
// navigation. (Geometry/fog are browser-verified, per house rules.)
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { RouterView, createMemoryHistory, createRouter, type Router } from 'vue-router'
import MobileLayout from '@/components/layout/MobileLayout.vue'
import type { TabItem } from '@/router/tabs'
import { IconHome, IconCalendar } from '@/components/icons'

const TABS: TabItem[] = [
  { icon: IconHome, label: 'Dashboard', to: '/user/dashboard' },
  { icon: IconCalendar, label: 'Calendar', to: '/user/calendar' },
]

const Blank = defineComponent({ render: () => h('div', { class: 'screen' }) })

let app: App | null = null
let host: HTMLElement | null = null
const navigate = vi.fn()
let lastPush: Promise<unknown> = Promise.resolve()

async function mount(): Promise<Router> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/user/dashboard', component: Blank },
      { path: '/user/calendar', component: Blank },
      { path: '/user/practice/:id', component: Blank },
    ],
  })
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
          onNavigate: (to: string) => {
            navigate(to)
            lastPush = router.push(to)
          },
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

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

function main(): HTMLElement {
  const el = host?.querySelector<HTMLElement>('.mobile-layout__main')
  if (!el) throw new Error('no main')
  return el
}

function tab(i: number): HTMLButtonElement {
  const el = host?.querySelectorAll<HTMLButtonElement>('.v-tabbar__item')[i]
  if (!el) throw new Error('no tab')
  return el
}

afterEach(() => {
  app?.unmount()
  app = null
  host?.remove()
  host = null
  navigate.mockReset()
})

describe('MobileLayout', () => {
  it('a dock hop returns each tab to its own scroll position', async () => {
    const router = await mount()
    main().scrollTop = 300

    await router.push('/user/calendar')
    await flush()
    expect(main().scrollTop).toBe(0) // the calendar was never scrolled

    main().scrollTop = 120
    await router.push('/user/dashboard')
    await flush()
    expect(main().scrollTop).toBe(300)

    await router.push('/user/calendar')
    await flush()
    expect(main().scrollTop).toBe(120)
  })

  it('a screen pushed from a tab still opens at the top', async () => {
    const router = await mount()
    main().scrollTop = 300

    await router.push('/user/practice/1')
    await flush()
    expect(main().scrollTop).toBe(0)
  })

  it('a tap on the open tab scrolls it to the top instead of navigating', async () => {
    await mount()
    main().scrollTop = 300
    const scrollTo = vi.spyOn(main(), 'scrollTo')

    tab(0).click()
    await flush()

    expect(navigate).not.toHaveBeenCalled()
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }))
  })

  it('a tap on another tab navigates', async () => {
    const router = await mount()

    tab(1).click()
    await lastPush
    await flush()

    expect(navigate).toHaveBeenCalledWith('/user/calendar')
    expect(router.currentRoute.value.path).toBe('/user/calendar')
  })
})
