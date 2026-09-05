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
  AdminCuratorGroupCuratorRef,
  AdminCuratorGroupListItem,
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
  CancelBookingRequest,
  CheckinMetricResponse,
  CheckinRequest,
  CheckinResponse,
  ClaimMasterInviteRequest,
  ClaimMasterInviteResponse,
  CreateBookingRequest,
  CreateCompanyPromoRequest,
  CreateCuratorGroupInviteRequest,
  CreateCuratorGroupRequest,
  CreateDiaryEntryRequest,
  CreateMasterPromoRequest,
  CreateReportRequest,
  CreateWithdrawalRequest,
  CuratorGroupCuratorRef,
  CuratorGroupDeletePreviewResponse,
  CuratorGroupInvitePreviewGroup,
  CuratorGroupInvitePreviewResponse,
  CuratorGroupInviteResponse,
  CuratorGroupLeavePreviewResponse,
  CuratorGroupListResponse,
  CuratorGroupMasterItem,
  CuratorGroupMemberItem,
  CuratorGroupMineItem,
  CuratorGroupMineResponse,
  CuratorGroupPageResponse,
  CuratorGroupRemovePreviewResponse,
  CuratorGroupResponse,
  CuratorGroupTransferRef,
  CuratorGroupViewer,
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
  JoinCuratorGroupRequest,
  JoinCuratorGroupResponse,
  LowCheckinPractice,
  MasterApplyExperience,
  MasterApplyProfile,
  MasterApplyRequest,
  MasterApplyResponse,
  MasterGroupRightResponse,
  MasterProfileResponse,
  MasterPublicResponse,
  MasterReviewItem,
  MasterStatsResponse,
  MasterTransactionItem,
  MethodChangeActionResponse,
  MethodChangeRequest,
  MethodChangeRequestSubmit,
  MoodDistribution,
  OfferCuratorGroupTransferRequest,
  PaginatedAdminCuratorGroupsResponse,
  PaginatedAdminPracticesResponse,
  PaginatedAdminWithdrawalsResponse,
  PaginatedBookingsResponse,
  PaginatedCheckinsResponse,
  PaginatedCuratorGroupMastersResponse,
  PaginatedCuratorGroupMembersResponse,
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
  UpdateCuratorGroupRequest,
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
  ZoomEntryResolveResponse,
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

// B26 (PROMPT №724): `export type { X } from './generated'` re-exports X to
// CONSUMERS of this file but does not bind X for use WITHIN this file (ES
// module re-export semantics) -- these two are used locally below
// (AudiencePreviewRequest/Response, PracticeFilters), so they need their own
// local binding alongside the re-export statements further down.
import type { AudienceKind, PracticeType } from './generated'

// -- P5 bridge (Master GROUPS, PROMPT №594): audience_kind + group_ids on
// CreatePracticeRequest/UpdatePracticeRequest ahead of the next generated.ts
// regen picking up those FIELDS natively -- same "never hand-edited" posture
// as the T21-1 bridge above. The VALUE UNION itself is no longer hand-typed
// here (B26, PROMPT №724): generated.ts has carried `AudienceKind` with the
// identical literal set since 2026-07-27 and it never drifted, so this is
// now a re-export under the name every existing import already uses. The
// interfaces below stay bridged -- audience_kind/group_ids are still absent
// from GeneratedCreatePracticeRequest/GeneratedUpdatePracticeRequest
// themselves (verified against generated.ts) -- remove the WHOLE bridge
// (interfaces included) once a regen adds those fields natively.
export type { AudienceKind as PracticeAudienceKind } from './generated'

export interface CreatePracticeRequest extends GeneratedCreatePracticeRequest {
  /** Default 'public' server-side when omitted -- matches every practice's
   * behavior before this feature existed. */
  audience_kind?: AudienceKind
  /** Required (non-empty) only when audience_kind='groups'; the master's
   * OWN custom groups (rejects another master's group / a system slug with
   * a 400). */
  group_ids?: string[]
}

export interface UpdatePracticeRequest extends GeneratedUpdatePracticeRequest {
  /** Both optional (PATCH semantics): omitted = unchanged. group_ids, when
   * sent, REPLACES the practice's full target-group set. */
  audience_kind?: AudienceKind
  group_ids?: string[]
}

// -- Q15 bridge (PROMPT №613): brand-new schemas, no generated.ts base to
// extend yet -- POST /practices/{id}/audience-preview, a read-only dry-run
// that never saves anything. Field shape copied verbatim from the backend's
// AudiencePreviewRequest/Response (practices/schemas.py). Unlike
// UpdatePracticeRequest above, both request fields are REQUIRED here -- the
// caller always has a complete proposed state in hand (it's evaluating "if
// I save the form as it stands"), not a partial PATCH.
export interface AudiencePreviewRequest {
  audience_kind: AudienceKind
  group_ids: string[]
  /** FE-24 (GT P5): the mirror of group_ids for audience_kind=
   *  'curator_groups' -- the generated schema carries it natively; this
   *  bridge adds it in the same shape. Mutually exclusive with group_ids. */
  curator_group_ids?: string[]
}

