<!--
  VELO Frontend -- SupportStatsPanel (FE-262, slice 2)

  Support over one month of appeals (GET /support/stats): the admin's own
  month ([00:00 of the 1st, 00:00 of the next 1st) in their profile timezone,
  ISO with the offset -- the backend refuses a time without a zone), a step
  back in time at a time, forward only up to the current month.

  Four tiles: the month's tickets (with the change against the month before,
  read from the same endpoint), spam, and the rating of the answers (average
  and share of 4-5 stars, folded from the categories). Below: the tickets by
  category with each category's rating line, and the ratings per admin.
  `average` and `share_4_5` are null when nothing was rated -- the tiles say
  a dash, not 0. Not in the API, so not on screen: the first-answer time, the
  share solved within a day and the tickets per day (see the PR).
-->

<template>
  <div class="support-stats" data-testid="support-stats">
    <div class="support-stats__nav">
      <button
        type="button"
        class="support-stats__step"
        :aria-label="t('adminScreens.adminSupportStats.prevMonth')"
        data-testid="stats-prev"
        @click="shift(-1)"
      >
        ‹
      </button>
      <span class="support-stats__month" data-testid="stats-month">{{ monthLabel }}</span>
      <button
        type="button"
        class="support-stats__step"
        :disabled="monthOffset === 0"
        :aria-label="t('adminScreens.adminSupportStats.nextMonth')"
        data-testid="stats-next"
        @click="shift(1)"
      >
        ›
      </button>
    </div>

    <div v-if="loading" class="support-stats__center"><VLoader size="lg" /></div>

    <VEmptyState
      v-else-if="error"
      icon="warning"
      :title="t('common.loadFailed')"
      :description="error"
    >
      <VButton size="sm" variant="outline" @click="retry">{{ t('common.retry') }}</VButton>
    </VEmptyState>

    <template v-else-if="stats">
      <div class="support-stats__tiles">
        <ConsoleCard class="support-stats__tile" data-testid="stats-tile-total">
          <span class="support-stats__label">{{ t('console.support.stats.total') }}</span>
          <span class="support-stats__value">{{ stats.total }}</span>
          <span v-if="delta" class="support-stats__note">{{ delta }}</span>
        </ConsoleCard>
        <ConsoleCard class="support-stats__tile" data-testid="stats-tile-spam">
          <span class="support-stats__label">{{ t('adminScreens.adminSupportStats.spam') }}</span>
          <span class="support-stats__value">{{ stats.spam }}</span>
        </ConsoleCard>
        <ConsoleCard class="support-stats__tile" data-testid="stats-tile-rating">
          <span class="support-stats__label">{{ t('console.support.stats.rating') }}</span>
          <span class="support-stats__value">{{ averageText }}</span>
          <span class="support-stats__note">{{
            t('adminScreens.adminSupportStats.ratedCount', { count: totals.rated })
          }}</span>
        </ConsoleCard>
        <ConsoleCard class="support-stats__tile" data-testid="stats-tile-share">
          <span class="support-stats__label">{{ t('console.support.stats.share') }}</span>
          <span class="support-stats__value">{{ shareText }}</span>
        </ConsoleCard>
      </div>

      <div class="support-stats__cards">
        <ConsoleCard :title="t('adminScreens.adminSupportStats.categories')">
          <ul class="support-stats__cats">
            <li
              v-for="row in stats.categories"
              :key="row.category"
              class="support-stats__cat"
              data-testid="stats-category-row"
            >
              <div class="support-stats__cat-head">
                <span>{{ supportCategoryLabel(row.category) }}</span>
                <span>{{ shareLabel(row) }}</span>
              </div>
              <div class="support-stats__track">
                <i
                  class="support-stats__fill"
                  :style="{ width: `${categoryShare(row, stats.total) ?? 0}%` }"
                />
              </div>
              <div class="support-stats__figures">{{ figuresLine(row) }}</div>
            </li>
          </ul>
        </ConsoleCard>

        <ConsoleCard :title="t('adminScreens.adminSupportStats.resolvers')" flush>
          <ConsoleTable
            v-if="resolverRows.length"
            :columns="resolverColumns"
            :rows="resolverRows"
            row-key="key"
            :label="t('adminScreens.adminSupportStats.resolvers')"
          />
          <p v-else class="support-stats__empty">
            {{ t('adminScreens.adminSupportStats.noRatings') }}
          </p>
        </ConsoleCard>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { t, getLocale } from '@/locales'
import { computed, ref } from 'vue'
import { useQuery } from '@pinia/colada'
import { DateTime } from 'luxon'
import { VButton, VEmptyState, VLoader } from '@/components/ui'
import ConsoleCard from '@/components/console/ConsoleCard.vue'
import ConsoleTable, { type ConsoleTableColumn } from '@/components/console/ConsoleTable.vue'
import {
  categoryShare,
  ratingTotals,
  signedDelta,
} from '@/components/console/requests/supportStatsFigures'
import type { SupportStatsCategory, SupportStatsFigures } from '@/api/support'
import { adminFigures, adminSupportStatsQuery } from '@/composables/queries/admin'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { useAuthStore } from '@/stores/auth'
import { supportCategoryLabel } from '@/utils/supportTopics'

const authStore = useAuthStore()
const toast = useToast()

/** 0 = the current month; each step is one month further back. */
const monthOffset = ref(0)

const monthStart = computed(() =>
  DateTime.now()
    .setZone(authStore.user?.timezone)
    .startOf('month')
    .minus({ months: monthOffset.value }),
)
const monthLabel = computed(() => monthStart.value.toFormat('LLLL yyyy', { locale: getLocale() }))

