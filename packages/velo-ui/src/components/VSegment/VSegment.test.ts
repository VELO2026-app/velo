// =============================================================================
// VSegment Unit Tests
// =============================================================================
//
// Dependency-free SFC mount (createApp + happy-dom container) — the repo has
// no @vue/test-utils, and plugin-vue (vitest.config) compiles the .vue for
// us. Kit-compatible from day one: relative import, no application aliases —
// the file travels with the component into @velo/ui unchanged.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest'
import { createApp, type App } from 'vue'
import VSegment from './VSegment.vue'

let app: App | null = null
let host: HTMLElement | null = null

const OPTIONS = [
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'past', label: 'Past', badge: 3 },
]

function mount(props: {
  modelValue: string
  compact?: boolean
  scrollable?: boolean
}): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(VSegment, { options: OPTIONS, ...props })
  app.mount(host)
  return host
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('VSegment', () => {
  it('renders one tab per option, in order, with labels and optional badges', () => {
    const el = mount({ modelValue: 'upcoming' })
    const tabs = [...el.querySelectorAll('.v-segment__item')]
    expect(tabs.map((t) => t.textContent?.trim())).toEqual(['Upcoming', 'Past 3'])
    expect(el.querySelectorAll('.v-segment__badge').length).toBe(1)
  })

  it('marks exactly the selected option active (class + aria-selected)', () => {
    const el = mount({ modelValue: 'past' })
    const tabs = [...el.querySelectorAll('.v-segment__item')]
    expect(tabs.map((t) => t.classList.contains('v-segment__item--active'))).toEqual([false, true])
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true'])
  })

  it('emits update:modelValue with the clicked option value', () => {
    let received = ''
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp(VSegment, {
      modelValue: 'upcoming',
      options: OPTIONS,
      'onUpdate:modelValue': (v: string) => (received = v),
    })
    app.mount(host)
    host.querySelectorAll<HTMLButtonElement>('.v-segment__item')[1]?.click()
    expect(received).toBe('past')
  })

  it('carries the compact/scrollable variants as modifier classes', () => {
    const el = mount({ modelValue: 'upcoming', compact: true, scrollable: true })
    const root = el.querySelector('.v-segment')
    expect(root?.classList.contains('v-segment--compact')).toBe(true)
    expect(root?.classList.contains('v-segment--scrollable')).toBe(true)
  })
})
