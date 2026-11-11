// =============================================================================
// VELO Frontend -- SectionUnavailableView (FE-163, PM-22 p.13)
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import SectionUnavailableView from '@/views/SectionUnavailableView.vue'

const push = vi.fn()
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }))

let app: App | null = null
let host: HTMLElement | null = null

afterEach(() => {
  app?.unmount()
  host?.remove()
  push.mockClear()
})

describe('SectionUnavailableView', () => {
  it('shows the title and the text, and the button goes home', async () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp(SectionUnavailableView).use(createTestI18n())
    app.mount(host)
    await nextTick()

    expect(host.textContent).toContain('Раздел недоступен')
    expect(host.textContent).toContain('Эта возможность не включена на вашей платформе')
    host.querySelector('button')?.click()
    expect(push).toHaveBeenCalledWith('/')
  })
})
