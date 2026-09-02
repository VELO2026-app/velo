// =============================================================================
// VELO Frontend -- useViewportGeometry.ts Unit Tests (PROMPT №657, rebuild)
// =============================================================================
//
// Pure-function tests (isKeyboardOpenFrom / computeKeyboardBottomOffset) --
// no DOM/SDK dependency, ported/extended from the retired
// utils/keyboardDetection.test.ts. computeKeyboardBottomOffset's pan case is
// the RED-THEN-GREEN case for this rebuild: run against the OLD formula
// (frozenVh - visibleHeight, no offset term -- literally what
// DiaryFeedView.vue:891 computed before this prompt) it returns 400 where
// truth is 300 (quoted in the PROMPT №657 DONE report). This file tests the
// NEW formula, which is expected to be green throughout.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import {
  isKeyboardOpenFrom,
  computeKeyboardBottomOffset,
  restBaselineDelta,
  useViewportGeometry,
  keyboardOpen,
  viewportOffsetTop,
  visibleHeight,
} from '@/composables/useViewportGeometry'

describe('isKeyboardOpenFrom', () => {
  it('detects the keyboard under the ANDROID SHRINK model, where the browser delta alone collapses to ~0', () => {
    const nativeDelta = 300
    const layoutHeight = 800
    const visualHeight = 795 // browser delta = 5, well under threshold
    const threshold = 150

    expect(isKeyboardOpenFrom(nativeDelta, layoutHeight, visualHeight, threshold)).toBe(true)
  })

  it('detects the keyboard under the OVERLAY model (no native signal), same as before this fix', () => {
    const nativeDelta = null
    const layoutHeight = 800
    const visualHeight = 500 // browser delta = 300, over threshold
    const threshold = 150

    expect(isKeyboardOpenFrom(nativeDelta, layoutHeight, visualHeight, threshold)).toBe(true)
  })

  it('reports closed at rest, with a native signal available (delta ~0)', () => {
    expect(isKeyboardOpenFrom(2, 800, 798, 150)).toBe(false)
  })

  it('reports closed at rest, with no native signal (browser delta ~0)', () => {
    expect(isKeyboardOpenFrom(null, 800, 798, 150)).toBe(false)
  })

  it('a native delta of exactly the threshold is NOT open (strictly greater, matches the existing >)', () => {
    expect(isKeyboardOpenFrom(150, 800, 798, 150)).toBe(false)
  })
})

describe('restBaselineDelta (PROMPT №663)', () => {
  it('no baseline yet (0) returns null regardless of current height', () => {
    expect(restBaselineDelta(0, 523.7)).toBeNull()
  })

  it("THE RED-THEN-GREEN CASE: the owner's own device numbers, where BOTH the old native and browser deltas collapsed to ~0", () => {
    // At rest: restHeight established at 828.235 (the frozen box's own value,
    // reported by the device before any keyboard opened). Keyboard up:
    // visualViewport.height 523.697. The OLD inputs (quoted in PROMPT №663):
    // nativeKeyboardDelta() = stableHeight(523.7) - height(523.7) = 0 (WRONG,
    // reads as closed); browser fallback = innerHeight(523) - vv.height(523.7)
    // ~= 0 (WRONG too, same reason -- both move together on this device).
    // restBaselineDelta uses a DIFFERENT reference -- the pre-keyboard rest
    // height -- and gets the right answer.
    const delta = restBaselineDelta(828.235, 523.697)
    expect(delta).toBeCloseTo(304.538, 2)
    expect(isKeyboardOpenFrom(delta, 523, 523.697, 150)).toBe(true)
  })

  it('a taller reading than the current baseline is NOT how the baseline itself updates (pure function -- updateRestHeight, not exported, owns that)', () => {
    // restBaselineDelta is a pure comparison; a "new taller reading raises the
    // baseline" is publish()'s job (updateRestHeight), not this function's --
    // pinning that this one only ever computes restHeight - currentHeight.
    expect(restBaselineDelta(500, 600)).toBe(-100)
  })

  it('at rest (current close to the baseline) is NOT open', () => {
    const delta = restBaselineDelta(828.235, 828.235)
    expect(isKeyboardOpenFrom(delta, 828, 828.235, 150)).toBe(false)
  })
})

