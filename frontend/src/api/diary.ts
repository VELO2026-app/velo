// =============================================================================
// VELO Frontend -- Diary API (Phase F9)
// =============================================================================
//
// Typed wrappers for all diary-related endpoints:
//
//   Check-in (F9.1):
//     POST /api/v1/practices/{id}/checkin          -- upsert (confirmed booking)
//     GET  /api/v1/users/me/checkins               -- paginated list
//
//   Feedback (F9.1):
//     POST /api/v1/practices/{id}/feedback         -- upsert (attended booking)
//     GET  /api/v1/users/me/feedbacks              -- paginated list
//
//   Diary entries (F9.2):
//     POST   /api/v1/diary                         -- create entry
//     GET    /api/v1/diary                         -- paginated list
//     GET    /api/v1/diary/{id}                    -- single entry
//     PATCH  /api/v1/diary/{id}                    -- update entry (clear_* sentinels)
//     DELETE /api/v1/diary/{id}                    -- hard delete
//
//   Insights (F9.3, master-facing):
//     GET /api/v1/practices/{id}/insights          -- aggregated distributions
// =============================================================================

import { api } from '@/api/client'
import { buildQuery } from '@/api/utils'
import type {
  CheckinRequest,
  CheckinResponse,
  PaginatedCheckinsResponse,
  FeedbackRequest,
  FeedbackResponse,
  PaginatedFeedbacksResponse,
  CreateDiaryEntryRequest,
  UpdateDiaryEntryRequest,
  DiaryEntryResponse,
  PaginatedDiaryEntriesResponse,
  DiaryFeedResponse,
  DiaryFeedFilters,
  CreateExternalActivityRequest,
  ExternalActivityResponse,
  PracticeInsightsResponse,
  Mood,
  FeedbackRating,
} from '@/api/types'

// ============================================================================
// Check-in
// ============================================================================

/**
 * Create or update a pre-practice check-in (upsert).
 *
 * Window: scheduled_at - 3h .. scheduled_at.
 * Requires booking.status == confirmed.
 * Repeated calls overwrite mood/comment.
 */
export function upsertCheckin(practiceId: string, body: CheckinRequest): Promise<CheckinResponse> {
  return api.post<CheckinResponse>(`/api/v1/practices/${practiceId}/checkin`, body)
}

export interface ListCheckinsParams {
  practice_id?: string
  date_from?: string
  date_to?: string
  limit?: number
  offset?: number
}

/**
 * Fetch current user's check-ins with optional filters.
 */
export function listMyCheckins(
  params: ListCheckinsParams = {},
): Promise<PaginatedCheckinsResponse> {
  const query = buildQuery({
    practice_id: params.practice_id,
    date_from: params.date_from,
    date_to: params.date_to,
    limit: params.limit ?? 20,
    offset: params.offset ?? 0,
  })
  return api.get<PaginatedCheckinsResponse>(`/api/v1/users/me/checkins${query}`)
}

/**
 * Fetch a single check-in by ID (read-only detail).
 */
export function getCheckin(id: string): Promise<CheckinResponse> {
  return api.get<CheckinResponse>(`/api/v1/users/me/checkins/${id}`)
}

// ============================================================================
// Feedback
// ============================================================================

/**
 * Create or update a post-practice feedback (upsert).
 *
 * Window: scheduled_at + duration_minutes .. + 72h.
 * Requires booking.status == attended AND practice.status == completed.
 * One feedback per (practice, user) -- repeated calls overwrite.
 */
export function upsertFeedback(
  practiceId: string,
  body: FeedbackRequest,
): Promise<FeedbackResponse> {
  return api.post<FeedbackResponse>(`/api/v1/practices/${practiceId}/feedback`, body)
}

export interface ListFeedbacksParams {
  practice_id?: string
  rating?: FeedbackRating
  date_from?: string
  date_to?: string
  limit?: number
  offset?: number
}

/**
 * Fetch current user's feedbacks with optional filters.
 */
export function listMyFeedbacks(
  params: ListFeedbacksParams = {},
): Promise<PaginatedFeedbacksResponse> {
  const query = buildQuery({
    practice_id: params.practice_id,
    rating: params.rating,
    date_from: params.date_from,
    date_to: params.date_to,
    limit: params.limit ?? 20,
    offset: params.offset ?? 0,
  })
  return api.get<PaginatedFeedbacksResponse>(`/api/v1/users/me/feedbacks${query}`)
}

/**
 * Fetch a single feedback by ID (read-only detail).
 */
export function getFeedback(id: string): Promise<FeedbackResponse> {
  return api.get<FeedbackResponse>(`/api/v1/users/me/feedbacks/${id}`)
}

// ============================================================================
// Diary entries
// ============================================================================

