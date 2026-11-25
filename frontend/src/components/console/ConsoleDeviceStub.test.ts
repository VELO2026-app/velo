// The device stub's link: the console address that was asked for (a bot's
// ticket link opens that ticket in the browser), without the hash Telegram
// may put its signed launch data in; the console's home for anything else.
import { createTestI18n } from '@/locales/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { createPinia } from 'pinia'
import ConsoleDeviceStub from '@/components/console/ConsoleDeviceStub.vue'

vi.mock('@/platform', () => ({ platform: { name: 'telegram', openLink: vi.fn() } }))

let app: App | null = null
let root: HTMLElement | null = null

async function linkAt(path: string): Promise<string | undefined> {
  const stub = { render: () => h(ConsoleDeviceStub, { reason: 'telegram' }) }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/admin/:rest(.*)*', component: stub },
      { path: '/user/dashboard', name: 'user-dashboard', component: stub },
    ],
  })
  await router.push(path)
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp({ render: () => h(RouterView) })
    .use(createTestI18n())
    .use(createPinia())
    .use(router)
  app.mount(root)
  await nextTick()
  return root.querySelector('[data-testid="console-stub-link"]')?.textContent?.trim()
}

afterEach(() => {
  app?.unmount()
  root?.remove()
  app = null
  root = null
})

describe('ConsoleDeviceStub: the console link', () => {
  it('is the console address asked for, with its query', async () => {
    expect(await linkAt('/admin/support?ticket=t1')).toBe(
      `${location.origin}/admin/support?ticket=t1`,
    )
  })

  it('drops the hash', async () => {
    expect(await linkAt('/admin/support?ticket=t1#tgWebAppData=signed')).toBe(
      `${location.origin}/admin/support?ticket=t1`,
    )
  })

  it('is the console home for an address outside the console', async () => {
    expect(await linkAt('/user/dashboard')).toBe(`${location.origin}/admin`)
  })
})
