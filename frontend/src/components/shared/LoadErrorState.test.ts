// =============================================================================
// VELO Frontend -- LoadErrorState tests (FE-256..FE-259)
// =============================================================================
//
// The shared failed-read block: it names the failure, says what failed when the
// caller tells it, and hands the Retry tap back to the caller.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { describe, it, expect, afterEach } from 'vitest'
import { createApp, h, type App } from 'vue'
import LoadErrorState from './LoadErrorState.vue'

let app: App | null = null
let host: HTMLElement | null = null

function mount(props: { title?: string; description?: string }, onRetry: () => void): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(LoadErrorState, { ...props, onRetry }) }).use(createTestI18n())
  app.mount(host)
  return host
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('LoadErrorState', () => {
  it('says «Ошибка загрузки» by default, flags itself as an error state and returns the Retry tap', () => {
    let retries = 0
    const el = mount({}, () => retries++)

    expect(el.textContent).toContain('Ошибка загрузки')
    expect(el.querySelector('[data-testid="screen-error"]')).not.toBeNull()
    expect(el.querySelector('.v-empty__desc')).toBeNull()

    el.querySelector('button')?.click()
    expect(retries).toBe(1)
  })

  it("shows the caller's title and the name of what failed instead of the default", () => {
    const el = mount({ title: 'Не удалось загрузить', description: 'Школы' }, () => {})

    expect(el.textContent).toContain('Не удалось загрузить')
    expect(el.textContent).not.toContain('Ошибка загрузки')
    expect(el.querySelector('.v-empty__desc')?.textContent).toBe('Школы')
  })
})
