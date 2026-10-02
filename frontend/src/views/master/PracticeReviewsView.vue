<!--
  VELO Frontend -- PracticeReviewsView (Phase-3 Master DS)

  Per-practice reviews detail. Route: /master/analytics/practice/:id
  (nested under analytics so the Аналитика tab stays active; masterStatusGuard).
  Reached by tapping a practice card in AnalyticsView → «Прошедшие практики».

  Sections (operator design 2026-06-11, "Отзывы о практике"):
    - VHeader (back + title).
    - Practice header card: direction icon + title + date · participants.
    - 3 VStatCard: Check-in % / Feedback % / Отзывов (count).
    - «Распределение»: rating bars (fill = RATING_COLOR, icon = RATING_ICON_COLOR).
    - «Отзывы»: individual reviews list.

  Data reality (E1 wired, 2026-06-16):
    REAL: practice header (getPractice) + stats/distribution (getPracticeInsights,
          reused from diaryStore cache — eager-loaded by AnalyticsView).
    REAL: the «Отзывы» list — getPracticeReviews (E1 named reviews, paginated).
          `rating` arrives pre-bucketed ('fire'|'good'|'confused') from the backend.
-->

<template>
  <PracticeAnalytics
    v-if="analyticsSimulation"
    :data="analyticsData"
    :loading="analyticsSimulation && practice === null"
    :error="practiceError ? 'Практика недоступна' : null"
    @back="router.back()"
    @retry="load"
  />
  <div v-else class="practice-reviews">
    <VHeader title="Отзывы о практике" show-back @back="router.back()" />

    <!-- Practice header card (shared PracticeHeroCard; titleSize base, meta =
         date + participants — no duration, relies on the additive v-if). -->
    <PracticeHeroCard
      v-if="practice"
      :title="practice.title"
      title-size="base"
      :date="practiceDate"
      :participants="participantsLabel"
      :direction="practice.direction"
    />

    <!-- Stats -->
    <div class="practice-reviews__stats">
      <VStatCard :value="checkinPct" label="Check-in" />
      <VStatCard :value="feedbackPct" label="Feedback" />
      <VStatCard :value="feedbacksLabel" label="Отзывов" />
    </div>

    <!-- Распределение -->
    <section class="practice-reviews__section">
      <h2 class="velo-section-title">Распределение</h2>
      <VRatingDistribution
        :fire="feedbackCounts.fire"
        :good="feedbackCounts.good"
        :confused="feedbackCounts.confused"
      />
    </section>

    <!-- Отзывы (E1 named reviews) -->
    <section class="practice-reviews__section">
      <h2 class="velo-section-title">Отзывы</h2>
      <div v-if="reviewsLoading && reviews.length === 0" class="practice-reviews__rloader">
        <VLoader size="lg" />
      </div>
      <VEmptyState v-else-if="reviewsError" icon="warning" title="Не удалось загрузить отзывы">
        <VButton size="sm" variant="outline" @click="loadReviews">Повторить</VButton>
      </VEmptyState>
      <template v-else-if="reviews.length > 0">
        <VCard
          v-for="(r, i) in reviews"
          :key="i"
          clickable
          class="practice-reviews__review"
          @click="goStudent(r)"
        >
          <div class="practice-reviews__review-top">
            <span class="practice-reviews__review-ident">
              <component
                :is="RATING_ICON[r.rating]"
                :size="28"
                :style="{ color: RATING_ICON_COLOR[r.rating] }"
              />
            </span>
            <span class="practice-reviews__review-name">{{ r.reviewer_name }}</span>
          </div>
          <div v-if="r.comment" class="practice-reviews__review-quote">«{{ r.comment }}»</div>
        </VCard>
        <div v-if="hasMoreReviews" class="practice-reviews__more">
          <VButton variant="ghost" @click="loadMoreReviews">Показать ещё</VButton>
        </div>
      </template>
      <VEmptyState v-else variant="note" title="Отзывов пока нет" />
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useDiaryStore } from '@/stores/diary'
import { getPractice, getPracticeReviews } from '@/api/practices'
import { VStatCard, VCard, VButton, VLoader, VEmptyState } from '@/components/ui'
import VRatingDistribution from '@/components/shared/VRatingDistribution.vue'
import PracticeHeroCard from '@/components/shared/PracticeHeroCard.vue'
import { VHeader } from '@/components/layout'
import { RATING_ICON_COLOR } from '@/utils/displayHelpers'
import { RATING_ICON } from '@/utils/ratingIcons'
import { formatShortDate } from '@/utils/format'
import type { PracticeResponse, ReviewItem } from '@/api/types'
import PracticeAnalytics from '@/components/shared/practice-analytics/PracticeAnalytics.vue'
import type {
  PracticeAnalyticsData,
  PracticeAnswer,
} from '@/components/shared/practice-analytics/analytics'
import { useAuthStore } from '@/stores/auth'

