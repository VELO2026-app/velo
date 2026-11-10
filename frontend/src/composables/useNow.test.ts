// =============================================================================
// VELO Frontend -- useNow (FE-157 s4/scroll-time)
// =============================================================================
//
// The rules under test: consumers of one cadence share ONE timer; the timer
// pauses while the document is hidden or the consumer is deactivated
// (keep-alive) and refreshes the value on resume; disposal clears everything.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, effectScope, h, KeepAlive, nextTick, ref, type EffectScope } from 'vue'
import { mount } from '@vue/test-utils'
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
