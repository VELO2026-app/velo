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
  PaginatedPracticeAnalyticsPairs,
  PaginatedPracticeAnalyticsReviews,
  PracticeAnalyticsResponse,
  AudiencePreviewRequest,
  AudiencePreviewResponse,
  ZoomEntryResolveResponse,
  ZoomSdkJoinResponse,
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
 * POST /api/v1/practices/{id}/audience-preview (owner Q15, PROMPT №613).
 * Read-only dry-run -- never saves anything. Returns how many of this
 * practice's ACTIVE bookers would fall outside the proposed audience, so
 * EditPracticeView can warn with a real count before an audience-narrowing
 * save strands people who are already booked.
 */
export function previewAudienceChange(
  id: string,
  body: AudiencePreviewRequest,
): Promise<AudiencePreviewResponse> {
  return api.post<AudiencePreviewResponse>(`/api/v1/practices/${id}/audience-preview`, body)
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
  return api.post<PracticeResponse>(`/api/v1/practices/${id}/cancel`, scope ? { scope } : undefined)
}

/**
 * Fetch attendance list and aggregates for a specific practice.
 *
 * Returns total, attended, no_show, pending counts + per-booking items.
 */
export function getAttendance(id: string): Promise<AttendanceResponse> {
  return api.get<AttendanceResponse>(`/api/v1/practices/${id}/attendance`)
}

/**
 * A4 V2 (PROMPT №572): the "Повторить" action on a permanently-failed Zoom
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
 * T-35: ask the SERVER how the current user enters this practice right now.
 *
 * The answer -- personal entry, host, not booked (guest), or an honest
 * waiting/failed/cancelled state -- is a decision, and it deliberately does
 * not live here.
 * It used to: utils/zoomLink.ts chose between a personal and a shared link,
 * which made correctness a rule four entry points had to remember. This
 * endpoint is the same choice made where it can be made correctly, by the
 * only party that knows whether this person holds a booking attendance will
 * be written for.
 *
 * Keyed by practice id, not by the public /z/{code} code: this screen is also
 * reached by an ordinary tap from a dashboard, where no code exists.
 *
 * 404 when the practice does not exist or is draft/deleted -- a well-formed
 * deep link naming a deleted practice lands exactly here, and the caller must
 * render an honest error rather than an empty screen.
 */
export function resolveZoomEntry(practiceId: string): Promise<ZoomEntryResolveResponse> {
  return api.get<ZoomEntryResolveResponse>(`/api/v1/practices/${practiceId}/zoom/resolve`)
}

/**
 * Standalone F4: the Meeting SDK join parameters for the current user on this
 * practice, minted by the server at the moment of entering and never stored
 * (backend zoom/sdk.py). Only 'personal' and 'host' get them; anything else
 * is ApiResponseError 409 zoom_entry_not_joinable (re-resolve and show the
 * new state). 409 zoom_sdk_not_configured: this server has no SDK keys. 502
 * zoom_unavailable / zoom_host_token_unavailable: Zoom did not answer. 429:
 * the per-user limit.
 *
 * The body carries credentials (passcode, token, a host's ZAK): hand it to
 * the SDK and drop it -- never store it, never log it.
 */
export function joinZoomSdk(practiceId: string): Promise<ZoomSdkJoinResponse> {
  return api.post<ZoomSdkJoinResponse>(`/api/v1/practices/${practiceId}/zoom/sdk-join`)
}

/**
 * Fetch paginated named reviews for a practice (E1).
 *
 * The de-anonymised counterpart to the anonymous rating distribution: each
 * item carries the reviewer's name, avatar and comment. `rating` arrives
 * pre-mapped to its zone (ScoreZone, BE-77) by the backend -- the same five
 * moodScale.ts keys the anonymous distribution counts.
 */
export function getPracticeReviews(
  id: string,
  limit = 20,
  offset = 0,
): Promise<PaginatedReviewsResponse> {
  const query = buildQuery({ limit, offset })
  return api.get<PaginatedReviewsResponse>(`/api/v1/practices/${id}/reviews${query}`)
}

// ============================================================================
// BE-78: «Аналитика по практике»
// ============================================================================
//
// Readers: the leading master; for a school's practice also its curator and
// its verified masters. Anyone else gets 404 -- not 403: the endpoints take
// any signed-in user (a curator may hold role='user') and mask the practice.
// An entitled reader of a practice that is not completed gets 400. Scores
// arrive as zones (ScoreZone) only; every "X из N" uses N = `attended`.

/** Header + both zone distributions + the two list totals. */
export function getPracticeAnalytics(id: string): Promise<PracticeAnalyticsResponse> {
  return api.get<PracticeAnalyticsResponse>(`/api/v1/practices/${id}/analytics`)
}

/** «Пришёл -> ушёл»: attendees with a PRE check-in AND a review, by name. */
export function getPracticeAnalyticsPairs(
  id: string,
  limit = 20,
  offset = 0,
): Promise<PaginatedPracticeAnalyticsPairs> {
  const query = buildQuery({ limit, offset })
  return api.get<PaginatedPracticeAnalyticsPairs>(`/api/v1/practices/${id}/analytics/pairs${query}`)
}

/** Reviews with text, newest first. */
export function getPracticeAnalyticsReviews(
  id: string,
  limit = 20,
  offset = 0,
): Promise<PaginatedPracticeAnalyticsReviews> {
  const query = buildQuery({ limit, offset })
  return api.get<PaginatedPracticeAnalyticsReviews>(
    `/api/v1/practices/${id}/analytics/reviews${query}`,
  )
}
