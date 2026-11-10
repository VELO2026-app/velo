<!--
  VELO Frontend -- MasterPracticeDetailView (Phase-3 Master DS)

  Master's practice detail at /master/practices/:id/detail (masterStatusGuard;
  rendered inside MasterShell, no tab bar). Reached by tapping a practice card in
  MasterPracticesView (both tabs). R1=A: ONE route, status-branched.

    - PAST branch (completed / cancelled): read-only review — hero + attendance
      stats + participant reviews + Check-ins / Attendance CTAs
      (i18n:masterScreens.masterPracticeDetail.sections.attendance).
    - UPCOMING branch (draft / scheduled / live) = WI-B hub: PracticeHeroCard +
      enrolled/capacity stat cards (i18n:masterScreens.masterPracticeDetail.stats.enrolled /
      .stats.capacity; the price card was removed, operator 2026-06-18) +
      the booked roster (i18n:masterScreens.masterPracticeDetail.bookedCount,
      read-only rows) + description/contraindications accordions + Check-ins,
      with a "…" menu (edit i18n:ui.edit / cancel|delete). Replaces the former redirect
      to the edit screen. EditPracticeView is untouched (reached via "…" → edit).
      NB: there is deliberately NO start-practice button. Going live is
      AUTOMATIC (backend lifecycle worker flips scheduled -> live at scheduled_at,
      and -> completed at scheduled_at + duration). PATCH status='live' is rejected
      by the backend (422), so never wire such a button here.

  Decisions (operator, WI-B, all G=A):
    FORK1 — REMOVED (PROMPT post-№280): the per-participant cancel-booking X was a
            stub (no master-removes-participant endpoint — cancelBooking is self-only)
            so the operator asked to drop it entirely until the backend exists. The
            roster rows are now read-only. Re-add the X when the remove-participant
            endpoint ships (E11, master-ds-zod-roadmap). FORK2 — the recurrence-days
            hero line is HIDDEN (no recurrence model). FORK3 — NO publish CTA
            (i18n:masterScreens.editPractice.actions.publish) on the hub
            (draft→scheduled stays in EditPracticeView). FORK4 — the hub hero
            reuses the shared PracticeHeroCard.

  Data reality:
    REAL: header (getPractice) · enrolled/capacity stats + roster (getAttendance) ·
          cancel (cancelPractice) · delete draft (deletePractice). PAST rating
          badges + stats as before (getAttendance + anonymous insights).
          Status transitions scheduled -> live -> completed are NOT driven from
          here -- the backend lifecycle worker does them by the clock, so the PAST
          branch starts rendering on its own once the practice's duration elapses.
    STUB → Zod: remove-one-participant (no endpoint) → the X was REMOVED (not faked).
-->

