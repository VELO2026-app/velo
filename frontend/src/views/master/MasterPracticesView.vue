<!--
  VELO Frontend -- MasterPracticesView (Phase-3 Master DS)

  Master's own practice list. masterStatusGuard; rendered inside MasterShell.

  Tabs (VSegment):
    - "Предстоящие" -- draft + scheduled + live  (asc by scheduled_at)
    - "Прошедшие"   -- completed ONLY            (desc by scheduled_at)
    Cancelled practices appear in NEITHER tab — a cancelled practice did not
    happen, so it is hidden from the list (server-side data is untouched;
    operator 2026-06-25).

  Card (operator SVG 2026-06-11):
    - direction icon + title + "когда, время • N мин"
    - meta row: участники / check-ins / «Регулярная» (series)
    - upcoming: «Изменить» + «Check-ins» buttons BELOW the card
    - past: ✓/✗ attendance + rating-distribution badges INSIDE the card

  Data reality (Q4=А):
    REAL  -- participants, date/time/duration, practice icon; check-in count
             (checkin_count / max, owner-only -- E12 swap, ПРОМТ №419: was
             insights.checkins mood tally, now distinct PRE check-ins, see
             practiceCardMeta.ts) + rating distribution (insights.feedbacks,
             reused from diaryStore cache like AnalyticsView, PAST tab only).
    STUB  -- attended/no-show counts (no aggregate field) → «—»; recurrence days
             («Регулярная» shown for series, exact days TBD); «осталось N из M»
             omitted (no series-session field). All recorded in
             master-ds-zod-roadmap.md.
-->

<template>
  <div class="master-practices">
    <!-- Header -->
    <VHeader title="Практики">
      <template #action>
        <button class="master-practices__add-btn" aria-label="Создать практику" @click="goNew">
          <IconPlus :size="22" />
        </button>
      </template>
    </VHeader>

    <!-- Tabs — unified track+thumb segmented control (one solid block, two
         switches inside), the shared master idiom. Counts removed per operator. -->
    <div class="master-practices__tabs">
      <VSegmentTrack v-model="activeTab" :options="tabOptions" variant="tabs" />
    </div>

    <!-- Loading -->
    <div
      v-if="currentLoading && currentItems.length === 0"
      class="master-practices__loader"
    >
      <VLoader size="lg" />
    </div>

    <!-- Error (INITIAL load only -- a failed page-N is toasted by onLoadMore and
         must not replace the pages already on screen; mirrors the loading rung
         above and MyBookingsView.vue:28) -->
    <div
      v-else-if="currentError && currentItems.length === 0"
      class="master-practices__content"
    >
      <VEmptyState
        icon="warning"
        title="Не удалось загрузить практики"
        :description="currentError"
      >
        <VButton size="sm" variant="outline" @click="masterStore.refreshMyPractices()">
          Повторить
        </VButton>
      </VEmptyState>
    </div>

    <!-- List -->
    <div v-else class="master-practices__content">
      <!-- ===================== Upcoming ===================== -->
      <template v-if="activeTab === 'upcoming'">
        <template v-if="upcomingPractices.length > 0">
          <article
            v-for="p in upcomingPractices"
            :key="p.id"
            class="mp-card mp-card--clickable"
            role="button"
            :tabindex="0"
            @click="goDetail(p.id)"
            @keydown.enter.space.prevent="goDetail(p.id)"
          >
            <div class="mp-card__head">
              <span class="mp-card__icon"><component :is="practiceIconFor(p)" :size="46" /></span>
              <div class="mp-card__titles">
                <div class="mp-card__title">{{ p.title }}</div>
                <div class="mp-card__sub">
                  {{ whenLabel(p) }}, {{ formatTime(p.scheduled_at, p.timezone) }} •
                  {{ p.duration_minutes }} мин
                </div>
              </div>
            </div>
            <div class="mp-card__meta">
              <span class="mp-stat"><IconGroup :size="16" /> {{ participantsLabel(p) }}</span>
              <span v-if="checkinLabel(p)" class="mp-stat"
                ><IconCheckin :size="16" /> {{ checkinLabel(p) }}</span
              >
              <span v-if="recurrenceLabel(p)" class="mp-stat"
                ><IconRepeat :size="16" /> {{ recurrenceLabel(p) }}</span
              >
            </div>
            <div v-if="remainingSessionsLabel(p)" class="mp-card__meta mp-card__meta--row2">
              <span class="mp-stat"
                ><IconHourglass :size="16" /> {{ remainingSessionsLabel(p) }}</span
              >
            </div>
          </article>
        </template>
        <VEmptyState
          v-else
          icon="calendar"
          title="Нет предстоящих практик"
          description="Создайте первую практику"
        >
          <VButton size="sm" variant="outline" @click="goNew">Создать</VButton>
        </VEmptyState>
      </template>

      <!-- ===================== Past ===================== -->
      <template v-else>
        <template v-if="pastPractices.length > 0">
          <article
            v-for="p in pastPractices"
            :key="p.id"
            class="mp-card mp-card--clickable"
            role="button"
            :tabindex="0"
            @click="goDetail(p.id)"
            @keydown.enter.space.prevent="goDetail(p.id)"
          >
            <div class="mp-card__head">
              <span class="mp-card__icon"><component :is="practiceIconFor(p)" :size="46" /></span>
              <div class="mp-card__titles">
                <div class="mp-card__title">{{ p.title }}</div>
                <!-- Date • participant count (operator SVG «1 Analytics (reviews) 2»).
                     The ✓/✗ presence row is removed — attendance lives in Посещаемость
                     / the practice detail (operator PL-E1). -->
                <div class="mp-card__sub">{{ whenLabel(p) }} • {{ participantsCount(p) }}</div>
              </div>
            </div>
            <!-- Rating distribution (REAL, anonymous insights — eager-loaded). -->
            <VRatingBadges
              v-if="hasRating(p.id)"
              class="mp-card__rbadges"
              :fire="ratingPct(p.id, 'fire')"
              :good="ratingPct(p.id, 'good')"
              :confused="ratingPct(p.id, 'confused')"
            />
          </article>
        </template>
        <VEmptyState
          v-else
          icon="list"
          title="Нет прошедших практик"
          description="Здесь появятся завершённые практики"
        />
      </template>

      <!-- Load more -->
      <div v-if="currentHasMore" class="master-practices__load-more">
        <VButton variant="ghost" block :loading="currentLoading" @click="onLoadMore">
          Показать ещё
        </VButton>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import { VButton, VLoader, VEmptyState, VSegmentTrack, VRatingBadges } from '@/components/ui'
