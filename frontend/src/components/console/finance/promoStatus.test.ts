// =============================================================================
// VELO Frontend -- promoStatus tests (FE-267)
// =============================================================================
//
// The status column of the promo table: one word per promo, in the order
// deactivated, used up, past its end date, active.
// =============================================================================

import { describe, expect, it } from 'vitest'
import { promoStatus, type PromoFacts } from '@/components/console/finance/promoStatus'

const NOW = Date.parse('2026-11-25T12:00:00Z')

function promo(overrides: Partial<PromoFacts> = {}): PromoFacts {
  return {
    is_active: true,
    max_uses: 100,
    used_count: 10,
    valid_until: '2026-12-31T00:00:00Z',
    ...overrides,
  }
}

describe('promoStatus', () => {
  it.each([
    { name: 'a promo in its limits is active', promo: promo(), status: 'active' },
    {
      name: 'no limit and no end date is active',
      promo: promo({ max_uses: null, valid_until: null }),
      status: 'active',
    },
    {
      name: 'one use left is still active',
      promo: promo({ max_uses: 100, used_count: 99 }),
      status: 'active',
    },
    {
      name: 'the last use taken is used up',
      promo: promo({ max_uses: 100, used_count: 100 }),
      status: 'exhausted',
    },
    {
      name: 'a past end date is expired',
      promo: promo({ valid_until: '2026-11-24T00:00:00Z' }),
      status: 'expired',
    },
    {
      name: 'the end date reached is expired',
      promo: promo({ valid_until: '2026-11-25T12:00:00Z' }),
      status: 'expired',
    },
    {
      name: 'a deactivated promo is deactivated',
      promo: promo({ is_active: false }),
      status: 'inactive',
    },
    {
      name: 'deactivated wins over used up and expired',
      promo: promo({ is_active: false, used_count: 100, valid_until: '2026-01-01T00:00:00Z' }),
      status: 'inactive',
    },
    {
      name: 'used up wins over expired',
      promo: promo({ used_count: 100, valid_until: '2026-01-01T00:00:00Z' }),
      status: 'exhausted',
    },
  ])('$name', ({ promo, status }) => {
    expect(promoStatus(promo, NOW)).toBe(status)
  })
})
