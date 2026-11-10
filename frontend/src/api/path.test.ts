import { describe, it, expect, vi, beforeEach } from 'vitest'
import { path, raw } from '@/api/path'
import { buildQuery } from '@/api/utils'

describe('path', () => {
  it('leaves ordinary ids untouched', () => {
    expect(path`/api/v1/practices/${'3f2a-uuid'}`).toBe('/api/v1/practices/3f2a-uuid')
  })

  it('encodes "/" so an id cannot add a path segment', () => {
    expect(path`/api/v1/practices/${'a/b'}`).toBe('/api/v1/practices/a%2Fb')
  })

  it('encodes "?" and "#" so an id cannot inject a query or fragment', () => {
    expect(path`/api/v1/practices/${'x?admin=1#f'}`).toBe('/api/v1/practices/x%3Fadmin%3D1%23f')
  })

  it('escapes ".." and "." segments against dot-segment traversal', () => {
    expect(path`/api/v1/practices/${'..'}/cancel`).toBe('/api/v1/practices/%2E%2E/cancel')
    expect(path`/api/v1/practices/${'.'}`).toBe('/api/v1/practices/%2E')
    expect(path`/api/v1/practices/${'../admin'}`).toBe('/api/v1/practices/..%2Fadmin')
  })

  it('encodes every interpolation, not only the first', () => {
    expect(path`/api/v1/schools/${'s/1'}/members/${'u?2'}`).toBe(
      '/api/v1/schools/s%2F1/members/u%3F2',
    )
  })

  it('inserts raw fragments verbatim (base path, query string)', () => {
    const qs = buildQuery({ limit: 20, search: 'a b' })
    expect(path`${raw('/api/v1/schools')}/${'a/b'}/members${raw(qs)}`).toBe(
      '/api/v1/schools/a%2Fb/members?limit=20&search=a+b',
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

  it('encodes a hostile id in a real module call', async () => {
    const { getGroupMembers, deleteGroup } = await import('@/api/groups')
    await deleteGroup('../x')
    expect(del).toHaveBeenCalledWith('/api/v1/masters/me/groups/..%2Fx')
    await getGroupMembers('a/b?c', '', 20, 0)
    expect(get.mock.calls[0]![0]).toMatch(/^\/api\/v1\/masters\/me\/groups\/a%2Fb%3Fc\/members\?/)
  })
})
