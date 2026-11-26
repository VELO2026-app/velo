// api/promos.ts: the master's promo-code requests -- the URL and the body each
// wrapper sends, and the cancellable page read (FE-260).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPromo, deactivatePromo, getMyPromos } from '@/api/promos'
import { api } from '@/api/client'
import type { CreateMasterPromoRequest } from '@/api/types'

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>()
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), request: vi.fn() },
  }
})

const B = '/api/v1/masters/me/promos'

beforeEach(() => {
  vi.mocked(api.get).mockReset().mockResolvedValue({})
  vi.mocked(api.post).mockReset().mockResolvedValue({})
  vi.mocked(api.patch).mockReset().mockResolvedValue({})
  vi.mocked(api.request).mockReset().mockResolvedValue({})
})

describe('api/promos.ts', () => {
  it('getMyPromos reads the first page by default, shared', async () => {
    await getMyPromos()

    expect(api.get).toHaveBeenCalledWith(`${B}?limit=50&offset=0`)
  })

  it('getMyPromos with a signal reads one page by its offset, cancellable', async () => {
    const { signal } = new AbortController()
    await getMyPromos(100, 100, signal)

    expect(api.request).toHaveBeenCalledWith('GET', `${B}?limit=100&offset=100`, { signal })
    expect(api.get).not.toHaveBeenCalled()
  })

  it('createPromo posts the code as given; deactivatePromo patches its own path', async () => {
    const body = { code: 'SPRING', discount_percent: 15 } satisfies CreateMasterPromoRequest
    await createPromo(body)
    await deactivatePromo('p1')

    expect(api.post).toHaveBeenCalledWith(B, body)
    expect(api.patch).toHaveBeenCalledWith(`${B}/p1/deactivate`)
  })
})
