// =============================================================================
// VAccordion Unit Tests
// =============================================================================
//
// Dependency-free SFC mount (createApp + happy-dom container) — the repo has
// no @vue/test-utils, and plugin-vue (vitest.config) compiles the .vue for
// us. Kit-compatible from day one: relative import, no application aliases —
// the file travels with the component into @velo/ui unchanged.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import VAccordion from './VAccordion.vue'

import { configureUi } from '../../i18n'

// The kit component reads the host translator (FE-118 P3): the test injects
// a dictionary with the golden ru values, so the assertions below pin the
// same rendered texts the app suite asserted before the move.
configureUi({
  t: (key) => ({ 'ui.expand': 'Развернуть', 'ui.collapse': 'Свернуть' })[key] ?? key,
})

let app: App | null = null
let host: HTMLElement | null = null

function mount(props: { title: string; defaultOpen?: boolean }): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({
    render: () =>
      h(VAccordion, props, {
        default: () => h('p', { class: 'test-body' }, 'Hidden content'),
      }),
  })
  app.mount(host)
  return host
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('VAccordion', () => {
  it('starts collapsed: no body, expand aria, and opens on header click', async () => {
    const el = mount({ title: 'Details' })
    const header = el.querySelector<HTMLButtonElement>('.v-accordion__header')
    expect(header).not.toBeNull()
    expect(header?.getAttribute('aria-expanded')).toBe('false')
    expect(header?.getAttribute('aria-label')).toBe('Развернуть')
    expect(el.querySelector('.v-accordion__body')).toBeNull()
    header?.click()
    await nextTick()
    expect(header?.getAttribute('aria-expanded')).toBe('true')
    expect(header?.getAttribute('aria-label')).toBe('Свернуть')
    expect(el.querySelector('.v-accordion__body')).not.toBeNull()
    expect(el.querySelector('.test-body')?.textContent).toBe('Hidden content')
  })

  it('defaultOpen starts expanded and collapses back on click', async () => {
    const el = mount({ title: 'Details', defaultOpen: true })
    const header = el.querySelector<HTMLButtonElement>('.v-accordion__header')
    expect(header?.getAttribute('aria-expanded')).toBe('true')
    expect(el.querySelector('.v-accordion__body')).not.toBeNull()
    header?.click()
    await nextTick()
    expect(header?.getAttribute('aria-expanded')).toBe('false')
    expect(el.querySelector('.v-accordion__body')).toBeNull()
  })

  it('renders the title and keeps the open modifier class in sync', async () => {
    const el = mount({ title: 'Details' })
    const root = el.querySelector('.v-accordion')
    expect(root?.className).not.toContain('v-accordion--open')
    el.querySelector<HTMLButtonElement>('.v-accordion__header')?.click()
    await nextTick()
    expect(root?.className).toContain('v-accordion--open')
    expect(el.querySelector('.v-accordion__title')?.textContent).toBe('Details')
  })
})