describe('computeKeyboardBottomOffset', () => {
  it('overlay model, no pan -- matches what the old (pre-rebuild) formula already got right', () => {
    // frozenVh - visibleHeight, same as the retired calc(frozen - vvh).
    expect(computeKeyboardBottomOffset(800, 400, 0)).toBe(400)
  })

  it('shrink model, no pan -- matches what the old formula already got right', () => {
    expect(computeKeyboardBottomOffset(800, 400, 0)).toBe(400)
  })

  it('pan present (offsetTop=100) -- THE case the old formula could not handle: 300, not 400', () => {
    // The old formula (frozenVh - visibleHeight = 800 - 400 = 400) was PROVEN
    // wrong here before this file existed -- quoted in the №657 DONE report.
    // The composer's true bottom edge must land at offsetTop + visibleHeight
    // (=500) measured from the top, i.e. frozenVh - 500 = 300 from the
    // bottom.
    expect(computeKeyboardBottomOffset(800, 400, 100)).toBe(300)
  })

  it('larger pan than the remaining visible height still resolves algebraically (no clamping here -- CSS bottom can go negative, which is a real signal, not a bug to hide)', () => {
    expect(computeKeyboardBottomOffset(800, 400, 500)).toBe(-100)
  })
})

// -- Integration: useViewportGeometry() live, driven through real
// visualViewport resize events -- same mounting idiom as the retired
// useKeyboardOpen.test.ts (bare createApp, tma.js SDK module-mocked).
const viewportMock = vi.hoisted(() => ({
  isMounted: vi.fn(() => false),
  isStable: vi.fn(() => true),
  stableHeight: vi.fn(() => 0),
  height: vi.fn(() => 0),
}))
vi.mock('@tma.js/sdk-vue', () => ({
  viewport: viewportMock,
}))

let app: App | null = null
let host: HTMLElement | null = null
let vvListeners: Record<string, () => void> = {}
let mockVv: { height: number; offsetTop: number } | null = null

// Mutates the SAME visualViewport object in place (real browsers never swap
// the object out from under an existing listener registration -- only its
// properties change). Creating a fresh object per call would silently break
// the composable's closured reference and test the harness, not the module.
function setBrowserViewport(innerHeight: number, height: number, offsetTop = 0): void {
  Object.defineProperty(window, 'innerHeight', { value: innerHeight, configurable: true })
  if (mockVv) {
    mockVv.height = height
    mockVv.offsetTop = offsetTop
    return
  }
  mockVv = { height, offsetTop }
  Object.defineProperty(window, 'visualViewport', {
    value: {
      get height() {
        return mockVv!.height
      },
      get offsetTop() {
        return mockVv!.offsetTop
      },
      addEventListener: (evt: string, fn: () => void) => {
        vvListeners[evt] = fn
      },
      removeEventListener: () => {},
    },
    configurable: true,
  })
}

function mount(): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  const Host = defineComponent({
    setup() {
      useViewportGeometry()
      return () => h('div')
    },
  })
  app = createApp(Host)
  app.mount(host)
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await nextTick()
  // setShift() schedules via requestAnimationFrame -- happy-dom runs rAF
  // callbacks on a macrotask, so give it one.
  await new Promise((r) => setTimeout(r, 0))
}

