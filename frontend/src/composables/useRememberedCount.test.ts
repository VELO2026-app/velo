// =============================================================================
// VELO Frontend -- useRememberedCount (skeleton sized like the last answer)
// =============================================================================

import { afterEach, describe, expect, it } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { useRememberedCount } from '@/composables/useRememberedCount'

const KEY = 'velo:skeleton-count:test-block'

afterEach(() => {
  sessionStorage.clear()
})

function run(count: ReturnType<typeof ref<number>>, ready: ReturnType<typeof ref<boolean>>) {
  const scope = effectScope()
  const result = scope.run(() =>
    useRememberedCount(
      'test-block',
      () => count.value ?? 0,
      () => ready.value ?? false,
      { fallback: 3, max: 3 },
    ),
  )
  if (!result) throw new Error('no scope')
  return { result, stop: () => scope.stop() }
}

describe('useRememberedCount', () => {
  it('nothing known: the fallback size', () => {
    const { result, stop } = run(ref(0), ref(false))
    expect(result.value).toBe(3)
    stop()
  })

  it('a block that starts ready and empty (not asked yet) does not teach "0"', async () => {
    const { result, stop } = run(ref(0), ref(true))
    await nextTick()
    expect(result.value).toBe(3)
    expect(sessionStorage.getItem(KEY)).toBeNull()
    stop()
  })

  it('an empty answer is remembered, and the next skeleton is one placeholder', async () => {
    const count = ref(0)
    const ready = ref(false)
    const first = run(count, ready)
    ready.value = true
    await nextTick()
    expect(sessionStorage.getItem(KEY)).toBe('0')
    first.stop()

    const second = run(ref(0), ref(false))
    expect(second.result.value).toBe(1)
    second.stop()
  })

  it('clamps to the display cap', async () => {
    const count = ref(0)
    const ready = ref(false)
    const { result, stop } = run(count, ready)
    count.value = 12
    ready.value = true
    await nextTick()
    expect(result.value).toBe(3)
    count.value = 2
    await nextTick()
    expect(result.value).toBe(2)
    stop()
  })
})
