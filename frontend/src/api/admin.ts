// =============================================================================
// VELO Frontend -- Admin API (Phase F8, updated F8-fix S-5)
// =============================================================================
//
// Typed wrappers for all admin endpoints.
// All types live in api/types.ts (S-5: consistent with project convention).
//
// ENDPOINTS:
//   GET  /api/v1/admin/stats
//   GET  /api/v1/admin/stats/overview        -- period-scoped growth + deltas (E7)
//   GET  /api/v1/admin/masters/pending
//   GET  /api/v1/admin/masters/list
//   GET  /api/v1/admin/masters/{id}          -- single master (W-1 fix)
//   POST /api/v1/admin/masters/{id}/verify
//   POST /api/v1/admin/masters/{id}/reject
//   GET  /api/v1/admin/reports
//   GET  /api/v1/admin/reports/{id}          -- single report (W-2 fix)
//   POST /api/v1/admin/reports/{id}/resolve
//   POST /api/v1/admin/reports/{id}/dismiss
//   GET  /api/v1/admin/metrics/check-in     -- engagement metric (E9)
//   GET  /api/v1/admin/metrics/feedback     -- engagement metric (E9)
//   GET  /api/v1/admin/metrics/return       -- engagement metric (E9)
//   GET  /api/v1/admin/participants         -- global participants list (E1)
//   GET  /api/v1/admin/practices            -- global practices list (E9)
//   GET  /api/v1/admin/practices/{id}       -- practice detail + roster (E9)
//   GET  /api/v1/admin/practices/{id}/zoom-attendance -- Zoom meeting status +
//                                              unmatched bucket (T21-1, ПРОМТ №541)
//   GET  /api/v1/admin/revenue              -- revenue/commission/payout (E9)
// =============================================================================

import { api } from '@/api/client'
import { buildQuery } from '@/api/utils'
import type {
  AdminStatsResponse,
  AdminStatsOverviewResponse,
  PaginatedMastersResponse,
  AdminMasterActionResponse,
  PaginatedMethodChangeRequestsResponse,
  MethodChangeActionResponse,
  ReportResponse,
  PaginatedReportsResponse,
  ReportStatusFilter,
  ReportTargetTypeFilter,
  AdminWithdrawalResponse,
  PaginatedAdminWithdrawalsResponse,
  WithdrawalStatus,
  CheckinMetricResponse,
  FeedbackMetricResponse,
  ReturnMetricResponse,
  PaginatedAdminPracticesResponse,
  AdminPracticeDetailResponse,
  AdminRevenueResponse,
  InviteMasterResponse,
  PaginatedUsersResponse,
  PaginatedParticipantsResponse,
  AdminMasterDetail,
  AdminMasterProfileUpdate,
  RevokeMasterAdvisory,
  PromoResponse,
} from '@/api/types'
// T5: AdminPromoResponse/AdminPaginatedPromosResponse are natively in
// generated.ts as of the b56944d regen -- imported directly from there
// (not api/types), same convention taxonomy.ts uses for its generated
// types. Field-checked against the hand-written stand-in this replaced:
// identical shape, nothing kept back.
import type { AdminPromoResponse, AdminPaginatedPromosResponse } from '@/api/generated'
// T21-1: AdminZoomAttendanceResponse (+ its nested types) are natively in
// generated.ts as of the 9e1a309 regen -- same T5 convention as the promo
// types above, imported directly rather than via api/types.
import type { AdminZoomAttendanceResponse } from '@/api/generated'

export type { AdminPromoResponse, AdminPaginatedPromosResponse }
export type { AdminZoomAttendanceResponse }
export type AdminPromoTypeFilter = 'company' | 'master'

// Re-export for views that import from api/admin.ts directly.
export type {
  AdminStatsResponse,
  AdminStatsOverviewResponse,
  AdminMasterListItem,
  AdminMasterDetail,
  AdminMasterProfileUpdate,
  PaginatedMastersResponse,
  AdminMasterActionResponse,
  RevokeMasterAdvisory,
  PaginatedUsersResponse,
  UserResponse,
  AdminMethodChangeItem,
  PaginatedMethodChangeRequestsResponse,
  MethodChangeActionResponse,
  ReportResponse,
  PaginatedReportsResponse,
  ReportStatusFilter,
  ReportTargetTypeFilter,
  AdminWithdrawalResponse,
  PaginatedAdminWithdrawalsResponse,
  WithdrawalStatus,
  PayoutDetails,
} from '@/api/types'

// ============================================================================
// Stats
// ============================================================================

