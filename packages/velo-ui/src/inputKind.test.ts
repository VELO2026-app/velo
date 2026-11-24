// =============================================================================
// @velo/ui -- field `kind` (soft-keyboard presets) tests
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest'
import { createApp, h, type App, type Component } from 'vue'
import VInput from './components/VInput/VInput.vue'
import VTextarea from './components/VTextarea/VTextarea.vue'
import { inputKindAttrs } from './inputKind'

let app: App | null = null
let host: HTMLElement | null = null

function mountField(
  component: Component,
  props: Record<string, unknown>,
  affix = false,
): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({
    render: () =>
      h(
        component,
        { modelValue: '', ...props },
        affix ? { suffix: () => h('span', 'x') } : undefined,
      ),
  })
  app.mount(host)
  const el = host.querySelector('input, textarea')
  if (!(el instanceof HTMLElement)) throw new Error('field did not render')
  return el
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('inputKindAttrs', () => {
  it('yields nothing without a kind', () => {
    expect(inputKindAttrs(undefined)).toEqual({})
  })
})

describe('VInput kind', () => {
  it('email sets the email keyboard and turns autocorrect off', () => {
    const el = mountField(VInput, { kind: 'email', type: 'email' })
    expect(el.getAttribute('inputmode')).toBe('email')
    expect(el.getAttribute('autocomplete')).toBe('email')
    expect(el.getAttribute('autocapitalize')).toBe('none')
    expect(el.getAttribute('enterkeyhint')).toBe('next')
  })

  it('search sets the search action key', () => {
    const el = mountField(VInput, { kind: 'search' })
    expect(el.getAttribute('enterkeyhint')).toBe('search')
    expect(el.getAttribute('inputmode')).toBe('search')
  })

  it('reaches the input on the affix render path too', () => {
    const el = mountField(VInput, { kind: 'tel' }, true)
    expect(el.getAttribute('inputmode')).toBe('tel')
  })

  it('a native attribute from the caller wins over the preset', () => {
    const el = mountField(VInput, { kind: 'search', enterkeyhint: 'go' })
    expect(el.getAttribute('enterkeyhint')).toBe('go')
    expect(el.getAttribute('inputmode')).toBe('search')
  })

  it('without kind no keyboard attributes are rendered', () => {
    const el = mountField(VInput, {})
    for (const a of ['inputmode', 'enterkeyhint', 'autocomplete', 'autocapitalize']) {
      expect(el.hasAttribute(a)).toBe(false)
    }
  })
})

describe('VTextarea kind', () => {
  it('message keeps Enter as a line break and capitalises sentences', () => {
    const el = mountField(VTextarea, { kind: 'message' })
    expect(el.getAttribute('enterkeyhint')).toBe('enter')
    expect(el.getAttribute('autocapitalize')).toBe('sentences')
  })

  it('without kind no keyboard attributes are rendered', () => {
    const el = mountField(VTextarea, {})
    expect(el.hasAttribute('enterkeyhint')).toBe(false)
  })
})
