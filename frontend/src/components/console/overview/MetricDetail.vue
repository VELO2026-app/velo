<!--
  VELO Frontend -- MetricDetail (FE-268)

  The breakdown of the open engagement metric, from its own endpoint:
    check-in  the counts, the trend over the period, the practices with a
              low check-in rate;
    feedback  the counts and the rating distribution (the shared 1..10 scale
              in five zones);
    return    the counts and the most frequent participants.
  Logic carried over from the mobile drill-ins (AdminCheckinRateView,
  AdminFeedbackRateView, AdminReturnRateView); the markup is new.
-->

<template>
  <div class="detail" :data-testid="`metric-detail-${detail.kind}`">
    <MetricFacts :facts="facts" />

    <div v-if="detail.kind === 'checkin'" class="detail__columns">
      <section class="detail__block">
        <h3 class="detail__heading">{{ t('console.analytics.checkin.trend') }}</h3>
        <TrendBars :bars="detail.data.series" :empty-text="t('console.analytics.empty')" />
      </section>
      <section class="detail__block">
        <h3 class="detail__heading">{{ t('console.analytics.checkin.lowTitle') }}</h3>
        <ul v-if="detail.data.low_practices.length > 0" class="detail__list">
          <li v-for="p in detail.data.low_practices" :key="p.id" class="detail__row">
            <span class="detail__name">{{ p.title }}</span>
            <span class="detail__sub">{{
              t('console.analytics.checkin.lowRow', {
                pct: Math.round(p.checkin_rate_pct),
                total: p.total,
              })
            }}</span>
          </li>
        </ul>
        <p v-else class="detail__empty">{{ t('console.analytics.empty') }}</p>
      </section>
    </div>

    <section v-else-if="detail.kind === 'feedback'" class="detail__block">
      <h3 class="detail__heading">{{ t('console.analytics.feedback.distribution') }}</h3>
      <div class="detail__ratings">
        <VRatingBar
          v-for="row in ratingRows"
          :key="row.key"
          :label="row.label"
          :value="row.rate"
          :bar-color="row.barColor"
        >
          <template #icon><component :is="row.icon" :size="22" /></template>
        </VRatingBar>
      </div>
    </section>

    <section v-else class="detail__block">
      <h3 class="detail__heading">{{ t('console.analytics.return.top') }}</h3>
      <ul v-if="topUsers.length > 0" class="detail__list">
        <li v-for="u in topUsers" :key="u.id" class="detail__row">
          <span class="detail__name">{{ u.name }}</span>
          <span class="detail__sub">{{
            t('console.analytics.return.practices', u.practices_count)
          }}</span>
        </li>
      </ul>
      <p v-else class="detail__empty">{{ t('console.analytics.empty') }}</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed } from 'vue'
import { VRatingBar } from '@/components/ui'
import MetricFacts from '@/components/console/overview/MetricFacts.vue'
import TrendBars from '@/components/console/overview/TrendBars.vue'
import type { MetricDetailProps } from '@/components/console/overview/types'
import { MOOD_SCALE_FILLS } from '@/utils/displayHelpers'
import { MOOD_SCALE_KEYS, MOOD_SCALE_LABELS, zoneTotal, type MoodScaleKey } from '@/utils/moodScale'
import { MOOD_SCALE_ICON } from '@/utils/ratingIcons'
import { formatCount } from '@/utils/format'

const props = defineProps<{
  /** The open metric and the answer of its endpoint. */
  detail: MetricDetailProps
}>()

// The counts behind the rate: two per metric.
const facts = computed(() => {
  const detail = props.detail
  const fact = (label: string, count: number) => ({ label, value: formatCount(count) })
  if (detail.kind === 'checkin')
    return [
      fact(t('console.analytics.checkin.records'), detail.data.total_records),
      fact(t('console.analytics.checkin.done'), detail.data.checked_in),
    ]
  if (detail.kind === 'feedback')
    return [
      fact(t('console.analytics.feedback.visited'), detail.data.visited),
      fact(t('console.analytics.feedback.left'), detail.data.left_review),
    ]
  return [
    fact(t('console.analytics.return.users'), detail.data.total_users),
    fact(t('console.analytics.return.returning'), detail.data.returning),
  ]
})

// Counts -> the share of the reviews left, for the bar widths; the best zone first.
const ratingRows = computed(() => {
  const detail = props.detail
  if (detail.kind !== 'feedback') return []
  const counts = detail.data.distribution
  const total = zoneTotal(counts)
  return [...MOOD_SCALE_KEYS].reverse().map((key: MoodScaleKey) => ({
    key,
    label: MOOD_SCALE_LABELS[key],
    icon: MOOD_SCALE_ICON[key],
    barColor: MOOD_SCALE_FILLS[key],
    rate: total === 0 ? null : Math.round((counts[key] / total) * 100),
  }))
})

/** Participants shown: the endpoint returns the top 50, the screen reads the first ten. */
const TOP_USERS_SHOWN = 10
const topUsers = computed(() =>
  props.detail.kind === 'return' ? props.detail.data.top_users.slice(0, TOP_USERS_SHOWN) : [],
)
</script>

<style scoped>
.detail {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.detail__columns {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
  gap: var(--space-6);
}

.detail__block {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
}

.detail__heading {
  margin: 0;
  font-size: var(--velo-fs-16);
  font-weight: inherit;
  color: var(--velo-text-primary);
  -webkit-text-stroke: var(--velo-text-stroke-strong);
}

.detail__list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.detail__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--velo-border-light);
  font-size: var(--velo-fs-14);
  color: var(--velo-text-primary);
}

.detail__row:last-child {
  border-bottom: 0;
}

.detail__name {
  min-width: 0;
  overflow-wrap: anywhere;
}

.detail__sub {
  flex: 0 0 auto;
  color: var(--velo-text-secondary);
}

.detail__ratings {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  max-width: 44rem;
}

.detail__empty {
  margin: 0;
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
}
</style>
