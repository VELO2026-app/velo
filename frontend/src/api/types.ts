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
  AdminSchoolCuratorRef,
  AdminSchoolListItem,
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
  BookingRecordingResponse,
  BookingResponse,
  BrowserLoginResponse,
  BrowserLoginStartResponse,
  CancelBookingRequest,
  CheckinMetricResponse,
  CheckinRequest,
  CheckinResponse,
  ClaimMasterInviteRequest,
  ClaimMasterInviteResponse,
  CreateBookingRequest,
  CreateCompanyPromoRequest,
  CreateSchoolRequest,
  CreateDiaryEntryRequest,
  CreateExternalActivityRequest,
  CreateMasterPromoRequest,
  CreateReportRequest,
  CreateWithdrawalRequest,
  CustomActivityNamesResponse,
  SchoolAnalyticsResponse,
  SchoolCheckinItem,
  SchoolCuratorRef,
  SchoolDeletePreviewResponse,
  SchoolEventActor,
  SchoolEventItem,
  SchoolInvitePreviewSchool,
  SchoolInvitePreviewResponse,
  SchoolInviteResponse,
  SchoolLeavePreviewResponse,
  SchoolListResponse,
  SchoolMasterItem,
  SchoolMasterOfferRequest,
  SchoolMemberItem,
  SchoolMineItem,
  SchoolMineResponse,
  SchoolPageResponse,
  SchoolRemovePreviewResponse,
  SchoolResponse,
  SchoolRosterItem,
  SchoolBlockedItem,
  SchoolReviewItem,
  SchoolTransferRef,
  SchoolViewer,
  DiaryEntryResponse,
  DiaryFeedItem,
  DiaryFeedResponse,
  DismissReportRequest,
  ExistingReportResponse,
  ExternalActivityResponse,
  ExternalActivityType,
  FeedbackMetricResponse,
  FeedbackRequest,
  FeedbackResponse,
  IncomeResponse,
  InviteMasterResponse,
  JoinSchoolRequest,
  JoinSchoolResponse,
  LowCheckinPractice,
  MasterApplyExperience,
  MasterApplyProfile,
  MasterApplyRequest,
  MasterApplyResponse,
  MasterSchoolRightResponse,
  MasterProfileResponse,
  MasterPublicResponse,
  MasterReviewItem,
  MasterStatsResponse,
  MasterTransactionItem,
  MethodChangeActionResponse,
  MethodChangeRequest,
  MethodChangeRequestSubmit,
  OfferSchoolTransferRequest,
  PaginatedAdminSchoolsResponse,
  PaginatedAdminPracticesResponse,
  PaginatedAdminWithdrawalsResponse,
  PaginatedBookingsResponse,
  PaginatedCheckinsResponse,
  PaginatedSchoolCheckinsResponse,
  PaginatedSchoolEventsResponse,
  PaginatedSchoolMastersResponse,
  PaginatedSchoolMembersResponse,
  PaginatedSchoolReviewsResponse,
  PaginatedSchoolRosterResponse,
  PaginatedSchoolBlocksResponse,
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
  PaginatedPracticeAnalyticsPairs,
  PaginatedPracticeAnalyticsReviews,
  PaginatedReviewsResponse,
  PracticeAnalyticsPair,
  PracticeAnalyticsResponse,
  PracticeAnalyticsReview,
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
  RecurrenceSpec,
  ReflectionRequest,
  ReflectionResponse,
  RejectMasterRequest,
  RejectMethodChangeRequest,
  RejectWithdrawalRequest,
  RevokeMasterAdvisory,
  ReportResponse,
  ResolveReportRequest,
  ReturnMetricResponse,
  ReviewItem,
  SchoolStudentCheckinItem,
  SchoolStudentFeedbackItem,
  SchoolStudentProfileResponse,
  ScoreZone,
  ScoreZoneCounts,
  SeriesPoint,
  StudentCheckinItem,
  StudentDetailResponse,
  StudentFeedbackItem,
  StudentListItem,
  TelegramAuthRequest,
  TopUser,
  TopupRequest,
  TopupResponse,
  UpdateSchoolRequest,
  UpdateDiaryEntryRequest,
  UpdateReportRequest,
  MasterApplicationInfo,
  McpScope,
  McpScopeLabel,
  McpTokenCreate,
  McpTokenCreated,
  McpTokenItem,
  McpTokenListResponse,
  TimezoneCatalogResponse,
  TimezoneLabel,
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
  ZoomEntryResolveResponse,
  ZoomSdkJoinResponse,
  BlockStudentResponse,
  DistinctTagsResponse,
  GroupInviteResponse,
  GroupListItem,
  GroupListResponse,
  GroupMemberItem,
  GroupResponse,
  GroupSearchMemberItem,
  JoinGroupResponse,
  PaginatedGroupMembersResponse,
  PaginatedGroupSearchResponse,
  StudentGroupItem,
  StudentGroupsResponse,
  StudentTagResponse,
  AudiencePreviewRequest,
  AudiencePreviewResponse,
  BookingWithPracticeResponse,
  CreatePracticeRequest,
  PracticeResponse,
  PracticeSummary,
  RoleSwitchInfo,
  UpdatePracticeRequest,
} from './generated'

