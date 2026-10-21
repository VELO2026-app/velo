// =============================================================================
// VELO Frontend -- VPaginationDots Unit Tests
// =============================================================================
//
// Dependency-free SFC mount (createApp + happy-dom container) — the repo has no
// @vue/test-utils, and plugin-vue (vitest.config) compiles the .vue for us.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { describe, it, expect, afterEach } from 'vitest'
import { createApp, type App } from 'vue'
import VPaginationDots from '@/components/ui/VPaginationDots.vue'

let app: App | null = null
let host: HTMLElement | null = null

function mount(props: { total: number; active?: number }): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(VPaginationDots, props).use(createTestI18n())
  app.mount(host)
  return host
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

const DOT = '.v-pagination-dots__dot'
const ACTIVE = 'v-pagination-dots__dot--active'

describe('VPaginationDots', () => {
  it('renders exactly `total` dots', () => {
    const el = mount({ total: 3, active: 0 })
    expect(el.querySelectorAll(DOT).length).toBe(3)
  })

  it('marks the active dot (0-based) and only that one', () => {
    const el = mount({ total: 3, active: 1 })
    const actives = [...el.querySelectorAll(DOT)].map((d) => d.classList.contains(ACTIVE))
    expect(actives).toEqual([false, true, false])
  })

  it('defaults active to the first dot', () => {
    const el = mount({ total: 2 })
    const actives = [...el.querySelectorAll(DOT)].map((d) => d.classList.contains(ACTIVE))
    expect(actives).toEqual([true, false])
  })
})
