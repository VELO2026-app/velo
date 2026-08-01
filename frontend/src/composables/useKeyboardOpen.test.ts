// =============================================================================
// VELO Frontend -- useKeyboardOpen Unit Tests (PROMPT №651, T24-1 fix pt. 2)
// =============================================================================
//
// useKeyboardOpen has onMounted/onBeforeUnmount, so it needs a real Vue
// component context -- mounts a minimal host (bare createApp, no
// @vue/test-utils, same idiom as every screen test in this repo).
//
// @tma.js/sdk-vue's `viewport` is module-mocked so tests can drive
// isMounted/stableHeight/height directly, without a real Telegram SDK.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { useKeyboardOpen } from '@/composables/useKeyboardOpen'

// vi.mock is hoisted above imports/top-level consts -- vi.hoisted() is the
// documented escape hatch so the factory can reference viewportMock without
// a temporal-dead-zone error.
const viewportMock = vi.hoisted(() => ({
  isMounted: vi.fn(() => false),
  stableHeight: vi.fn(() => 0),
  height: vi.fn(() => 0),
}))
vi.mock('@tma.js/sdk-vue', () => ({
  viewport: viewportMock,
}))

let app: App | null = null
let host: HTMLElement | null = null

function mount(): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  const Host = defineComponent({
    setup() {
      const { keyboardOpen } = useKeyboardOpen()
      return () => h('div', { 'data-open': String(keyboardOpen.value) })
    },
  })
  app = createApp(Host)
  app.mount(host)
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await nextTick()
}

function isOpen(): boolean {
  return host?.querySelector('div')?.getAttribute('data-open') === 'true'
}

function setBrowserViewport(innerHeight: number, visualHeight: number): void {
  Object.defineProperty(window, 'innerHeight', { value: innerHeight, configurable: true })
  Object.defineProperty(window, 'visualViewport', {
    value: { height: visualHeight, addEventListener: vi.fn(), removeEventListener: vi.fn() },
    configurable: true,
  })
}

describe('useKeyboardOpen', () => {
  beforeEach(() => {
    viewportMock.isMounted.mockReset().mockReturnValue(false)
    viewportMock.stableHeight.mockReset().mockReturnValue(0)
    viewportMock.height.mockReset().mockReturnValue(0)
  })

  afterEach(() => {
    app?.unmount()
    host?.remove()
    app = null
    host = null
  })

  it('detects the keyboard under the ANDROID SHRINK model, where the browser delta alone collapses to ~0', async () => {
    // Browser-level numbers collapse toward 0 (the WebView's own rendering
    // surface shrunk before the CSS engine saw it) -- the native signal is
    // what must carry this, exactly the case useKeyboardOpen was blind to
    // before this fix (T24-1: "no buttons show below" the field, because
    // the tab bar never hid).
    setBrowserViewport(800, 795)
    viewportMock.isMounted.mockReturnValue(true)
    viewportMock.stableHeight.mockReturnValue(800)
    viewportMock.height.mockReturnValue(500) // native delta = 300, real keyboard

    mount()
    await flush()

    expect(isOpen()).toBe(true)
  })

  it('detects the keyboard under the OVERLAY model with no native signal, same as before this fix', async () => {
    setBrowserViewport(800, 500)
    mount()
    await flush()
    expect(isOpen()).toBe(true)
  })

  it('at rest, with NO native signal, is closed -- identical to today (proved, not asserted blind)', async () => {
    setBrowserViewport(800, 798)
    mount()
    await flush()
    expect(isOpen()).toBe(false)
  })

  it('at rest, WITH a native signal available, is still closed', async () => {
    setBrowserViewport(800, 798)
    viewportMock.isMounted.mockReturnValue(true)
    viewportMock.stableHeight.mockReturnValue(800)
    viewportMock.height.mockReturnValue(798)
    mount()
    await flush()
    expect(isOpen()).toBe(false)
  })

  it('no visualViewport at all: stays false (unchanged no-op, standalone/older engines)', async () => {
    Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true })
    mount()
    await flush()
    expect(isOpen()).toBe(false)
  })
})
