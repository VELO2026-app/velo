import { createTestI18n } from '@/locales/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router'
import ConsoleScreen from '@/views/console/ConsoleScreen.vue'

vi.mock('@/views/console/ConsolePracticesView.vue', () => ({
  __esModule: true,
  default: defineComponent({ render: () => h('p', { 'data-testid': 'practices' }) }),
}))
vi.mock('@/views/console/ConsolePlaceholderView.vue', () => ({
  __esModule: true,
  default: defineComponent({ render: () => h('p', { 'data-testid': 'placeholder' }) }),
}))

let app: App | null = null
let root: HTMLElement | null = null

async function mountAt(name: string): Promise<Router> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/console/practices', name: 'console-practices', component: ConsoleScreen },
      { path: '/console/finance', name: 'console-finance', component: ConsoleScreen },
    ],
  })
  await router.push({ name })
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp({ render: () => h(RouterView) })
    .use(createTestI18n())
    .use(router)
  app.mount(root)
  return router
}

async function settled(id: string): Promise<HTMLElement | null> {
  await vi.waitFor(() => expect(root?.querySelector(`[data-testid="${id}"]`)).not.toBeNull())
  await nextTick()
  return root?.querySelector(`[data-testid="${id}"]`) ?? null
}

afterEach(() => {
  app?.unmount()
  root?.remove()
})

describe('ConsoleScreen', () => {
  it('shows the screen of the route', async () => {
    await mountAt('console-practices')

    expect(await settled('practices')).not.toBeNull()
  })

  it('shows the placeholder for a module that has no screen yet', async () => {
    await mountAt('console-finance')

    expect(await settled('placeholder')).not.toBeNull()
  })

  it('switches the screen when the route changes', async () => {
    const router = await mountAt('console-finance')
    await settled('placeholder')

    await router.push({ name: 'console-practices' })

    expect(await settled('practices')).not.toBeNull()
    expect(root?.querySelector('[data-testid="placeholder"]')).toBeNull()
  })
})
