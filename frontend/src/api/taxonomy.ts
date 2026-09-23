// =============================================================================
// VELO Frontend -- Taxonomy API (R5 stage 3a/3b/3c)
// =============================================================================
//
// GET /api/v1/taxonomy -- active-only direction/style catalog, any
// authenticated user (not admin-gated). Backs MethodTaxonomyPicker's DB-
// sourced options (R5 stage 3b), with the hardcoded practiceOptions.ts
// consts kept as the offline/error fallback.
//
// GET/POST/PATCH /api/v1/admin/taxonomy/* -- admin CRUD (R5 stage 3c),
// backs the editable AdminCatalogView.vue.
//
// Types sourced from generated.ts (regenerated at deploy c1dbe08) -- both
// endpoints share the same admin/taxonomy/schemas.py response shape, so one
// set of generated types covers both. Re-exported under the item names
// existing consumers already import.
// =============================================================================

import { api } from '@/api/client'
import type {
  TaxonomyDirectionResponse,
  TaxonomyStyleResponse,
  TaxonomyListResponse,
  CreateDirectionRequest,
  CreateStyleRequest,
  UpdateTaxonomyItemRequest,
} from '@/api/generated'

export type TaxonomyStyleItem = TaxonomyStyleResponse
export type TaxonomyDirectionItem = TaxonomyDirectionResponse
export type {
  TaxonomyListResponse,
  CreateDirectionRequest,
  CreateStyleRequest,
  UpdateTaxonomyItemRequest,
}

/** Active-only catalog (is_active=true). Throws (ApiResponseError) on
 *  failure -- callers that need an offline fallback must catch. */
export function getActiveTaxonomy(): Promise<TaxonomyListResponse> {
  return api.get<TaxonomyListResponse>('/api/v1/taxonomy')
}

// -----------------------------------------------------------------------
// Admin CRUD (R5 stage 3c) -- admin-only, includes inactive rows.
// -----------------------------------------------------------------------

/** Full catalog, including inactive rows (admin management view). */
export function getFullTaxonomy(): Promise<TaxonomyListResponse> {
  return api.get<TaxonomyListResponse>('/api/v1/admin/taxonomy')
}

export function createTaxonomyDirection(
  body: CreateDirectionRequest,
): Promise<TaxonomyDirectionItem> {
  return api.post<TaxonomyDirectionItem>('/api/v1/admin/taxonomy/directions', body)
}

export function updateTaxonomyDirection(
  directionId: string,
  body: UpdateTaxonomyItemRequest,
): Promise<TaxonomyDirectionItem> {
  return api.patch<TaxonomyDirectionItem>(`/api/v1/admin/taxonomy/directions/${directionId}`, body)
}

export function createTaxonomyStyle(
  directionId: string,
  body: CreateStyleRequest,
): Promise<TaxonomyStyleItem> {
  return api.post<TaxonomyStyleItem>(
    `/api/v1/admin/taxonomy/directions/${directionId}/styles`,
    body,
  )
}

export function updateTaxonomyStyle(
  styleId: string,
  body: UpdateTaxonomyItemRequest,
): Promise<TaxonomyStyleItem> {
  return api.patch<TaxonomyStyleItem>(`/api/v1/admin/taxonomy/styles/${styleId}`, body)
}
