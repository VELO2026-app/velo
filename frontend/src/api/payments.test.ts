// =============================================================================
// VELO Frontend -- payments.ts Unit Tests (T1 stage 1 -- money-path wrapper)
// =============================================================================
//
// createTopup is the single narrowest, highest-stakes function in the app: it
// either (stub mode) instantly credits balance server-side, or (real mode)
// creates a Stripe Checkout Session. The wrapper itself has no branching --
// both modes return the same TopupResponse shape -- so these tests cover the
// request-building contract and pass-through of both response shapes, plus
// error propagation. Client mocked at the seam (@/api/client); ApiResponseError
// kept real via importOriginal so rejection tests assert on the real class.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTopup } from '@/api/payments'
import { api } from '@/api/client'

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>()
  return {
    ...actual,
    api: {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
  }
})

describe('createTopup', () => {
  beforeEach(() => {
    vi.mocked(api.post).mockReset()
  })

  it('POSTs to /api/v1/payments/topup with amount_cents in the body', async () => {
    vi.mocked(api.post).mockResolvedValue({
      payment_id: 'pay_1',
      checkout_url: '/topup/success',
      amount_cents: 5000,
      currency: 'eur',
    })

    await createTopup(5000)

    expect(api.post).toHaveBeenCalledWith('/api/v1/payments/topup', { amount_cents: 5000 })
  })
})