<template>
  <div class="practice-detail">
    <VHeader :title="headerTitle" show-back @back="router.back()">
      <template v-if="isUpcoming" #action>
        <VMenu :aria-label="t('masterScreens.masterPracticeDetail.menuAria')">
          <template #default="{ close }">
            <!-- Pencil → edit, trash → delete/cancel (Q1=A,
                 openDestructive is contextual: a draft deletes, a scheduled
                 practice cancels, both with confirmation). -->
            <VMenuItem
              :icon="IconPen"
              :ariaLabel="t('ui.edit')"
              @click="
                () => {
                  goEdit()
                  close()
                }
              "
            />
            <VMenuItem
              :icon="IconTrash"
              danger
              :ariaLabel="destructiveLabel"
              @click="
                () => {
                  openDestructive()
                  close()
                }
              "
            />
          </template>
        </VMenu>
      </template>
    </VHeader>

    <!-- Loading -->
    <div v-if="loading" class="practice-detail__loader">
      <VLoader size="lg" />
    </div>

    <!-- Error -->
    <div v-else-if="error" class="practice-detail__content">
      <VEmptyState icon="warning" :title="t('practice.loadFailed')" :description="error">
        <VButton size="sm" variant="outline" @click="load">{{ t('common.retry') }}</VButton>
      </VEmptyState>
    </div>

    <template v-else-if="practice">
      <!-- ===================== UPCOMING hub (WI-B) ===================== -->
      <div v-if="isUpcoming" class="practice-detail__content">
        <!-- FE-24 (GT P5): the school audience stopped matching this master
             (they left or were removed from the practice's school, the school
             froze, or schools are switched off). Nobody but the master and the
             already-booked can see the practice; existing bookings stay valid.
             The school's name still arrives filled -- on purpose, so the master
             knows WHAT went dark. BE-74: the banner offers no action. A flagged
             practice always belongs to a school (the flag is set only for
             'schools', and the CHECK forbids that audience without a
             school), and a school practice's audience and school are read-only
             on the edit screen -- so there is nothing there to change. -->
        <div v-if="practice.audience_unavailable" class="pd-audience-warn">
          <span class="pd-audience-warn__text">
            {{ t('masterScreens.masterPracticeDetail.audienceUnavailable') }}
          </span>
        </div>

        <!-- Hero (shared PracticeHeroCard — FORK4). Recurrence-days line is
             intentionally NOT shown (FORK2: no recurrence model). -->
        <PracticeHeroCard
          :title="practice.title"
          :date="whenLabel"
          :duration="durationLabel"
          :recurrence="recurrenceLabel"
          :direction="practice.direction"
          :difficulty-dots="difficultyDots"
          :difficulty-label="difficultyLabel"
        />

        <!-- T-35: THE link for this practice -- ours, not Zoom's. It used to
             copy the raw shared Zoom URL (zoom_shared_join_url), which is
             precisely what put a guest link into channels where booked
             students also sit: they clicked it, joined unmatchable, and were
             recorded NO_SHOW. No raw Zoom URL leaves the API any more, so
             that mistake is not available to make.
             Shown WITHOUT waiting for a meeting to exist, unlike the old
             block: this link resolves at CLICK time, so it is already valid
             for a practice whose Zoom meeting is still being created -- and
             it keeps working after a reschedule, because it names the
             practice, never the meeting. -->
        <div v-if="publicLink" class="pd-shared-link">
          <span class="pd-shared-link__label">{{
            t('masterScreens.masterPracticeDetail.shareLinkHint')
          }}</span>
          <VButton size="sm" variant="outline" :loading="copyingShared" @click="onCopySharedLink">
            {{ t('masterScreens.masterPracticeDetail.copy') }}
          </VButton>
        </div>

        <!-- Enrolled / capacity stat cards (i18n:masterScreens.masterPracticeDetail.stats.enrolled /
             .stats.capacity; the price card was removed — operator 2026-06-18) -->
        <div class="practice-detail__stats">
          <VStatCard
            :value="enrolledStat"
            :label="t('masterScreens.masterPracticeDetail.stats.enrolled')"
          />
          <VStatCard
            :value="capacityStat"
            :label="t('masterScreens.masterPracticeDetail.stats.capacity')"
          />
        </div>

        <!-- Attendance has its own failure state: the screen stays up, the
             stat cards keep their dash placeholders and offer a retry. -->
        <VEmptyState
          v-if="attendanceError"
          icon="warning"
          :title="t('masterScreens.masterPracticeDetail.attendanceLoadFailed')"
        >
          <template #action>
            <VButton size="sm" variant="outline" @click="loadAttendance">{{
              t('common.retry')
            }}</VButton>
          </template>
        </VEmptyState>

        <!-- Booked roster (i18n:masterScreens.masterPracticeDetail.bookedCount;
             first 5 + expander — operator 2026-06-18) -->
        <section v-if="rosterItems.length > 0" class="practice-detail__section">
          <h2 class="velo-section-title">
            {{ t('masterScreens.masterPracticeDetail.bookedCount') }}
          </h2>
          <div v-for="item in visibleRoster" :key="item.booking_id" class="pd-prow">
            <span class="pd-prow__ava">
              <img
                v-if="item.user_avatar_url && !brokenAvatars.has(item.booking_id)"
                :src="item.user_avatar_url"
                alt=""
                class="pd-prow__ava-img"
                loading="lazy"
                decoding="async"
                @error="brokenAvatars.add(item.booking_id)"
              />
              <template v-else>{{ initials(item) }}</template>
            </span>
            <span class="pd-prow__name">{{ displayName(item) }}</span>
          </div>
          <VShowMore
            v-if="!rosterExpanded && hiddenRosterCount > 0"
            plus
            :label="t('masterScreens.masterPracticeDetail.moreParticipants', hiddenRosterCount)"
            @click="rosterExpanded = true"
          />
        </section>

        <!-- Description / contraindications / what to bring — separate cards
             (i18n:masterScreens.masterPracticeDetail.sections.description /
             .contraindications / .whatToBring; bold headers, big chevron —
             PROMPT №158). -->
        <section
          v-if="practice.description || practice.contraindications || practice.what_to_prepare"
          class="practice-detail__section"
        >
          <div v-if="practice.description" class="pd-acc" :class="{ 'pd-acc--open': descOpen }">
            <button
              class="pd-acc__hd"
              :aria-expanded="descOpen"
              :aria-label="descOpen ? t('ui.collapse') : t('ui.expand')"
              @click="descOpen = !descOpen"
            >
              <span class="pd-acc__title">{{
                t('masterScreens.masterPracticeDetail.sections.description')
              }}</span>
              <svg
                class="pd-acc__chev"
                viewBox="0 0 24 24"
                width="22"
                height="22"
                aria-hidden="true"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            <div v-if="descOpen" class="pd-acc__body">{{ practice.description }}</div>
          </div>

          <div
            v-if="practice.contraindications"
            class="pd-acc"
            :class="{ 'pd-acc--open': contraOpen }"
          >
            <button
              class="pd-acc__hd"
              :aria-expanded="contraOpen"
              :aria-label="contraOpen ? t('ui.collapse') : t('ui.expand')"
              @click="contraOpen = !contraOpen"
            >
              <span class="pd-acc__title">{{
                t('masterScreens.masterPracticeDetail.sections.contraindications')
              }}</span>
              <svg
                class="pd-acc__chev"
                viewBox="0 0 24 24"
                width="22"
                height="22"
                aria-hidden="true"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            <div v-if="contraOpen" class="pd-acc__body">{{ practice.contraindications }}</div>
          </div>

          <div v-if="practice.what_to_prepare" class="pd-acc" :class="{ 'pd-acc--open': prepOpen }">
            <button
              class="pd-acc__hd"
              :aria-expanded="prepOpen"
              :aria-label="prepOpen ? t('ui.collapse') : t('ui.expand')"
              @click="prepOpen = !prepOpen"
            >
              <span class="pd-acc__title">{{
                t('masterScreens.masterPracticeDetail.sections.whatToBring')
              }}</span>
              <svg
                class="pd-acc__chev"
                viewBox="0 0 24 24"
                width="22"
                height="22"
                aria-hidden="true"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            <div v-if="prepOpen" class="pd-acc__body">{{ practice.what_to_prepare }}</div>
          </div>
        </section>

        <!-- Bottom buttons removed (operator 2026-06-18): going live is
             automatic by schedule (Zod), check-in lives on the dashboard
             within 24h of the start. -->
      </div>

      <!-- ===================== PAST detail (read-only) ===================== -->
      <div v-else class="practice-detail__content practice-detail__content--past">
        <!-- Hero (shared PracticeHeroCard; titleSize base canon, icon-46;
             rating-distribution badges via the additive #extra slot) -->
        <PracticeHeroCard
          :title="practice.title"
          title-size="base"
          :date="whenLabel"
          :duration="durationLabel"
          :direction="practice.direction"
        >
          <template v-if="hasRating" #extra>
            <VRatingBadges size="lg" :pcts="ratingPcts" />
          </template>
        </PracticeHeroCard>

        <!-- Stats -->
        <div class="practice-detail__stats">
          <VStatCard
            :value="attendedValue"
            :label="t('masterScreens.masterPracticeDetail.rosterStats.attended')"
            value-tone="teal"
          />
          <VStatCard
            :value="noShowValue"
            :label="t('masterScreens.masterPracticeDetail.rosterStats.noShow')"
            value-tone="rose"
          />
        </div>

        <!-- Attendance has its own failure state: the screen stays up, the
             stat cards keep their dash placeholders and offer a retry. -->
        <VEmptyState
          v-if="attendanceError"
          icon="warning"
          :title="t('masterScreens.masterPracticeDetail.attendanceLoadFailed')"
        >
          <template #action>
            <VButton size="sm" variant="outline" @click="loadAttendance">{{
              t('common.retry')
            }}</VButton>
          </template>
        </VEmptyState>

        <!-- Participant reviews (i18n:masterScreens.masterPracticeDetail.sections.reviews;
             E1 named reviews — getPracticeReviews) -->
        <section class="practice-detail__section">
          <h2 class="velo-section-title">
            {{ t('masterScreens.masterPracticeDetail.sections.reviews') }}
          </h2>
          <div v-if="reviewsLoading && reviews.length === 0" class="practice-detail__rloader">
            <VLoader />
          </div>
          <template v-else-if="reviews.length > 0">
            <div v-for="(r, i) in visibleReviews" :key="i" class="practice-detail__review">
              <div class="practice-detail__review-top">
                <span class="practice-detail__review-ic">
                  <component :is="MOOD_SCALE_ICON[r.rating]" :size="28" />
                </span>
                <span class="practice-detail__review-name">{{ r.reviewer_name }}</span>
              </div>
              <div v-if="r.comment" class="practice-detail__review-quote">«{{ r.comment }}»</div>
            </div>
            <!-- First 10 + the show-more expander
                 (i18n:masterScreens.masterPracticeDetail.common.showMoreLower,
                 operator PROMPT №160). -->
            <VShowMore
              v-if="!reviewsExpanded && hiddenReviewsCount > 0"
              :label="t('masterScreens.masterPracticeDetail.common.showMoreLower')"
              @click="expandReviews"
            />
            <div v-else-if="reviewsExpanded && hasMoreReviews" class="practice-detail__more">
              <VButton variant="ghost" @click="loadMoreReviews">{{ t('common.showMore') }}</VButton>
            </div>
          </template>
          <VEmptyState
            v-else
            variant="note"
            :title="t('masterScreens.masterPracticeDetail.noReviewsYet')"
          />
        </section>

        <!-- CTAs -->
        <div class="practice-detail__actions">
          <VButton variant="primary" block @click="goCheckins">Check-ins</VButton>
          <VButton variant="outline" block @click="goRoster">{{
            t('masterScreens.masterPracticeDetail.sections.attendance')
          }}</VButton>
        </div>
      </div>
    </template>

    <!-- Cancel the whole practice (scheduled/live) — reuses CancelPracticeDialog. -->
    <CancelPracticeDialog
      :open="showCancel"
      :practice="practice"
      :loading="cancelling"
      @confirm="doCancel"
      @cancel="showCancel = false"
    />

    <!-- Delete a draft practice. -->
    <VConfirmDialog
      :open="showDelete"
      :message="t('masterScreens.masterPracticeDetail.draft.deleteConfirm')"
      :confirm-label="t('ui.delete')"
      :loading="deleting"
      @confirm="doDelete"
      @cancel="showDelete = false"
    />
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useDiaryStore } from '@/stores/diary'
import { useMasterStore } from '@/stores/master'
import {
  getPractice,
  getAttendance,
  deletePractice,
  cancelPractice,
  getPracticeReviews,
} from '@/api/practices'
import { extractApiError } from '@/composables/useApiError'
import {
  VStatCard,
  VButton,
  VLoader,
  VEmptyState,
  VConfirmDialog,
  VMenu,
  VMenuItem,
  VRatingBadges,
} from '@/components/ui'
import { VHeader } from '@/components/layout'
import PracticeHeroCard from '@/components/shared/PracticeHeroCard.vue'
import VShowMore from '@/components/shared/VShowMore.vue'
import CancelPracticeDialog from '@/components/shared/CancelPracticeDialog.vue'
import { IconPen } from '@/components/icons'
import { MOOD_SCALE_ICON } from '@/utils/ratingIcons'
import { zonePercents, zoneTotal, type MoodScaleKey } from '@/utils/moodScale'
// IconTrash is not re-exported from the icons barrel; import the component
// directly (same as EntryView).
import { IconTrash } from '@/components/icons'
import { DIFFICULTY_DOTS, DIFFICULTY_LABEL, recurrenceDaysLabel } from '@/utils/displayHelpers'
import { formatDateShort, formatTime } from '@/utils/format'
import { useToast } from '@/composables/useToast'
import type {
  PracticeResponse,
  AttendanceResponse,
  AttendanceItemResponse,
  PracticeDifficulty,
  ReviewItem,
} from '@/api/types'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const diaryStore = useDiaryStore()
const masterStore = useMasterStore()

