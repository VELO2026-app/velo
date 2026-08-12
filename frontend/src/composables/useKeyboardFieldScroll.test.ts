// =============================================================================
// VELO Frontend -- useKeyboardFieldScroll Unit Tests (PROMPT №679)
// =============================================================================
//
// The owed test for 3ad1433d's unmount-cleanup fix: onFieldFocus attaches a
// `resize` listener to the LONG-LIVED, global window.visualViewport. It used
// to be removed only on the field's own `blur` -- navigating away with the
// keyboard still open (no blur fires first) leaked it forever, along with
// everything its closure keeps alive. The fix adds onUnmounted() cleanup.
//
// This is a component-lifecycle concern (onUnmounted only runs inside a
// mounted component's setup()), so it needs the bare createApp + real DOM
// idiom (matches useViewportGeometry.test.ts), not a call to onFieldFocus in
// isolation -- calling it outside a component would make onUnmounted a no-op
// and the test would pass for the wrong reason.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { useKeyboardFieldScroll } from '@/composables/useKeyboardFieldScroll'

// Tracks real add/remove calls against a single shared listener set, so
// "the listener is gone after unmount" is an actual assertion, not a no-op
// double (unlike useViewportGeometry.test.ts's mock, whose removeEventListener
// is a no-op because that suite never needs to prove removal).
let resizeListeners: Set<() => void> = new Set()

function installVisualViewport(): void {
  resizeListeners = new Set()
  Object.defineProperty(window, 'visualViewport', {
    value: {
      addEventListener: (evt: string, fn: () => void) => {
        if (evt === 'resize') resizeListeners.add(fn)
      },
      removeEventListener: (evt: string, fn: () => void) => {
        if (evt === 'resize') resizeListeners.delete(fn)
      },
    },
    configurable: true,
  })
}

let app: App | null = null
let host: HTMLElement | null = null
let inputEl: HTMLInputElement | null = null

function mount(): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  const Host = defineComponent({
    setup() {
      const { onFieldFocus } = useKeyboardFieldScroll()
      return () =>
        h('input', { ref: (el) => (inputEl = el as HTMLInputElement), onFocus: onFieldFocus })
    },
  })
  app = createApp(Host)
  app.mount(host)
}

describe('useKeyboardFieldScroll (unmount cleanup, owed by 3ad1433d)', () => {
  beforeEach(() => {
    installVisualViewport()
  })

  afterEach(() => {
    app?.unmount()
    host?.remove()
    app = null
    host = null
    inputEl = null
  })

  it('attaches a visualViewport resize listener on focus', () => {
    mount()
    expect(resizeListeners.size).toBe(0)

    inputEl!.dispatchEvent(new FocusEvent('focus'))

    expect(resizeListeners.size).toBe(1)
  })

  it("removes the listener on the field's own blur (unchanged behaviour)", () => {
    mount()
    inputEl!.dispatchEvent(new FocusEvent('focus'))
    expect(resizeListeners.size).toBe(1)

    inputEl!.dispatchEvent(new FocusEvent('blur'))

    expect(resizeListeners.size).toBe(0)
  })

  it('THE OWED CASE: unmounting WITHOUT blur still removes the listener -- this must go red without the onUnmounted fix', () => {
    mount()
    inputEl!.dispatchEvent(new FocusEvent('focus'))
    expect(resizeListeners.size).toBe(1) // sanity: the leak precondition is real

    // Nav-away-with-keyboard-open: the component is torn down, blur never fires.
    app!.unmount()
    host!.remove()
    app = null
    host = null

    expect(resizeListeners.size).toBe(0)
  })
})
