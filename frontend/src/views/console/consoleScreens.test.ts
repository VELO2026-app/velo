// The console's route components resolve to the screen itself: the router
// waits for it before it switches, as for any lazy route.
import { describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { consoleRoutes } from '@/router/routes/console'
import { loadConsoleScreen } from '@/views/console/consoleScreens'

const Practices = defineComponent({ name: 'PracticesStub', render: () => null })
const Placeholder = defineComponent({ name: 'PlaceholderStub', render: () => null })
vi.mock('@/views/console/ConsolePracticesView.vue', () => ({ default: Practices }))
vi.mock('@/views/console/ConsolePlaceholderView.vue', () => ({ default: Placeholder }))
vi.mock('@/views/shells/ConsoleShell.vue', () => ({
  default: defineComponent({ render: () => null }),
}))

describe('loadConsoleScreen', () => {
  it('loads the screen of a route that has one', async () => {
    expect((await loadConsoleScreen('console-practices')).default).toBe(Practices)
  })

  it('loads the placeholder for a module that has no screen yet', async () => {
    expect((await loadConsoleScreen('console-settings')).default).toBe(Placeholder)
  })
})

describe('console route records', () => {
  it('finish the navigation with the screen itself loaded', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: consoleRoutes() })

    await router.push('/admin/practices')

    expect(router.currentRoute.value.matched.at(-1)?.components?.default).toBe(Practices)
  })
})
