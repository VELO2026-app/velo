<!--
  VELO Frontend -- UserDashboardView (Phase F3.1, updated DS-dashboard)

  Main user screen. Shows:
    - Check-in alert banner (amber) -- confirmed booking in check-in window
    - "Ближайшие практики" -- live-aware list: the active session (if any) pinned
                              first, then up to 2 soonest upcoming (max 3), each
                              with Zoom + Check-in
    - "Ваш прогресс"       -- attended count + hours, from GET /bookings/me/stats
    - "AI-саммари"         -- placeholder card, all-time attended count + hours
                              + mood trend indicator; the whole card is tappable.
                              (W8 fix, PROMPT №387: this used to carry a week/month
                              toggle that only relabeled the sentence -- the
                              number never changed, since GET /bookings/me/stats
                              has no period param and adding one is real backend
                              work, not this fix's scope. Removed the toggle
                              rather than ship a control that lies about what
                              it's showing -- BUILD-FULL-DESIGN honesty.)

  Check-in window:  scheduled_at - CHECKIN_WINDOW_H  .. scheduled_at
  Feedback window:  scheduled_at + duration_minutes   .. + FEEDBACK_WINDOW_H

  Progress stats come from GET /api/v1/bookings/me/stats (UserStatsResponse:
  practices_attended + hours_attended), a server-side aggregate over ALL attended
  bookings -- so the numbers are complete, not limited to the first bookings page.

  Screen 16 (AI-summary): tapping the summary card navigates to 'user-ai-summary'
  (currently a placeholder screen -- the user AI backend does not exist yet).
  The mood trend indicator stays static (illustration, not a control).

  [FE-13] The dashboard carries ONLY the check-in reminder now. The feedback
  and no-show reflection banners were removed here (not their routes/screens):
  per the task, all other events move to the notification center (FE-12, not
  built yet). Until it exists, feedback stays reachable from PracticeDetailView's
  own in-window button (F9.1), and reflection is temporarily unreachable from
  the UI -- a deliberate, owner-accepted gap, not an oversight.
-->

<template>
  <div class="dashboard">
    <!-- Greeting removed (static, low-value, took space — operator 2026-06-04). -->

    <!-- Check-in alert banner (shared Banner) -->
    <Banner
      v-if="checkinAlert"
      variant="warning"
      title="Пора на check-in!"
      :body="`${checkinAlert.practice.title}${checkinAlertTime}`"
      :clickable="true"
      class="dashboard__alert"
      @click="goToCheckin(checkinAlert.practice_id)"
    >
      <template #icon><IconClock :size="28" /></template>
    </Banner>

    <!-- ================================================================
         NEAREST PRACTICE
         ================================================================ -->
    <section class="dashboard__section">
      <h3 class="dashboard__section-title">Ближайшие практики</h3>

      <!-- Loading -->
      <div
        v-if="bookingsStore.upcomingLoading && nearestBookings.length === 0"
        class="dashboard__loader"
      >
        <VLoader />
      </div>

      <!-- Empty -->
      <div v-else-if="nearestBookings.length === 0" class="dashboard__empty">
        <p class="dashboard__empty-text">Нет предстоящих практик</p>
        <VButton size="sm" variant="outline" @click="router.push({ name: 'user-calendar' })">
          Найти практику
        </VButton>
      </div>

      <!-- Live-aware list (TASK-2): the active session (if any) is pinned first,
           then up to 2 soonest upcoming (max 3). Each card keeps its full markup
           + per-card handlers (Zoom / check-in / live badge). -->
      <template v-else>
        <div v-for="b in nearestBookings" :key="b.id" class="dashboard__nearest-item">
          <PracticeListCard
            :practice="b.practice"
            :title="practiceTitle(b)"
            :when="practiceDate(b)"
            :when-time="practiceTime(b)"
            :duration="practiceDuration(b)"
            @click="openBooking(b)"
          >
            <template #badge>
              <VBadge v-if="isLive(b)" variant="success">
                <span class="dashboard__live-dot" /> В эфире
              </VBadge>
              <VBadge v-else-if="isFree(b)" variant="blue"> Бесплатно </VBadge>
              <VBadge v-else variant="blue"> <IconCheck :size="12" /> Оплачено </VBadge>
            </template>
          </PracticeListCard>

          <!-- Action buttons (outside the card, per Figma) -->
          <div class="dashboard__practice-actions">
            <!-- R1 (№263): honest state — a null link disables the button
                 rather than reading as broken. T-35: there is nothing left to
                 choose between here -- the manual fallback is gone, so this is
                 the person's OWN registrant link or an honest wait. -->
            <VButton
              variant="secondary"
              block
              :disabled="zoomLinkFor(b).kind === 'pending' || zoomLinkFor(b).kind === 'failed'"
              @click="onZoomClick(b)"
            >
              Zoom
            </VButton>
            <VButton
              variant="primary"
              block
              :disabled="b.has_checkin"
              @click="goToCheckin(b.practice_id)"
            >
              Check-in
            </VButton>
          </div>
          <!-- A4 V2 (PROMPT №572): honest permanent-failure state, distinct
               from "still preparing" -- see PracticeLiveView's identical
               badge for the full rationale. -->
          <VBadge
            v-if="zoomLinkFor(b).kind === 'failed'"
            variant="error"
            class="dashboard__zoom-note"
          >
            Не удалось создать встречу — обратитесь к мастеру
          </VBadge>
        </div>
      </template>
    </section>

    <!-- ================================================================
         PROGRESS
         ================================================================ -->
    <section class="dashboard__section">
      <h3 class="dashboard__section-title">Ваш прогресс</h3>
      <div class="dashboard__stats-grid">
        <VStatCard class="dashboard__stat" :value="attendedCount" label="Практик пройдено" />
        <VStatCard class="dashboard__stat" :value="practiceHours" label="Часов в практике" />
      </div>
    </section>

    <!-- ================================================================
         AI SUMMARY (placeholder)
         ================================================================ -->
    <section class="dashboard__section">
      <h3 class="dashboard__section-title">AI-саммари</h3>

      <!-- Whole card is the tap target → AI-summary screen (16). VCard `clickable`
           supplies role="button" + tabindex + Enter/Space + cursor (DS a11y).
           No period toggle (W8 fix, PROMPT №387): the underlying number is an
           all-time aggregate (GET /bookings/me/stats has no period param), so
           a week/month switch that only reworded the sentence without changing
           the number was actively misleading, not just decorative. -->
      <VCard clickable @click="router.push({ name: 'user-ai-summary' })">
        <p class="dashboard__ai-text">
          За всё время вы посетили <strong>{{ attendedCount }}</strong> практик и провели в практике
          <strong>{{ practiceHours }}</strong> часов.
        </p>

        <!-- Mood trend indicator: from -> to. Non-clickable (static). -->
        <div v-if="attendedCount > 0" class="dashboard__ai-mood">
          <span class="dashboard__ai-mood-label">с</span>
          <IconMoodMid :size="40" />
          <IconArrowRight :size="16" class="dashboard__ai-mood-arrow" />
          <IconMoodHigh :size="40" />
          <span class="dashboard__ai-mood-label">до</span>
        </div>
      </VCard>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useBookingsStore } from '@/stores/bookings'
