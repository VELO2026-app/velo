// =============================================================================
// VELO Frontend -- Payments API (Phase F5)
// =============================================================================
//
// Typed wrapper for payment endpoints.
//
// Backend endpoints used:
//   POST /api/v1/payments/topup -- create topup (Stripe or stub)
// =============================================================================

import { api } from '@/api/client'
import type { TopupResponse } from '@/api/types'

/**
 * Create a balance topup.
 *
 * In stub mode (Stripe not configured): backend instantly confirms
 * the payment, credits balance, and returns success URL.
 *
 * In real mode: backend creates a Stripe Checkout Session and
 * returns the checkout URL for redirect.
 */
export function createTopup(amountCents: number): Promise<TopupResponse> {
  return api.post<TopupResponse>('/api/v1/payments/topup', {
    amount_cents: amountCents,
  })
}