export function getAdminStats(): Promise<AdminStatsResponse> {
  return api.get<AdminStatsResponse>('/api/v1/admin/stats')
}

/**
 * Period-scoped platform overview (E7): growth counts + percent deltas + revenue
 * + engagement rates for one calendar period. `offset` steps the window by whole
 * periods (0 = current, -1 = previous week/month, +1 = next) for the dashboard
 * stepper. Deltas are always vs the period immediately before the navigated one.
 */
export function getAdminStatsOverview(
  period: 'week' | 'month',
  offset = 0,
): Promise<AdminStatsOverviewResponse> {
  const query = buildQuery({ period, offset })
  return api.get<AdminStatsOverviewResponse>(`/api/v1/admin/stats/overview${query}`)
}

// ============================================================================
// Masters
// ============================================================================

export function getPendingMasters(limit = 20, offset = 0): Promise<PaginatedMastersResponse> {
  const query = buildQuery({ limit, offset })
  return api.get<PaginatedMastersResponse>(`/api/v1/admin/masters/pending${query}`)
}

export function getMastersList(
  status?: 'pending' | 'verified' | 'rejected',
  limit = 100,
  offset = 0,
): Promise<PaginatedMastersResponse> {
  const query = buildQuery({ limit, offset, status })
  return api.get<PaginatedMastersResponse>(`/api/v1/admin/masters/list${query}`)
}

// ============================================================================
// Users (all-users list + explicit make-master, ПРОМТ №292)
// ============================================================================

/**
 * List all users (any role). No server-side search — the screen filters the
 * fetched page client-side. Limit clamped to the backend cap (le=100).
 */
export function getUsersList(
  role?: 'user' | 'master' | 'admin',
  limit = 100,
  offset = 0,
): Promise<PaginatedUsersResponse> {
  const query = buildQuery({ limit, offset, role })
  return api.get<PaginatedUsersResponse>(`/api/v1/admin/users${query}`)
}

/**
 * Global participants list (all platform users) for the «Участников» screen.
 * `filter` = all | new | active; new/active window on `period` (+ `offset`
 * stepper, parity with the dashboard). Paginated (limit/page_offset).
 */
export function getParticipants(
  filter: 'all' | 'new' | 'active' = 'all',
  period: 'week' | 'month' = 'week',
  offset = 0,
  limit = 100,
  page_offset = 0,
): Promise<PaginatedParticipantsResponse> {
  const query = buildQuery({ filter, period, offset, limit, page_offset })
  return api.get<PaginatedParticipantsResponse>(`/api/v1/admin/participants${query}`)
}

/**
 * Explicitly promote a user to master (creates a verified MasterProfile if
 * missing). 409 already_master if they are already a master. Distinct from the
 * application-approval verify path.
 */
export function makeMaster(userId: string): Promise<AdminMasterActionResponse> {
  return api.post<AdminMasterActionResponse>(`/api/v1/admin/users/${userId}/make-master`, {})
}

/**
 * Fetch a single master by user_id.
 * Fallback for AdminMasterReviewView when router state is unavailable.
 */
export function getMasterById(userId: string): Promise<AdminMasterDetail> {
  return api.get<AdminMasterDetail>(`/api/v1/admin/masters/${userId}`)
}

/**
 * Admin edits a master's methods during review (T3). Overwrites the flat method
 * list (min 1). Distinct from the master's own method-change request (M3).
 */
export function editMasterMethods(
  userId: string,
  methods: string[],
): Promise<AdminMasterActionResponse> {
  return api.patch<AdminMasterActionResponse>(
    `/api/v1/admin/masters/${userId}/methods`,
    { methods },
  )
}

/**
 * Admin edits any master-authored profile field (batch H). Partial update:
 * only the keys present in `body` are applied — to both MasterProfile.data.profile
 * (display_name / bio / email / phone / methods / experience_years /
 * certifications / languages) and the User account name (first_name / last_name).
 * Works on a master in ANY status.
 */
export function editMasterProfile(
  userId: string,
  body: AdminMasterProfileUpdate,
): Promise<AdminMasterActionResponse> {
  return api.patch<AdminMasterActionResponse>(
    `/api/v1/admin/masters/${userId}/profile`,
    body,
  )
}

/**
 * Verify a pending master application. promote (ПРОМТ №505, mirrors
 * approveMethodChange below): optional custom method labels to add to the
 * taxonomy catalog -- absent/empty posts the same bare `{}` every existing
 * caller already sends, so nothing else changes.
 */