function shift(steps: number): void {
  const next = monthOffset.value - steps
  if (next < 0) return
  monthOffset.value = next
}

function windowOf(start: DateTime) {
  return { createdFrom: start.toISO() ?? '', createdTo: start.plus({ months: 1 }).toISO() ?? '' }
}

// The month's figures (Pinia Colada, composables/queries/admin.ts): one entry
// per month; a step shows the loader until the month answers.
const {
  data: stats,
  loading,
  error,
  retry,
} = adminFigures(
  useQuery(() => adminSupportStatsQuery(windowOf(monthStart.value))),
  // A failed read over the shown month (a return to the app) is told.
  (e) => toast.error(extractApiError(e, t('common.loadError'))),
)

// The month before, for the change under the total. Quiet: a failed or
// pending read just leaves the line out.
const previousQuery = useQuery(() =>
  adminSupportStatsQuery(windowOf(monthStart.value.minus({ months: 1 }))),
)
const delta = computed(() => {
  const now = stats.value
  const before = previousQuery.data.value
  return now && before
    ? t('console.support.stats.versusPrevious', { delta: signedDelta(now.total, before.total) })
    : ''
})

const totals = computed(() => ratingTotals(stats.value?.categories ?? []))
const averageText = computed(() =>
  totals.value.average === null ? '—' : totals.value.average.toFixed(1),
)
const shareText = computed(() =>
  totals.value.share === null ? '—' : `${Math.round(totals.value.share * 100)}%`,
)

function shareLabel(row: SupportStatsCategory): string {
  const share = categoryShare(row, stats.value?.total ?? 0)
  return share === null ? '—' : `${share}%`
}

/** One row's figures: "12 tickets · 3 rated · avg 4.33 · 4-5: 67%". */
function figuresLine(row: SupportStatsFigures & { tickets?: number }): string {
  const parts: string[] = []
  if (row.tickets !== undefined) {
    parts.push(t('adminScreens.adminSupportStats.ticketsCount', { count: row.tickets }))
  }
  parts.push(t('adminScreens.adminSupportStats.ratedCount', { count: row.rated }))
  parts.push(
    row.average === null
      ? t('adminScreens.adminSupportStats.noAverage')
      : t('adminScreens.adminSupportStats.average', { average: row.average.toFixed(2) }),
  )
  parts.push(
    row.share_4_5 === null
      ? t('adminScreens.adminSupportStats.noShare')
      : t('adminScreens.adminSupportStats.share', { share: Math.round(row.share_4_5 * 100) }),
  )
  return parts.join(' · ')
}

const resolverColumns = computed<ConsoleTableColumn[]>(() => [
  { key: 'name', label: t('console.support.stats.columns.admin') },
  { key: 'rated', label: t('console.support.stats.columns.rated'), width: 80, align: 'end' },
  { key: 'average', label: t('console.support.stats.columns.average'), width: 80, align: 'end' },
  { key: 'share', label: t('console.support.stats.columns.share'), width: 90, align: 'end' },
])

const resolverRows = computed(() =>
  (stats.value?.resolvers ?? []).map((row, i) => ({
    key: row.admin?.user_id ?? `unnamed-${i}`,
    name: row.admin?.name ?? t('adminScreens.adminSupport.claimedBy.adminFallback'),
    rated: row.rated,
    average: row.average === null ? '—' : row.average.toFixed(2),
    share: row.share_4_5 === null ? '—' : `${Math.round(row.share_4_5 * 100)}%`,
  })),
)
</script>

<style scoped>
.support-stats {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.support-stats__nav {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.support-stats__step {
  width: var(--velo-size-40);
  height: var(--velo-size-40);
  border: var(--velo-border-width) solid var(--velo-glass-border);
  border-radius: var(--radius-full);
  background: var(--velo-bg-card-solid);
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
  cursor: pointer;
}

.support-stats__step:disabled {
  opacity: 0.4;
  cursor: default;
}

.support-stats__month {
  min-width: 160px;
  text-align: center;
  font-size: var(--velo-fs-16);
  color: var(--velo-text-primary);
}

.support-stats__center {
  display: flex;
  justify-content: center;
  padding: var(--space-6) 0;
}

.support-stats__tiles {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-4);
}

@media (max-width: 1199px) {
  .support-stats__tiles {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .support-stats__cards {
    grid-template-columns: minmax(0, 1fr);
  }
}

.support-stats__tile {
  gap: var(--space-1);
}

.support-stats__label {
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
}

.support-stats__value {
  font-size: var(--velo-fs-28);
  color: var(--velo-text-primary);
  -webkit-text-stroke: var(--velo-text-stroke-strong);
}

.support-stats__note {
  font-size: var(--velo-fs-12);
  color: var(--velo-text-muted);
}

.support-stats__cards {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--space-4);
  align-items: start;
}

.support-stats__cats {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.support-stats__cat {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.support-stats__cat-head {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  font-size: var(--velo-fs-14);
  color: var(--velo-text-primary);
}

.support-stats__track {
  position: relative;
  height: 10px;
  overflow: hidden;
  border-radius: var(--velo-radius-badge);
  background: var(--velo-glass-blue-15);
}

.support-stats__fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: var(--velo-radius-badge);
  background: var(--velo-primary);
}

.support-stats__figures {
  font-size: var(--velo-fs-12);
  color: var(--velo-text-muted);
}

.support-stats__empty {
  margin: 0;
  padding: var(--space-4);
  font-size: var(--velo-fs-14);
  color: var(--velo-text-muted);
}
</style>