const practiceId = route.params.id as string

// -- Data --
const practice = ref<PracticeResponse | null>(null)
const attendance = ref<AttendanceResponse | null>(null)
// Attendance fails independently of the practice: the roster/stat blocks show
// a retry note instead of replacing the whole screen with the load error.
const attendanceError = ref(false)
const loading = ref(false)
const error = ref<string | null>(null)

// -- Status branch --
const isPast = computed(
  (): boolean => practice.value?.status === 'completed' || practice.value?.status === 'cancelled',
)
const isUpcoming = computed((): boolean => practice.value != null && !isPast.value)
const isDraft = computed((): boolean => practice.value?.status === 'draft')
const headerTitle = computed((): string =>
  isPast.value
    ? t('masterScreens.masterPracticeDetail.pastTitle')
    : t('masterScreens.masterPracticeDetail.practiceWord'),
)
const destructiveLabel = computed((): string =>
  isDraft.value ? t('ui.delete') : t('masterScreens.masterPracticeDetail.cancelCta'),
)

// Reactive insights cache (shared with Analytics / Practices — often warm).
const insightsCache = diaryStore.insightsCache
const insights = computed(() => insightsCache.get(practiceId) ?? null)

// -- Hero meta (shared) --
const whenLabel = computed((): string => {
  if (!practice.value) return ''
  const day = formatDateShort(practice.value.scheduled_at, practice.value.timezone)
  const time = formatTime(practice.value.scheduled_at, practice.value.timezone)
  return `${day}, ${time}`
})

