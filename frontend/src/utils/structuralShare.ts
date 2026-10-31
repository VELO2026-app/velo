// =============================================================================
// VELO Frontend -- structural sharing for revalidated data
// =============================================================================
// A silent refresh answers with brand-new objects even when nothing changed.
// Assigning them as-is re-triggers every computed and re-renders every row
// (and wakes the motion built on top: list moves, height glides). This keeps
// the PREVIOUS references wherever the fresh value is deep-equal, so:
//   - an identical answer returns `prev` itself -> assigning it to a ref is a
//     no-op (Vue compares raw values), nothing re-renders;
//   - a partly changed list keeps the unchanged rows' objects (their cards do
//     not re-render), only the changed ones are new.
// Same idea as TanStack Query's `structuralSharing` (replaceEqualDeep).
// Only plain objects and arrays are walked; anything else compares by value.
// =============================================================================

import { toRaw } from 'vue'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

export function replaceEqualDeep<T>(prev: unknown, next: T): T {
  if (Object.is(prev, next)) return prev as T
  // Store state comes back as reactive proxies: compare the raw shape, but
  // hand back the value as read (the proxy) so a same-value assignment is a
  // no-op for Vue.
  const prevRaw: unknown = prev !== null && typeof prev === 'object' ? toRaw(prev) : prev
  if (Array.isArray(prevRaw) && Array.isArray(next)) {
    const prevList = prev as unknown[]
    const nextList = next as unknown[]
    let same = prevRaw.length === nextList.length
    const out = nextList.map((item: unknown, i: number): unknown => {
      const shared = i < prevRaw.length ? replaceEqualDeep(prevList[i], item) : item
      if (i >= prevRaw.length || shared !== prevList[i]) same = false
      return shared
    })
    return (same ? prev : out) as T
  }
  if (isPlainObject(prevRaw) && isPlainObject(next)) {
    const prevObj = prev as Record<string, unknown>
    const prevKeys = Object.keys(prevRaw)
    const nextKeys = Object.keys(next)
    let same = prevKeys.length === nextKeys.length
    const out: Record<string, unknown> = {}
    for (const key of nextKeys) {
      const had = Object.prototype.hasOwnProperty.call(prevRaw, key)
      const shared = had ? replaceEqualDeep(prevObj[key], next[key]) : next[key]
      if (!had || shared !== prevObj[key]) same = false
      out[key] = shared
    }
    return (same ? prev : out) as T
  }
  return next
}
