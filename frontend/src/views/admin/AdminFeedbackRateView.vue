<!--
  VELO Frontend -- AdminFeedbackRateView (Admin DS, 2026-06-14, operator SVG "3 Feedback rate")

  Drill-in from the dashboard Engagement "Feedback rate" row. Hero rate + totals +
  rating distribution, one row per zone of the shared 1..10 scale (Огонь ..
  Плохо, BE-77).

  WIRED (E9, 2026-06-16): GET /admin/metrics/feedback — leave-rate, visited/left
  totals, rating distribution (counts → bucket percentages). Loading/error states;
  absolute values only (period-over-period deltas need E7, not delivered).
-->

<template>
  <div class="admin-detail">
    <header class="admin-detail__top">
      <VBackButton @click="router.back()" />
      <span class="admin-detail__title">Feedback rate</span>
      <span class="admin-detail__range">{{ rangeLabel }}</span>
    </header>

    <div v-if="loading" class="admin-detail__loader"><VLoader size="lg" /></div>
    <VEmptyState
      v-else-if="error"
      icon="warning"
      title="Не удалось загрузить метрику"
      :description="error"
    >
      <VButton size="sm" variant="outline" @click="load">Повторить</VButton>
    </VEmptyState>

    <template v-else>
      <VMetricHero :value="leaveRate" label="Оставляют отзыв">
        <template #icon><IconFeedback :size="28" /></template>
      </VMetricHero>

      <div class="admin-detail__stats2">
        <VStatCard :value="visited" label="Посетили" />
        <VStatCard :value="leftReview" label="Оставили отзыв" />
      </div>

      <h3 class="admin-detail__section">Распределение оценок</h3>
      <VCard class="admin-detail__rating">
        <VRatingBar
          v-for="row in ratingRows"
          :key="row.key"
          :label="row.label"
          :value="row.rate"
          :bar-color="row.barColor"
        >
          <template #icon><component :is="row.icon" :size="22" /></template>
        </VRatingBar>
      </VCard>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  VBackButton,
  VMetricHero,
  VStatCard,
  VCard,
  VRatingBar,
  VLoader,
  VEmptyState,
  VButton,
} from '@/components/ui'
import { IconFeedback } from '@/components/icons'
import { getFeedbackMetric } from '@/api/admin'
import { extractApiError } from '@/composables/useApiError'
import { formatPeriodRange } from '@/utils/periodRange'
import type { FeedbackMetricResponse } from '@/api/types'
import { MOOD_SCALE_FILLS } from '@/utils/displayHelpers'
import { MOOD_SCALE_KEYS, MOOD_SCALE_LABELS, zoneTotal, type MoodScaleKey } from '@/utils/moodScale'
import { MOOD_SCALE_ICON } from '@/utils/ratingIcons'

const router = useRouter()

// Selected week/month carried from the dashboard drill-in (P1). Defaults to the
// current week on a direct link (no query).
const route = useRoute()
const period: 'week' | 'month' = route.query.period === 'month' ? 'month' : 'week'
const rawOffset = Number.parseInt(String(route.query.offset ?? ''), 10)
const offset = Number.isFinite(rawOffset) ? rawOffset : 0
const rangeLabel = formatPeriodRange(period, offset)

const data = ref<FeedbackMetricResponse | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

const leaveRate = computed((): string => (data.value ? `${Math.round(data.value.rate_pct)}%` : '—'))
const visited = computed((): string | number => data.value?.visited ?? '—')
const leftReview = computed((): string | number => data.value?.left_review ?? '—')

// Distribution: counts → percentage of the reviews left, for the bar widths.
const distributionTotal = computed((): number => {
  const d = data.value?.distribution
  return d ? zoneTotal(d) : 0
})
function bucketPct(count: number | undefined): number | null {
  if (count == null || distributionTotal.value === 0) return null
  return Math.round((count / distributionTotal.value) * 100)
}
// Best zone first, as the three-row version read (Огонь on top).
const ratingRows = computed(() =>
  [...MOOD_SCALE_KEYS].reverse().map((key: MoodScaleKey) => ({
    key,
    label: MOOD_SCALE_LABELS[key],
    icon: MOOD_SCALE_ICON[key],
    barColor: MOOD_SCALE_FILLS[key],
    rate: bucketPct(data.value?.distribution[key]),
  })),
)

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    data.value = await getFeedbackMetric(period, offset)
  } catch (e) {
    error.value = extractApiError(e, 'Ошибка загрузки')
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.admin-detail {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.admin-detail__top {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: var(--velo-size-44);
}
.admin-detail__title {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}
.admin-detail__range {
  margin-left: auto;
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
}
.admin-detail__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-6) 0;
}
.admin-detail__stats2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}
.admin-detail__section {
  font-family: var(--font-body);
  font-size: var(--text-base);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: var(--velo-gap-2) 0 0;
}
.admin-detail__rating {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}
</style>