const route = useRoute()
const router = useRouter()
const diaryStore = useDiaryStore()

const practiceId = computed(() => route.params.id as string)

// ==========================================================================
// ANALYTICS SIMULATION (owner 2026-10-01): the new practice-analytics
// contract (tz-practice-analytics.md) needs per-student RAW 1..10 answers,
// which no backend endpoint serves yet. For telegram 388101199 the screen
// renders <PracticeAnalytics> over deterministic demo answers so the layout
// can be reviewed; every other viewer keeps the current screen. Remove with
// the MASTER_INVITE_SIMULATION batch when the backend contract ships
// (search: ANALYTICS_SIMULATION).
// ==========================================================================

const auth = useAuthStore()
const ANALYTICS_SIMULATION_TELEGRAM_ID = 388101199
const analyticsSimulation = computed(
  () => auth.user?.telegram_id === ANALYTICS_SIMULATION_TELEGRAM_ID,
)

const SIMULATED_ANSWERS: PracticeAnswer[] = [
  {
    userId: 'sim-1',
    name: 'Анна',
    before: 9,
    after: 9,
    comment: 'Очень атмосферно, пришлю друзей',
  },
  { userId: 'sim-2', name: 'Пётр', before: 4, after: 7, comment: null },
  {
    userId: 'sim-3',
    name: 'Мария',
    before: 6,
    after: 6,
    comment: 'Полезно, но мало времени на практику',
  },
  { userId: 'sim-4', name: 'Игорь', before: 2, after: 5, comment: null },
  { userId: 'sim-5', name: 'Ольга', before: 8, after: 10, comment: 'Лучшее, что было за месяц' },
  { userId: 'sim-6', name: 'Дмитрий', before: 5, after: 8, comment: null },
]

const analyticsData = computed((): PracticeAnalyticsData | null =>
  practice.value && analyticsSimulation.value
    ? {
        practice: practice.value,
        participants: practice.value.current_participants,
        answers: SIMULATED_ANSWERS,
      }
    : null,
)

// E1: tap a review → the reviewer's student profile (user_id now on ReviewItem).
function goStudent(r: ReviewItem): void {
  void router.push({
    name: 'master-student-profile',
    params: { id: r.user_id },
    query: { name: r.reviewer_name },
  })
}

// Reactive insights cache (shared with AnalyticsView -- often already warm).
const insightsCache = diaryStore.insightsCache
const insights = computed(() => insightsCache.get(practiceId.value) ?? null)

// =========================================================================
// Practice header (getPractice -- robust on direct nav / refresh)
// =========================================================================

const practice = ref<PracticeResponse | null>(null)
const practiceError = ref(false)

async function load(): Promise<void> {
  // Insights are usually already cached (AnalyticsView eager-loads the page);
  // loadInsights skips a cached id, otherwise fetches.
  await diaryStore.loadInsights(practiceId.value)
  void loadReviews()
  practiceError.value = false
  try {
    practice.value = await getPractice(practiceId.value)
  } catch {
    // Practice not found / network -- header card hides, stats show "—".
    practice.value = null
    practiceError.value = true
  }
}

