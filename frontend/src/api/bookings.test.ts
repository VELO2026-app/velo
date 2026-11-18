// =============================================================================
// VELO Frontend -- bookings.ts Unit Tests (T1 stage 1 -- money-path wrapper)
// =============================================================================
//
// Covers the two money-moving wrappers: purchasePractice (creates Booking +
// Purchase + ledger entries -- not wrapped by stores/bookings.ts, called
// directly from views) and cancelBooking (triggers the backend's
// refund-by-deadline policy). Client mocked at the seam (@/api/client);
// ApiResponseError kept real via importOriginal for realistic error-path tests.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { purchasePractice, cancelBooking } from '@/api/bookings'
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

describe('purchasePractice', () => {
  beforeEach(() => {
    vi.mocked(api.post).mockReset()
  })

  it('POSTs to the practice purchase endpoint with no body when promoCode is omitted', async () => {
    vi.mocked(api.post).mockResolvedValue({ id: 'purch_1' })

    await purchasePractice('practice_1')

    expect(api.post).toHaveBeenCalledWith('/api/v1/practices/practice_1/purchase', undefined)
  })

  it('includes promo_code in the body when provided', async () => {
    vi.mocked(api.post).mockResolvedValue({ id: 'purch_2' })

    await purchasePractice('practice_1', 'SUMMER10')

    expect(api.post).toHaveBeenCalledWith('/api/v1/practices/practice_1/purchase', {
      promo_code: 'SUMMER10',
    })
  })
})

describe('cancelBooking', () => {
  beforeEach(() => {
    vi.mocked(api.delete).mockReset()
  })

  it('DELETEs the booking by id', async () => {
    vi.mocked(api.delete).mockResolvedValue(undefined)

    await cancelBooking('booking_1')

    expect(api.delete).toHaveBeenCalledWith('/api/v1/bookings/booking_1')
  })
})
