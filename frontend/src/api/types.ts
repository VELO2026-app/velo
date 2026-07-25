// =============================================================================
// VELO Frontend -- API Types
// =============================================================================
//
// Single import point for all API types. Combines:
//   1. Auto-generated types from backend OpenAPI (generated.ts)
//   2. Frontend-only types (filters, UI unions, error shapes)
//
// CONSUMERS: always import from '@/api/types', never from '@/api/generated'.
// BACKEND TYPES: do NOT add manually — they come from generated.ts.
// Run `make gen-types` after changing any Pydantic schema.
// =============================================================================

// -- Re-export everything from generated backend types -----------------------

export type {
  AISummaryResponse,
  AdminMasterActionResponse,
  AdminMasterDetail,
  AdminMasterListItem,
  AdminMasterProfileUpdate,
  AdminParticipant,
  EditMasterMethodsRequest,
  AdminPracticeDetailResponse,
  AdminPracticeListItem,
  AdminRevenuePerMaster,
  AdminRevenueResponse,
  AdminRosterEntry,
  AdminStatsResponse,
  AdminStatsOverviewResponse,
  AdminWithdrawalResponse,
  ApproveWithdrawalRequest,
  AttendanceItemResponse,
  AttendanceResponse,
  AuthResponse,
  BookingDetailResponse,
  BookingResponse,
  CancelBookingRequest,
  CheckinMetricResponse,
  CheckinRequest,
  CheckinResponse,
  ClaimMasterInviteRequest,
  ClaimMasterInviteResponse,
  CreateBookingRequest,
  CreateCompanyPromoRequest,
  CreateDiaryEntryRequest,
  CreateMasterPromoRequest,
  CreateReportRequest,
  CreateWithdrawalRequest,
  DiaryEntryResponse,
  DiaryFeedItem,
  DiaryFeedResponse,
  DismissReportRequest,
  ExistingReportResponse,
  FeedbackMetricResponse,
  FeedbackRatingDistribution,
  FeedbackRequest,
  FeedbackResponse,
  IncomeResponse,
  InviteMasterResponse,
  LowCheckinPractice,
  MasterApplyExperience,
  MasterApplyProfile,
  MasterApplyRequest,
  MasterApplyResponse,
  MasterProfileResponse,
  MasterPublicResponse,
  MasterReviewItem,
  MasterStatsResponse,
  MasterTransactionItem,
  MethodChangeActionResponse,
  MethodChangeRequest,
  MethodChangeRequestSubmit,
  MoodDistribution,
  PaginatedAdminPracticesResponse,
  PaginatedAdminWithdrawalsResponse,
  PaginatedBookingsResponse,
  PaginatedCheckinsResponse,
  PaginatedDiaryEntriesResponse,
  PaginatedFeedbacksResponse,
  PaginatedMasterReviewsResponse,
  PaginatedMastersResponse,
  PaginatedMethodChangeRequestsResponse,
  AdminMethodChangeItem,
  PaginatedParticipantsResponse,
  PaginatedPracticesResponse,
  PaginatedPromosResponse,
  PaginatedPurchasesResponse,
  PaginatedReportsResponse,
  PaginatedReviewsResponse,
  PaginatedStudentsResponse,
  PaginatedTransactionsResponse,
  PaginatedUserReportsResponse,
  PaginatedUsersResponse,
  PaginatedWaitlistResponse,
  PaginatedWithdrawalsResponse,
  PayoutDetails,
  PayoutDetailsUpdate,
  PracticeInsightsResponse,
  PreviewPurchaseRequest,
  PreviewPurchaseResponse,
  PromoResponse,
  PurchaseRequest,
  PurchaseResponse,
  PurchaseWithPracticeResponse,
  RatingDistribution,
  RecurrenceSpec,
  RejectMasterRequest,
  RejectMethodChangeRequest,
  RejectWithdrawalRequest,
  RevokeMasterAdvisory,
  ReportResponse,
  ResolveReportRequest,
  ReturnMetricResponse,
  ReviewItem,
  SeriesPoint,
  StudentCheckinItem,
  StudentDetailResponse,
  StudentFeedbackItem,
  StudentListItem,
  TelegramAuthRequest,
  TopUser,
  TopupRequest,
  TopupResponse,
  UpdateDiaryEntryRequest,
  UpdateReportRequest,
  MasterApplicationInfo,
  UserResponse,
  UserRole,
  UserStatsResponse,
  UserUpdate,
  VerifyMasterRequest,
  WaitlistConfirmResponse,
  WaitlistEntryResponse,
  WaitlistStatus,
  WaitlistWithPracticeResponse,
  WithdrawalResponse,
} from './generated'