onMounted(load)

const practiceDate = computed((): string =>
  practice.value ? formatShortDate(practice.value.scheduled_at, practice.value.timezone) : '',
)

const participantsLabel = computed((): string => {
  const p = practice.value
  if (!p) return ''
  return p.max_participants != null
    ? `${p.current_participants}/${p.max_participants}`
    : String(p.current_participants)
})

// =========================================================================
// Stats (from anonymous insights). "—" until loaded.
// =========================================================================

const totalCheckins = computed((): number => {
  const i = insights.value
  return i ? i.checkins.high + i.checkins.mid + i.checkins.low : 0
})

const totalFeedbacks = computed((): number => {
  const i = insights.value
  return i ? i.feedbacks.fire + i.feedbacks.good + i.feedbacks.confused : 0
})

const checkinPct = computed((): string => {
  const i = insights.value
  if (!i || i.participants === 0) return '—'
  return `${Math.round((totalCheckins.value / i.participants) * 100)}%`
})

const feedbackPct = computed((): string => {
  const i = insights.value
  if (!i || i.participants === 0) return '—'
  return `${Math.round((totalFeedbacks.value / i.participants) * 100)}%`
})

const feedbacksLabel = computed((): string | number =>
  insights.value ? totalFeedbacks.value : '—',
)

// =========================================================================
// Distribution — VRatingDistribution owns the bar config/palettes/markup; we
// just feed it this practice's raw feedback counts.
// =========================================================================

const feedbackCounts = computed(
  (): { fire: number; good: number; confused: number } =>
    insights.value?.feedbacks ?? { fire: 0, good: 0, confused: 0 },
)

// =========================================================================
// Отзывы (E1 named reviews — GET /practices/{id}/reviews, paginated)
// =========================================================================

const REVIEWS_PAGE = 20

const reviews = ref<ReviewItem[]>([])
const reviewsTotal = ref(0)
const reviewsLoading = ref(false)
const reviewsError = ref(false)
const hasMoreReviews = computed((): boolean => reviews.value.length < reviewsTotal.value)

async function loadReviews(): Promise<void> {
  reviewsLoading.value = true
  reviewsError.value = false
  try {
    const res = await getPracticeReviews(practiceId.value, REVIEWS_PAGE, 0)
    reviews.value = res.items
    reviewsTotal.value = res.total
  } catch {
    reviewsError.value = true
  } finally {
    reviewsLoading.value = false
  }
}

async function loadMoreReviews(): Promise<void> {
  if (reviewsLoading.value || !hasMoreReviews.value) return
  reviewsLoading.value = true
  try {
    const res = await getPracticeReviews(practiceId.value, REVIEWS_PAGE, reviews.value.length)
    reviews.value = [...reviews.value, ...res.items]
    reviewsTotal.value = res.total
  } catch {
    // Keep the loaded page; the «Показать ещё» button stays for a retry.
  } finally {
    reviewsLoading.value = false
  }
}

// =========================================================================
// Lifecycle
// =========================================================================
</script>

<style scoped>
.practice-reviews {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  /* F-5 rail sync: MobileLayout supplies the 24px horizontal rail. */
  padding: var(--space-4) 0;
}

/* ===== Stats ===== */
.practice-reviews__stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-3);
}

/* ===== Section ===== */
.practice-reviews__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

/* ===== Review card ===== */
.practice-reviews__review {
  display: flex;
  flex-direction: column;
  gap: var(--velo-gap-6);
}

.practice-reviews__review-top {
  display: flex;
  align-items: center;
  gap: var(--velo-card-meta-row-gap);
}

.practice-reviews__review-ident {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.practice-reviews__review-name {
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

.practice-reviews__review-quote {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  line-height: 1.45;
}

.practice-reviews__rloader {
  display: flex;
  justify-content: center;
  padding: var(--space-4) 0;
}

/* ===== Load more ===== */
.practice-reviews__more {
  display: flex;
  justify-content: center;
  padding-top: var(--space-2);
}
</style>