// `export type { X } from './generated'` re-exports X to consumers of this
// file but does not bind X for use WITHIN this file; PracticeType is used
// locally below (PracticeFilters), so it needs its own local binding.
import type { PracticeType } from './generated'

// FE-157: the former hand-written bridges (CreatePracticeRequest,
// UpdatePracticeRequest, PracticeResponse, PracticeSummary,
// BookingWithPracticeResponse, AudiencePreview*, RoleSwitchInfo) are gone --
// generated.ts carries every one of them natively (see the re-export list
// above), and `scripts/api-type-dupes.mjs` forbids hand copies.
export type { AudienceKind as PracticeAudienceKind } from './generated'

// =============================================================================
// Frontend-only types (no backend counterpart)
// =============================================================================

// -- API error shape (matches VeloError + Pydantic 422 formats) --------------

/** Error body shape shared by VeloError and Pydantic 422 responses. */
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
//
// B26 (PROMPT №724): this block used to hand-copy SIXTEEN backend-owned
// vocabularies. FOUR were found byte-identical to a type generated.ts has
// carried for weeks (PracticeType/PracticeStatus/BookingStatus/
// WithdrawalStatus below, plus PracticeAudienceKind above) -- those are now
// re-exports, not copies, so they can no longer drift silently. EVERY type
// still declared locally in this block carries its OWN comment saying WHY:
// either the backend serves the field as a bare `string` (no generated union
// exists to point at), or the union here is a deliberately NARROWER subset
// of a wider backend vocabulary. Do not mass-replace these with generated.ts
// imports -- for the ones with no generated counterpart there is nothing to
// import, and for the deliberate subsets the narrowing is the point.

export type { PracticeType, PracticeStatus } from './generated'
// Statuses a CLIENT may PATCH a practice into. 'live' and 'completed' were
// removed (lifecycle automation): going live and completion are now driven by
// the backend lifecycle worker off the clock (live at scheduled_at, completed at
// scheduled_at + duration_minutes), never by the client -- the backend rejects
// them at the schema layer (422). 'cancelled' is absent for the same reason it
// always was: that path is POST /practices/{id}/cancel (it handles refunds).
// NB: PracticeStatus (re-exported above) still carries live/completed -- those
// are real statuses the backend REPORTS, they just cannot be REQUESTED.
// Intentionally NARROWER than PracticeStatus, not a generated.ts candidate.
/** Statuses a client may PATCH a practice into -- deliberately narrower than the reported PracticeStatus. */
export type PracticeStatusTransition = 'scheduled' | 'deleted'

// -- Calendar taxonomy facets (match backend data.taxonomy values) --
// Mirror of settings.practice_allowed_directions in backend/app/core/config.py.
// Keep in sync when the backend list is extended. NOT a generated.ts
// re-export candidate: the backend serves `direction` as a bare `string`
// (verified in generated.ts's CreatePracticeRequest/UpdatePracticeRequest --
// no closed union exists there to point at), so this hand-copy is the only
// place any type safety exists for this field at all.
//
// FRONT-FIRST (2026-05-28): the 10 keys below reflect the final taxonomy
// agreed with the operator. The backend currently accepts the OLD 8 keys
// (meditation/yoga/breathwork/somatic/tantra/womens_circle/mens_circle/
// kundalini); see handoff §9 task B-2 for the matching backend rollout
// (extend practice_allowed_directions, migrate womens_circle/mens_circle
// -> circles + style, migrate kundalini -> yoga + style=kundalini). The
// frontend commit MUST wait for the backend deploy.
/** Practice direction taxonomy facets, hand-copied because the backend serves direction as a bare string. */
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
// Same reasoning as PracticeDirection above: backend serves `difficulty` as
// a bare `string`, no generated union to re-point at.
/** Practice difficulty facets, narrowed from a bare backend string for type safety. */
export type PracticeDifficulty = 'beginner' | 'medium' | 'high'
// -- Calendar feed buckets (match backend filter literals) -- these are
// QUERY-PARAM literals the calendar filter sends, not a field any response
// object carries -- generated.ts has no counterpart to re-point at.
/** Calendar duration-bucket query literal (short or long); a filter value, not a response field. */
export type DurationBucket = 'short' | 'long'
/** Calendar time-of-day query literal (night, morning, day, evening). */
export type TimeOfDay = 'night' | 'morning' | 'day' | 'evening'
export type { BookingStatus } from './generated'
// No generated.ts counterpart for these three -- Purchase/Master/Attendance
// each expose their status as a bare backend `string`, narrowed here for
// call-site type safety only.
/** Purchase status narrowed from a bare backend string for call-site type safety. */
export type PurchaseStatus = 'pending' | 'completed' | 'refunded' | 'failed'
/** Master verification status narrowed from a bare backend string. */
export type MasterStatus = 'pending' | 'verified' | 'rejected'
/** Attendance's booking status narrowed from a bare backend string. */
export type AttendanceBookingStatus = 'pending' | 'confirmed' | 'attended' | 'no_show'
export type { WithdrawalStatus } from './generated'
// WaitlistStatus is re-exported from generated.ts -- that file is the
// SOURCE OF TRUTH for its values, not this comment, so its members are
// deliberately not enumerated here (PROMPT №614: a REMOVED status added
// backend-side would otherwise make a listed enumeration stale the moment
// it reached the wire). A stale hand-written copy used to live here with
// 'confirmed' instead of 'converted' -- removed to avoid shadowing the
// generated type.
//
// Zones of a 1..10 mood / rating (BE-77) are ScoreZone, re-exported above from
// generated.ts; utils/moodScale.ts holds the matching keys + labels and
// type-checks MoodScaleKey against ScoreZone. No hand-written zone type here.