describe('useViewportGeometry() integration', () => {
  beforeEach(() => {
    vvListeners = {}
    mockVv = null
    viewportMock.isMounted.mockReset().mockReturnValue(false)
    viewportMock.isStable.mockReset().mockReturnValue(true)
    viewportMock.stableHeight.mockReset().mockReturnValue(0)
    viewportMock.height.mockReset().mockReturnValue(0)
  })

  afterEach(() => {
    app?.unmount()
    host?.remove()
    app = null
    host = null
  })

  it('publishes visibleHeight / viewportOffsetTop / keyboardOpen on mount, from the browser fallback', async () => {
    setBrowserViewport(800, 500, 0)
    mount()
    await flush()

    expect(visibleHeight.value).toBe(500)
    expect(viewportOffsetTop.value).toBe(0)
    expect(keyboardOpen.value).toBe(true) // browser delta 300 > threshold 150
  })

  it('picks up a pan (offsetTop > 0) on a live visualViewport resize event', async () => {
    setBrowserViewport(800, 400, 0)
    mount()
    await flush()
    expect(viewportOffsetTop.value).toBe(0)

    setBrowserViewport(800, 400, 120)
    vvListeners.resize?.()
    await flush()

    expect(viewportOffsetTop.value).toBe(120)
  })

  it('reflects the SAME ref through the useKeyboardOpen() wrapper (single source, not a second copy)', async () => {
    setBrowserViewport(800, 500, 0)
    mount()
    await flush()

    const { useKeyboardOpen } = await import('@/composables/useKeyboardOpen')
    const { keyboardOpen: fromWrapper } = useKeyboardOpen()
    expect(fromWrapper.value).toBe(keyboardOpen.value)
    expect(fromWrapper).toBe(keyboardOpen) // literally the same object, not a copy
  })

  // [FE-44] The owner's device screenshot: keyboard closed, yet the diary
  // stayed capped at the keyboard-open height -- the closing keyboard's LAST
  // visualViewport resize never fired, so publish() never ran again and both
  // `html.is-keyboard-open` and `--velo-vvh` kept their keyboard-open values.
  // The fix: focusout (which cannot be missed -- no keyboard without a
  // focused field) resets the state SYNCHRONOUSLY when focus leaves every
  // editable, with a delayed recheck as the backstop.
  it('[FE-44] focusout heals a stale keyboard-open state even when NO resize event fires', async () => {
    const root = document.documentElement
    // At rest: baseline seeds, keyboard closed.
    setBrowserViewport(828, 828, 0)
    mount()
    await flush()
    expect(keyboardOpen.value).toBe(false)
    expect(root.classList.contains('is-keyboard-open')).toBe(false)

    // Keyboard opens (resize fires): class on, --velo-vvh capped.
    setBrowserViewport(828, 500, 0)
    vvListeners.resize?.()
    await flush()
    expect(keyboardOpen.value).toBe(true)
    expect(root.classList.contains('is-keyboard-open')).toBe(true)
    expect(root.style.getPropertyValue('--velo-vvh')).toBe('500px')

    // The MISSED close: the viewport object heals to full height, but NO
    // resize event fires. The stale state must still be in place here --
    // that is the bug's premise.
    setBrowserViewport(828, 828, 0)
    expect(root.classList.contains('is-keyboard-open')).toBe(true)

    // focusout (to nothing) -> healed IMMEDIATELY, not after a delay: the
    // keyboard vacates its area over ~250ms and the app must already be at
    // full height when that space becomes visible.
    window.dispatchEvent(new FocusEvent('focusout'))
    expect(root.classList.contains('is-keyboard-open')).toBe(false)
    expect(root.style.getPropertyValue('--velo-vvh')).toBe('')
    expect(keyboardOpen.value).toBe(false)

    // ...AND the root pan is zeroed (rAF-deferred): the close pan surviving
    // keyboard-dismiss was FE-7's own device measurement (scrollY 154), and
    // it paints the white band no keyboard-state reset can reach.
    const scrollTo = vi.fn()
    Object.defineProperty(window, 'scrollY', { value: 154, configurable: true })
    window.scrollTo = scrollTo
    window.dispatchEvent(new FocusEvent('focusout'))
    await new Promise((r) => setTimeout(r, 0)) // rAF lands on a macrotask
    expect(scrollTo).toHaveBeenCalledWith(0, 0)

    // The settle timer (700ms) must not resurrect the open state either --
    // its re-check publishes at-rest truth.
    await new Promise((r) => setTimeout(r, 800))
    await flush()
    expect(keyboardOpen.value).toBe(false)
    expect(root.classList.contains('is-keyboard-open')).toBe(false)
    expect(root.classList.contains('is-keyboard-closing')).toBe(false)
  })

  // [FE-44] The guard: a field-to-field focus move keeps the keyboard up --
  // focusout must NOT reset anything there.
  it('[FE-44] focusout to ANOTHER editable (keyboard stays) does not reset the open state', async () => {
    const root = document.documentElement
    setBrowserViewport(828, 500, 0)
    mount()
    await flush()
    expect(root.classList.contains('is-keyboard-open')).toBe(true)

    const fieldA = document.createElement('input')
    const fieldB = document.createElement('input')
    document.body.append(fieldA, fieldB)
    fieldA.focus()
    window.dispatchEvent(new FocusEvent('focusout', { relatedTarget: fieldB }))
    expect(root.classList.contains('is-keyboard-open')).toBe(true)
    expect(root.style.getPropertyValue('--velo-vvh')).toBe('500px')
    fieldA.remove()
    fieldB.remove()
  })

  // [FE-44] The owner's "уезжает плохо: белый фон, потом растягивается":
  // intermediate close-resizes arrive LAGGING the visual reveal, and every
  // one of them used to re-assert the cap at a stale smaller height. The
  // first RISING frame must drop the cap and hold at-rest for the whole
  // animation -- the iOS keyboard is an overlay, a full-height app is simply
  // revealed, never white.
  it('[FE-44] intermediate close-resizes (rising heights) never re-cap the app', async () => {
    const root = document.documentElement
    setBrowserViewport(828, 500, 0)
    mount()
    await flush()
    expect(root.classList.contains('is-keyboard-open')).toBe(true)

    // Close animation frame 1: rising, still far from rest (the OLD behavior
    // read delta 828-650=178 > 150 as "still open" and re-capped).
    setBrowserViewport(828, 650, 0)
    vvListeners.resize?.()
    await flush()
    expect(root.classList.contains('is-keyboard-open')).toBe(false)
    expect(root.style.getPropertyValue('--velo-vvh')).toBe('')

    // Suppressed frames AND the final one stay at rest -- no late stretch.
    setBrowserViewport(828, 780, 0)
    vvListeners.resize?.()
    await flush()
    expect(root.classList.contains('is-keyboard-open')).toBe(false)

    setBrowserViewport(828, 828, 0)
    vvListeners.resize?.()
    await new Promise((r) => setTimeout(r, 400)) // window expires
    await flush()
    expect(root.classList.contains('is-keyboard-open')).toBe(false)
  })

  // [FE-44] focusin on an editable cancels the close suppression -- a quick
  // reopen must re-assert the cap from its first falling resize, not after
  // the window times out.
  it('[FE-44] a reopen during the close window re-asserts the cap immediately', async () => {
    const root = document.documentElement
    setBrowserViewport(828, 500, 0)
    mount()
    await flush()
    expect(root.classList.contains('is-keyboard-open')).toBe(true)

    window.dispatchEvent(new FocusEvent('focusout')) // close starts, suppressed
    expect(root.classList.contains('is-keyboard-open')).toBe(false)

    // The user focuses a field again before the window ends: focusin bubbles
    // from the element (window-level listener, target = the field).
    const field = document.createElement('input')
    document.body.append(field)
    field.focus()
    field.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))

    setBrowserViewport(828, 500, 0)
    vvListeners.resize?.()
    await flush()
    expect(root.classList.contains('is-keyboard-open')).toBe(true)
    expect(root.style.getPropertyValue('--velo-vvh')).toBe('500px')
    field.remove()
  })
})
