<!--
  VELO Frontend -- ConsoleDashboardView (FE-268, FE-262 slice 5)

  The dashboard of the web console: the queues that need the admin, the
  figures of a week or a month with their change, engagement, and the
  practices still to come today.

  Data (all on the current API, composables/queries/admin.ts):
    - "needs attention": the counters (`GET /admin/stats`), open tickets,
      pending payouts -- useAttentionQueues;
    - the figures and the engagement rates: `GET /admin/stats/overview`, one
      entry per (period, offset), the stepper moves the window;
    - today: the upcoming practices (TodayCard).
  What the API cannot give is not here: the margin (BE-250), the revenue by
  weeks and by direction, the sparklines (BE-255).
-->

<template>
  <ConsolePage :title="t('console.modules.dashboard')" testid="console-dashboard">
    <ConsoleCard
      :title="t('console.dashboard.attention.title')"
      :note="t('console.dashboard.attention.note')"
    >
      <div v-if="queuesFailed" class="dashboard__alert" role="alert" data-testid="counters-error">
        <span>{{ t('console.dashboard.attention.loadFailed') }}</span>
        <VButton size="sm" variant="outline" @click="reloadQueues">{{ t('common.retry') }}</VButton>
      </div>
      <AttentionQueues :queues="queues" />
    </ConsoleCard>

    <section class="dashboard__section" :aria-labelledby="figuresTitleId">
      <div class="dashboard__bar">
        <h2 :id="figuresTitleId" class="dashboard__title">
          {{ t('console.dashboard.figures.title') }}
        </h2>
        <PeriodBar
          :period="periodWindow.period"
          :offset="periodWindow.offset"
          @change="setWindow"
        />
      </div>

      <ConsoleLoading v-if="figures.loading.value" data-testid="figures-loading" />
      <OverviewEmpty
        v-else-if="figures.error.value"
        icon="warning"
        :title="t('console.dashboard.figures.loadFailed')"
        :description="figures.error.value"
      >
        <VButton size="sm" variant="outline" @click="figures.retry">{{
          t('common.retry')
        }}</VButton>
      </OverviewEmpty>
      <template v-else>
        <div class="dashboard__tiles">
          <FigureTile
            :label="t('console.dashboard.figures.revenue')"
            :value="revenueText"
            :delta="overview?.revenue_delta_pct"
          />
          <FigureTile
            :label="t('console.dashboard.figures.practices')"
            :value="countText(overview?.practices_count)"
            :delta="overview?.practices_delta_pct"
          />
          <FigureTile
            :label="t('console.dashboard.figures.newUsers')"
            :value="countText(overview?.new_users)"
            :delta="overview?.new_users_delta_pct"
          />
          <FigureTile
            :label="t('console.dashboard.figures.newMasters')"
            :value="countText(overview?.new_masters)"
            :delta="overview?.new_masters_delta_pct"
          />
        </div>
        <div class="dashboard__lower">
          <EngagementCard :rows="engagementRows" />
          <TodayCard />
        </div>
      </template>
    </section>
  </ConsolePage>
</template>

<script setup lang="ts">
import { t, getLocale } from '@/locales'
import { computed, ref, useId } from 'vue'
import { useQuery } from '@pinia/colada'
import { VButton } from '@/components/ui'
import ConsoleCard from '@/components/console/ConsoleCard.vue'
import ConsolePage from '@/components/console/ConsolePage.vue'
import ConsoleLoading from '@/components/console/content/ConsoleLoading.vue'
import AttentionQueues from '@/components/console/overview/AttentionQueues.vue'
import EngagementCard from '@/components/console/overview/EngagementCard.vue'
import FigureTile from '@/components/console/overview/FigureTile.vue'
import OverviewEmpty from '@/components/console/overview/OverviewEmpty.vue'
import PeriodBar from '@/components/console/overview/PeriodBar.vue'
import type { EngagementRow } from '@/components/console/overview/types'
import TodayCard from '@/components/console/overview/TodayCard.vue'
import { useAttentionQueues } from '@/components/console/overview/useAttentionQueues'
import {
  adminFigures,
  adminOverviewQuery,
  type AdminPeriodWindow,
} from '@/composables/queries/admin'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { consoleRouteName } from '@/utils/console/modules'
import { formatCount, formatMoney } from '@/utils/format'

const toast = useToast()
const figuresTitleId = useId()

const { queues, failed: queuesFailed, reload: reloadQueues } = useAttentionQueues()

// The window the figures answer; the stepper moves it, a switch of the
// granularity goes back to the current one (PeriodBar).
const periodWindow = ref<AdminPeriodWindow>({ period: 'week', offset: 0 })
function setWindow(next: AdminPeriodWindow): void {
  periodWindow.value = next
}

// One entry per window. The previous window's numbers never stand in for the
// one asked for (adminFigures): the loader shows until it answers; a failed
// refetch over figures shown is told once.
const figures = adminFigures(
  useQuery(() => adminOverviewQuery(periodWindow.value)),
  (error) => toast.error(extractApiError(error, t('console.dashboard.figures.loadFailed'))),
)
const overview = computed(() => figures.data.value)

function countText(count: number | undefined): string {
  return count === undefined ? '—' : formatCount(count)
}
const revenueText = computed(() =>
  overview.value === null
    ? '—'
    : formatMoney(overview.value.revenue_cents, 'EUR', getLocale(), true),
)

// The three rates open their metric in the analytics for the same window.
const engagementRows = computed<EngagementRow[]>(() => {
  const data = overview.value
  const to = (metric: string) => ({
    name: consoleRouteName('analytics'),
    query: { metric, period: periodWindow.value.period, offset: String(periodWindow.value.offset) },
  })
  return [
    {
      key: 'checkin',
      label: t('console.metrics.checkin'),
      rate: data?.checkin_rate_pct ?? null,
      delta: data?.checkin_rate_delta,
      to: to('checkin'),
    },
    {
      key: 'feedback',
      label: t('console.metrics.feedback'),
      rate: data?.feedback_rate_pct ?? null,
      delta: data?.feedback_rate_delta,
      to: to('feedback'),
    },
    {
      key: 'return',
      label: t('console.metrics.return'),
      rate: data?.return_rate_pct ?? null,
      delta: data?.return_rate_delta,
      to: to('return'),
    },
  ]
})
</script>

<style scoped>
.dashboard__alert {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--velo-radius-10);
  background: var(--velo-error-bg);
  font-size: var(--velo-fs-14);
  color: var(--velo-text-primary);
}

.dashboard__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.dashboard__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3) var(--space-5);
}

.dashboard__title {
  margin: 0;
  font-size: var(--velo-fs-20);
  font-weight: inherit;
  color: var(--velo-text-primary);
  -webkit-text-stroke: var(--velo-text-stroke-strong);
}

.dashboard__tiles {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-4);
}

.dashboard__lower {
  display: grid;
  grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
  gap: var(--space-4);
  align-items: start;
}

/* Under 1100 px the content is about 700 px wide: two figures a row, and the
   engagement block and the day stand one over the other. */
@media (max-width: 1099px) {
  .dashboard__tiles {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .dashboard__lower {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
