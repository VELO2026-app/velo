<!--
  VELO Frontend -- AdminRevenueView (Admin DS, 2026-06-14, operator SVG "1 Revenue")

  Drill-in from the dashboard "Баланс по мастерам" link. Platform revenue +
  commission + payout + per-master earnings.

  WIRED (E9, 2026-06-16): GET /api/v1/admin/revenue?period=week|month — revenue
  (GMV), commission, payout + per-master breakdown (loading/error/empty states).
  Неделя/Месяц toggle (mirrors AdminDashboardView's period segment), default
  'week' to match the backend default. Money via formatMoney(..., 'EUR', 'ru',
  true) so €0.00 renders honestly: seed practices are currently free, so totals
  read 0 until priced templates land (seed-pricing task, operator D2=В, queued
  next). No fabricated figures.
-->

<template>
  <div class="admin-detail">
    <header class="admin-detail__top">
      <VBackButton @click="router.back()" />
      <span class="admin-detail__title">Выручка</span>
    </header>

    <VSegment
      compact
      :model-value="period"
      :options="periodOptions"
      aria-label="Период выручки"
      @update:model-value="selectPeriod"
    />

    <div v-if="loading" class="admin-detail__loader"><VLoader size="lg" /></div>

    <VEmptyState
      v-else-if="error"
      icon="warning"
      title="Не удалось загрузить выручку"
      :description="error"
    >
      <VButton size="sm" variant="outline" @click="load">Повторить</VButton>
    </VEmptyState>

    <template v-else-if="data">
      <VMetricHero :value="revenueLabel" :label="revenueHeroLabel">
        <template #icon><IconFinance :size="28" /></template>
      </VMetricHero>

      <div class="admin-detail__stats2">
        <VStatCard :value="commissionLabel" label="Комиссия" />
        <VStatCard :value="payoutLabel" label="Выплачено" />
      </div>

      <h3 class="admin-detail__section">По мастерам</h3>
      <div v-if="data.per_master.length" class="admin-detail__items">
        <VListRow
          v-for="m in data.per_master"
          :key="m.master_id"
          :title="m.name"
          :subtitle="`Выплачено: ${money(m.payout_cents)}`"
        >
          <template #trailing>
            <span class="admin-revenue__earned">{{ money(m.earned_cents) }}</span>
          </template>
        </VListRow>
      </div>
      <VCard v-else><p class="admin-detail__empty">Данных пока нет</p></VCard>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
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
import type { SegmentOption } from '@/components/ui/VSegment.vue'
import { IconFinance } from '@/components/icons'
import { getAdminRevenue } from '@/api/admin'
import { extractApiError } from '@/composables/useApiError'
import { formatMoney } from '@/utils/format'
import type { AdminRevenueResponse } from '@/api/types'

const router = useRouter()

const data = ref<AdminRevenueResponse | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

// Период (Неделя/Месяц), default 'week' matches the backend default.
const period = ref<'week' | 'month'>('week')
const periodOptions: SegmentOption[] = [
  { value: 'week', label: 'Неделя' },
  { value: 'month', label: 'Месяц' },
]
const revenueHeroLabel = computed<string>(() =>
  period.value === 'week' ? 'Выручка за неделю' : 'Выручка за месяц',
)

// VSegment emits a plain string; narrow it back to the period union.
function selectPeriod(p: string): void {
  if (p !== 'week' && p !== 'month') return
  period.value = p
}

// allowZero=true: free-seed totals must show €0.00, not "Бесплатно".
function money(cents: number): string {
  return formatMoney(cents, 'EUR', 'ru', true)
}

const revenueLabel = computed<string>(() => (data.value ? money(data.value.revenue_cents) : '—'))
const commissionLabel = computed<string>(() =>
  data.value ? money(data.value.commission_cents) : '—',
)
const payoutLabel = computed<string>(() => (data.value ? money(data.value.payout_cents) : '—'))

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    data.value = await getAdminRevenue(period.value)
  } catch (e) {
    error.value = extractApiError(e, 'Ошибка загрузки')
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(period, load)
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
.admin-detail__items {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.admin-detail__empty {
  margin: 0;
  text-align: center;
  color: var(--velo-text-muted);
  font-size: var(--text-sm);
  padding: var(--space-4) var(--space-2);
}
.admin-revenue__earned {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  white-space: nowrap;
}
</style>
