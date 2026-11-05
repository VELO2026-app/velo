// =============================================================================
// VLoader Unit Tests
// =============================================================================
//
// Dependency-free SFC mount (createApp + happy-dom container) — the repo has
// no @vue/test-utils, and plugin-vue (vitest.config) compiles the .vue for
// us. Kit-compatible from day one: relative import, no application aliases —
// the file travels with the component into @velo/ui unchanged.
//
// The localized aria-label is NOT pinned here: in the kit the label is a
// host responsibility (attrs land on the root, §7.2); the application-side
// pin lives in VLoader.localized.test.ts.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest'
import { createApp, type App } from 'vue'
import VLoader from './VLoader.vue'

let app: App | null = null
let host: HTMLElement | null = null

function mount(props: { size?: 'sm' | 'md' | 'lg' }): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(VLoader, props)
  app.mount(host)
  return host
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('VLoader', () => {
  it('renders the spinner root as a live status region', () => {
    const el = mount({})
    const root = el.querySelector('.v-loader')
    expect(root).not.toBeNull()
    expect(root?.getAttribute('role')).toBe('status')
  })

  it('sizes via the modifier class (default md, size prop wins)', () => {
    const el = mount({})
    expect(el.querySelector('.v-loader')?.className).toContain('v-loader--md')

    const sized = mount({ size: 'lg' })
    expect(sized.querySelector('.v-loader')?.className).toContain('v-loader--lg')
  })
})