import { getMyStats } from '@/api/bookings'
import { useToast } from '@/composables/useToast'
import { VLoader, VButton, VBadge, VStatCard, VCard } from '@/components/ui'
import {
  IconClock,
  IconCheck,
  IconArrowRight,
  IconMoodMid,
  IconMoodHigh,
} from '@/components/icons'
import PracticeListCard from '@/components/shared/PracticeListCard.vue'
import Banner from '@/components/shared/Banner.vue'
import { formatDateShort, formatTime, formatDuration } from '@/utils/format'
import { platform } from '@/platform'
import { isInCheckinWindow } from '@/composables/usePracticeWindows'
import { isLiveNow, isFree } from '@/utils/bookingStatus'
import { selectNearestBookings } from '@/utils/nearestBookings'
import { useViewerTimezone } from '@/composables/useViewerTimezone'
import { CHECKIN_WINDOW_H } from '@/utils/constants'
import { resolveZoomLink, type ZoomLinkResolution } from '@/utils/zoomLink'
import type { BookingWithPracticeResponse, UserStatsResponse } from '@/api/types'

// CHECKIN_WINDOW_H is imported but only used implicitly via isInCheckinWindow.
// Keeping import to document the dependency (mirrors usePracticeWindows).
void CHECKIN_WINDOW_H