const durationLabel = computed((): string =>
  practice.value ? t('practice.durationMinutes', { n: practice.value.duration_minutes }) : '',
)

// -- Upcoming hero extras --
// Recurrence chip (Q2=B): mirrors MasterPracticesView — the weekday list
// (via `recurrenceDaysLabel(practice.recurrence_days)`, e.g. "Mon, Wed, Fri")
// or "Daily" (i18n:display.recurrenceDaily) for a series, "Regular"
// (i18n:masterScreens.masterPracticeDetail.regular) when the day list is
// empty; null hides the chip.
const recurrenceLabel = computed((): string | null => {
  if (practice.value?.practice_type !== 'series') return null
  return (
    recurrenceDaysLabel(practice.value.recurrence_days) ??
    t('masterScreens.masterPracticeDetail.regular')
  )
})

// T-35: OUR public link for this practice ({PUBLIC_LINK_BASE}/z/{code}),
// built server-side and returned owner-only. The hand-typed
// PracticeWithSharedLink interface that used to stand here is gone -- the
// field is native in generated.ts after the T-35 regen, exactly as that
// interface's own comment asked of the first person to touch this file.
const publicLink = computed((): string | null => practice.value?.zoom_public_link ?? null)
const copyingShared = ref(false)
async function onCopySharedLink(): Promise<void> {
  if (copyingShared.value || !publicLink.value) return
  copyingShared.value = true
  try {
    // Clipboard needs no backend -- same pattern as MasterGroupDetailView's
    // group-invite copy.
    await navigator.clipboard.writeText(publicLink.value)
    toast.success(t('common.linkCopied'))
  } catch (e) {
    toast.error(extractApiError(e, t('masterScreens.masterPracticeDetail.toast.linkCopyFailed')))
  } finally {
    copyingShared.value = false
  }
}