export function verifyMaster(
  userId: string,
  promote?: string[],
  masterOnly?: string[],
): Promise<AdminMasterActionResponse> {
  const body: { promote?: string[]; master_only?: string[] } = {}
  if (promote && promote.length) body.promote = promote
  if (masterOnly && masterOnly.length) body.master_only = masterOnly
  return api.post<AdminMasterActionResponse>(
    `/api/v1/admin/masters/${userId}/verify`,
    body,
  )
}

export function rejectMaster(userId: string, reason: string): Promise<AdminMasterActionResponse> {
  return api.post<AdminMasterActionResponse>(`/api/v1/admin/masters/${userId}/reject`, { reason })
}

/**
 * Advisory signals shown in the revoke confirm dialog (A1, read-only): future
 * scheduled/live practices, balance, pending withdrawals — WARN-not-block.
 */
export function getRevokePreview(userId: string): Promise<RevokeMasterAdvisory> {
  return api.get<RevokeMasterAdvisory>(`/api/v1/admin/masters/${userId}/revoke-preview`)
}

/**
 * Revoke a master's capability (A1, operator Б): role -> user + profile
 * soft-frozen (status=suspended, is_accepting=false); all data preserved.
 * Re-grant via makeMaster ("Сделать мастером"). Never blocks on the advisory.
 */
export function revokeMaster(userId: string): Promise<RevokeMasterAdvisory> {
  return api.post<RevokeMasterAdvisory>(`/api/v1/admin/masters/${userId}/revoke`)
}

/**
 * Issue a generic one-time master invite link (Batch-INVITE). No target: the
 * link works for any authenticated opener until the first claim burns it.
 * 503 bot_url_not_configured if telegram_bot_url is unset on the server.
 */
export function inviteMaster(): Promise<InviteMasterResponse> {
  return api.post<InviteMasterResponse>('/api/v1/admin/masters/invite', {})
}

// ============================================================================
// Method change-requests (M3, FLAT) — master methods moderation
// ============================================================================

/** List masters with a pending method change-request (newest first). */
export function getMethodChangeRequests(
  limit = 20,
  offset = 0,
): Promise<PaginatedMethodChangeRequestsResponse> {
  const query = buildQuery({ limit, offset })
  return api.get<PaginatedMethodChangeRequestsResponse>(
    `/api/v1/admin/masters/method-change-requests${query}`,
  )
}

/** Approve a master's pending method change-request (methods become live).
 *  promote (R5 stage 4, operator decision 3=Б): optional custom method
 *  labels to add to the taxonomy catalog. Omitted/empty -> no catalog
 *  write, identical to pre-stage-4 behavior. */
export function approveMethodChange(
  userId: string,
  promote?: string[],
  masterOnly?: string[],
): Promise<MethodChangeActionResponse> {
  const body: { promote?: string[]; master_only?: string[] } = {}
  if (promote && promote.length) body.promote = promote
  if (masterOnly && masterOnly.length) body.master_only = masterOnly
  return api.post<MethodChangeActionResponse>(
    `/api/v1/admin/masters/${userId}/method-change-request/approve`,
    body,
  )
}

/** Reject a master's pending method change-request (with a reason). */
export function rejectMethodChange(
  userId: string,
  reason: string,
): Promise<MethodChangeActionResponse> {
  return api.post<MethodChangeActionResponse>(
    `/api/v1/admin/masters/${userId}/method-change-request/reject`,
    { reason },
  )
}

// ============================================================================
// Reports
// ============================================================================

export function getReports(
  status?: ReportStatusFilter,
  target_type?: ReportTargetTypeFilter,
  limit = 20,
  offset = 0,
): Promise<PaginatedReportsResponse> {
  const query = buildQuery({ status, target_type, limit, offset })
  return api.get<PaginatedReportsResponse>(`/api/v1/admin/reports${query}`)
}

/**
 * Fetch a single report by id.
 * Fallback for AdminReportDetailView when router state is unavailable.
 */
export function getReportById(reportId: string): Promise<ReportResponse> {
  return api.get<ReportResponse>(`/api/v1/admin/reports/${reportId}`)
}

export function resolveReport(reportId: string, resolutionNote: string): Promise<ReportResponse> {
  return api.post<ReportResponse>(`/api/v1/admin/reports/${reportId}/resolve`, {
    resolution_note: resolutionNote,
  })
}

export function dismissReport(reportId: string, resolutionNote?: string): Promise<ReportResponse> {
  return api.post<ReportResponse>(`/api/v1/admin/reports/${reportId}/dismiss`, {
    resolution_note: resolutionNote ?? null,
  })
}

// ============================================================================
// Withdrawals (payout approval)
// ============================================================================

