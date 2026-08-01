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
})