// Accordion open state (local per-screen cards, was VAccordion — PROMPT №158).
// All three open by default (operator PD-C1: contraindications also expanded).
const descOpen = ref(true)
const contraOpen = ref(true)
const prepOpen = ref(true)

const difficultyDots = computed((): number => {
  const d = practice.value?.difficulty
  return d ? DIFFICULTY_DOTS[d as PracticeDifficulty] : 0
})
const difficultyLabel = computed((): string => {
  const d = practice.value?.difficulty
  return d ? DIFFICULTY_LABEL[d as PracticeDifficulty] : ''
})

// -- Upcoming stat cards --
const enrolledStat = computed((): string | number =>
  attendance.value ? attendance.value.total : '—',
)
const capacityStat = computed((): string | number => {
  const cap = practice.value?.max_participants
  return cap != null ? cap : '∞'
})

// -- Roster (i18n:masterScreens.masterPracticeDetail.bookedCount): first 5,
//    the rest behind the "+ N more participants" expander
//    (i18n:masterScreens.masterPracticeDetail.moreParticipants) --
const ROSTER_PREVIEW = 5
const rosterItems = computed((): AttendanceItemResponse[] => attendance.value?.items ?? [])
const rosterExpanded = ref(false)
const visibleRoster = computed((): AttendanceItemResponse[] =>
  rosterExpanded.value ? rosterItems.value : rosterItems.value.slice(0, ROSTER_PREVIEW),
)
const hiddenRosterCount = computed((): number =>
  Math.max(0, rosterItems.value.length - ROSTER_PREVIEW),
)