import {
  IconPlus,
  IconGroup,
  IconCheckin,
  IconRepeat,
  IconHourglass,
} from '@/components/icons'
import { useMasterStore } from '@/stores/master'
import { useDiaryStore } from '@/stores/diary'
import { useToast } from '@/composables/useToast'
import { practiceIconFor } from '@/utils/displayHelpers'
import { checkinLabel, recurrenceLabel, remainingSessionsLabel } from '@/utils/practiceCardMeta'
import { formatDateShort, formatShortDate, formatTime } from '@/utils/format'
import { practiceHasEnded } from '@/utils/practiceStatus'
import { plural } from '@/utils/plural'
import type { PracticeResponse } from '@/api/types'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const masterStore = useMasterStore()
const diaryStore = useDiaryStore()

// Reactive insights cache (shared with Analytics / PracticeReviews — often warm).
const insightsCache = diaryStore.insightsCache

// Active tab is mirrored in the URL query (?tab=past) so that returning from a
// practice detail via router.back() restores the tab the user left from
// (otherwise a fresh mount always reset to «Предстоящие»).
const activeTab = ref<'upcoming' | 'past'>(route.query.tab === 'past' ? 'past' : 'upcoming')

// T22-3/T22-5 (ПРОМТ №561): the server now owns both the filter AND the
// ordering per bucket (nearest-first for upcoming, most-recent-first for
// past) -- no client-side filter/sort left to hide the next ordering bug.
//
// A4 V5 (ПРОМТ №571): fetchUpcomingPractices() is a one-shot cache -- it
// no-ops once upcomingLoaded is true (stores/master.ts:117-121) -- but the
// backend transitions a practice scheduled/live -> completed BY WALL CLOCK
// (the autofinalize worker, practices/service.py's state machine), not on
// request. Without a local time check, a class that ended five minutes ago
// stays rendered under "Предстоящие" until something else (an edit,
// create, cancel elsewhere) happens to call refreshMyPractices(), or a hard
// reload. Mirrors MasterDashboardView's own 60s clock + practiceHasEnded
// filter (nearestPractices) exactly -- same fix, same idiom, applied to
// the full list instead of the dashboard's top-2 preview. Draft is
// deliberately EXCLUDED from this filter (unlike Dashboard's narrower
// widget): a draft's scheduled_at can be stale from the moment it was
// created and still legitimately belongs in "Предстоящие" until the
// master publishes or deletes it -- it is not something the clock auto-
// finalizes away.
const now = ref(Date.now())
let clockInterval: ReturnType<typeof setInterval> | null = null

