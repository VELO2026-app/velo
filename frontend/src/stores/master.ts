// =============================================================================
// VELO Frontend -- Master Store (Phase F6, fixed W-4)
// =============================================================================
//
// W-4: fetchMyPractices() now uses a dedicated practicesLoaded flag instead
// of checking items.length > 0. The old guard incorrectly re-fetched every
// time a master with zero practices visited the list view.
// =============================================================================

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getMyMasterProfile, getMyPractices } from '@/api/masters'
import { usePagination } from '@/composables/usePagination'
import { extractApiError } from '@/composables/useApiError'
import { ApiResponseError } from '@/api/client'
import { MASTER_APPLIED_KEY } from '@/utils/constants'
import type { MasterProfileResponse, PracticeResponse } from '@/api/types'

export const useMasterStore = defineStore('master', () => {
  // =========================================================================
  // Profile
  // =========================================================================

  const profile = ref<MasterProfileResponse | null>(null)
  const profileLoading = ref(false)
  const profileError = ref<string | null>(null)

  // Tracks whether at least one successful fetch has completed.
  // Used by masterStatusGuard to skip redundant network calls.
  const profileLoaded = ref(false)

  // CONFIRMED "no application at all" (№257 honest entry): the backend
  // answered 403 code=master_profile_not_found (distinct from
  // master_profile_not_verified -- a pending/rejected application). Keyed on
  // the machine code, NOT on profile===null, so a transient network error
  // never routes a real master into the apply wizard.
  const profileMissing = ref(false)

  // Per-session suppression for the post-approval onboarding carousel
  // (MasterOnboardingView, Phase D). Set true on done/skip so the overlay does
  // not re-trigger within a session; the persisted server flag
  // (master_onboarding_completed, Zod E15) governs across sessions. Cleared on
  // $reset/logout so a different account in the same tab starts fresh.
  const onboardingShownThisSession = ref(false)

  /**
   * Fetch master profile from API.
   *
   * @param force - If true, always fetches even if already loaded.
   *                Default false: skips if profileLoaded is true.
   *
   * Called by:
   *   - masterStatusGuard (lazy, force=false)
   *   - MasterPendingView (polling / manual recheck, force=true)
   *   - MasterDashboardView (on mount, force=false)
   */
  async function fetchMyProfile(force = false): Promise<void> {
    if (!force && profileLoaded.value) return
    profileLoading.value = true
    profileError.value = null
    try {
      profile.value = await getMyMasterProfile()
      profileLoaded.value = true
      profileMissing.value = false
    } catch (e) {
      profileError.value = extractApiError(e, 'Не удалось загрузить профиль мастера')
      profileMissing.value =
        e instanceof ApiResponseError && e.code === 'master_profile_not_found'
    } finally {
      profileLoading.value = false
    }
  }

  // =========================================================================
  // Practices (paginated) -- T22-3/T22-5 (ПРОМТ №561): TWO independent
  // cursors, not one. "Предстоящие" and "Прошедшие" are different questions
  // to the server (nearest-first vs most-recent-first over disjoint status
  // sets), so one shared futures-first cursor could never answer both --
  // page 1 of a single cursor was always the FURTHEST-future rows, which is
  // exactly what made a far-future occurrence read as "nearest" and buried
  // every completed practice behind the whole future backlog. Each cursor
  // fetches independently and lazily: a screen that only needs one bucket
  // (AnalyticsView: past only) never fetches the other.
  // =========================================================================

  const paginationUpcoming = usePagination<PracticeResponse>((limit, offset) =>
    getMyPractices('upcoming', limit, offset),
  )
  const paginationPast = usePagination<PracticeResponse>((limit, offset) =>
    getMyPractices('past', limit, offset),
  )

  // W-4: separate flag instead of items.length > 0 check.
  // Prevents re-fetching when master legitimately has zero practices.
  const upcomingLoaded = ref(false)
  const pastLoaded = ref(false)

  /** Combined view across both cursors -- for consumers that need a practice
   *  by id regardless of bucket (EditPracticeView/MasterPracticeDetailView/
   *  AttendanceView/AttendanceRosterView's cache lookups) or a mixed-status
   *  set (CreatePracticeView's "Использовать шаблон", which re-sorts by
   *  created_at itself and does not care which bucket a template came from).
   *  Order is NOT meaningful here -- callers that care about order use
   *  practicesUpcoming/practicesPast directly. */
  const practices = computed<PracticeResponse[]>(() => [
    ...paginationUpcoming.items.value,
    ...paginationPast.items.value,
  ])
  const practicesTotal = computed(
    () => paginationUpcoming.total.value + paginationPast.total.value,
  )

  /**
   * Initial load of the "Предстоящие" bucket only.
   * Skips if already loaded (navigating back to list).
   */
  async function fetchUpcomingPractices(): Promise<void> {
    if (upcomingLoaded.value) return
    await paginationUpcoming.refresh()
    upcomingLoaded.value = true
  }

  /**
   * Initial load of the "Прошедшие" bucket only. Lazy -- called when a
   * screen actually needs past practices (the practices-list "Прошедшие" tab
   * on activation; AnalyticsView's reviews tab on mount), never eagerly.
   */
  async function fetchPastPractices(): Promise<void> {
    if (pastLoaded.value) return
    await paginationPast.refresh()
    pastLoaded.value = true
  }

  /**
   * Initial load of BOTH buckets. For consumers that need the combined
   * view up front (dashboard's zero-state + nearest-practice card,
   * create-practice's template list) and previously relied on the single
   * shared cursor warming everything in one call.
   */
  async function fetchMyPractices(): Promise<void> {
    await Promise.all([fetchUpcomingPractices(), fetchPastPractices()])
  }

  /**
   * Force-reload BOTH buckets.
   * Called after create / edit / delete / cancel operations -- any of them
   * can move a practice between buckets (e.g. cancelling removes it from
   * "Предстоящие" and it never appears in "Прошедшие" either).
   */
  async function refreshMyPractices(): Promise<void> {
    await Promise.all([paginationUpcoming.refresh(), paginationPast.refresh()])
    upcomingLoaded.value = true
    pastLoaded.value = true
  }

  // =========================================================================
  // Reset (on logout -- W-1)
  // =========================================================================

  function $reset(): void {
    profile.value = null
    profileLoading.value = false
    profileError.value = null
    profileLoaded.value = false
    profileMissing.value = false
    onboardingShownThisSession.value = false
    paginationUpcoming.reset()
    paginationPast.reset()
    upcomingLoaded.value = false
    pastLoaded.value = false
    // Drop the applicant marker so a logged-out tab can't reach master-pending.
    sessionStorage.removeItem(MASTER_APPLIED_KEY)
  }

  return {
    // Profile
    profile,
    profileLoading,
    profileError,
    profileLoaded,
    profileMissing,
    onboardingShownThisSession,
    fetchMyProfile,

    // Practices -- combined view (order not meaningful; id-lookup/template use)
    practices,
    practicesTotal,
    fetchMyPractices,
    refreshMyPractices,

    // Practices -- "Предстоящие" (nearest first)
    practicesUpcoming: paginationUpcoming.items,
    practicesUpcomingTotal: paginationUpcoming.total,
    practicesUpcomingLoading: paginationUpcoming.loading,
    practicesUpcomingError: paginationUpcoming.error,
    practicesUpcomingLoadMoreError: paginationUpcoming.loadMoreError,
    practicesUpcomingHasMore: paginationUpcoming.hasMore,
    fetchUpcomingPractices,
    loadMoreUpcomingPractices: paginationUpcoming.loadMore,

    // Practices -- "Прошедшие" (most recent first)
    practicesPast: paginationPast.items,
    practicesPastTotal: paginationPast.total,
    practicesPastLoading: paginationPast.loading,
    practicesPastError: paginationPast.error,
    practicesPastLoadMoreError: paginationPast.loadMoreError,
    practicesPastHasMore: paginationPast.hasMore,
    fetchPastPractices,
    loadMorePastPractices: paginationPast.loadMore,

    // Reset
    $reset,
  }
})
