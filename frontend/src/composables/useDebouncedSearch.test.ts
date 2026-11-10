import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { useDebouncedSearch, type DebouncedSearchRun } from './useDebouncedSearch'

describe('useDebouncedSearch', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('debounces keystrokes into one call with the last query', async () => {
    const source = ref('')
    const handler = vi.fn()
    const scope = effectScope()
    scope.run(() => useDebouncedSearch(source, handler))
    source.value = 'a'
    await nextTick()
    source.value = 'ab'
    await nextTick()
    vi.advanceTimersByTime(299)
    expect(handler).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0]).toBe('ab')
    scope.stop()
  })

  it('marks an older run stale once a newer one fires', async () => {
    const source = ref('')
    const runs: DebouncedSearchRun[] = []
    const scope = effectScope()
    scope.run(() => useDebouncedSearch(source, (_q, run) => void runs.push(run)))
    source.value = 'a'
    await nextTick()
    vi.advanceTimersByTime(300)
    source.value = 'b'
    await nextTick()
    vi.advanceTimersByTime(300)
    expect(runs).toHaveLength(2)
    expect(runs[0].isStale()).toBe(true)
    expect(runs[1].isStale()).toBe(false)
    scope.stop()
  })

  it('clears the timer and invalidates in-flight runs on scope disposal', async () => {
    const source = ref('')
    const runs: DebouncedSearchRun[] = []
    const scope = effectScope()
    scope.run(() => useDebouncedSearch(source, (_q, run) => void runs.push(run)))
    source.value = 'a'
    await nextTick()
    vi.advanceTimersByTime(300)
    source.value = 'b'
    await nextTick()
    scope.stop()
    vi.advanceTimersByTime(1000)
    expect(runs).toHaveLength(1)
    expect(runs[0].isStale()).toBe(true)
  })

  it('beforeSchedule=false cancels the pending fetch', async () => {
    const source = ref('')
    const handler = vi.fn()
    const scope = effectScope()
    scope.run(() =>
      useDebouncedSearch(source, handler, { beforeSchedule: (q) => q.trim().length > 0 }),
    )
    source.value = 'a'
    await nextTick()
    source.value = ''
    await nextTick()
    vi.advanceTimersByTime(1000)
    expect(handler).not.toHaveBeenCalled()
    scope.stop()
  })
})
