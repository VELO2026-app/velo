// =============================================================================
// @velo/ui -- keyboard field-scroll seam Unit Tests (FE-143)
// =============================================================================
//
// Pins the seam's two contracts (see the module banner):
//   1. the DEFAULT is a callable no-op -- a mount without a provider (a
//      Storybook host, a standalone test) binds onFieldFocus and nothing
//      happens, nothing throws;
//   2. a provided FACTORY runs in the consumer's own setup and its product
//      is what the consumer receives -- the focus event reaches exactly the
//      host implementation, and per-consumer lifecycle cleanup (the app's
//      unmount reap) stays possible.
//
// Dependency-free mount idiom (createApp + happy-dom), matching the kit's
// component tests.
// =============================================================================

import { describe, it, expect, afterEach, vi } from 'vitest'
import { createApp, defineComponent, h, provide, type App } from 'vue'
import { KEYBOARD_FIELD_SCROLL_INJECTION_KEY, useKeyboardFieldScroll } from './keyboardFieldScroll'

let app: App | null = null
let host: HTMLElement | null = null
let inputEl: HTMLInputElement | null = null

// The provider must sit ON A PARENT: inject() resolves only ancestors'
// provides, never the calling component's own -- so the mount mirrors the
// real shape (host root provides, consumer below).
function mount(withProvider: boolean, factory?: () => { onFieldFocus: (e: FocusEvent) => void }) {
  host = document.createElement('div')
  document.body.appendChild(host)
  const Field = defineComponent({
    setup() {
      const { onFieldFocus } = useKeyboardFieldScroll()
      return () =>
        h('input', { ref: (el) => (inputEl = el as HTMLInputElement), onFocus: onFieldFocus })
    },
  })
  const Root = defineComponent({
    setup() {
      if (withProvider && factory) {
        provide(KEYBOARD_FIELD_SCROLL_INJECTION_KEY, factory)
      }
      return () => h(Field)
    },
  })
  app = createApp(Root)
  app.mount(host)
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  inputEl = null
})

describe('keyboardFieldScroll seam (FE-143)', () => {
  it('without a provider: onFieldFocus is a callable no-op, the focus event is simply absorbed', () => {
    mount(false)
    expect(() => inputEl!.dispatchEvent(new FocusEvent('focus'))).not.toThrow()
  })

  it('with a provider: the consumer receives the factory product and focus events reach the host implementation', () => {
    const onFieldFocus = vi.fn()
    const factory = vi.fn(() => ({ onFieldFocus }))
    mount(true, factory)

    // The factory ran in the consumer's setup -- exactly once for this consumer.
    expect(factory).toHaveBeenCalledTimes(1)

    inputEl!.dispatchEvent(new FocusEvent('focus'))
    expect(onFieldFocus).toHaveBeenCalledTimes(1)
    expect(onFieldFocus.mock.calls[0]![0]).toBeInstanceOf(FocusEvent)
  })

  it('each consumer gets its own product: two mounts run the factory twice', () => {
    const factory = vi.fn(() => ({ onFieldFocus: () => undefined }))

    mount(true, factory)
    const firstApp = app
    const firstHost = host
    app = null
    host = null
    inputEl = null

    mount(true, factory)
    expect(factory).toHaveBeenCalledTimes(2)

    firstApp?.unmount()
    firstHost?.remove()
  })
})
