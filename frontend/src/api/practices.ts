// =============================================================================
// VELO Frontend -- Practices API (Phase F3.1, updated F4.1, F6)
// =============================================================================
//
// Typed wrappers over api methods for practice endpoints.
//
// Public endpoints (role=any):
//   GET /api/v1/practices          -- public feed (scheduled + live)
//   GET /api/v1/practices/{id}     -- single practice detail
//
// Master endpoints (role=master):
//   POST   /api/v1/practices              -- create practice
//   PATCH  /api/v1/practices/{id}         -- edit / status transition
//   DELETE /api/v1/practices/{id}         -- soft-delete (draft only -> deleted)
//   POST   /api/v1/practices/{id}/cancel  -- cancel with full refund
//   GET    /api/v1/practices/{id}/attendance -- attendance list + aggregates
//   GET    /api/v1/practices/{id}/reviews    -- paginated named reviews (E1)
//
// F4.1: buildQuery extracted to @/api/utils (shared with bookings.ts).
// F6:   master CRUD methods added.
// E1:   getPracticeReviews -- de-anonymised named reviews.
// =============================================================================

import { api } from '@/api/client'
import { buildQuery } from '@/api/utils'
import type {
  PaginatedPracticesResponse,
  PracticeFilters,
  PracticeResponse,
  CreatePracticeRequest,
  UpdatePracticeRequest,
  AttendanceResponse,
  PaginatedReviewsResponse,
} from '@/api/types'

// ============================================================================
// Public
// ============================================================================

/**
 * Fetch paginated list of public practices.
 *
 * Maps PracticeFilters + pagination params to backend query params.
 * Backend uses `status` alias for the status filter query param.
 */
export function getPractices(
  filters: PracticeFilters = {},
  limit = 20,
  offset = 0,
): Promise<PaginatedPracticesResponse> {
  const query = buildQuery({
    limit,
    offset,
    practice_type: filters.practice_type,
    direction: filters.direction,
    difficulty: filters.difficulty,
    style: filters.style,
    duration_bucket: filters.duration_bucket,
    time_of_day: filters.time_of_day,
    status: filters.status,
    master_id: filters.master_id,
    date_from: filters.date_from,
    date_to: filters.date_to,
    sort_by: filters.sort_by,
    sort_order: filters.sort_order,
  })
  return api.get<PaginatedPracticesResponse>(`/api/v1/practices${query}`)
}

/**
 * Fetch a single practice by ID.
 */
export function getPractice(id: string): Promise<PracticeResponse> {
  return api.get<PracticeResponse>(`/api/v1/practices/${id}`)
}

// ============================================================================
// Master CRUD (role=master)
// ============================================================================

/**
 * Create a new practice (status defaults to 'draft' until published).
 *
 * Backend state machine: draft -> scheduled (via PATCH status='scheduled').
 * scheduled_at must be a future UTC ISO 8601 string.
 */
export function createPractice(body: CreatePracticeRequest): Promise<PracticeResponse> {
  return api.post<PracticeResponse>('/api/v1/practices', body)
}

/**
 * Edit practice fields and/or trigger a status transition.
 *
 * Status transitions allowed via PATCH:
 *   draft       -> scheduled (publish)
 *
 * scheduled -> live and live -> completed are NO LONGER PATCH-able: they are
 * driven by the backend lifecycle worker by the clock (start at scheduled_at,
 * finish at scheduled_at + duration), not by the client.
 * "cancelled" is NOT reachable here -- use cancelPractice() instead.
 * "deleted"   -> use deletePractice() (soft-delete, draft only).
 */
export function updatePractice(id: string, body: UpdatePracticeRequest): Promise<PracticeResponse> {
  return api.patch<PracticeResponse>(`/api/v1/practices/${id}`, body)
}

/**
 * Soft-delete a practice (draft only -> status=deleted).
 * Returns 204 No Content on success.
 */
export function deletePractice(id: string): Promise<void> {
  return api.delete(`/api/v1/practices/${id}`)
}

/**
 * Cancel a practice with full refund to all participants.
 *
 * Allowed statuses: scheduled, live -> cancelled.
 * Backend triggers refund for all confirmed bookings atomically.
 *
 * `scope` selects how far the cancellation reaches for a SERIES practice:
 *   'this'            -- only this occurrence (default when omitted).
 *   'this_and_future' -- this occurrence and every later one in the series.
 * A non-series practice has no siblings, so omitting scope behaves like 'this'.
 */
