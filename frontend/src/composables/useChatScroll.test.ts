// =============================================================================
// VELO Frontend -- useChatScroll (FE-157 s4/scroll-time)
// =============================================================================
//
// Behaviour under test: keep-bottom (a pinned reader stays pinned across
// resizes, a reader of history is left alone), preserved position when an
// older page is prepended, and the sentinel observer lifecycle. happy-dom
// measures no layout, so scroll metrics are stubbed on the element.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref, type EffectScope } from 'vue'
import { isNearBottomMetrics, useChatScroll } from '@/composables/useChatScroll'

// -- Observer stubs -----------------------------------------------------------

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  disconnected = false
  constructor(public callback: () => void) {
    FakeResizeObserver.instances.push(this)
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true
  }
}

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  disconnected = false
  observed: Element[] = []
  constructor(
    public callback: (entries: Array<{ isIntersecting: boolean }>) => void,
    public options?: IntersectionObserverInit,
  ) {
    FakeIntersectionObserver.instances.push(this)
  }
  observe(el: Element): void {
    this.observed.push(el)
  }
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true
  }
  fire(isIntersecting: boolean): void {
    this.callback([{ isIntersecting }])
  }
}

interface FeedMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** A scroller whose geometry the test owns. */
function makeFeed(m: FeedMetrics): HTMLElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollHeight', { get: () => m.scrollHeight, configurable: true })
  Object.defineProperty(el, 'clientHeight', { get: () => m.clientHeight, configurable: true })
  Object.defineProperty(el, 'scrollTop', {
    get: () => m.scrollTop,
    set: (v: number) => {
      m.scrollTop = v
    },
    configurable: true,
  })
  return el
}

let scope: EffectScope

beforeEach(() => {
  FakeResizeObserver.instances = []
  FakeIntersectionObserver.instances = []
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  scope = effectScope()
})

afterEach(() => {
  scope.stop()
  vi.unstubAllGlobals()
})

describe('isNearBottomMetrics', () => {
  it('counts a drift within the threshold as at the bottom', () => {
    expect(isNearBottomMetrics(880, 1000, 100, 120)).toBe(true)
    expect(isNearBottomMetrics(700, 1000, 100, 120)).toBe(false)
  })
})

describe('useChatScroll keep-bottom', () => {
  it('re-pins a reader who was at the bottom when the feed resizes', () => {
    const m = { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 }
    const scrollEl = ref<HTMLElement | null>(makeFeed(m))
    const onResize = vi.fn()
    const chat = scope.run(() => useChatScroll({ scrollEl, onResize }))!

    chat.rememberBottomState()
    chat.attachKeepBottom()
    // Keyboard opens: the viewport shrinks by far more than the threshold.
    m.clientHeight = 150
    FakeResizeObserver.instances[0]!.callback()

    expect(onResize).toHaveBeenCalledTimes(1)
    expect(m.scrollTop).toBe(1000)
  })

  it('reports a re-pin only when the reader was held at the bottom', () => {
    const m = { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 }
    const scrollEl = ref<HTMLElement | null>(makeFeed(m))
    const onRepin = vi.fn()
    const chat = scope.run(() => useChatScroll({ scrollEl, onRepin }))!

    chat.attachKeepBottom()
    chat.rememberBottomState()
    FakeResizeObserver.instances[0]!.callback()
    expect(onRepin).toHaveBeenCalledTimes(1)

    // The reader scrolled up into history: a resize leaves them, no report.
    m.scrollTop = 100
    chat.rememberBottomState()
    FakeResizeObserver.instances[0]!.callback()
    expect(onRepin).toHaveBeenCalledTimes(1)
  })

  it('leaves a reader of history where they are', () => {
    const m = { scrollTop: 100, scrollHeight: 1000, clientHeight: 100 }
    const scrollEl = ref<HTMLElement | null>(makeFeed(m))
    const chat = scope.run(() => useChatScroll({ scrollEl }))!

    chat.rememberBottomState()
    expect(chat.isPinned()).toBe(false)
    chat.attachKeepBottom()
    FakeResizeObserver.instances[0]!.callback()

    expect(m.scrollTop).toBe(100)
  })

  it('decides from the remembered state, not from post-resize geometry', () => {
    const m = { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 }
    const scrollEl = ref<HTMLElement | null>(makeFeed(m))
    const chat = scope.run(() => useChatScroll({ scrollEl }))!

    chat.rememberBottomState() // pinned
    chat.attachKeepBottom()
    m.clientHeight = 150 // keyboard: live geometry now says "far from the bottom"
    expect(chat.isNearBottom()).toBe(false)
    FakeResizeObserver.instances[0]!.callback()

    expect(m.scrollTop).toBe(1000)
  })

  it('observes one element once and disconnects with the scope', () => {
    const scrollEl = ref<HTMLElement | null>(
      makeFeed({ scrollTop: 0, scrollHeight: 1, clientHeight: 1 }),
    )
    const chat = scope.run(() => useChatScroll({ scrollEl }))!

    chat.attachKeepBottom()
    chat.attachKeepBottom()
    expect(FakeResizeObserver.instances).toHaveLength(1)

    scope.stop()
    expect(FakeResizeObserver.instances[0]!.disconnected).toBe(true)
  })

  it('treats a missing scroller as pinned and does nothing', () => {
    const scrollEl = ref<HTMLElement | null>(null)
    const chat = scope.run(() => useChatScroll({ scrollEl }))!
    expect(chat.isNearBottom()).toBe(true)
    expect(() => chat.scrollToBottom()).not.toThrow()
    chat.attachKeepBottom()
    expect(FakeResizeObserver.instances).toHaveLength(0)
  })
})

