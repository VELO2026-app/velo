import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, type App, type Component } from 'vue'
import ConsoleSplit from '@/components/console/ConsoleSplit.vue'

let app: App | null = null
let root: HTMLElement | null = null

function mount(props: Record<string, unknown> = {}): HTMLElement {
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp({
    render: () =>
      h(ConsoleSplit as Component, props, {
        list: () => h('p', { 'data-testid': 'the-list' }, 'List'),
        detail: () => h('p', { 'data-testid': 'the-detail' }, 'Detail'),
      }),
  })
  app.mount(root)
  return root
}

function shown(el: HTMLElement): string[] {
  return ['the-list', 'the-detail'].filter((id) => el.querySelector(`[data-testid="${id}"]`))
}

afterEach(() => {
  app?.unmount()
  root?.remove()
})

describe('ConsoleSplit', () => {
  it('shows the list and the detail side by side by default', () => {
    expect(shown(mount())).toEqual(['the-list', 'the-detail'])
  })

  it('shows one column alone when the screen asks for a pane', () => {
    const list = mount({ pane: 'list' })
    expect(shown(list)).toEqual(['the-list'])
    app?.unmount()
    root?.remove()

    expect(shown(mount({ pane: 'detail' }))).toEqual(['the-detail'])
  })
})
