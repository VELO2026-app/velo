// =============================================================================
// VELO Frontend -- Masters API (Phase F6, updated F7)
// =============================================================================
//
// Typed wrappers over api.get/post/patch for master endpoints.
//
// Backend endpoints:
//   POST   /api/v1/masters/apply           -- submit application (role=user)
//   DELETE /api/v1/masters/me/application  -- withdraw a pending application (F4)
//   GET    /api/v1/masters/me              -- my master profile (role=master)
//   GET    /api/v1/masters/me/practices    -- my practices list (role=master)
//   PATCH  /api/v1/masters/me/payout       -- update payout details (F7)
//   POST   /api/v1/masters/me/withdraw     -- create a PAYOUT withdrawal request (F7)
//   GET    /api/v1/masters/me/withdrawals  -- list my payout withdrawals (F7)
//
// NB: "withdraw" is two unrelated concepts here -- withdrawMasterApplication
// (F4, pull back an application) vs createWithdrawal (F7, request a payout).
// Named distinctly on purpose so they're never confused at the call site.
// =============================================================================

import { api } from '@/api/client'
import { buildQuery } from '@/api/utils'
import type {
  ClaimMasterInviteResponse,
  MasterApplyRequest,
  MasterApplyResponse,
  MasterProfileResponse,
  MasterPublicResponse,
  PaginatedPracticesResponse,
  PayoutDetails,
  PaginatedWithdrawalsResponse,
  WithdrawalResponse,
  PaginatedStudentsResponse,
  StudentDetailResponse,
  IncomeResponse,
  PaginatedTransactionsResponse,
  MasterStatsResponse,
  PaginatedMasterReviewsResponse,
} from '@/api/types'

/**
 * Submit a master application (3-step form).
 * Only callable by users with role='user'.
 */
export function applyMaster(body: MasterApplyRequest): Promise<MasterApplyResponse> {
  return api.post<MasterApplyResponse>('/api/v1/masters/apply', body)
}

/**
 * Withdraw the caller's own PENDING master application (F4).
 * Status flip only -- the account stays a plain role='user'; re-applying
 * afterward works exactly like applying fresh.
 */
export function withdrawMasterApplication(): Promise<void> {
  return api.delete('/api/v1/masters/me/application')
}

/**
 * Claim a one-time master invite (deeplink master_onboarding__<token>).
 * Binds to the caller's own account; consumes the token on success
 * (Batch-INVITE, №258).
 */
export function claimMasterInvite(token: string): Promise<ClaimMasterInviteResponse> {
  return api.post<ClaimMasterInviteResponse>('/api/v1/masters/invite/claim', { token })
}

/**
 * Fetch the current master's profile.
 * Only callable by users with role='master'.
 * F7: response now includes payout field (null if not configured).
 */
export function getMyMasterProfile(): Promise<MasterProfileResponse> {
  return api.get<MasterProfileResponse>('/api/v1/masters/me')
}

/**
 * Submit a method change-request (M3, FLAT). The verified master proposes a
 * new flat method set; it is stored pending admin moderation and does NOT
 * change the live methods until approved. Returns the refreshed profile so
 * the caller sees method_change_request projected. 409 if one is pending.
 */
export function submitMethodChangeRequest(
  proposedMethods: string[],
): Promise<MasterProfileResponse> {
  return api.post<MasterProfileResponse>('/api/v1/masters/me/method-change-request', {
    proposed_methods: proposedMethods,
  })
}

/**
 * Replace the master's languages (E16, freely editable — no moderation).
 * Returns the refreshed profile. Empty array clears the set.
 */
export function updateMasterLanguages(languages: string[]): Promise<MasterProfileResponse> {
  return api.patch<MasterProfileResponse>('/api/v1/masters/me/languages', { languages })
}

/**
 * Fetch a verified master's PUBLIC profile (S-4).
 * Callable by any authenticated user. Only verified masters resolve;
 * pending / rejected / non-master ids return 404. Carries no financial
 * or contact data -- safe public subset + practices_count / reviews_count.
 */
export function getPublicMaster(userId: string): Promise<MasterPublicResponse> {
  return api.get<MasterPublicResponse>(`/api/v1/masters/${userId}`)
}

/**
 * Fetch paginated list of practices owned by the current master.
 * Only callable by users with role='master'.
 *
 * bucket (T22-3/T22-5, ПРОМТ №561): "upcoming" (draft/scheduled/live, nearest
 * first) or "past" (completed, most-recent first) -- the server now owns both
 * the filter and the ordering per tab, replacing the old single futures-first
 * cursor the client used to split and re-sort itself.
 */
export function getMyPractices(
  bucket: 'upcoming' | 'past',
  limit = 20,
  offset = 0,
): Promise<PaginatedPracticesResponse> {
  const query = buildQuery({ bucket, limit, offset })
  return api.get<PaginatedPracticesResponse>(`/api/v1/masters/me/practices${query}`)
}

// =============================================================================
// F7: Finance endpoints
// =============================================================================