export function getAdminWithdrawals(
  status?: WithdrawalStatus,
  limit = 20,
  offset = 0,
): Promise<PaginatedAdminWithdrawalsResponse> {
  const query = buildQuery({ limit, offset, status })
  return api.get<PaginatedAdminWithdrawalsResponse>(`/api/v1/admin/withdrawals${query}`)
}

export function approveWithdrawal(
  withdrawalId: string,
  note?: string,
): Promise<AdminWithdrawalResponse> {
  return api.post<AdminWithdrawalResponse>(`/api/v1/admin/withdrawals/${withdrawalId}/approve`, {
    note: note ?? null,
  })
}

export function rejectWithdrawal(
  withdrawalId: string,
  note: string,
): Promise<AdminWithdrawalResponse> {
  return api.post<AdminWithdrawalResponse>(`/api/v1/admin/withdrawals/${withdrawalId}/reject`, {
    note,
  })
}

// ============================================================================
// Engagement metrics (E9). Per-distinct-practice rates (D4/D5), period + offset
// scoped (0 = current, -1 = previous week/month) — same window as the dashboard
// stepper. Omitting the args = current week (drill-in views).
// ============================================================================

export function getCheckinMetric(
  period: 'week' | 'month' = 'week',
  offset = 0,
): Promise<CheckinMetricResponse> {
  const query = buildQuery({ period, offset })
  return api.get<CheckinMetricResponse>(`/api/v1/admin/metrics/check-in${query}`)
}

export function getFeedbackMetric(
  period: 'week' | 'month' = 'week',
  offset = 0,
): Promise<FeedbackMetricResponse> {
  const query = buildQuery({ period, offset })
  return api.get<FeedbackMetricResponse>(`/api/v1/admin/metrics/feedback${query}`)
}

export function getReturnMetric(
  period: 'week' | 'month' = 'week',
  offset = 0,
): Promise<ReturnMetricResponse> {
  const query = buildQuery({ period, offset })
  return api.get<ReturnMetricResponse>(`/api/v1/admin/metrics/return${query}`)
}

// ============================================================================
// Oversight: practices (list + detail/roster) + revenue (E9)
// ============================================================================

/** Scope filter for the global practices list (backend: ?scope=). */
export type AdminPracticeScope = 'all' | 'upcoming' | 'past'

export function getAdminPractices(
  scope: AdminPracticeScope = 'all',
  limit = 20,
  offset = 0,
): Promise<PaginatedAdminPracticesResponse> {
  const query = buildQuery({ scope, limit, offset })
  return api.get<PaginatedAdminPracticesResponse>(`/api/v1/admin/practices${query}`)
}

export function getAdminPracticeDetail(id: string): Promise<AdminPracticeDetailResponse> {
  return api.get<AdminPracticeDetailResponse>(`/api/v1/admin/practices/${id}`)
}

/** T21-1 (ПРОМТ №541): meeting status, per-booking minutes present, and the
 * unmatched bucket -- schema existed since E21 step G with zero consumers
 * until now (ПРОМТ №540 audit). */
export function getAdminZoomAttendance(practiceId: string): Promise<AdminZoomAttendanceResponse> {
  return api.get<AdminZoomAttendanceResponse>(`/api/v1/admin/practices/${practiceId}/zoom-attendance`)
}

/** Platform revenue/commission/payout + per-master breakdown for the period.
 * offset (W9, ПРОМТ №387): steps the window by whole periods, same stepper
 * convention as getCheckinMetric/getFeedbackMetric/getReturnMetric below. */
export function getAdminRevenue(
  period: 'week' | 'month' = 'week',
  offset = 0,
): Promise<AdminRevenueResponse> {
  const query = buildQuery({ period, offset })
  return api.get<AdminRevenueResponse>(`/api/v1/admin/revenue${query}`)
}

// ============================================================================
// Promos (T5) -- admin sees + deactivates every master's promos, plus its own
// company-wide ones. Company creation (POST) stays out of this batch's scope.
// ============================================================================

export function getAdminPromos(
  type?: AdminPromoTypeFilter,
  isActive?: boolean,
  limit = 20,
  offset = 0,
): Promise<AdminPaginatedPromosResponse> {
  const query = buildQuery({ type, is_active: isActive, limit, offset })
  return api.get<AdminPaginatedPromosResponse>(`/api/v1/admin/promos${query}`)
}

export function deactivateAdminPromo(promoId: string): Promise<PromoResponse> {
  return api.patch<PromoResponse>(`/api/v1/admin/promos/${promoId}/deactivate`)
}