const router = useRouter()

const bookingsStore = useBookingsStore()
const toast = useToast()

// -- Reactive clock: updated every 60s so alert computeds re-evaluate --
const now = ref(Date.now())
let clockInterval: ReturnType<typeof setInterval> | null = null

// -- Profile stats (attended count + hours): server-side aggregate over ALL
// attended bookings -- not derived from the paginated bookings page (W-6). --
const stats = ref<UserStatsResponse | null>(null)

// =========================================================================
// Alert banners
// =========================================================================

/** First confirmed booking currently in the check-in window, not yet done. */
const checkinAlert = computed((): BookingWithPracticeResponse | null => {
  return (
    bookingsStore.bookings.find((b) => {
      if (b.status !== 'confirmed') return false
      // Hide once the user has already checked in (no re-submit via banner).
      if (b.has_checkin) return false
      // Hide if the user persistently skipped this booking's check-in (B2).
      if (b.checkin_skipped) return false
      // Hide if the user skipped this practice's check-in this session.
      if (bookingsStore.dismissedCheckins.includes(b.practice_id)) return false
      const scheduledMs = new Date(b.practice.scheduled_at).getTime()
      return isInCheckinWindow(scheduledMs, now.value)
    }) ?? null
  )
})

/** Human-readable time hint for check-in banner subtitle. */
const checkinAlertTime = computed((): string => {
  if (!checkinAlert.value) return ''
  const diffMs = new Date(checkinAlert.value.practice.scheduled_at).getTime() - now.value
  const diffMinutes = Math.round(diffMs / 60_000)
  if (diffMinutes <= 0) return ' • Сейчас'
  if (diffMinutes < 60) return ` • через ${diffMinutes} мин`
  const hours = Math.floor(diffMinutes / 60)
  return ` • через ${hours} ч`
})

// [FE-13] feedbackAlert/reflectionAlert lived here. Removed: the dashboard
// keeps ONLY the check-in reminder -- feedback and no-show reflection events
// belong to the notification center (FE-12). Until it exists, feedback is
// reachable from PracticeDetailView's own button (F9.1); reflection from
// nowhere (its route/screen stay for the notification center to link to).
// The store's dismissedCheckins/dismissedReflections sets are untouched --
// CheckinView/ReflectionView still use them.

// =========================================================================
// Nearest practice
// =========================================================================

/**
 * Nearest bookings the user can still act on (live-aware list, TASK-2).
 *
 * Candidate rule (unchanged): a booking is a candidate while its practice has
 * NOT ended yet -- still confirmed, practice not completed/cancelled, and now is
 * before its END (start + duration_minutes). This keeps the card visible to a
 * booked user during the live session (Zoom / Check-in) and hides it the moment
 * the practice is over. (This is "my session" -- distinct from the bookable
 * calendar feed, which hides a practice once it STARTS.)
 *
 * Selection (operator Г): pin the active session (the single latest-started
 * in-progress booking) FIRST -- that's where Zoom / Check-in matter -- then the
 * 2 soonest upcoming, so a genuinely-imminent booking is never hidden behind a
 * live one. Max 3 cards; nothing live -> just the 2 soonest upcoming. The pure
 * selection lives in utils/nearestBookings (unit-tested); reacts to `now` so it
 * re-ranks on the 60s clock tick.
 */
const nearestBookings = computed((): BookingWithPracticeResponse[] =>
  selectNearestBookings(bookingsStore.upcoming, now.value),
)

