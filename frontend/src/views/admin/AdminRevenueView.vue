<!--
  VELO Frontend -- AdminRevenueView (Admin DS, 2026-06-14, operator SVG "1 Revenue")

  Drill-in from the dashboard masters-balance link
  (i18n:adminScreens.adminDashboard.mastersBalance). Platform revenue +
  commission + payout + per-master earnings.

  WIRED (E9, 2026-06-16): GET /api/v1/admin/revenue?period=week|month — revenue
  (GMV), commission, payout + per-master breakdown (loading/error/empty states).
  Week/month toggle (i18n:common.periodWeek / i18n:common.periodMonth; mirrors
  AdminDashboardView's period segment), default 'week' to match the backend
  default. Money via formatMoney(..., 'EUR', getLocale(),
  true) so €0.00 renders honestly: seed practices are currently free, so totals
  read 0 until priced templates land (seed-pricing task, operator D2=B, queued
  next). No fabricated figures.
-->

<template>
  <div class="admin-detail">
    <header class="admin-detail__top">
      <VBackButton @click="router.back()" />
      <span class="admin-detail__title">{{ t('adminScreens.adminRevenue.revenue') }}</span>
    </header>

    <VSegment
      compact
      :model-value="period"
      :options="periodOptions"
      :aria-label="t('adminScreens.adminRevenue.revenuePeriod')"
      @update:model-value="selectPeriod"
    />

    <div v-if="loading" class="admin-detail__loader"><VLoader size="lg" /></div>

    <VEmptyState
      v-else-if="error"
      icon="warning"
      :title="t('adminScreens.adminRevenue.revenueLoadFailed')"
      :description="error"
    >
      <VButton size="sm" variant="outline" @click="retry">{{ t('common.retry') }}</VButton>
    </VEmptyState>

    <template v-else-if="data">
      <VMetricHero :value="revenueLabel" :label="revenueHeroLabel">
        <template #icon><IconFinance :size="28" /></template>
      </VMetricHero>

      <div class="admin-detail__stats2">
        <VStatCard
          :value="commissionLabel"
          :label="t('adminScreens.adminRevenue.commissionStat')"
        />
        <VStatCard :value="payoutLabel" :label="t('adminScreens.adminRevenue.payoutStat')" />
      </div>

      <h3 class="admin-detail__section">{{ t('adminScreens.adminRevenue.byMasters') }}</h3>
      <div v-if="data.per_master.length" class="admin-detail__items">
        <VListRow
          v-for="m in data.per_master"
          :key="m.master_id"
          :title="m.name"
          :subtitle="t('adminScreens.adminRevenue.paidAmount', { amount: money(m.payout_cents) })"
        >
          <template #trailing>
            <span class="admin-revenue__earned">{{ money(m.earned_cents) }}</span>
          </template>
        </VListRow>
      </div>
      <VCard v-else
        ><p class="admin-detail__empty">
          {{ t('common.noData') }}
        </p></VCard
      >
    </template>
  </div>
</template>

<script setup lang="ts">
import { t, getLocale } from '@/locales'
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useQuery } from '@pinia/colada'
import {
  VBackButton,
  VSegment,
  VMetricHero,
  VStatCard,
  VCard,
  VListRow,
  VLoader,
  VEmptyState,
  VButton,
} from '@/components/ui'
import type { SegmentOption } from '@/components/ui'
import { IconFinance } from '@/components/icons'
import { adminFigures, revenueQuery } from '@/composables/queries/admin'
import { formatMoney } from '@/utils/format'

const router = useRouter()

// Period (i18n:common.periodWeek / i18n:common.periodMonth), default 'week' matches the backend default.
const period = ref<'week' | 'month'>('week')
const periodOptions: SegmentOption[] = [
  { value: 'week', label: t('common.periodWeek') },
  { value: 'month', label: t('common.periodMonth') },
]
const revenueHeroLabel = computed<string>(() =>
  period.value === 'week'
    ? t('adminScreens.adminRevenue.titleWeek')
    : t('adminScreens.adminRevenue.titleMonth'),
)

// The period's figures (Pinia Colada, composables/queries/admin.ts): the
// current window, the entry the dashboard's revenue line reads. A period
// switch shows the loader until the new window answers.
const { data, loading, error, retry } = adminFigures(
  useQuery(() => revenueQuery({ period: period.value, offset: 0 })),
)

// VSegment emits a plain string; narrow it back to the period union.
function selectPeriod(p: string): void {
  if (p !== 'week' && p !== 'month') return
  period.value = p
}

// allowZero=true: free-seed totals must show €0.00, not t('adminScreens.adminRevenue.besplatno').
function money(cents: number): string {
  return formatMoney(cents, 'EUR', getLocale(), true)
}

const revenueLabel = computed<string>(() => (data.value ? money(data.value.revenue_cents) : '—'))
const commissionLabel = computed<string>(() =>
  data.value ? money(data.value.commission_cents) : '—',
)
const payoutLabel = computed<string>(() => (data.value ? money(data.value.payout_cents) : '—'))
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
.admin-detail__items {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.admin-detail__empty {
  margin: 0;
  text-align: center;
  color: var(--velo-text-muted);
  font-size: var(--velo-fs-16);
  padding: var(--space-4) var(--space-2);
}
.admin-revenue__earned {
  font-family: var(--font-body);
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  white-space: nowrap;
}
</style>
