// =============================================================================
// VELO Frontend -- Reports API (Master GROUPS P3, ПРОМТ №592)
// =============================================================================
//
// Typed wrapper over the EXISTING backend Report table (Phase 3.3) --
// POST /api/v1/reports, target_type in {user, master, practice}, one report
// per (reporter, target_type, target_id). Nothing new on the backend; this
// is the first frontend caller (recon #589: no frontend/src/api/reports.ts
// existed before this).
//
// Hand-written, not generated: mirrors groups.ts's own reasoning -- no local
// server to regenerate generated.ts against. Reconciles automatically at the
// next `velo update` regen. Does not touch api/types.ts (its header forbids
// manual backend-type additions).
//
// ⚠ DUPLICATE HANDLING -- MEASURED, corrects the PROMPT's own assumption:
// reports/router.py's create_report_endpoint returns HTTP 200 (NOT 409) on
// a duplicate -- body is ExistingReportResponse (wraps the existing report),
// distinct from the 201 body (a flat ReportResponse). Read directly from the
// current source before writing this, not assumed. Net effect for the
// caller is the SAME either way requested by the PROMPT ("treat as
// success"): both 200 and 201 are ok responses, so api.post() never throws
// for a duplicate -- there is nothing to catch. The return type here is
// deliberately loose (not consumed field-by-field by any caller; the block
// flow only needs success/failure, never a field off the body).
// =============================================================================

import { api } from '@/api/client'

export type ReportTargetType = 'user' | 'master' | 'practice'

export interface CreateReportRequest {
  target_type: ReportTargetType
  target_id: string
  reason: string
}

/** POST /api/v1/reports -- create a report. Resolves successfully on BOTH
 *  a genuinely new report (201) and a duplicate of the caller's own prior
 *  report (200, returns the existing one) -- only a real API error rejects. */
export function createReport(body: CreateReportRequest): Promise<unknown> {
  return api.post('/api/v1/reports', body)
}
