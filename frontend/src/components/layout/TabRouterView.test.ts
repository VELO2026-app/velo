// =============================================================================
// TabRouterView -- dock tab roots stay alive between taps
// =============================================================================
// A tab root is mounted once: a return re-attaches the finished screen
// (onActivated, no new mount, no loading state), its teleported header leaves
// the island while it is away (one header at a time), and a non-tab route
// mounts fresh exactly as a plain RouterView does.

import { describe, it, expect, afterEach } from 'vitest'
import { createApp, defineComponent, h, nextTick, onActivated, onMounted } from 'vue'
import type { App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import TabRouterView from './TabRouterView.vue'
import VHeader from './VHeader.vue'
import { provideFloatingHeader } from './useFloatingHeader'

const counts: Record<string, { mounted: number; activated: number }> = {}

function screen(name: string) {
  counts[name] = { mounted: 0, activated: 0 }
  return defineComponent({
    name,
    setup() {
      onMounted(() => counts[name]!.mounted++)
      onActivated(() => counts[name]!.activated++)
      return () =>
        h('div', { class: `screen screen--${name}` }, [h(VHeader, { title: name }), h('p', name)])
    },
  })
}

let app: App | null = null
let host: HTMLElement | null = null

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

async function setup(): Promise<Router> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/a', component: screen('A') },
      { path: '/b', component: screen('B') },
      { path: '/detail/:id', component: screen('D') },
    ],
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(
    defineComponent({
      setup: () => {
        provideFloatingHeader()
        return () => [
          h('div', { class: 'mobile-layout__island' }),
          h('main', [h(TabRouterView, { keep: ['/a', '/b'] })]),
        ]
      },
    }),
  )
  app.use(router)
  await router.push('/a')
  await router.isReady()
  app.mount(host)
  await nextTick()
  return router
}

const go = async (router: Router, path: string): Promise<void> => {
  await router.push(path)
  await nextTick()
  await nextTick()
}

function headers(): string[] {
  return Array.from(host?.querySelectorAll('.mobile-layout__island .v-header__title') ?? []).map(
    (el) => el.textContent ?? '',
  )
}

describe('TabRouterView', () => {
  it('the kept screen keeps its header (inline, off-stage) and gets it back on return', async () => {
    const router = await setup()
    await go(router, '/b')
    await go(router, '/a')
    expect(headers()).toEqual(['A'])
    expect(host?.querySelectorAll('.v-header').length).toBe(1)
  })

  it('a tab root mounts once; a return re-activates the same instance', async () => {
    const router = await setup()
    await go(router, '/b')
    await go(router, '/a')
    await go(router, '/b')
    expect(counts.A).toEqual({ mounted: 1, activated: 2 })
    expect(counts.B).toEqual({ mounted: 1, activated: 2 })
    expect(host?.querySelectorAll('.screen').length).toBe(1)
  })

  it('the teleported header leaves the island with its screen: one header at a time', async () => {
    const router = await setup()
    expect(headers()).toEqual(['A'])
    await go(router, '/b')
    expect(headers()).toEqual(['B'])
    await go(router, '/a')
    expect(headers()).toEqual(['A'])
    await go(router, '/detail/1')
    expect(headers()).toEqual(['D'])
    expect(host?.querySelectorAll('.screen').length).toBe(1)
  })

  it('a non-tab route mounts fresh on every visit (never kept)', async () => {
    const router = await setup()
    await go(router, '/detail/1')
    await go(router, '/a')
    await go(router, '/detail/2')
    expect(counts.D!.mounted).toBe(2)
    expect(counts.A).toEqual({ mounted: 1, activated: 2 })
  })
})