// -- T21-1 bridge: two fields the backend already returns, ahead of the next
// `generated.ts` regen (velo-manage.sh regenerates it from a live backend on
// deploy; never hand-edited -- see file header). Remove this block once a
// regen picks up `zoom_registrant_join_url` / `zoom_host_join_url` natively
// and switch these two back to the plain re-export above.
import type {
  BookingWithPracticeResponse as GeneratedBookingWithPracticeResponse,
  CreatePracticeRequest as GeneratedCreatePracticeRequest,
  PracticeResponse as GeneratedPracticeResponse,
  PracticeSummary as GeneratedPracticeSummary,
  UpdatePracticeRequest as GeneratedUpdatePracticeRequest,
} from './generated'

// -- P5 bridge (Master GROUPS, ПРОМТ №594): audience_kind + group_ids, ahead
// of the next generated.ts regen -- same "never hand-edited" posture as the
// T21-1 bridge above. Remove once a regen picks these up natively.
export type PracticeAudienceKind = 'public' | 'students' | 'groups'

export interface CreatePracticeRequest extends GeneratedCreatePracticeRequest {
  /** Default 'public' server-side when omitted -- matches every practice's
   * behavior before this feature existed. */
  audience_kind?: PracticeAudienceKind
  /** Required (non-empty) only when audience_kind='groups'; the master's
   * OWN custom groups (rejects another master's group / a system slug with
   * a 400). */
  group_ids?: string[]
}

export interface UpdatePracticeRequest extends GeneratedUpdatePracticeRequest {
  /** Both optional (PATCH semantics): omitted = unchanged. group_ids, when
   * sent, REPLACES the practice's full target-group set. */
  audience_kind?: PracticeAudienceKind
  group_ids?: string[]
}

export interface PracticeResponse extends GeneratedPracticeResponse {
  /** The practice owner's own Zoom host-registrant link. Populated only on
   * owner-facing responses; null/undefined otherwise. Optional for the same
   * fixture-compatibility reason as above. */
  zoom_host_join_url?: string | null
  /** A4 V2 (ПРОМТ №572): this practice's ZoomMeeting.status verbatim
   * ('active' | 'pending_creation' | 'create_failed' | 'deleted'), or null/
   * undefined if no ZoomMeeting row exists. NOT owner-gated (unlike
   * zoom_host_join_url above) -- see the backend schema field's own
   * docstring. Lets resolveZoomLink (utils/zoomLink.ts) tell "still
   * preparing" apart from "permanently failed" for BOTH the master and a
   * booked participant. */
  zoom_meeting_status?: string | null
  /** A4 V6 (ПРОМТ №572): True when this response is the master's own
   * EARLIER submission returned again (a window-scoped retry-after-timeout
   * dedup, or the losing side of a genuine concurrent double-tap) instead
   * of a freshly created practice. Only ever meaningful on the CREATE
   * endpoint's response -- optional/undefined everywhere else (list,
   * detail, update, delete, cancel), same fixture-compatibility reason as
   * the other bridged fields above. */
  deduplicated?: boolean
  /** P5 (ПРОМТ №594): 'public' | 'students' | 'groups'. Optional/undefined
   * for the same fixture-compatibility reason as the other bridged fields
   * above -- defaults to 'public' server-side, but existing test fixtures
   * built before this field existed simply omit it. */
  audience_kind?: PracticeAudienceKind
  /** The practice's target CUSTOM groups' names (audience_kind='groups'
   * only; empty/undefined otherwise). Static per-practice data, not a
   * per-viewer flag -- CheckinView.vue composes the "Вы не состоите в
   * группе «...»" message from this directly, no second round-trip. */
  audience_group_names?: string[]
}