/**
 * True when a card's practice is happening right now — decided by CLIENT TIME
 * (start ≤ now < end) via the shared isLiveNow, NOT by the master's manual
 * status='live' flip. Keeps the «В эфире» badge in sync with «Мои бронирования»
 * and makes it appear/disappear exactly on schedule, no backend/cron dependency.
 *
 * Per-card (TASK-2): «Бесплатно»/«Оплачено» use the shared isFree() directly in
 * the template, and the Check-in button disables on the booking's own
 * has_checkin (one check-in per booking) -- mirrors the banner.
 */
function isLive(b: BookingWithPracticeResponse): boolean {
  return isLiveNow(b, now.value)
}

/**
 * Practice title without a trailing " (эфир)" marker. Some seeded / manually
 * created practices include "(эфир)" in their title (see seed.py); since the
 * card already shows a "В эфире" badge for live practices, the suffix in the
 * title is redundant — strip it on the client.
 */
function practiceTitle(b: BookingWithPracticeResponse): string {
  return (b.practice.title ?? '').replace(/\s*\(эфир\)\s*$/, '')
}

/**
 * Zoom button — the booking's own registrant link, or an honest disabled
 * state. No per-click round trip: the link already arrives with the booking
 * from GET /bookings/me(/upcoming).
 *
 * T-35: this list does NOT call the resolve endpoint. It does not need to --
 * every row here belongs to a live booking of this very user, so the only
 * answer the server could give is the personal link this payload already
 * carries. The resolve endpoint exists for the single-practice screen, where
 * the caller may hold no booking at all.
 */
function zoomLinkFor(b: BookingWithPracticeResponse): ZoomLinkResolution {
  return resolveZoomLink(
    b.zoom_registrant_join_url,
    b.practice.zoom_meeting_status,
  )
}

function onZoomClick(b: BookingWithPracticeResponse): void {
  const resolved = zoomLinkFor(b)
  if (resolved.url) {
    platform.openLink(resolved.url)
  } else {
    // Backstop only — the button is disabled in this state (R1).
    toast.info('Ссылка ещё готовится')
  }
}

/**
 * Open a booking's practice. Routing uses the BACKEND status='live' (an actually
 * running session the master started → Practice-Live / Zoom entry); otherwise
 * the practice detail. (The «В эфире» BADGE is client-time, so it can show while
 * routing still points to detail until the master starts the live session.)
 */
function openBooking(b: BookingWithPracticeResponse): void {
  if (b.practice.status === 'live') {
    router.push({
      name: 'practice-live',
      params: { practiceId: b.practice_id },
    })
  } else {
    router.push({
      name: 'practice-detail',
      params: { id: b.practice_id },
    })
  }
}

/**
 * "Завтра, 07:00" / "5 янв, 10:00"
 * F5: rendered in the VIEWER'S own profile timezone (the profile decides),
 * not the practice's timezone. format helpers apply their own neutral
 * default if the profile timezone is somehow absent.
 */
const viewerTz = useViewerTimezone()

// Dashboard "Ближайшая практика": show BOTH the day (relative «Сегодня»/«Завтра»
// or the date «10 июня») AND the time, stacked as two lines in the card — so the
// time is never lost on a future-day card (operator 2026-06-09).
function practiceDate(b: BookingWithPracticeResponse): string {
  return formatDateShort(b.practice.scheduled_at, viewerTz.value)
}
function practiceTime(b: BookingWithPracticeResponse): string {
  return formatTime(b.practice.scheduled_at, viewerTz.value)
}
function practiceDuration(b: BookingWithPracticeResponse): string {
  return formatDuration(b.practice.duration_minutes)
}

// =========================================================================
// Progress stats
// =========================================================================

const attendedCount = computed((): number => stats.value?.practices_attended ?? 0)

/**
 * Total hours in practice.
 * hours_attended is a server-side float already rounded to one decimal.
 * Formatted as integer when whole (12), one decimal otherwise (9,5).
 */
const practiceHours = computed((): string => {
  const hours = stats.value?.hours_attended ?? 0
  return hours % 1 === 0 ? String(hours) : hours.toFixed(1).replace('.', ',')
})

