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

/** Topup request body: the amount in cents. */
export interface TopupRequest {
  amount_cents: number
}

/** Topup answer: payment id, checkout URL, amount, currency. */
export interface TopupResponse {
  payment_id: string
  checkout_url: string
  amount_cents: number
  currency: string
}

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