export interface PracticeSummary extends GeneratedPracticeSummary {
  /** Same field, same posture as PracticeResponse.zoom_meeting_status
   * above -- powers the identical pending-vs-failed distinction on
   * list-view Zoom buttons (dashboard nearest card, my-bookings). */
  zoom_meeting_status?: string | null
}

export interface BookingWithPracticeResponse extends GeneratedBookingWithPracticeResponse {
  /** This booking's own Zoom registrant link (the personal ?tk= URL), or
   * null/undefined if not yet confirmed/attended or not yet created by
   * Zoom. Optional (not just nullable): existing test fixtures built before
   * this field existed omit it entirely, and the ladder treats a missing
   * field the same as an explicit null. */
  zoom_registrant_join_url?: string | null
  /** Overrides the generated field's type to OUR bridged PracticeSummary
   * (zoom_meeting_status) above -- the generated one does not have it yet. */
  practice: PracticeSummary
}

// =============================================================================
// Frontend-only types (no backend counterpart)
// =============================================================================

// -- Role switch (capability-derived, №256) -----------------------------------
// Mirrors the backend UserResponse.role_switch block: null when there is
// nothing to switch to, otherwise the derived set (verified master ->
// user/master; admin -> all three). Kept here (not relying on generated.ts)
// because the frontend must typecheck locally BEFORE the server regenerates
// generated.ts on the next `velo update`. After regen the generated field is
// read structurally — no conflict, since this is a separate named type.
import type { UserRole } from './generated'

export interface RoleSwitchInfo {
  /** Roles this account may switch itself into. */
  allowed_roles: UserRole[]
}

// -- API error shape (matches VeloError + Pydantic 422 formats) --------------

export interface ApiError {
  /** Machine-readable error code ("bad_request", "not_found", etc.) */
  error?: string
  /** Human-readable message (VeloError format). */
  message?: string
  /** Pydantic validation error details (422 only). */
  detail?:
    | string
    | Array<{
        loc: (string | number)[]
        msg: string
        type: string
      }>
}

// -- UI union types (narrower than backend str for type safety) --------------

export type PracticeType = 'live' | 'series' | 'one_on_one' | 'replay'
export type PracticeStatus = 'draft' | 'scheduled' | 'live' | 'completed' | 'cancelled' | 'deleted'
// Statuses a CLIENT may PATCH a practice into. 'live' and 'completed' were
// removed (lifecycle automation): going live and completion are now driven by
// the backend lifecycle worker off the clock (live at scheduled_at, completed at
// scheduled_at + duration_minutes), never by the client -- the backend rejects
// them at the schema layer (422). 'cancelled' is absent for the same reason it
// always was: that path is POST /practices/{id}/cancel (it handles refunds).
// NB: PracticeStatus above still carries live/completed -- those are real
// statuses the backend REPORTS, they just cannot be REQUESTED.
export type PracticeStatusTransition = 'scheduled' | 'deleted'

// -- Calendar taxonomy facets (match backend data.taxonomy values) --
// Mirror of settings.practice_allowed_directions in backend/app/core/config.py.
// Keep in sync when the backend list is extended.
//
// FRONT-FIRST (2026-05-28): the 10 keys below reflect the final taxonomy
// agreed with the operator. The backend currently accepts the OLD 8 keys
// (meditation/yoga/breathwork/somatic/tantra/womens_circle/mens_circle/
// kundalini); see handoff §9 task B-2 for the matching backend rollout
// (extend practice_allowed_directions, migrate womens_circle/mens_circle
// -> circles + style, migrate kundalini -> yoga + style=kundalini). The
// frontend commit MUST wait for the backend deploy.
export type PracticeDirection =
  | 'meditation'
  | 'yoga'
  | 'breathwork'
  | 'somatic'
  | 'tantra'
  | 'circles'
  | 'sound_healing'
  | 'art'
  | 'narrative'
  | 'movement'
