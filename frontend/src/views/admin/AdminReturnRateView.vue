<!--
  VELO Frontend -- AdminReturnRateView (Admin DS, 2026-06-14, operator SVG "4 Return rate")

  Drill-in from the dashboard Engagement "Return rate" row. Hero rate + totals +
  top loyal users.

  WIRED (E9, 2026-06-16): GET /admin/metrics/return — return rate, totals, top
  loyal users. Loading/error/empty states; absolute values only (period-over-period
  deltas need E7, not delivered).
-->

<template>
  <div class="admin-detail">
    <header class="admin-detail__top">
      <VBackButton @click="router.back()" />
      <span class="admin-detail__title">Return rate</span>
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
      <VMetricHero :value="returnRate" :label="t('adminScreens.adminReturnRate.returnRate')">
        <template #icon><IconRepeat :size="28" /></template>
      </VMetricHero>

      <div class="admin-detail__stats2">
        <VStatCard :value="totalUsers" :label="t('adminScreens.adminReturnRate.totalUsers')" />
        <VStatCard :value="returning" :label="t('adminScreens.adminReturnRate.returning')" />
      </div>

      <h3 class="admin-detail__section">
        {{ t('adminScreens.adminReturnRate.topLoyalUsers') }}
      </h3>
      <template v-if="loyalUsers.length">
        <VListRow v-for="u in loyalUsers" :key="u.id" :title="u.title" :subtitle="u.subtitle" />
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
  VCard,
  VListRow,
  VLoader,
  VEmptyState,
  VButton,
} from '@/components/ui'
import { IconRepeat } from '@/components/icons'
import { adminFigures, returnMetricQuery } from '@/composables/queries/admin'
import { formatPeriodRange } from '@/utils/periodRange'

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
const { data, loading, error, retry } = adminFigures(
  useQuery(() => returnMetricQuery({ period, offset })),
)

const returnRate = computed((): string =>
  data.value ? `${Math.round(data.value.rate_pct)}%` : '—',
)
const totalUsers = computed((): string | number => data.value?.total_users ?? '—')
const returning = computed((): string | number => data.value?.returning ?? '—')
const loyalUsers = computed(() =>
  (data.value?.top_users ?? []).map((u) => ({
    id: u.id,
    title: u.name,
    subtitle: t('adminScreens.adminReturnRate.practicesCount', { n: u.practices_count }),
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
