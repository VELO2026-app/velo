<!--
  VELO Frontend -- AdminSupportStatsView (FE-107 / BE-162 delivery 3)

  Support over a period of APPEALS: GET /api/v1/support/stats?created_from&
  created_to -- the six categories (tickets, rated, average, share of 4-5),
  the totals, spam, and per admin a rating is about. One MONTH at a time,
  the admin's own month ([00:00 of the 1st, 00:00 of the next 1st) in their
  users.timezone), ISO with the offset -- the backend refuses a time without
  a zone; `from` inclusive, `to` exclusive, everything by the appeal's date.

  WHERE THIS LIVES IS THE GATE'S CALL (the ticket's own words: dashboard of
  «Модерация» or its own screen). Until the gate rules, it is its own screen
  one hop from the «Обращения» list whose filters it sums; the look is
  functional, on the existing components and --velo-* tokens.

  `average` arrives rounded to hundredths, `share_4_5` as 0..1 to
  thousandths; both null when nothing was rated -- no rating is not a zero,
  and the rows say «—» rather than 0.00.

  Route: /admin/support/stats (name 'admin-support-stats', before
  support/:id so the literal segment wins).
-->

<template>
  <div class="stats">
    <header class="stats__top">
      <VBackButton @click="router.back()" />
      <span class="stats__title">{{ t('adminScreens.adminSupportStats.title') }}</span>
      <span class="stats__range">{{ monthLabel }}</span>
    </header>

    <!-- Month nav: one step back in time; forward only up to the current
         month (the future has no appeals yet). -->
    <div class="stats__nav">
      <button
        type="button"
        class="stats__nav-btn"
        :aria-label="t('adminScreens.adminSupportStats.prevMonth')"
        data-testid="stats-prev"
        @click="shift(-1)"
      >
        ‹
      </button>
      <span class="stats__nav-label">{{ monthLabel }}</span>
      <button
        type="button"
        class="stats__nav-btn"
        :disabled="monthOffset === 0"
        :aria-label="t('adminScreens.adminSupportStats.nextMonth')"
        data-testid="stats-next"
        @click="shift(1)"
      >
        ›
      </button>
    </div>

    <div v-if="loading" class="stats__loader"><VLoader size="lg" /></div>

    <VEmptyState
      v-else-if="error"
      icon="warning"
      :title="t('common.loadFailed')"
      :description="error"
    >
      <VButton size="sm" variant="outline" @click="load">{{ t('common.retry') }}</VButton>
    </VEmptyState>

    <template v-else-if="stats">
      <div class="stats__totals">
        <VStatCard :value="stats.total" :label="t('adminScreens.adminSupportStats.total')" />
        <VStatCard :value="stats.spam" :label="t('adminScreens.adminSupportStats.spam')" />
      </div>

      <h3 class="stats__section">{{ t('adminScreens.adminSupportStats.categories') }}</h3>
      <VCard class="stats__rows">
        <div
          v-for="row in stats.categories"
          :key="row.category"
          class="stats__row"
          data-testid="stats-category-row"
        >
          <span class="stats__row-name">{{ supportCategoryLabel(row.category) }}</span>
          <span class="stats__row-figures">{{ figuresLine(row) }}</span>
        </div>
      </VCard>

      <h3 class="stats__section">{{ t('adminScreens.adminSupportStats.resolvers') }}</h3>
      <VCard v-if="stats.resolvers.length" class="stats__rows">
        <div
          v-for="(row, i) in stats.resolvers"
          :key="row.admin?.user_id ?? i"
          class="stats__row"
          data-testid="stats-resolver-row"
        >
          <span class="stats__row-name">{{
            row.admin?.name ?? t('adminScreens.adminSupport.claimedBy.adminFallback')
          }}</span>
          <span class="stats__row-figures">{{ figuresLine(row) }}</span>
        </div>
      </VCard>
      <p v-else class="stats__empty">{{ t('adminScreens.adminSupportStats.noRatings') }}</p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { t, getLocale } from '@/locales'
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { VBackButton, VButton, VCard, VEmptyState, VLoader, VStatCard } from '@/components/ui'
import { DateTime } from 'luxon'
import { useAuthStore } from '@/stores/auth'
import { extractApiError } from '@/composables/useApiError'
import { getSupportStats, type SupportStats, type SupportStatsFigures } from '@/api/support'
import { supportCategoryLabel } from '@/utils/supportTopics'

const router = useRouter()
const authStore = useAuthStore()

/** 0 = the current month; each step is one month further back. */
const monthOffset = ref(0)
const stats = ref<SupportStats | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

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
  void load()
}

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const from = monthStart.value
    stats.value = await getSupportStats(from.toISO() ?? '', from.plus({ months: 1 }).toISO() ?? '')
  } catch (e) {
    error.value = extractApiError(e, t('common.loadError'))
  } finally {
    loading.value = false
  }
}

onMounted(load)

/** One row's figures: «12 обращений · 3 с оценкой · ср. 4.33 · 4–5: 67%»
 *  (a resolver row has no tickets of its own -- the rated count leads). */
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
      : t('adminScreens.adminSupportStats.share', {
          share: Math.round(row.share_4_5 * 100),
        }),
  )
  return parts.join(' · ')
}
</script>

<style scoped>
.stats {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.stats__top {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: var(--velo-size-44);
}

.stats__title {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

.stats__range {
  margin-left: auto;
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
}

.stats__nav {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-4);
}

.stats__nav-btn {
  width: var(--velo-size-40);
  height: var(--velo-size-40);
  border: var(--velo-border-width) solid var(--velo-glass-border);
  border-radius: var(--radius-full);
  background: none;
  color: var(--velo-text-primary);
  font-size: var(--text-lg);
  cursor: pointer;
}

.stats__nav-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.stats__nav-label {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  min-width: 160px;
  text-align: center;
}

.stats__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-6) 0;
}

.stats__totals {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}

.stats__section {
  font-family: var(--font-body);
  font-size: var(--text-base);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: var(--velo-gap-2) 0 0;
}

.stats__rows {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.stats__row {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.stats__row-name {
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

.stats__row-figures {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
}

.stats__empty {
  margin: 0;
  text-align: center;
  color: var(--velo-text-muted);
  font-size: var(--text-sm);
  padding: var(--space-4) 0;
}
</style>