function displayName(item: AttendanceItemResponse): string {
  return item.user_display_name || `#${item.user_id.slice(0, 8)}`
}
function initials(item: AttendanceItemResponse): string {
  const name = (item.user_display_name || item.user_id).trim()
  return (name.charAt(0) || '?').toUpperCase()
}

// 2026-07-14: this roster paints <img> directly instead of going through
// VAvatar, so it needs its own broken-image guard. A dead avatar host (t.me was
// pulled at the registry level, taking every Telegram userpic with it) would
// otherwise render a broken glyph while initials() sits right there, unused.
// Keyed by booking_id -- one bad avatar must not blank out the whole roster.
const brokenAvatars = ref(new Set<string>())

// -- Past: rating distribution badges (REAL, anonymous insights) --
const totalFeedbacks = computed((): number => {
  const f = insights.value?.feedbacks
  return f ? zoneTotal(f) : 0
})
const hasRating = computed((): boolean => insights.value != null && totalFeedbacks.value > 0)
// Rendered only under hasRating, so the insights are loaded there.
const ratingPcts = computed((): Record<MoodScaleKey, number> =>
  zonePercents(insights.value!.feedbacks),
)

// -- Past: stats (REAL via getAttendance; "—" until loaded) --
const attendedValue = computed((): string | number =>
  attendance.value ? attendance.value.attended : '—',
)
const noShowValue = computed((): string | number =>
  attendance.value ? attendance.value.no_show : '—',
)

// -- Past: participant reviews
//    (i18n:masterScreens.masterPracticeDetail.sections.reviews; E1 named
//    reviews — getPracticeReviews, paginated) --
const REVIEWS_PAGE = 20
const REVIEWS_PREVIEW = 10
const reviews = ref<ReviewItem[]>([])
const reviewsTotal = ref(0)
const reviewsLoading = ref(false)
const hasMoreReviews = computed((): boolean => reviews.value.length < reviewsTotal.value)

// First 10 + the show-more expander
// (i18n:masterScreens.masterPracticeDetail.common.showMoreLower,
// operator PROMPT №160).
const reviewsExpanded = ref(false)
const visibleReviews = computed((): ReviewItem[] =>
  reviewsExpanded.value ? reviews.value : reviews.value.slice(0, REVIEWS_PREVIEW),
)
const hiddenReviewsCount = computed((): number => Math.max(0, reviewsTotal.value - REVIEWS_PREVIEW))
function expandReviews(): void {
  reviewsExpanded.value = true
  if (hasMoreReviews.value) void loadMoreReviews()
}