/**
 * Create a new diary entry.
 *
 * content is required (1-10000 chars).
 * title, mood, practice_id are optional.
 */
export function createDiaryEntry(body: CreateDiaryEntryRequest): Promise<DiaryEntryResponse> {
  return api.post<DiaryEntryResponse>('/api/v1/diary', body)
}

export interface ListDiaryEntriesParams {
  practice_id?: string
  mood?: Mood
  date_from?: string
  date_to?: string
  limit?: number
  offset?: number
}

/**
 * Fetch current user's diary entries with optional filters.
 */
export function listDiaryEntries(
  params: ListDiaryEntriesParams = {},
): Promise<PaginatedDiaryEntriesResponse> {
  const query = buildQuery({
    practice_id: params.practice_id,
    mood: params.mood,
    date_from: params.date_from,
    date_to: params.date_to,
    limit: params.limit ?? 20,
    offset: params.offset ?? 0,
  })
  return api.get<PaginatedDiaryEntriesResponse>(`/api/v1/diary${query}`)
}

// ============================================================================
// Diary feed (unified timeline)
// ============================================================================

export interface ListDiaryFeedParams extends DiaryFeedFilters {
  // occurred_at of the last item from the previous page; the next page
  // returns events strictly older than this. Omit for the first page.
  cursor?: string
  limit?: number
}

/**
 * Fetch the unified diary timeline (cursor-paginated).
 *
 * Aggregates every projected activity (bookings, practice outcomes,
 * check-ins, feedbacks, notes/dreams) newest-first. Filter chips map to
 * `category` (repeated param); `search` is a case-insensitive text match.
 *
 * Pagination is cursor-based: pass `cursor` = previous response's
 * `next_cursor` to load the next page. `next_cursor === null` means the
 * end of the feed.
 */
export function listDiaryFeed(params: ListDiaryFeedParams = {}): Promise<DiaryFeedResponse> {
  const query = buildQuery({
    // categories[] -> repeated `category` query params (FastAPI list[...]).
    category: params.categories,
    date_from: params.date_from,
    date_to: params.date_to,
    search: params.search,
    cursor: params.cursor,
    limit: params.limit,
  })
  return api.get<DiaryFeedResponse>(`/api/v1/diary/feed${query}`)
}

/**
 * Fetch a single diary entry by ID.
 */
export function getDiaryEntry(id: string): Promise<DiaryEntryResponse> {
  return api.get<DiaryEntryResponse>(`/api/v1/diary/${id}`)
}

/**
 * Update a diary entry (partial update).
 *
 * Use clear_mood / clear_title / clear_practice sentinel flags to
 * explicitly set nullable fields to null (omitting them leaves unchanged).
 */
export function updateDiaryEntry(
  id: string,
  body: UpdateDiaryEntryRequest,
): Promise<DiaryEntryResponse> {
  return api.patch<DiaryEntryResponse>(`/api/v1/diary/${id}`, body)
}

/**
 * Soft-delete a diary entry (hidden from the feed, recoverable via restore).
 * Returns 204 No Content.
 */
export function deleteDiaryEntry(id: string): Promise<void> {
  return api.delete(`/api/v1/diary/${id}`)
}

/**
 * Restore a soft-deleted diary entry (undo delete). Returns the entry.
 */
export function restoreDiaryEntry(id: string): Promise<DiaryEntryResponse> {
  return api.post<DiaryEntryResponse>(`/api/v1/diary/${id}/restore`)
}

// ============================================================================
// External activity (FE-70 / BE-27)
// ============================================================================

/**
 * Record an activity that happened OUTSIDE velo (a home meditation, a massage).
 *
 * 201 with the created activity. The backend writes the activity AND its diary
 * event in one transaction, so a successful response means the NEXT
 * GET /api/v1/diary/feed already includes it -- callers refresh the feed
 * afterwards instead of inserting anything by hand.
 *
 * Field-level 422s (future occurred_at, custom-name rules, length caps) arrive
 * as FastAPI loc arrays; api/client.ts keeps them on ApiResponseError.validation.
 */
export function createExternalActivity(
  body: CreateExternalActivityRequest,
): Promise<ExternalActivityResponse> {
  return api.post<ExternalActivityResponse>('/api/v1/diary/external-activities', body)
}

// ============================================================================
// Practice insights (master-facing)
// ============================================================================

/**
 * Fetch aggregated anonymous insights for a completed practice.
 *
 * Master-only: only the practice owner can call this.
 * Returns mood distribution, rating distribution, participant count,
 * and feedback comments count. No individual user data exposed.
 */
export function getPracticeInsights(practiceId: string): Promise<PracticeInsightsResponse> {
  return api.get<PracticeInsightsResponse>(`/api/v1/practices/${practiceId}/insights`)
}
