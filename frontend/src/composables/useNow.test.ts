// =============================================================================
// VELO Frontend -- useNow (FE-157 s4/scroll-time)
// =============================================================================
//
// The rules under test: consumers of one cadence share ONE timer; the timer
// pauses while the document is hidden or the consumer is deactivated
// (keep-alive) and refreshes the value on resume; disposal clears everything.
// Each consumer owns its ref (a paused one is not woken by the others' ticks),
// and the keep-alive hooks bind only when called directly in a component's
// setup -- never from a store or another scope created inside it.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, effectScope, h, KeepAlive, nextTick, ref, type EffectScope } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, defineStore, setActivePinia } from 'pinia'
import { useNow } from '@/composables/useNow'

const hiddenState = vi.hoisted(() => ({ hidden: false }))
vi.mock('@/platform/dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/platform/dom')>()),
  isDocumentHidden: () => hiddenState.hidden,
}))

function setHidden(hidden: boolean): void {
  hiddenState.hidden = hidden
  document.dispatchEvent(new Event('visibilitychange'))
}

let scope: EffectScope

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-10T10:00:00Z'))
  hiddenState.hidden = false
  scope = effectScope()
})

afterEach(() => {
  scope.stop()
  vi.useRealTimers()
})

describe('useNow', () => {
  it('ticks on the interval', () => {
    const now = scope.run(() => useNow(1000))!
    const start = now.value
    vi.advanceTimersByTime(3000)
    expect(now.value).toBe(start + 3000)
  })

  it('shares one timer between consumers of the same interval', () => {
    const a = scope.run(() => useNow(1000))!
    const b = scope.run(() => useNow(1000))!
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(1000)
    expect(a.value).toBe(b.value)
  })

  it('pauses while the document is hidden and refreshes on return', () => {
    const now = scope.run(() => useNow(1000))!
    setHidden(true)
    expect(vi.getTimerCount()).toBe(0)
    const frozen = now.value
    vi.advanceTimersByTime(60_000)
    expect(now.value).toBe(frozen)

    setHidden(false)
    expect(vi.getTimerCount()).toBe(1)
    expect(now.value).toBe(Date.now())
  })

  it('clears the timer when the last consumer is disposed', () => {
    const a = effectScope()
    const b = effectScope()
    a.run(() => useNow(1000))
    b.run(() => useNow(1000))
    a.stop()
    expect(vi.getTimerCount()).toBe(1)
    b.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('pauses on deactivated and resumes on activated (keep-alive)', async () => {
    let now: { value: number } = { value: 0 }
    const Child = defineComponent({
      setup() {
        now = useNow(1000)
        return () => h('div')
      },
    })
    const show = ref(true)
    const Host = defineComponent({
      setup: () => () => h(KeepAlive, null, { default: () => (show.value ? h(Child) : h('span')) }),
    })
    const wrapper = mount(Host)
    vi.advanceTimersByTime(2000)
    expect(now.value).toBe(Date.now())

    show.value = false
    await nextTick()
    const frozen = now.value
    vi.advanceTimersByTime(5000)
    expect(now.value).toBe(frozen)

    show.value = true
    await nextTick()
    expect(now.value).toBe(Date.now())
    vi.advanceTimersByTime(1000)
    expect(now.value).toBe(Date.now())

    wrapper.unmount()
    const stopped = now.value
    vi.advanceTimersByTime(5000)
    expect(now.value).toBe(stopped)
  })
})

describe('useNow: lifecycle ownership (FE-157 s4 review #1)', () => {
  it('gives every consumer its own ref: a deactivated consumer does not receive ticks', async () => {
    let paused: { value: number } = { value: 0 }
    const Paused = defineComponent({
      setup() {
        paused = useNow(1000)
        return () => h('div')
      },
    })
    const show = ref(true)
    const Host = defineComponent({
      setup: () => () =>
        h(KeepAlive, null, { default: () => (show.value ? h(Paused) : h('span')) }),
    })
    const wrapper = mount(Host)
    // A second, always-active consumer of the same cadence keeps the timer running.
    const live = scope.run(() => useNow(1000))!

    show.value = false
    await nextTick()
    const frozen = paused.value
    vi.advanceTimersByTime(5000)
    expect(vi.getTimerCount()).toBe(1)
    expect(live.value).toBe(Date.now())
    expect(paused.value).toBe(frozen)

    wrapper.unmount()
  })

  it('a store clock does not borrow the lifecycle of the component that first created the store', async () => {
    setActivePinia(createPinia())
    const useClockStore = defineStore('useNow-test-clock', () => ({ now: useNow(1000) }))
    let store: ReturnType<typeof useClockStore> | null = null
    const FirstUser = defineComponent({
      setup() {
        store = useClockStore()
        return () => h('div')
      },
    })
    const show = ref(true)
    const Host = defineComponent({
      setup: () => () =>
        h(KeepAlive, null, { default: () => (show.value ? h(FirstUser) : h('span')) }),
    })
    const wrapper = mount(Host)

    // Deactivating the component must not pause the store's clock...
    show.value = false
    await nextTick()
    vi.advanceTimersByTime(3000)
    expect(store!.now).toBe(Date.now())

    // ...nor must unmounting it stop the clock.
    wrapper.unmount()
    vi.advanceTimersByTime(3000)
    expect(store!.now).toBe(Date.now())

    // The store's own scope owns the clock.
    store!.$dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('in a foreign scope inside setup(), stops with that scope, not with the component', () => {
    let inner: EffectScope | null = null
    let now: { value: number } = { value: 0 }
    const Comp = defineComponent({
      setup() {
        inner = effectScope(true)
        now = inner.run(() => useNow(1000))!
        return () => h('div')
      },
    })
    const wrapper = mount(Comp)
    wrapper.unmount()
    vi.advanceTimersByTime(2000)
    expect(now.value).toBe(Date.now())

    inner!.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})
