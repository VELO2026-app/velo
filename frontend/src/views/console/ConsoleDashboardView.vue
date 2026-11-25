<!--
  VELO Frontend -- ConsoleDashboardView (FE-268, FE-262 slice 5)

  The dashboard of the web console: the queues that need the admin, the
  figures of a week or a month with their change, engagement, and the
  practices still to come today.

  Data (all on the current API, composables/queries/admin.ts):
    - "needs attention": the counters (`GET /admin/stats`), open tickets,
      pending payouts -- useAttentionQueues;
    - the figures and the engagement rates: `GET /admin/stats/overview`, one
      entry per (period, offset), the stepper moves the window, and the window
      lives in the URL (`?period=month&offset=-1`, the analytics reads the same);
    - today: the upcoming practices (TodayCard), a block of its own: it does not
      wait for the period's figures and does not follow the stepper.
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
      <div v-else class="dashboard__tiles" :style="{ '--dashboard-tiles': tileCount }">
        <FigureTile
          v-if="paymentsEnabled"
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
    </section>

    <!-- Each block keeps its own states: the rates follow the window above, the
         day does not. -->
    <div class="dashboard__lower">
      <EngagementCard
        :rows="engagementRows"
        :loading="figures.loading.value"
        :error="figures.error.value"
        @retry="figures.retry"
      />
      <TodayCard />
    </div>
  </ConsolePage>
</template>

<script setup lang="ts">
import { t, getLocale } from '@/locales'
import { computed, useId } from 'vue'
import { useQuery } from '@pinia/colada'
import { VButton } from '@/components/ui'
import { isOptionEnabled } from '@/platform/instance'
import ConsoleCard from '@/components/console/ConsoleCard.vue'
import ConsolePage from '@/components/console/ConsolePage.vue'
import ConsoleLoading from '@/components/console/content/ConsoleLoading.vue'
import AttentionQueues from '@/components/console/overview/AttentionQueues.vue'
import EngagementCard from '@/components/console/overview/EngagementCard.vue'
import FigureTile from '@/components/console/overview/FigureTile.vue'
import OverviewEmpty from '@/components/console/overview/OverviewEmpty.vue'
import PeriodBar from '@/components/console/overview/PeriodBar.vue'
import TodayCard from '@/components/console/overview/TodayCard.vue'
import { engagementLabel, overviewRateOf } from '@/components/console/overview/engagement'
import { ENGAGEMENT_METRICS, type EngagementRow } from '@/components/console/overview/types'
import { useAttentionQueues } from '@/composables/console/useAttentionQueues'
import { periodToQuery, useConsolePeriod } from '@/composables/console/useConsolePeriod'
import { adminFigures, adminOverviewQuery } from '@/composables/queries/admin'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { consoleRouteName } from '@/utils/console/modules'
import { formatCount, formatMoney } from '@/utils/format'

const toast = useToast()
const figuresTitleId = useId()

const { queues, failed: queuesFailed, reload: reloadQueues } = useAttentionQueues()

// The window the figures answer lives in the URL; the stepper moves it, a
// switch of the granularity goes back to the current one (PeriodBar).
const { periodWindow, setWindow } = useConsolePeriod()

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
// The revenue figure is the payments option's: without it the tile is not there.
const paymentsEnabled = isOptionEnabled('payments')
// Four tiles with the revenue one, three without: the row fills its width.
const tileCount = paymentsEnabled ? 4 : 3

const revenueText = computed(() =>
  overview.value === null
    ? '—'
    : formatMoney(overview.value.revenue_cents, 'EUR', getLocale(), true),
)

// The three rates open their metric in the analytics for the same window.
const engagementRows = computed<EngagementRow[]>(() =>
  ENGAGEMENT_METRICS.map((key) => ({
    key,
    label: engagementLabel(key),
    ...overviewRateOf(overview.value, key),
    to: {
      name: consoleRouteName('analytics'),
      query: { metric: key, ...periodToQuery(periodWindow.value) },
    },
  })),
)
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
  grid-template-columns: repeat(var(--dashboard-tiles, 4), minmax(0, 1fr));
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
