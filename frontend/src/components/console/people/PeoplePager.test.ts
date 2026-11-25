import { createTestI18n } from '@/locales/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, type App, type Component } from 'vue'
import PeoplePager from '@/components/console/people/PeoplePager.vue'

let app: App | null = null
let root: HTMLElement | null = null

function mount(props: Record<string, unknown>, onPage?: (page: number) => void): HTMLElement {
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp({
    render: () => h(PeoplePager as Component, { ...props, 'onUpdate:page': onPage }),
  }).use(createTestI18n())
  app.mount(root)
  return root
}

function pageButton(el: HTMLElement, n: number): HTMLButtonElement | undefined {
  return Array.from(el.querySelectorAll<HTMLButtonElement>('.people-pager__page')).find(
    (b) => b.textContent?.trim() === String(n),
  )
}

afterEach(() => {
  app?.unmount()
  root?.remove()
})

describe('PeoplePager', () => {
  it('says how many rows are shown and goes to a page other than the current one', () => {
    const pages: number[] = []
    const el = mount({ page: 2, pageSize: 20, total: 70, shown: 20 }, (p) => pages.push(p))

    expect(el.querySelector('.people-pager__shown')?.textContent).toBe('Показано 21–40 из 70')
    expect(pageButton(el, 2)?.getAttribute('aria-current')).toBe('page')

    pageButton(el, 2)?.click()
    pageButton(el, 4)?.click()
    expect(pages).toEqual([4])
  })

  it('shows the count only, no page buttons, when everything fits one page', () => {
    const el = mount({ page: 1, pageSize: 20, total: 7, shown: 7 })

    expect(el.querySelector('.people-pager__shown')?.textContent).toBe('Показано 1–7 из 7')
    expect(el.querySelector('.people-pager__pages')).toBeNull()
  })

  it('reads 0–0 of 0 for an empty list', () => {
    const el = mount({ page: 1, pageSize: 20, total: 0, shown: 0 })

    expect(el.querySelector('.people-pager__shown')?.textContent).toBe('Показано 0–0 из 0')
  })
})
