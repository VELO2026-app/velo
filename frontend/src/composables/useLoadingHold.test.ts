// =============================================================================
// VELO Frontend -- useDelayedFlag / useLoadingHold (loading system)
// =============================================================================
//
// The rule under test: nothing shows for a fast answer (< 300 ms); once a
// placeholder was seen it stays at least 450 ms; `reveal` marks content that
// arrives after a visible placeholder; `settled()` resolves when it is gone.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref, type EffectScope } from 'vue'
import {
  LOADING_DELAY_MS,
  LOADING_MIN_DURATION_MS,
  useDelayedFlag,
  useLoadingHold,
} from '@/composables/useLoadingHold'

let scope: EffectScope

beforeEach(() => {
  vi.useFakeTimers()
  scope = effectScope()
})

afterEach(() => {
  scope.stop()
  vi.useRealTimers()
})

describe('useDelayedFlag', () => {
  it('a fast answer never turns the flag on', async () => {
    const source = ref(true)
    const flag = scope.run(() => useDelayedFlag(source))!
    vi.advanceTimersByTime(LOADING_DELAY_MS - 10)
    source.value = false
    await nextTick()
    vi.advanceTimersByTime(1000)
    expect(flag.value).toBe(false)
  })

  it('a slow answer turns it on after the delay and holds it for the minimum', async () => {
    const source = ref(true)
    const flag = scope.run(() => useDelayedFlag(source))!
    vi.advanceTimersByTime(LOADING_DELAY_MS)
    expect(flag.value).toBe(true)

    vi.advanceTimersByTime(50)
    source.value = false // data after 300 ms: seen for only 50 ms so far
    await nextTick()
    expect(flag.value).toBe(true)

    vi.advanceTimersByTime(LOADING_MIN_DURATION_MS - 50 - 1)
    expect(flag.value).toBe(true)
    vi.advanceTimersByTime(1)
    expect(flag.value).toBe(false)
  })

  it('a long wait that already outlasted the minimum hides at once', async () => {
    const source = ref(true)
    const flag = scope.run(() => useDelayedFlag(source))!
    vi.advanceTimersByTime(LOADING_DELAY_MS + LOADING_MIN_DURATION_MS + 100)
    source.value = false
    await nextTick()
    vi.advanceTimersByTime(0)
    expect(flag.value).toBe(false)
  })
})

describe('useLoadingHold', () => {
  it('fast: the skeleton is mounted only while pending, reveal stays false', async () => {
    const pending = ref(true)
    const hold = scope.run(() => useLoadingHold(pending))!
    expect(hold.showSkeleton.value).toBe(true) // mounted at once (CSS-invisible)

    pending.value = false
    await nextTick()
    expect(hold.showSkeleton.value).toBe(false)
    expect(hold.reveal.value).toBe(false)
    await expect(hold.settled()).resolves.toBeUndefined()
  })

  it('slow: held for the minimum after the data, then settled() resolves and reveal is set', async () => {
    const pending = ref(true)
    const hold = scope.run(() => useLoadingHold(pending))!
    vi.advanceTimersByTime(LOADING_DELAY_MS)
    await nextTick()
    expect(hold.reveal.value).toBe(true)

    pending.value = false
    await nextTick()
    expect(hold.showSkeleton.value).toBe(true)

    let done = false
    void hold.settled().then(() => {
      done = true
    })
    vi.advanceTimersByTime(LOADING_MIN_DURATION_MS - 1)
    await nextTick()
    expect(done).toBe(false)

    vi.advanceTimersByTime(1)
    await nextTick()
    await nextTick()
    expect(hold.showSkeleton.value).toBe(false)
    expect(done).toBe(true)
  })
})