// -- Diary feed (unified timeline) --
// Event kinds are a closed vocabulary on the backend (DiaryEventKind). We
// narrow the generated `DiaryFeedItem.kind: string` to this union at the
// rendering layer for exhaustive card mapping. Keep in sync with the backend
// enum -- regenerating types does NOT produce this (snapshot/kind stay open).
/** Closed vocabulary of diary feed event kinds, narrowed at the rendering layer for exhaustive card mapping. */
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
  // A conversation with a master began (one row per thread, written by the
  // chat proxy on create-or-get). Snapshot: {thread_id, master_id, master_name}.
  | 'thread_started'
  // BE-27 (FE-70): an activity the person did OUTSIDE velo, entered by hand.
  // Snapshot: {activity_type, custom_activity_name, mood, thoughts_preview}
  // -- the caption/icon come from activity_type (custom -> the raw name);
  // occurred_at is the activity's OWN time, not the write time.
  | 'external_activity'

// Filter chips on the feed. Map 1:1 onto backend \`category\` query values
// (settings.diary_feed_categories). Omitting category = the All chip
// (i18n:common.all). Query-param literal, not a response field -- no
// generated.ts counterpart to re-point at.
/** Feed filter-chip categories, mapping one-to-one onto the backend category query values. */
export type DiaryFeedCategory = 'entries' | 'dreams' | 'feedbacks' | 'checkins' | 'practices'

// Query params for GET /api/v1/diary/feed (cursor pagination).
/** Query params of the diary feed endpoint: chips, date window, search (cursor pagination). */
export interface DiaryFeedFilters {
  // Filter chips -> repeated \`category\` params. Empty/undefined = all.
  categories?: DiaryFeedCategory[]
  date_from?: string
  date_to?: string
  search?: string
}

// -- Query / filter types (used by stores and API modules) -------------------

/** List/filter query params for practices: facets, date window, sort. */
export interface PracticeFilters {
  // Multi-select: OR within the facet, sent as repeated query params.
  practice_type?: PracticeType[]
  // Calendar facets (all optional). Multi-select facets are arrays.
  direction?: PracticeDirection[]
  difficulty?: PracticeDifficulty[]
  // F-8 (2026-05-29): style is now multi-select chips, sent as an array
  // (same as direction/difficulty). Backend B-4 accepts list[str] and
  // filters via .in_().
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

// Admin report-list query-param literals -- not response fields, no
// generated.ts counterpart to re-point at.
/** Admin report-list status filter literals. */
export type ReportStatusFilter = 'pending' | 'resolved' | 'dismissed'
/** Admin report-list target-type filter literals. */
export type ReportTargetTypeFilter = 'user' | 'master' | 'practice'

// -- Convenience re-export for generic paginated response -------------------

/** Generic shape of a limit/offset-paginated list response. */
export interface PaginatedResponse<T> {
  items: T[]
  total: number
  limit: number
  offset: number
}

// -- Promo request (unified for master and admin UI) ------------------------

/** Promo create request shared by the master and admin promo UIs. */
export interface CreatePromoRequest {
  code: string
  discount_percent: number
  max_uses?: number | null
  practice_id?: string | null
  valid_from?: string | null
  valid_until?: string | null
  first_purchase_only?: boolean
}
