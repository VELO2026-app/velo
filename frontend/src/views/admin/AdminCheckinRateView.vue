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
      :title="t('adminScreens.adminCommon.loadMetricFailed')"
      :description="error"
    >
      <VButton size="sm" variant="outline" @click="retry">{{ t('common.retry') }}</VButton>
    </VEmptyState>

    <template v-else>
      <VMetricHero :value="avgRate" :label="t('adminScreens.adminCheckinRate.avgRate')">
        <template #icon><IconCheck :size="30" /></template>
      </VMetricHero>

      <div class="admin-detail__stats2">
        <VStatCard :value="totalRecords" :label="t('adminScreens.adminCheckinRate.totalRecords')" />
        <VStatCard :value="checkedIn" :label="t('adminScreens.adminCheckinRate.checkedIn')" />
      </div>

      <VBarChart :bars="weekBars" />

      <h3 class="admin-detail__section">
        {{ t('adminScreens.adminCheckinRate.lowCheckinTitle') }}
      </h3>
      <template v-if="lowPractices.length">
        <VListRow v-for="p in lowPractices" :key="p.id" :title="p.title" :subtitle="p.subtitle" />
      </template>
      <VCard v-else
        ><p class="admin-detail__empty">
          {{ t('common.noData') }}
        </p></VCard
      >
    </template>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useQuery } from '@pinia/colada'
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
import { adminFigures, checkinMetricQuery } from '@/composables/queries/admin'
import { formatPeriodRange } from '@/utils/periodRange'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import type { SeriesPoint } from '@/api/types'

const router = useRouter()

// Selected week/month carried from the dashboard drill-in (P1). Defaults to the
// current week on a direct link (no query).
const route = useRoute()
const period: 'week' | 'month' = route.query.period === 'month' ? 'month' : 'week'
const rawOffset = Number.parseInt(String(route.query.offset ?? ''), 10)
const offset = Number.isFinite(rawOffset) ? rawOffset : 0
const rangeLabel = formatPeriodRange(period, offset)

// The window's figures (Pinia Colada, composables/queries/admin.ts) -- the
// entry the dashboard's row reads, so a drill-in from it paints at once.
const toast = useToast()
const { data, loading, error, retry } = adminFigures(
  useQuery(() => checkinMetricQuery({ period, offset })),
  (e) => toast.error(extractApiError(e, t('adminScreens.adminCommon.loadMetricFailed'))),
)

const avgRate = computed((): string => (data.value ? `${Math.round(data.value.rate_pct)}%` : '—'))
const totalRecords = computed((): string | number => data.value?.total_records ?? '—')
const checkedIn = computed((): string | number => data.value?.checked_in ?? '—')
const weekBars = computed((): SeriesPoint[] => data.value?.series ?? [])
const lowPractices = computed(() =>
  (data.value?.low_practices ?? []).map((p) => ({
    id: p.id,
    title: p.title,
    subtitle: t('adminScreens.adminCheckinRate.subtitle', {
      pct: Math.round(p.checkin_rate_pct),
      total: p.total,
    }),
  })),
)
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
  font-size: var(--velo-fs-16);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}
.admin-detail__range {
  margin-left: auto;
  font-family: var(--font-body);
  font-size: var(--velo-fs-14);
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
  font-size: var(--velo-fs-18);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: var(--velo-gap-2) 0 0;
}
.admin-detail__empty {
  margin: 0;
  text-align: center;
  color: var(--velo-text-muted);
  font-size: var(--velo-fs-16);
  padding: var(--space-1) var(--space-2);
}
</style>
