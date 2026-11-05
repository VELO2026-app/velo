// =============================================================================
// VStatCard Unit Tests
// =============================================================================
//
// Dependency-free SFC mount (createApp + happy-dom container) — the repo has
// no @vue/test-utils, and plugin-vue (vitest.config) compiles the .vue for
// us. Kit-compatible from day one: relative import, no application aliases —
// the file travels with the component into @velo/ui unchanged.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest'
import { createApp, type App } from 'vue'
import VStatCard from './VStatCard.vue'

let app: App | null = null
let host: HTMLElement | null = null

function mount(props: {
  value: string | number
  label: string
  layout?: 'column' | 'row'
  delta?: string
  valuePending?: boolean
}): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(VStatCard, props)
  app.mount(host)
  return host
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('VStatCard', () => {
  it('renders the value and the label', () => {
    const el = mount({ value: '156', label: 'participants' })
    expect(el.querySelector('.v-stat__value')?.textContent).toBe('156')
    expect(el.querySelector('.v-stat__label')?.textContent).toBe('participants')
  })

  it('valuePending: the value line shows the placeholder, never a false value', () => {
    const el = mount({ value: '156', label: 'participants', valuePending: true })
    expect(el.querySelector('.v-stat__value-skeleton')).not.toBeNull()
    expect(el.querySelector('.v-stat__value')?.textContent).not.toContain('156')
  })

  it('carries the layout variant as a modifier class', () => {
    const el = mount({ value: '156', label: 'participants', layout: 'row' })
    expect(el.querySelector('.v-stat')?.classList.contains('v-stat--row')).toBe(true)
  })

  it('renders the delta line only when provided', () => {
    const plain = mount({ value: '156', label: 'participants' })
    expect(plain.querySelector('.v-stat__delta')).toBeNull()

    const trending = mount({ value: '156', label: 'participants', delta: '+3' })
    expect(trending.querySelector('.v-stat__delta')?.textContent).toBe('+3')
  })
})
