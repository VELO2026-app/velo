// =============================================================================
// VSegmentTrack Unit Tests
// =============================================================================
//
// Dependency-free SFC mount (createApp + happy-dom container) — the repo has
// no @vue/test-utils, and plugin-vue (vitest.config) compiles the .vue for
// us. Kit-compatible from day one: relative import, no application aliases —
// the file travels with the component into @velo/ui unchanged.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest'
import { createApp, type App } from 'vue'
import VSegmentTrack from './VSegmentTrack.vue'

let app: App | null = null
let host: HTMLElement | null = null

const OPTIONS = [
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
]

function mount(props: {
  modelValue: string
  variant?: 'toggle' | 'tabs'
  scrollable?: boolean
  'onUpdate:modelValue'?: (v: string) => void
}): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(VSegmentTrack, { options: OPTIONS, ...props })
  app.mount(host)
  return host
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('VSegmentTrack', () => {
  it('renders the track with the variant class and one button per option', () => {
    const el = mount({ modelValue: 'week', variant: 'tabs' })
    expect(el.querySelector('.v-segment-track')?.classList.contains('v-segment-track--tabs')).toBe(
      true,
    )
    expect(el.querySelectorAll('.v-segment-track__btn').length).toBe(2)
  })

  it('defaults to the toggle variant', () => {
    const el = mount({ modelValue: 'week' })
    expect(
      el.querySelector('.v-segment-track')?.classList.contains('v-segment-track--toggle'),
    ).toBe(true)
  })

  it('marks exactly the selected button active (class + aria-selected)', () => {
    const el = mount({ modelValue: 'month' })
    const btns = [...el.querySelectorAll('.v-segment-track__btn')]
    expect(btns.map((b) => b.classList.contains('v-segment-track__btn--active'))).toEqual([
      false,
      true,
    ])
    expect(btns.map((b) => b.getAttribute('aria-selected'))).toEqual(['false', 'true'])
  })

  it('emits update:modelValue with the clicked option value', () => {
    let received = ''
    mount({ modelValue: 'week', 'onUpdate:modelValue': (v: string) => (received = v) })
    host?.querySelectorAll<HTMLButtonElement>('.v-segment-track__btn')[1]?.click()
    expect(received).toBe('month')
  })
})