const upcomingPractices = computed(() =>
  masterStore.practicesUpcoming.filter(
    (p) => !((p.status === 'scheduled' || p.status === 'live') && practiceHasEnded(p, now.value)),
  ),
)

// -- Past: completed ONLY, most-recent first -- server-side now (T22-5). --
const pastPractices = computed(() => masterStore.practicesPast)

// Tab-aware state: which bucket's loading/error/hasMore the current tab shows.
const currentItems = computed(() =>
  activeTab.value === 'past' ? pastPractices.value : upcomingPractices.value,
)
const currentLoading = computed(() =>
  activeTab.value === 'past' ? masterStore.practicesPastLoading : masterStore.practicesUpcomingLoading,
)
const currentError = computed(() =>
  activeTab.value === 'past' ? masterStore.practicesPastError : masterStore.practicesUpcomingError,
)
const currentHasMore = computed(() =>
  activeTab.value === 'past' ? masterStore.practicesPastHasMore : masterStore.practicesUpcomingHasMore,
)

const tabOptions = [
  { value: 'upcoming' as const, label: 'Предстоящие' },
  { value: 'past' as const, label: 'Прошедшие' },
]

// -- Card subtitle helpers --------------------------------------------------

/** Relative "Сегодня"/"Завтра", else compact "25 янв." (timezone-safe). */
function whenLabel(p: PracticeResponse): string {
  const rel = formatDateShort(p.scheduled_at, p.timezone)
  return rel === 'Сегодня' || rel === 'Завтра' ? rel : formatShortDate(p.scheduled_at, p.timezone)
}

function participantsLabel(p: PracticeResponse): string {
  return p.max_participants != null
    ? `${p.current_participants}/${p.max_participants}`
    : `${p.current_participants}`
}

/** «N участников» with Russian plural agreement — past-card sub-line (PL-E1). */
function participantsCount(p: PracticeResponse): string {
  const n = p.current_participants
  return `${n} ${plural(n, 'участник', 'участника', 'участников')}`
}

// -- Insights-derived (REAL) ------------------------------------------------

function totalFeedbacks(id: string): number {
  const i = insightsCache.get(id)
  return i ? i.feedbacks.fire + i.feedbacks.good + i.feedbacks.confused : 0
}

// checkinLabel / recurrenceLabel / remainingSessionsLabel moved to
// utils/practiceCardMeta (shared with the master dashboard card — DB-2).

function hasRating(id: string): boolean {
  return insightsCache.has(id) && totalFeedbacks(id) > 0
}

function ratingPct(id: string, key: 'fire' | 'good' | 'confused'): number {
  const i = insightsCache.get(id)
  if (!i) return 0
  const total = totalFeedbacks(id)
  return total > 0 ? Math.round((i.feedbacks[key] / total) * 100) : 0
}

/** Eager-load insights for the visible tab (idempotent: cached ids are skipped).
 *  E12 swap (ПРОМТ №419): the "Предстоящие" tab's check-in badge now reads
 *  checkin_count straight off the practice, not insights -- so insights are
 *  only fetched for "Прошедшие" (rating badges). Upcoming skips the round-trip
 *  entirely. */
function loadTabInsights(): Promise<void[]> {
  if (activeTab.value !== 'past') return Promise.resolve([])
  return Promise.all(pastPractices.value.map((p) => diaryStore.loadInsights(p.id)))
}

/** Eager-load insights for the visible tab. Bounded to the currently-loaded page;
 *  idempotent. */
async function loadTabData(): Promise<void> {
  await loadTabInsights()
}

// -- Navigation -------------------------------------------------------------

function goNew(): void {
  router.push({ name: 'master-practice-new' })
}
function goDetail(id: string): void {
  router.push({ name: 'master-practice-detail', params: { id } })
}

