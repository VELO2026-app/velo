// =============================================================================
// VWheel Unit Tests
// =============================================================================
//
// Dependency-free SFC mount (createApp + happy-dom container) — the repo has
// no @vue/test-utils, and plugin-vue (vitest.config) compiles the .vue for
// us. Kit-compatible from day one: relative import, no application aliases —
// the file travels with the component into @velo/ui unchanged.
//
// Render contract only: the wheel owns a real scroll container (snap + timers
// + el.scrollTo), which belongs to interaction tests on a real layout, not to
// a minimal mount. scrollTo is stubbed so the mount-time recentre is a no-op.
// =============================================================================

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createApp, type App } from 'vue'
import VWheel from './VWheel.vue'

let app: App | null = null
let host: HTMLElement | null = null

const OPTIONS = [
  { value: '10', label: '10' },
  { value: '11', label: '11' },
  { value: '12', label: '12' },
]

function mount(props: { modelValue: string }): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(VWheel, { options: OPTIONS, ...props })
  app.mount(host)
  return host
}

beforeEach(() => {
  Element.prototype.scrollTo = () => {}
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  delete (Element.prototype as { scrollTo?: unknown }).scrollTo
})

describe('VWheel', () => {
  it('renders one snap item per option, in order, with labels', () => {
    const el = mount({ modelValue: '11' })
    const items = [...el.querySelectorAll('.v-wheel__item')]
    expect(items.map((i) => i.textContent?.trim())).toEqual(['10', '11', '12'])
  })

  it('pads top and bottom so the first/last item can reach the centre', () => {
    const el = mount({ modelValue: '10' })
    expect(el.querySelectorAll('.v-wheel__pad').length).toBe(2)
  })
})
