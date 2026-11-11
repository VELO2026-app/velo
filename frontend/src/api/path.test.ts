import { describe, it, expect, vi, beforeEach } from 'vitest'
import { path, raw, UnsafePathSegmentError } from '@/api/path'
import { buildQuery } from '@/api/utils'

/** The path the browser would actually request (WHATWG URL resolution). */
function resolved(p: string): string {
  return new URL(p, 'https://box.test').pathname
}

describe('path', () => {
  it('leaves ordinary ids untouched', () => {
    expect(path`/api/v1/practices/${'3f2a-uuid'}`).toBe('/api/v1/practices/3f2a-uuid')
  })

  it('encodes "?" and "#" so an id cannot inject a query or fragment', () => {
    const p = path`/api/v1/practices/${'x?admin=1#f'}`
    expect(p).toBe('/api/v1/practices/x%3Fadmin%3D1%23f')
    expect(resolved(p)).toBe('/api/v1/practices/x%3Fadmin%3D1%23f')
  })

  it('refuses a slash: the backend routes on the decoded path, so %2F would still switch endpoints', () => {
    expect(() => path`/api/v1/practices/${'a/attendance'}`).toThrow(UnsafePathSegmentError)
    expect(() => path`/api/v1/practices/${'../admin'}`).toThrow(UnsafePathSegmentError)
    expect(() => path`/api/v1/practices/${'a\\b'}`).toThrow(UnsafePathSegmentError)
  })

  it('refuses dot-segments: the URL parser collapses even their encoded form', () => {
    // Why encoding is not enough: the parser treats %2E%2E as "..".
    expect(resolved('/api/v1/practices/%2E%2E/purchase')).toBe('/api/v1/purchase')
    expect(() => path`/api/v1/practices/${'..'}/cancel`).toThrow(UnsafePathSegmentError)
    expect(() => path`/api/v1/practices/${'.'}`).toThrow(UnsafePathSegmentError)
  })

  it('refuses an empty value (it would merge two slashes into another route)', () => {
    expect(() => path`/api/v1/practices/${''}/cancel`).toThrow(UnsafePathSegmentError)
  })

  it('encodes every interpolation, not only the first', () => {
    expect(path`/api/v1/schools/${'s 1'}/members/${'u?2'}`).toBe(
      '/api/v1/schools/s%201/members/u%3F2',
    )
  })

  it('inserts raw fragments verbatim (base path, query string)', () => {
    const qs = buildQuery({ limit: 20, search: 'a b' })
    expect(path`${raw('/api/v1/schools')}/${'s1'}/members${raw(qs)}`).toBe(
      '/api/v1/schools/s1/members?limit=20&search=a+b',
    )
  })
})

describe('API modules use path encoding', () => {
  const get = vi.fn().mockResolvedValue({})
  const del = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    get.mockClear()
    del.mockClear()
    vi.resetModules()
    vi.doMock('@/api/client', () => ({ api: { get, delete: del, post: vi.fn(), patch: vi.fn() } }))
  })

  it('a hostile id in a real module call is encoded or refused, never routed', async () => {
    const { getGroupMembers, deleteGroup } = await import('@/api/groups')
    // A fresh module graph (vi.resetModules): match the error by message, not class.
    expect(() => deleteGroup('../x')).toThrow(/unsafe path segment/)
    expect(del).not.toHaveBeenCalled()
    await getGroupMembers('a?c', '', 20, 0)
    expect(get.mock.calls[0]![0]).toMatch(/^\/api\/v1\/masters\/me\/groups\/a%3Fc\/members\?/)
  })
})
