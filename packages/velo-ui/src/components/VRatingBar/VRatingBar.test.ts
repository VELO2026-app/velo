// =============================================================================
// VRatingBar Unit Tests
// =============================================================================
//
// Dependency-free SFC mount (createApp + happy-dom container) — the repo has
// no @vue/test-utils, and plugin-vue (vitest.config) compiles the .vue for
// us. Kit-compatible from day one: relative import, no application aliases —
// the file travels with the component into @velo/ui unchanged.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest'
import { createApp, type App } from 'vue'
import VRatingBar from './VRatingBar.vue'

let app: App | null = null
let host: HTMLElement | null = null

function mount(props: {
  label: string
  value?: number | null
  suffix?: string
  barColor?: string
}): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(VRatingBar, props)
  app.mount(host)
  return host
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('VRatingBar', () => {
  it('renders the label and the percentage of a known value', () => {
    const el = mount({ label: 'Fire', value: 45 })
    expect(el.querySelector('.v-rating-bar__label')?.textContent).toBe('Fire')
    expect(el.querySelector('.v-rating-bar__value')?.textContent).toBe('45%')
    expect(el.querySelector('.v-rating-bar__fill')?.getAttribute('style')).toContain('width: 45%')
  })

  it('appends the suffix count next to the percent when provided', () => {
    const el = mount({ label: 'Fire', value: 45, suffix: '(5)' })
    expect(el.querySelector('.v-rating-bar__value')?.textContent).toBe('45% (5)')
  })

  it('stub state (no value): em dash + empty track', () => {
    const el = mount({ label: 'Fire', value: null })
    expect(el.querySelector('.v-rating-bar__value')?.textContent).toBe('—')
    expect(el.querySelector('.v-rating-bar__fill')?.getAttribute('style')).toContain('width: 0%')
  })

  it('clamps the fill width into 0..100', () => {
    const over = mount({ label: 'Fire', value: 140 })
    expect(over.querySelector('.v-rating-bar__fill')?.getAttribute('style')).toContain(
      'width: 100%',
    )
    const under = mount({ label: 'Fire', value: -10 })
    expect(under.querySelector('.v-rating-bar__fill')?.getAttribute('style')).toContain('width: 0%')
  })
})