async function loadReviews(): Promise<void> {
  reviewsLoading.value = true
  try {
    const res = await getPracticeReviews(practiceId, REVIEWS_PAGE, 0)
    reviews.value = res.items
    reviewsTotal.value = res.total
  } catch {
    // Non-fatal: the rest of the detail view stays usable; the section shows empty.
  } finally {
    reviewsLoading.value = false
  }
}

async function loadMoreReviews(): Promise<void> {
  if (reviewsLoading.value || !hasMoreReviews.value) return
  reviewsLoading.value = true
  try {
    const res = await getPracticeReviews(practiceId, REVIEWS_PAGE, reviews.value.length)
    reviews.value = [...reviews.value, ...res.items]
    reviewsTotal.value = res.total
  } catch {
    // Keep the loaded page; the show-more button (i18n:common.showMore)
    // stays for a retry.
  } finally {
    reviewsLoading.value = false
  }
}

// -- Navigation --
function goCheckins(): void {
  void router.push({ name: 'master-attendance', params: { id: practiceId } })
}
function goRoster(): void {
  void router.push({ name: 'master-attendance-roster', params: { id: practiceId } })
}
function goEdit(): void {
  void router.push({ name: 'master-practice-edit', params: { id: practiceId } })
}

// -- "…" destructive: cancel (scheduled/live) or delete (draft) --
const showCancel = ref(false)
const showDelete = ref(false)
const cancelling = ref(false)
const deleting = ref(false)

function openDestructive(): void {
  if (isDraft.value) showDelete.value = true
  else showCancel.value = true
}

async function doCancel(scope: 'this' | 'this_and_future'): Promise<void> {
  if (cancelling.value) return
  cancelling.value = true
  try {
    await cancelPractice(practiceId, scope)
    toast.success(t('masterScreens.masterPracticeDetail.toast.cancelled'))
    await masterStore.refreshMyPractices()
    router.back()
  } catch (e) {
    toast.error(extractApiError(e, t('masterScreens.masterPracticeDetail.toast.cancelFailed')))
  } finally {
    cancelling.value = false
    showCancel.value = false
  }
}

async function doDelete(): Promise<void> {
  if (deleting.value) return
  deleting.value = true
  try {
    await deletePractice(practiceId)
    toast.success(t('masterScreens.masterPracticeDetail.toast.draftDeleted'))
    await masterStore.refreshMyPractices()
    router.back()
  } catch (e) {
    toast.error(extractApiError(e, t('masterScreens.masterPracticeDetail.toast.deleteFailed')))
  } finally {
    deleting.value = false
    showDelete.value = false
  }
}

// -- Load --
// Bumps on every load()/loadAttendance() call; a superseded answer is a no-op.
let loadEpoch = 0
let attendanceEpoch = 0

/** Fetches attendance into its own state; never rejects. */
async function loadAttendance(): Promise<void> {
  const epoch = ++attendanceEpoch
  attendanceError.value = false
  try {
    const data = await getAttendance(practiceId)
    if (epoch === attendanceEpoch) attendance.value = data
  } catch {
    if (epoch === attendanceEpoch) attendanceError.value = true
  }
}

