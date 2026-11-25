import { createTestI18n } from '@/locales/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, type App, type Component } from 'vue'
import ConsolePager from '@/components/console/ConsolePager.vue'

let app: App | null = null
let root: HTMLElement | null = null

function mount(props: Record<string, unknown>): HTMLElement {
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp({ render: () => h(ConsolePager as Component, props) }).use(createTestI18n())
  app.mount(root)
  return root
}

const summary = () =>
  root?.querySelector('[data-testid="console-pager-summary"]')?.textContent?.trim()
const pages = () =>
  Array.from(root?.querySelectorAll<HTMLButtonElement>('.console-pager__page') ?? [])

afterEach(() => {
  app?.unmount()
  root?.remove()
  app = null
  root = null
})

describe('ConsolePager', () => {
  it('names the rows of the page by their place in the list', () => {
    mount({ page: 2, pageSize: 20, total: 70, shown: 20 })

    expect(summary()).toContain('21')
    expect(summary()).toContain('40')
    expect(summary()).toContain('70')
  })

  it('reads 0-0 for an empty list', () => {
    mount({ page: 1, pageSize: 20, total: 0, shown: 0 })

    expect(summary()).toMatch(/0\D+0\D+0/)
  })

  it('shows page numbers only when there is more than one page', () => {
    mount({ page: 1, pageSize: 20, total: 20, shown: 20 })
    expect(pages()).toHaveLength(0)
    app?.unmount()
    root?.remove()

    mount({ page: 1, pageSize: 20, total: 41, shown: 20 })
    expect(pages().map((b) => b.textContent?.trim())).toEqual(['1', '2', '3'])
  })

  it('asks for another page, but not for the current one', () => {
    const onUpdate = vi.fn()
    mount({ page: 2, pageSize: 20, total: 70, shown: 20, 'onUpdate:page': onUpdate })

    pages()[1]?.click()
    pages()[2]?.click()

    expect(onUpdate.mock.calls).toEqual([[3]])
  })
})