/** Load the server-side attended-practice stats (W-6: full, not page-derived). */
async function loadStats(): Promise<void> {
  try {
    stats.value = await getMyStats()
  } catch {
    // Leave stats null -> the cards show 0; the rest of the dashboard still works.
  }
}

// =========================================================================
// Actions
// =========================================================================

function goToCheckin(practiceId: string): void {
  router.push({ name: 'user-checkin', params: { practiceId } })
}

// [FE-13] goToFeedback/goToReflection removed with their banners (FE-12
// owns those navigations now); the check-in banner's handler stays.

// =========================================================================
// Lifecycle
// =========================================================================

onMounted(() => {
  bookingsStore.fetchMyBookings()
  // W15 fix (PROMPT №409): fetchUpcoming used to swallow its error entirely
  // (an empty result looked identical to "genuinely nothing upcoming") --
  // surface it via toast instead of leaving the widget silently blank.
  void bookingsStore.fetchUpcoming().then(() => {
    if (bookingsStore.upcomingError) toast.error(bookingsStore.upcomingError)
  })
  void loadStats()
  clockInterval = setInterval(() => {
    now.value = Date.now()
  }, 60_000)
})

onUnmounted(() => {
  if (clockInterval) clearInterval(clockInterval)
})
</script>

<style scoped>
/* ===== Alert banner (shared Banner) — only spacing here ===== */
.dashboard__alert {
  margin-bottom: var(--space-4);
}

/* ===== Sections ===== */
.dashboard__section {
  margin-bottom: var(--space-5);
}

.dashboard__section-title {
  font-family: var(--font-body);
  font-size: var(--text-base);
  /* Figma 2266:452 — все секционные заголовки 'Marmelad:Regular' (400),
   * не bold. Было 700 — баг-фикс. */
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: 0 0 var(--space-4);
}

/* ===== Nearest practice card =====
 * Карточка ближайшей практики — shared PracticeListCard (см.
 * components/shared/PracticeListCard.vue). Все card-стили перенесены туда,
 * здесь остаётся только spacing вокруг actions row под карточкой. */

/* Live pulse dot inside the «В эфире» badge (matches BookingCard's live dot). */
.dashboard__live-dot {
  width: 7px;
  height: 7px;
  border-radius: var(--radius-full);
  background: var(--velo-teal-600);
  flex-shrink: 0;
}

/* Live-aware list (TASK-2): separate each nearest card (+ its actions) from the
   next. Card→actions spacing stays on .dashboard__practice-actions margin-top. */
.dashboard__nearest-item:not(:last-child) {
  margin-bottom: var(--space-4);
}

.dashboard__practice-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  /* Figma: 15 — близко к --space-3 (14), но точно 15 для соответствия */
  gap: var(--velo-gap-15);
  margin-top: 15px;
}

.dashboard__zoom-note {
  display: block;
  width: fit-content;
  margin: var(--space-2) auto 0;
  text-align: center;
}

/* Zoom / Check-in buttons use a larger 20px label (Figma 2266:527, 2266:530)
   without changing the base VButton size variants. */
.dashboard__practice-actions :deep(.v-btn) {
  font-size: var(--text-lg);
}

/* ===== Loader / empty ===== */
.dashboard__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-8) 0;
}

.dashboard__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-5) 0;
  text-align: center;
}

.dashboard__empty-text {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  margin: 0;
}

/* ===== Progress stats =====
 * Figma 2266:452 — 2 карточки 160×104, gap 16 (--space-4),
 * контент flex-центрирован по обеим осям, gap value->label 9. */
.dashboard__stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-4);
}

/* Fixed card height (Figma 2266:452 — 160×104); the rest of the look comes
   from the shared VStatCard component. */
.dashboard__stat {
  height: 104px;
}

/* ===== AI summary ===== */
.dashboard__ai-text {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
  line-height: 1.6;
  margin: 0;
}

/* Mood trend indicator (static, non-clickable) */
.dashboard__ai-mood {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  margin-top: var(--space-4);
}

.dashboard__ai-mood-label {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
}

.dashboard__ai-mood-arrow {
  color: var(--velo-text-muted);
}
</style>