async function load(): Promise<void> {
  const epoch = ++loadEpoch
  loading.value = true
  error.value = null
  // Both branches need attendance (roster / stats): it leaves in parallel with
  // the practice read and fails on its own (attendanceError), not as a
  // screen-level error.
  const attendanceDone = loadAttendance()
  try {
    const cached = masterStore.practices.find((p) => p.id === practiceId)
    const loaded = cached ?? (await getPractice(practiceId))
    if (epoch !== loadEpoch) return
    practice.value = loaded

    // Insights (anonymous rating distribution) only feed the PAST hero badges
    // -- load them lazily there.
    if (isPast.value) await diaryStore.loadInsights(practiceId)
    await attendanceDone
    if (epoch !== loadEpoch) return

    // Named reviews only exist for finished practices; non-fatal alongside the load.
    if (isPast.value) void loadReviews()
  } catch (e) {
    if (epoch !== loadEpoch) return
    error.value = extractApiError(e, t('common.loadError'))
  } finally {
    if (epoch === loadEpoch) loading.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.practice-detail {
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

.practice-detail__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-10) 0;
}

.practice-detail__content {
  flex: 1;
  /* F-5 rail sync: ride MobileLayout's 24px rail (no local h-padding). */
  padding: var(--space-4) 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* Past detail: drop the content's top padding so the hero card sits closer to the
   floating header (operator PP-D1; the fog top-gap keeps the breathing room).
   Upcoming keeps the default spacing. */
.practice-detail__content--past {
  padding-top: 0;
}

/* ===== T24-38 (PROMPT №642): shared guest link ===== */
/* See the template block's own comment (above the markup) for the full
   liftability note -- this rule + its sibling below are part of that same
   removable unit. */
/* FE-24: the audience-unavailable warning -- the same white card plate as
   the shared-link row above, but the peach attention pair of tokens (a
   "something needs a decision" tone, not an error red). */
.pd-audience-warn {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--space-4);
}

.pd-audience-warn__text {
  font-size: var(--velo-fs-16);
  color: var(--velo-peach-700);
  line-height: 1.5;
}

.pd-shared-link {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--space-4);
}

.pd-shared-link__label {
  font-family: var(--font-body);
  font-size: var(--velo-fs-16);
  color: var(--velo-text-secondary);
  line-height: 1.4;
}

/* ===== Stats ===== */
.practice-detail__stats {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--space-3);
}

/* ===== Section ===== */
.practice-detail__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

/* Description / contraindications / what to bring — separate cards
   (bold header + big chevron, screen-local; PROMPT №158). */
.pd-acc {
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: 0 var(--space-4);
}

.pd-acc__hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: var(--space-3);
  padding: var(--space-4) 0;
  font-family: var(--font-body);
  font-size: var(--velo-fs-18);
  font-weight: 600;
  color: var(--velo-text-primary);
  text-align: left;
}

.pd-acc__chev {
  flex-shrink: 0;
  stroke: var(--velo-primary);
  stroke-width: 2;
  fill: none;
  transition: transform var(--transition-fast);
}

.pd-acc--open .pd-acc__chev {
  transform: rotate(180deg);
}

.pd-acc__body {
  padding: var(--space-3) 0 var(--space-4);
  border-top: 1px solid var(--velo-border-light);
  font-family: var(--font-body);
  font-size: var(--velo-fs-16);
  color: var(--velo-text-secondary);
  line-height: 1.5;
}

/* ===== Booked roster rows (upcoming) ===== */
.pd-prow {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--velo-gap-11) var(--space-4);
}

.pd-prow__ava {
  width: 42px;
  height: 42px;
  flex-shrink: 0;
  border-radius: var(--radius-full);
  background: var(--velo-glass-blue-60);
  color: var(--velo-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  font-family: var(--font-body);
  font-size: var(--velo-fs-16);
}

.pd-prow__ava-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.pd-prow__name {
  flex: 1;
  min-width: 0;
  font-size: var(--velo-fs-16);
  color: var(--velo-text-primary);
}

/* ===== Review card (PAST) ===== */
.practice-detail__review {
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--velo-card-padding-y) var(--velo-card-padding-x);
  display: flex;
  flex-direction: column;
  gap: var(--velo-gap-6);
}

.practice-detail__review-top {
  display: flex;
  align-items: center;
  gap: var(--velo-card-meta-row-gap);
}

/* Identifier icon (the rating the student chose) — replaces the avatar, left. */
.practice-detail__review-ic {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
}

.practice-detail__review-name {
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

.practice-detail__review-quote {
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
  line-height: 1.45;
}

.practice-detail__rloader {
  display: flex;
  justify-content: center;
  padding: var(--space-4) 0;
}

.practice-detail__more {
  display: flex;
  justify-content: center;
  padding-top: var(--space-2);
}

/* ===== CTAs ===== */
.practice-detail__actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-1);
}
</style>