export function cancelPractice(
  id: string,
  scope?: 'this' | 'this_and_future',
): Promise<PracticeResponse> {
  return api.post<PracticeResponse>(
    `/api/v1/practices/${id}/cancel`,
    scope ? { scope } : undefined,
  )
}

/**
 * Fetch attendance list and aggregates for a specific practice.
 *
 * Returns total, attended, no_show, pending counts + per-booking items.
 */
export function getAttendance(id: string): Promise<AttendanceResponse> {
  return api.get<AttendanceResponse>(`/api/v1/practices/${id}/attendance`)
}

// ============================================================================
// Zoom "Начать" (ПРОМТ №556, OWNER-1 option В)
// ============================================================================
//
// start_url is a bearer credential (its holder needs no further Zoom-side
// check to become host) that also expires -- the owner decided it must
// never be stored, never appear in a JSON response, and never be held by
// this frontend at all. So this API never returns a start_url: it returns a
// one-time ticket, and the actual redirect to Zoom happens entirely on the
// backend (GET .../zoom/start), reached via a PLAIN browser navigation
// (platform.openLink), not this authenticated fetch client.

/**
 * Request a one-time, 30s ticket authorizing a single Zoom start_url fetch
 * for this practice's meeting. Throws ApiResponseError (e.g. code
 * 'zoom_meeting_not_active') if there is nothing to start.
 */
export function createZoomStartTicket(practiceId: string): Promise<{ ticket: string }> {
  return api.post<{ ticket: string }>(`/api/v1/practices/${practiceId}/zoom/start-ticket`)
}

/**
 * A4 V2 (ПРОМТ №572): the "Повторить" action on a permanently-failed Zoom
 * meeting (zoom_meeting_status === 'create_failed'). Owner-only; throws
 * ApiResponseError code 'zoom_meeting_not_failed' if the meeting is not
 * currently in that state, or a 404 if there is no ZoomMeeting row at all.
 * Returns the updated practice -- zoom_meeting_status reflects the fresh
 * attempt's outcome immediately, no reload needed.
 */
export function retryZoomMeeting(practiceId: string): Promise<PracticeResponse> {
  return api.post<PracticeResponse>(`/api/v1/practices/${practiceId}/zoom/retry`)
}

/**
 * Build the URL to hand to platform.openLink() -- a plain browser
 * navigation to our backend, which redeems the ticket and 302s straight to
 * Zoom. Never fetch() this URL: that would not navigate the browser, and
 * the point of the redirect is that the frontend never touches start_url.
 *
 * FAILS CLOSED (ПРОМТ №557): no hardcoded fallback domain. If
 * VITE_API_BASE_URL is not configured, returns null rather than a URL --
 * the caller must show an honest "unavailable" message and navigate
 * nowhere. A foreign fallback domain here would mean a plain browser
 * navigation carrying the one-time start-ticket to a THIRD PARTY'S server
 * (api.talentir.info, per the open-issues registry, belongs to a different
 * project entirely) -- unlike TopupView.vue's checkout_url (validated
 * against an allowlist before navigating, and the value itself comes from
 * Stripe, not from us), there is no allowlist check possible here: this
 * ticket must only ever reach OUR OWN backend.
 */
export function zoomStartRedirectUrl(ticket: string): string | null {
  const base = import.meta.env.VITE_API_BASE_URL
  if (!base) return null
  return `${base}/api/v1/practices/zoom/start?ticket=${encodeURIComponent(ticket)}`
}

/**
 * Fetch paginated named reviews for a practice (E1).
 *
 * The de-anonymised counterpart to the anonymous rating distribution: each
 * item carries the reviewer's name, avatar and comment. `rating` arrives
 * pre-mapped to the three UI buckets ('fire' | 'good' | 'confused') by the
 * backend, so the frontend reuses the same rating icons/labels it already
 * renders for the anonymous distribution.
 */
export function getPracticeReviews(
  id: string,
  limit = 20,
  offset = 0,
): Promise<PaginatedReviewsResponse> {
  const query = buildQuery({ limit, offset })
  return api.get<PaginatedReviewsResponse>(`/api/v1/practices/${id}/reviews${query}`)
}
