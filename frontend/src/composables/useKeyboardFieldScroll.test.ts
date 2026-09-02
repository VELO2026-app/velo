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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

// =============================================================================
// [FE-45 follow-up] The settle scroll's SEMANTICS: minimal, only-if-needed.
// It used to be an unconditional scrollIntoView({block:'center'}) -- which
// re-centered fields that were already fully visible, sweeping the form's
// upper rows out of view ("улетает наверх, хотя место есть"). The new contract
// prefers scrollIntoViewIfNeeded(false) (no-op when visible, nearest-edge
// reveal when not), with scrollIntoView({block:'nearest'}) as the fallback
// when the WebKit-ism is absent. Pinned by stubbing both APIs and firing the
// settle timer (happy-dom has no layout, so the real scroll is a no-op --
// what is provable here is WHICH API and ARGUMENTS the settle path calls).
// =============================================================================
describe('useKeyboardFieldScroll -- settle scroll semantics ([FE-45 follow-up])', () => {
  let callsIfNeeded: unknown[][] = []
  let callsIntoView: unknown[][] = []

  function stubScrollApis(): void {
    callsIfNeeded = []
    callsIntoView = []
    ;(Element.prototype as unknown as Record<string, unknown>).scrollIntoViewIfNeeded = function (
      this: Element,
      ...args: unknown[]
    ) {
      callsIfNeeded.push([this, ...args])
    }
    ;(Element.prototype as unknown as Record<string, unknown>).scrollIntoView = function (
      this: Element,
      ...args: unknown[]
    ) {
      callsIntoView.push([this, ...args])
    }
  }

  function restoreScrollApis(): void {
    delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoViewIfNeeded
    delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView
  }

  beforeEach(() => {
    installVisualViewport()
    stubScrollApis()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    restoreScrollApis()
    app?.unmount()
    host?.remove()
    app = null
    host = null
    inputEl = null
  })

  it('settle fires scrollIntoViewIfNeeded(false) -- minimal, never a forced centering', () => {
    mount()
    inputEl!.dispatchEvent(new FocusEvent('focus'))
    // The kick-on-focus arms the settle timer (SETTLE_MS = 120).
    vi.advanceTimersByTime(130)

    expect(callsIfNeeded.length).toBeGreaterThanOrEqual(1)
    // Called on the FIELD element, with centerIfNeeded=false.
    expect(callsIfNeeded[0]![0]).toBe(inputEl)
    expect(callsIfNeeded[0]![1]).toBe(false)
    // The old forced-center path is NOT used when the WebKit API exists.
    expect(callsIntoView).toHaveLength(0)
  })

  it('without the WebKit API, falls back to scrollIntoView({block:"nearest"}) -- not center', () => {
    delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoViewIfNeeded
    mount()
    inputEl!.dispatchEvent(new FocusEvent('focus'))
    vi.advanceTimersByTime(130)

    expect(callsIntoView.length).toBeGreaterThanOrEqual(1)
    expect(callsIntoView[0]![1]).toEqual({ block: 'nearest' })
  })
})