describe('useChatScroll preservePosition', () => {
  it('shifts scrollTop by the height an older page added', async () => {
    const m = { scrollTop: 40, scrollHeight: 1000, clientHeight: 100 }
    const scrollEl = ref<HTMLElement | null>(makeFeed(m))
    const chat = scope.run(() => useChatScroll({ scrollEl }))!

    await chat.preservePosition(async () => {
      m.scrollHeight = 1600 // 600px of older entries prepended
    })

    expect(m.scrollTop).toBe(640)
  })
})

describe('useChatScroll sentinel', () => {
  it('fires onIntersect only while the sentinel intersects', async () => {
    const scrollEl = ref<HTMLElement | null>(
      makeFeed({ scrollTop: 0, scrollHeight: 1, clientHeight: 1 }),
    )
    const sentinel = ref<HTMLElement | null>(null)
    const onIntersect = vi.fn()
    const chat = scope.run(() => useChatScroll({ scrollEl }))!
    const handle = chat.observeSentinel(sentinel, { rootMargin: '1500px 0px 0px 0px', onIntersect })

    sentinel.value = document.createElement('div')
    await nextTick()
    const io = FakeIntersectionObserver.instances[0]!
    expect(io.options?.rootMargin).toBe('1500px 0px 0px 0px')
    expect(io.options?.root).toBe(scrollEl.value)

    io.fire(false)
    expect(onIntersect).not.toHaveBeenCalled()
    io.fire(true)
    expect(onIntersect).toHaveBeenCalledTimes(1)

    handle.attach() // already attached: no second observer
    expect(FakeIntersectionObserver.instances).toHaveLength(1)
  })

  it('rebuilds the observer when the sentinel element is swapped', async () => {
    const scrollEl = ref<HTMLElement | null>(
      makeFeed({ scrollTop: 0, scrollHeight: 1, clientHeight: 1 }),
    )
    const sentinel = ref<HTMLElement | null>(document.createElement('div'))
    const chat = scope.run(() => useChatScroll({ scrollEl }))!
    const handle = chat.observeSentinel(sentinel, { rootMargin: '0px', onIntersect: vi.fn() })
    handle.attach()
    const first = FakeIntersectionObserver.instances[0]!

    sentinel.value = null // list unmounted (search opened)
    await nextTick()
    expect(first.disconnected).toBe(true)

    sentinel.value = document.createElement('div') // list is back
    await nextTick()
    expect(FakeIntersectionObserver.instances).toHaveLength(2)
    expect(FakeIntersectionObserver.instances[1]!.observed).toHaveLength(1)
  })

  it('disconnects sentinel observers with the scope', () => {
    const scrollEl = ref<HTMLElement | null>(
      makeFeed({ scrollTop: 0, scrollHeight: 1, clientHeight: 1 }),
    )
    const sentinel = ref<HTMLElement | null>(document.createElement('div'))
    const chat = scope.run(() => useChatScroll({ scrollEl }))!
    chat.observeSentinel(sentinel, { rootMargin: '0px', onIntersect: vi.fn() }).attach()

    scope.stop()
    expect(FakeIntersectionObserver.instances[0]!.disconnected).toBe(true)
  })
})
