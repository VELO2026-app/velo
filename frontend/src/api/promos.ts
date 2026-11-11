// =============================================================================
// VELO Frontend -- Promos API (E10 -- wire the delivered backend)
// =============================================================================
//
// Master promo codes. Backend delivered (promos/router.py):
//   POST  /api/v1/masters/me/promos                 -- create a promo code
//   GET   /api/v1/masters/me/promos                 -- list my promos (newest first)
//   PATCH /api/v1/masters/me/promos/{id}/deactivate -- soft-deactivate (is_active=false)
// PC1 (2026-07-12): create was live on the backend since E10 but never wired on
// the frontend -- MasterNewPromocodeView's submit was a pure toast stub with no
// api import at all, so masters had no way to get a real promo into the list.
// =============================================================================

import { api } from '@/api/client'
import { buildQuery } from '@/api/utils'
import type { CreateMasterPromoRequest, PaginatedPromosResponse, PromoResponse } from '@/api/types'
import { path } from '@/api/path'

/** Create a new master promo code. */
export function createPromo(body: CreateMasterPromoRequest): Promise<PromoResponse> {
  return api.post<PromoResponse>('/api/v1/masters/me/promos', body)
}

/** List the current master's promo codes (newest first). */
export function getMyPromos(limit = 50, offset = 0): Promise<PaginatedPromosResponse> {
  const query = buildQuery({ limit, offset })
  return api.get<PaginatedPromosResponse>(`/api/v1/masters/me/promos${query}`)
}

/** Deactivate a promo code (soft -- sets is_active=false; no hard delete). */
export function deactivatePromo(promoId: string): Promise<PromoResponse> {
  return api.patch<PromoResponse>(path`/api/v1/masters/me/promos/${promoId}/deactivate`)
}
