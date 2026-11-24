// =============================================================================
// VELO Frontend -- route-change notifications: subscribe, unsubscribe
// =============================================================================

import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { installRouteEvents, onRouteChange } from '@/router/routeEvents'

const Blank = defineComponent({ render: () => h('div') })

async function makeRouter() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/a', component: Blank },
      { path: '/b', component: Blank },
      { path: '/c', component: Blank },
    ],
  })
  installRouteEvents(router)
  await router.push('/a')
  return router
}

describe('routeEvents', () => {
  it('notifies a subscriber after each finished navigation', async () => {
    const router = await makeRouter()
    const handler = vi.fn()
    const off = onRouteChange(handler)

    await router.push('/b')
    await router.push('/c')

    expect(handler).toHaveBeenCalledTimes(2)
    off()
  })

  it('stops notifying after unsubscribe', async () => {
    const router = await makeRouter()
    const handler = vi.fn()
    const off = onRouteChange(handler)
    await router.push('/b')
    off()

    await router.push('/c')

    expect(handler).toHaveBeenCalledTimes(1)
  })
})
