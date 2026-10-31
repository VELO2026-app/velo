import { describe, it, expect } from 'vitest'
import { reactive } from 'vue'
import { replaceEqualDeep } from './structuralShare'

describe('replaceEqualDeep', () => {
  it('an equal answer returns the previous reference itself', () => {
    const prev = [
      { id: 'a', n: 1, tags: ['x'] },
      { id: 'b', n: 2, tags: [] },
    ]
    const next = JSON.parse(JSON.stringify(prev)) as typeof prev
    expect(replaceEqualDeep(prev, next)).toBe(prev)
  })

  it('a partly changed list keeps the unchanged rows', () => {
    const prev = [
      { id: 'a', n: 1 },
      { id: 'b', n: 2 },
    ]
    const next = [
      { id: 'a', n: 1 },
      { id: 'b', n: 3 },
    ]
    const out = replaceEqualDeep(prev, next)
    expect(out).not.toBe(prev)
    expect(out[0]).toBe(prev[0])
    expect(out[1]).toEqual({ id: 'b', n: 3 })
  })

  it('length, keys and types count as changes', () => {
    expect(replaceEqualDeep([1, 2], [1, 2, 3])).toEqual([1, 2, 3])
    expect(replaceEqualDeep({ a: 1 }, { a: 1, b: undefined })).toEqual({ a: 1, b: undefined })
    expect(replaceEqualDeep({ a: 1 }, null)).toBeNull()
    expect(replaceEqualDeep(null, { a: 1 })).toEqual({ a: 1 })
    expect(replaceEqualDeep({ a: [1] }, { a: { 0: 1 } })).toEqual({ a: { 0: 1 } })
  })

  it('reactive store state: an equal answer returns the proxy (a no-op assignment)', () => {
    const state = reactive({ list: [{ id: 'a', when: '2026-01-01' }] })
    const shown = state.list
    const out = replaceEqualDeep(state.list, [{ id: 'a', when: '2026-01-01' }])
    expect(out).toBe(shown)
  })
})
