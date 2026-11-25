<!--
  VELO Frontend -- ConsoleAnalyticsView (FE-268, FE-262 slice 5)

  The analytics module of the web console: the three engagement metrics of a
  week or a month -- check-in, feedback, return -- each a rate with its
  change against the period before, and the breakdown of the open one.

  Data: `GET /admin/metrics/check-in|feedback|return` for the window, one
  Colada entry per metric and (period, offset) -- the entries the dashboard's
  engagement block links into. The deltas come from `GET /admin/stats/overview`
  for the same window. The metric, the period and the offset live in the URL
  (`?metric=feedback&period=month&offset=-1`), so a reload and the dashboard's
  links keep them. The participant path and the table by direction need
  BE-255; the other tabs of the design (audience, masters, practices) have no
  data yet, and the Excel export needs BE-251.
-->

<template>
  <ConsolePage
    :title="t('console.modules.analytics')"
    :crumbs="t('console.groups.growth')"
    testid="console-analytics"
  >
    <PeriodBar :period="periodWindow.period" :offset="periodWindow.offset" @change="setWindow" />

    <div class="analytics__metrics" role="group" :aria-label="t('console.analytics.metricsLabel')">
      <MetricCard
        v-for="m in cards"
        :id="m.key"
        :key="m.key"
        :label="m.label"
        :rate="m.rate"
        :delta="m.delta"
        :delta-failed="deltaFailed"
        :selected="m.key === metric"
        @select="setMetric(m.key)"
      />
    </div>

    <ConsoleCard :title="openTitle">
      <ConsoleLoading v-if="open.loading.value" data-testid="metric-loading" />
      <OverviewEmpty
        v-else-if="open.error.value"
        icon="warning"
        :title="t('console.analytics.loadFailed')"
        :description="open.error.value"
      >
        <VButton size="sm" variant="outline" @click="open.retry">{{ t('common.retry') }}</VButton>
      </OverviewEmpty>
      <MetricDetail v-else-if="detail" :detail="detail" />
    </ConsoleCard>
  </ConsolePage>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useQuery } from '@pinia/colada'
import { VButton } from '@/components/ui'
import ConsoleCard from '@/components/console/ConsoleCard.vue'
import ConsolePage from '@/components/console/ConsolePage.vue'
import ConsoleLoading from '@/components/console/ConsoleLoading.vue'
import MetricCard from '@/components/console/overview/MetricCard.vue'
import MetricDetail from '@/components/console/overview/MetricDetail.vue'
import OverviewEmpty from '@/components/console/overview/OverviewEmpty.vue'
import PeriodBar from '@/components/console/overview/PeriodBar.vue'
import { engagementLabel, overviewRateOf } from '@/components/console/overview/engagement'
import {
  ENGAGEMENT_METRICS,
  type EngagementMetricKey,
  type MetricDetailProps,
} from '@/components/console/overview/types'
import { periodToQuery, useConsolePeriod } from '@/composables/console/useConsolePeriod'
import {
  adminFigures,
  adminOverviewQuery,
  checkinMetricQuery,
  feedbackMetricQuery,
  returnMetricQuery,
  type AdminPeriodWindow,
} from '@/composables/queries/admin'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'

const route = useRoute()
const router = useRouter()
const toast = useToast()

// The URL is the state; a value it cannot mean falls back to the default
// (check-in, this week; a period after the current one does not exist).
const metric = computed<EngagementMetricKey>(
  () => ENGAGEMENT_METRICS.find((m) => m === route.query.metric) ?? 'checkin',
)
const { periodWindow } = useConsolePeriod()

function show(next: EngagementMetricKey, window: AdminPeriodWindow): void {
  void router.replace({
    query: { ...(next === 'checkin' ? {} : { metric: next }), ...periodToQuery(window) },
  })
}
function setMetric(next: EngagementMetricKey): void {
  show(next, periodWindow.value)
}
function setWindow(next: AdminPeriodWindow): void {
  show(metric.value, next)
}

// One entry per metric and window. A read that fails over figures shown is
// told once, and only for the open metric: three failing reads of one outage
// are one message, and the closed ones tell themselves when they are opened.
function told(key: EngagementMetricKey): (error: unknown) => void {
  return (error) => {
    if (metric.value === key) toast.error(extractApiError(error, t('console.analytics.loadFailed')))
  }
}
const checkin = adminFigures(
  useQuery(() => checkinMetricQuery(periodWindow.value)),
  told('checkin'),
)
const feedback = adminFigures(
  useQuery(() => feedbackMetricQuery(periodWindow.value)),
  told('feedback'),
)
const returning = adminFigures(
  useQuery(() => returnMetricQuery(periodWindow.value)),
  told('return'),
)
const states = { checkin, feedback, return: returning }

// The changes against the period before are the overview's. A failed read of
// it is not "nothing to compare with": the cards say it could not be read.
const overviewFigures = adminFigures(useQuery(() => adminOverviewQuery(periodWindow.value)))
const deltaFailed = computed(() => overviewFigures.error.value !== null)

const cards = computed(() =>
  ENGAGEMENT_METRICS.map((key) => ({
    key,
    label: engagementLabel(key),
    rate: states[key].data.value?.rate_pct ?? null,
    delta: overviewRateOf(overviewFigures.data.value, key).delta,
  })),
)

// The open metric's state and answer.
const open = computed(() => states[metric.value])
const openTitle = computed(() => engagementLabel(metric.value))
const detail = computed<MetricDetailProps | null>(() => {
  const kind = metric.value
  if (kind === 'checkin') return checkin.data.value && { kind, data: checkin.data.value }
  if (kind === 'feedback') return feedback.data.value && { kind, data: feedback.data.value }
  return returning.data.value && { kind, data: returning.data.value }
})
</script>

<style scoped>
/* The console opens from 744 px (about 630 px of content): three cards fit. */
.analytics__metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-4);
}
</style>
