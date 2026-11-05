// =============================================================================
// VMetricHero Unit Tests
// =============================================================================
//
// Dependency-free SFC mount (createApp + happy-dom container) — the repo has
// no @vue/test-utils, and plugin-vue (vitest.config) compiles the .vue for
// us. Kit-compatible from day one: relative import, no application aliases —
// the file travels with the component into @velo/ui unchanged.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest'
import { createApp, type App, h } from 'vue'
import VMetricHero from './VMetricHero.vue'

let app: App | null = null
let host: HTMLElement | null = null

function mount(props: { value: string | number; label: string }): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(VMetricHero, props)
  app.mount(host)
  return host
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('VMetricHero', () => {
  it('renders the hero value and its caption', () => {
    const el = mount({ value: '78%', label: 'Average check-in rate' })
    expect(el.querySelector('.v-metric-hero__value')?.textContent).toBe('78%')
    expect(el.querySelector('.v-metric-hero__label')?.textContent).toBe('Average check-in rate')
  })

  it('renders the icon slot inside the icon circle', () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp({
      render: () =>
        h(VMetricHero, { value: '78%', label: 'Average check-in rate' }, { icon: () => h('b') }),
    })
    app.mount(host)
    expect(host.querySelector('.v-metric-hero__icon b')).not.toBeNull()
  })
})