export type PracticeDifficulty = 'beginner' | 'medium' | 'high'
// -- Calendar feed buckets (match backend filter literals) --
export type DurationBucket = 'short' | 'long'
export type TimeOfDay = 'night' | 'morning' | 'day' | 'evening'
export type BookingStatus = 'pending' | 'confirmed' | 'attended' | 'no_show' | 'cancelled'
export type PurchaseStatus = 'pending' | 'completed' | 'refunded' | 'failed'
export type MasterStatus = 'pending' | 'verified' | 'rejected'
export type AttendanceBookingStatus = 'pending' | 'confirmed' | 'attended' | 'no_show'
export type WithdrawalStatus = 'pending' | 'approved' | 'rejected'
// WaitlistStatus is re-exported from generated.ts (the backend is the source
// of truth: 'waiting' | 'notified' | 'converted' | 'left' | 'declined' |
// 'expired'). A stale hand-written copy used to live here with 'confirmed'
// instead of 'converted' -- removed to avoid shadowing the generated type.
//
// Mood / FeedbackRating are UI BUCKETS, not the raw backend value. On the
// backend a check-in mood and a feedback rating are each a 1..10 score; the
// frontend groups that score into three labelled buckets for the faces / glyphs
// (see MOOD_OPTIONS / RATING_OPTIONS in displayHelpers.ts, where each bucket
// carries its numeric `score`). These are intentionally frontend-only.
export type Mood = 'low' | 'mid' | 'high'
export type FeedbackRating = 'fire' | 'good' | 'confused'

// -- Diary feed (unified timeline) --
// Event kinds are a closed vocabulary on the backend (DiaryEventKind). We
// narrow the generated `DiaryFeedItem.kind: string` to this union at the
// rendering layer for exhaustive card mapping. Keep in sync with the backend
// enum -- regenerating types does NOT produce this (snapshot/kind stay open).
export type DiaryEventKind =
  | 'booking_confirmed'
  | 'booking_cancelled_by_user'
  | 'practice_rescheduled'
  | 'practice_cancelled_by_master'
  | 'practice_outcome'
  | 'checkin'
  | 'feedback'
  | 'note'
  | 'dream'

// Filter chips on the feed. Map 1:1 onto backend \`category\` query values
// (settings.diary_feed_categories). Omitting category = "Все".
export type DiaryFeedCategory = 'entries' | 'dreams' | 'feedbacks' | 'checkins' | 'practices'

// Query params for GET /api/v1/diary/feed (cursor pagination).
export interface DiaryFeedFilters {
  // Filter chips -> repeated \`category\` params. Empty/undefined = all.
  categories?: DiaryFeedCategory[]
  date_from?: string
  date_to?: string
  search?: string
}

// -- Query / filter types (used by stores and API modules) -------------------

export interface PracticeFilters {
  // Multi-select: OR within the facet, sent as repeated query params.
  practice_type?: PracticeType[]
  // Calendar facets (all optional). Multi-select facets are arrays.
  direction?: PracticeDirection[]
  difficulty?: PracticeDifficulty[]
  // F-8 (2026-05-29): style теперь multi-select chips, отправляется как массив
  // (как direction/difficulty). Backend B-4 принимает list[str] и фильтрует
  // через .in_().
  style?: string[]
  duration_bucket?: DurationBucket
  time_of_day?: TimeOfDay
  status?: 'scheduled' | 'live'
  master_id?: string
  date_from?: string
  date_to?: string
  sort_by?: 'scheduled_at' | 'price_cents'
  sort_order?: 'asc' | 'desc'
}

export type ReportStatusFilter = 'pending' | 'resolved' | 'dismissed'
export type ReportTargetTypeFilter = 'user' | 'master' | 'practice'

// -- Convenience re-export for generic paginated response -------------------

export interface PaginatedResponse<T> {
  items: T[]
  total: number
  limit: number
  offset: number
}

// -- Promo request (unified for master and admin UI) ------------------------

export interface CreatePromoRequest {
  code: string
  discount_percent: number
  max_uses?: number | null
  practice_id?: string | null
  valid_from?: string | null
  valid_until?: string | null
  first_purchase_only?: boolean
}
