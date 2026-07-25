<!--
  VELO Frontend -- AdminCheckinRateView (Admin DS, 2026-06-14, operator SVG "2 Check-in rate")

  Drill-in from the dashboard Engagement "Check-in rate" row. Hero rate + totals +
  weekly bar chart + low-check-in practices.

  WIRED (E9, 2026-06-16): GET /admin/metrics/check-in — avg rate, totals, weekly
  series, low-check-in practices. Loading/error/empty states; absolute values only
  (period-over-period deltas need E7, not delivered).
-->

<template>
  <div class="admin-detail">
    <header class="admin-detail__top">
      <VBackButton @click="router.back()" />
      <span class="admin-detail__title">Check-in rate</span>
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
      <VMetricHero :value="avgRate" label="Средний check-in rate">
        <template #icon><IconCheck :size="30" /></template>
      </VMetricHero>

      <div class="admin-detail__stats2">
        <VStatCard :value="totalRecords" label="Всего записей" />
        <VStatCard :value="checkedIn" label="Отметились" />
      </div>

      <VBarChart :bars="weekBars" />

      <h3 class="admin-detail__section">Низкий check-in (практики)</h3>
      <template v-if="lowPractices.length">
        <VListRow v-for="p in lowPractices" :key="p.id" :title="p.title" :subtitle="p.subtitle" />
      </template>
      <VCard v-else><p class="admin-detail__empty">Данных пока нет</p></VCard>
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
  VBarChart,
  VCard,
  VListRow,
  VLoader,
  VEmptyState,
  VButton,
} from '@/components/ui'
import { IconCheck } from '@/components/icons'
import { getCheckinMetric } from '@/api/admin'
import { extractApiError } from '@/composables/useApiError'
import { formatPeriodRange } from '@/utils/periodRange'
import type { CheckinMetricResponse, SeriesPoint } from '@/api/types'

const router = useRouter()

// Selected week/month carried from the dashboard drill-in (P1). Defaults to the
// current week on a direct link (no query).
const route = useRoute()
const period: 'week' | 'month' = route.query.period === 'month' ? 'month' : 'week'
const rawOffset = Number.parseInt(String(route.query.offset ?? ''), 10)
const offset = Number.isFinite(rawOffset) ? rawOffset : 0
const rangeLabel = formatPeriodRange(period, offset)

const data = ref<CheckinMetricResponse | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

const avgRate = computed((): string => (data.value ? `${Math.round(data.value.rate_pct)}%` : '—'))
const totalRecords = computed((): string | number => data.value?.total_records ?? '—')
const checkedIn = computed((): string | number => data.value?.checked_in ?? '—')
const weekBars = computed((): SeriesPoint[] => data.value?.series ?? [])
const lowPractices = computed(() =>
  (data.value?.low_practices ?? []).map((p) => ({
    id: p.id,
    title: p.title,
    subtitle: `${Math.round(p.checkin_rate_pct)}% · ${p.total} записей`,
  })),
)

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    data.value = await getCheckinMetric(period, offset)
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
.admin-detail__empty {
  margin: 0;
  text-align: center;
  color: var(--velo-text-muted);
  font-size: var(--text-sm);
  padding: var(--space-1) var(--space-2);
}
</style>
