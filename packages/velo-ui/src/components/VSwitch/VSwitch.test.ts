// =============================================================================
// VSwitch Unit Tests
// =============================================================================
//
// Dependency-free SFC mount (createApp + happy-dom container) — the repo has
// no @vue/test-utils, and plugin-vue (vitest.config) compiles the .vue for
// us. Kit-compatible from day one: relative import, no application aliases —
// the file travels with the component into @velo/ui unchanged.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest'
import { createApp, type App } from 'vue'
import VSwitch from './VSwitch.vue'

let app: App | null = null
let host: HTMLElement | null = null

function mount(props: {
  modelValue?: boolean
  disabled?: boolean
  ariaLabel?: string
  'onUpdate:modelValue'?: (v: boolean) => void
}): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(VSwitch, props)
  app.mount(host)
  return host
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('VSwitch', () => {
  it('reflects the value in role=switch state: aria-checked + on class', () => {
    const off = mount({ modelValue: false })
    const offBtn = off.querySelector('.v-switch')
    expect(offBtn?.getAttribute('role')).toBe('switch')
    expect(offBtn?.getAttribute('aria-checked')).toBe('false')
    expect(offBtn?.classList.contains('v-switch--on')).toBe(false)

    const on = mount({ modelValue: true })
    expect(on.querySelector('.v-switch')?.getAttribute('aria-checked')).toBe('true')
    expect(on.querySelector('.v-switch')?.classList.contains('v-switch--on')).toBe(true)
  })

  it('toggles: a click emits update:modelValue with the negated value', () => {
    let received: boolean | null = null
    mount({ modelValue: false, 'onUpdate:modelValue': (v: boolean) => (received = v) })
    host?.querySelector<HTMLButtonElement>('.v-switch')?.click()
    expect(received).toBe(true)
  })

  it('does not toggle when disabled', () => {
    let received: boolean | null = null
    mount({
      modelValue: false,
      disabled: true,
      'onUpdate:modelValue': (v: boolean) => (received = v),
    })
    const btn = host?.querySelector<HTMLButtonElement>('.v-switch')
    expect(btn?.disabled).toBe(true)
    btn?.click()
    expect(received).toBeNull()
  })
})