/**
 * Update master's payout details (bank transfer, PayPal, Revolut).
 * Returns the stored PayoutDetails on success.
 *
 * body.details is freeform -- depends on method:
 *   bank_transfer -> { iban, bank_name?, account_holder?, swift? }
 *   paypal        -> { email }
 *   revolut       -> { tag? } or { phone? }
 */
export function updatePayoutDetails(body: PayoutDetails): Promise<PayoutDetails> {
  return api.patch<PayoutDetails>('/api/v1/masters/me/payout', body)
}

/**
 * Clear the master's configured payout method (M3). Idempotent server-side
 * (204 even when nothing is configured). The profile's `payout` then reads
 * null — the caller updates its local profile state.
 */
export function deletePayout(): Promise<void> {
  return api.delete('/api/v1/masters/me/payout')
}

/**
 * Create a withdrawal request.
 * Freezes amount_cents from available balance until admin decision.
 * Returns 201 on success.
 *
 * Requires payout details to be configured first (400 otherwise).
 * Minimum amount: 5000 cents (EUR 50.00).
 */
export function createWithdrawal(amount_cents: number): Promise<WithdrawalResponse> {
  return api.post<WithdrawalResponse>('/api/v1/masters/me/withdraw', { amount_cents })
}

/**
 * Fetch paginated list of my withdrawal requests (newest first).
 * Only callable by users with role='master'.
 */
export function getMyWithdrawals(limit = 20, offset = 0): Promise<PaginatedWithdrawalsResponse> {
  const query = buildQuery({ limit, offset })
  return api.get<PaginatedWithdrawalsResponse>(`/api/v1/masters/me/withdrawals${query}`)
}

// =============================================================================
// E5: Students / CRM endpoints
//   GET /api/v1/masters/me/students       -- paginated list (needs_attention)
//   GET /api/v1/masters/me/students/{id}  -- per-student aggregate
// =============================================================================

/**
 * Fetch the master's students — everyone who attended their practices.
 * Paginated; search is applied client-side over the loaded page.
 * Only callable by users with role='master'.
 */
export function getStudents(limit = 50, offset = 0): Promise<PaginatedStudentsResponse> {
  const query = buildQuery({ limit, offset })
  return api.get<PaginatedStudentsResponse>(`/api/v1/masters/me/students${query}`)
}

/**
 * Fetch one student's aggregate (practices_count, hours, satisfaction_pct,
 * recent check-ins and feedbacks) over THIS master's practices.
 * Note: the response carries no name/avatar — the calling list passes those.
 */
export function getStudent(id: string): Promise<StudentDetailResponse> {
  return api.get<StudentDetailResponse>(`/api/v1/masters/me/students/${id}`)
}

// =============================================================================
// E2: Finance — income (by period) + transaction feed
//   GET /api/v1/masters/me/income?period=week|month  -- gross booked turnover
//   GET /api/v1/masters/me/transactions              -- paginated ledger feed
// =============================================================================

/**
 * Fetch the master's gross booked turnover for the current calendar period
 * plus the previous-period total and the signed delta_pct (null when the
 * previous period had no net-positive turnover).
 */
export function getIncome(period: 'week' | 'month' = 'week'): Promise<IncomeResponse> {
  const query = buildQuery({ period })
  return api.get<IncomeResponse>(`/api/v1/masters/me/income${query}`)
}

/**
 * Fetch the master's transaction feed (title-tagged master_ledger rows,
 * newest first). amount_cents is signed: + sale, − commission/refund.
 */
export function getTransactions(limit = 20, offset = 0): Promise<PaginatedTransactionsResponse> {
  const query = buildQuery({ limit, offset })
  return api.get<PaginatedTransactionsResponse>(`/api/v1/masters/me/transactions${query}`)
}

// =============================================================================
// E7: Period-scoped dashboard stats
//   GET /api/v1/masters/me/stats?period=week|month
// =============================================================================

/**
 * Fetch the master's period-scoped dashboard stats: practices_count and
 * participants_count for the selected calendar period, each with a signed
 * *_delta_pct vs the previous period (null when the previous period was
 * non-positive). income_cents is also returned but rendered on Finance /
 * Analytics, not the dashboard.
 */
export function getMasterStats(period: 'week' | 'month' = 'week'): Promise<MasterStatsResponse> {
  const query = buildQuery({ period })
  return api.get<MasterStatsResponse>(`/api/v1/masters/me/stats${query}`)
}

// =============================================================================
// #3: Cross-practice named reviews feed
//   GET /api/v1/masters/me/reviews
// =============================================================================

/**
 * Fetch the master's cross-practice named reviews feed (newest first). Each
 * item carries the reviewer name/avatar, the rating bucket, the comment, and
 * the practice_title the review belongs to.
 */
export function getMasterReviews(
  limit = 20,
  offset = 0,
  attention = false,
): Promise<PaginatedMasterReviewsResponse> {
  // attention=true narrows the feed to the negative (confused) bucket
  // server-side (E1) so the «Требуют внимания» block sees a full page of
  // low-rated reviews, not only those that fall in the first mixed page.
  const query = buildQuery({ limit, offset, attention: attention || undefined })
  return api.get<PaginatedMasterReviewsResponse>(`/api/v1/masters/me/reviews${query}`)
}