/** Lazily fetch the bucket a tab needs -- each tab paginates independently
 *  and fetches on activation (T22-3/T22-5): "Прошедшие" is never fetched
 *  until the master actually switches to it. No-op if already loaded. */
async function ensureBucketLoaded(tab: 'upcoming' | 'past'): Promise<void> {
  if (tab === 'past') await masterStore.fetchPastPractices()
  else await masterStore.fetchUpcomingPractices()
}

async function onLoadMore(): Promise<void> {
  if (activeTab.value === 'past') {
    await masterStore.loadMorePastPractices()
    // A failed page-N keeps the list (usePagination routes it away from
    // `error`) but would be SILENT without this. Toast it, as the six admin
    // lists do. No manual clearing: the composable resets loadMoreError on
    // the next attempt.
    if (masterStore.practicesPastLoadMoreError) {
      toast.error(masterStore.practicesPastLoadMoreError)
    }
  } else {
    await masterStore.loadMoreUpcomingPractices()
    if (masterStore.practicesUpcomingLoadMoreError) {
      toast.error(masterStore.practicesUpcomingLoadMoreError)
    }
  }
  await loadTabData()
}

watch(activeTab, async (tab) => {
  // Persist the tab in the URL so a back-navigation from detail restores it.
  if (route.query.tab !== tab) {
    router.replace({ query: { ...route.query, tab } })
  }
  await ensureBucketLoaded(tab)
  await loadTabData()
})

onMounted(async () => {
  clockInterval = setInterval(() => {
    now.value = Date.now()
  }, 60_000)
  await ensureBucketLoaded(activeTab.value)
  await loadTabData()
})

onUnmounted(() => {
  if (clockInterval) clearInterval(clockInterval)
})
</script>

<style scoped>
.master-practices {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

/* -- "+" add button (filled primary circle + white plus, operator SVG) -- */
.master-practices__add-btn {
  width: var(--velo-size-46);
  height: var(--velo-size-46);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--velo-white);
  background: var(--velo-primary);
  border: 1px solid var(--velo-glass-border);
  border-radius: var(--radius-full);
  box-shadow: var(--velo-shadow-glow);
  transition: background-color var(--transition-fast);
}

.master-practices__add-btn:hover {
  background: var(--velo-primary-dark);
}

/* -- Tabs (F-5 rail sync: ride MobileLayout's 24px rail, no local h-padding) -- */
.master-practices__tabs {
  /* Top padding dropped so the tab block sits closer to the «+»/title header
     (operator 2026-06-25). The remaining header→tabs gap is MobileLayout's
     global island clearance (shared, untouched). Bottom keeps the gap to the
     first card. */
  padding: 0 0 var(--space-3);
  background: transparent;
}

/* -- Content -- */
.master-practices__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-12) 0;
}

.master-practices__content {
  flex: 1;
  padding: var(--space-3) 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.master-practices__load-more {
  padding-top: var(--space-2);
}

/* ===== Practice card ===== */
.mp-card {
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--velo-card-padding-y) var(--velo-card-padding-x);
  display: flex;
  flex-direction: column;
}

/* Past cards are tappable → practice detail (Р1=А). */
.mp-card--clickable {
  cursor: pointer;
  transition: transform var(--transition-fast);
}

.mp-card--clickable:active {
  transform: scale(0.99);
}

.mp-card__head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.mp-card__icon {
  flex-shrink: 0;
  color: var(--velo-text-primary);
  display: flex;
}

.mp-card__title {
  font-size: var(--text-lg);
  color: var(--velo-text-primary);
  letter-spacing: 0.3px;
}

.mp-card__sub {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  margin-top: var(--velo-gap-3);
}

.mp-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  margin-top: 13px;
  font-size: var(--text-xs);
  color: var(--velo-text-primary);
}

/* Second meta row («Осталось N из M занятий») sits tighter under the first and
   is centered in the card (operator 2026-06-25, Figma ref). */
.mp-card__meta--row2 {
  margin-top: 7px;
  justify-content: center;
}

.mp-stat {
  display: inline-flex;
  align-items: center;
  gap: var(--velo-gap-6);
}

.mp-stat :deep(svg) {
  opacity: 0.8;
}

/* Rating-distribution badges (sand/pink/blue-100 tints; confused = blue-400
   per operator SVG 2026-06-11). */
/* Margin only — the trio itself is the shared VRatingBadges component. */
.mp-card__rbadges {
  margin-top: 13px;
}
</style>