export interface AudiencePreviewResponse {
  /** How many of this practice's ACTIVE (pending/confirmed) bookers would
   * fall outside the proposed audience. Always present on the response
   * (no response_model_exclude_unset on the backend route). */
  stranded_count: number
}

export interface PracticeResponse extends GeneratedPracticeResponse {
  /* T-35: zoom_host_join_url, zoom_meeting_status and the new
   * zoom_public_link are all NATIVE in generated.ts now (the T-35 regen
   * picked them up), so this bridge no longer restates them. zoom_link is
   * gone from generated.ts entirely -- the column no longer exists. */
  /** A4 V6 (PROMPT №572): True when this response is the master's own
   * EARLIER submission returned again (a window-scoped retry-after-timeout
   * dedup, or the losing side of a genuine concurrent double-tap) instead
   * of a freshly created practice. Only ever meaningful on the CREATE
   * endpoint's response -- optional/undefined everywhere else (list,
   * detail, update, delete, cancel), same fixture-compatibility reason as
   * the other bridged fields above. */
  deduplicated?: boolean
  /** P5 (PROMPT №594): the practice's audience kind. The VALUE SET is
   * generated.ts's AudienceKind (public/students/groups/curator_groups --
   * GT-11 added the fourth) and is deliberately not restated here: comments
   * that enumerate unions drift the day the contract grows. Optional/
   * undefined for the same fixture-compatibility reason as the other bridged
   * fields above -- defaults to 'public' server-side, but existing test
   * fixtures built before this field existed simply omit it. */
  audience_kind?: AudienceKind
  /** The practice's target CUSTOM groups' names (audience_kind='groups'
   * only; empty/undefined otherwise). Static per-practice data, not a
   * per-viewer flag -- CheckinView.vue composes the "Вы не состоите в
   * группе «...»" message from this directly, no second round-trip. */
  audience_group_names?: string[]
}

export interface PracticeSummary extends GeneratedPracticeSummary {
  /* T-35: zoom_meeting_status is native in generated.ts now; this alias is
   * kept so the many existing imports of PracticeSummary from '@/api/types'
   * keep resolving to one name. */
}

export interface BookingWithPracticeResponse extends GeneratedBookingWithPracticeResponse {
  /** This booking's own Zoom registrant link (the personal ?tk= URL), or
   * null/undefined if not yet confirmed/attended or not yet created by
   * Zoom. Optional (not just nullable): existing test fixtures built before
   * this field existed omit it entirely, and the ladder treats a missing
   * field the same as an explicit null. */
  zoom_registrant_join_url?: string | null
  /** Overrides the generated field's type to OUR PracticeSummary alias
   * above, so both names stay interchangeable at call sites. */
  practice: PracticeSummary
}

// -- B52 bridge REMOVED (PROMPT No.744): the regen picked the field up natively.
// The bridge existed only because there was no deploy, so `has_unread_messages`
// could not reach generated.ts; it declared the field OPTIONAL for fixture
// compatibility. The 2026-08-16 deploy regenerated generated.ts, which now
// declares it REQUIRED -- and an interface may not widen a required property to
// optional, so the bridge became TS2430 and failed the deploy's vue-tsc gate.
// `UserStatsResponse` is back on the plain re-export list above, exactly as the
// bridge's own comment instructed ("remove this block once a regen picks it up
// natively"). ⚠ THE CLASS, worth more than the fix: a bridge that ADDS a field
// generated.ts lacks is invisible to the local gate, because adding is legal;
// it only becomes illegal the moment the regen makes the field required. So a
// hand-written bridge is provably safe locally and provably unsafe on deploy,
// and the local gate cannot tell you. The runtime guard is unaffected --
// UserProfileView reads `stats.has_unread_messages ?? false` and still does.

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
export type PracticeDifficulty = 'beginner' | 'medium' | 'high'
// -- Calendar feed buckets (match backend filter literals) -- these are
// QUERY-PARAM literals the calendar filter sends, not a field any response
// object carries -- generated.ts has no counterpart to re-point at.
export type DurationBucket = 'short' | 'long'
export type TimeOfDay = 'night' | 'morning' | 'day' | 'evening'
export type { BookingStatus } from './generated'
// No generated.ts counterpart for these three -- Purchase/Master/Attendance
// each expose their status as a bare backend `string`, narrowed here for
// call-site type safety only.
export type PurchaseStatus = 'pending' | 'completed' | 'refunded' | 'failed'
export type MasterStatus = 'pending' | 'verified' | 'rejected'
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
  // A conversation with a master began (one row per thread, written by the
  // chat proxy on create-or-get). Snapshot: {thread_id, master_id, master_name}.
  | 'thread_started'

// Filter chips on the feed. Map 1:1 onto backend \`category\` query values
// (settings.diary_feed_categories). Omitting category = "Все". Query-param
// literal, not a response field -- no generated.ts counterpart to re-point at.
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

// Admin report-list query-param literals -- not response fields, no
// generated.ts counterpart to re-point at.
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
