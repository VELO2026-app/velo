<!--
  VELO Frontend -- AdminDashboardView (Admin DS rebuild 2026-06-14)

  Admin dashboard, rebuilt to the operator's design (SVG: Panel / 1 Dashboard).
  Rendered inside AdminShell -> AdminLayout (fog feed + 24px rail + VAdminTabBar).

  Structure (DS-first — every value is a --velo-* token / DS component):
    - Header: "Admin" + an eye/observe button (stub until its target screen lands).
    - Alert banners: masters awaiting verification (warning) + reports awaiting
      moderation (alert) — shown only when their count > 0.
    - Statistics (i18n:adminScreens.adminDashboard.statistics): title + period
      toggle (i18n:common.periodWeek / i18n:common.periodMonth, user/master
      pattern) + 3 VStatCard + a week stepper.
    - Revenue (i18n:adminScreens.adminDashboard.revenue): amount card + the
      masters-balance link (i18n:adminScreens.adminDashboard.mastersBalance).
    - Engagement: 3 VProgressRow (Check-in / Feedback / Return rate).

  DATA SOURCES:
    Every read is a Pinia Colada query (composables/queries/admin.ts, FE-181).
    - Stat cards (i18n:adminScreens.adminDashboard.practicesStat /
      i18n:adminScreens.adminDashboard.mastersStat /
      i18n:adminScreens.adminDashboard.participantsStat) + percent deltas
      come from the period-scoped /admin/stats/overview (E7), one entry per
      i18n:common.periodWeek / i18n:common.periodMonth toggle and ← / →
      period stepper (offset) position.
    - Alert banners + tab badges come from /admin/stats (cumulative pending
      counts), the entry the shell's badges read.
    - Revenue and the engagement rates (Check-in/Feedback/Return) come from
      /admin/revenue and the per-metric endpoints for the same window, one
      entry per figure and window.
-->

<template>
  <div class="admin-dashboard">
    <!-- Header (scrolls within the fog feed, like the master greeting) -->
    <div class="admin-dashboard__header">
      <h1 class="admin-dashboard__title">Admin</h1>
      <button
        class="admin-dashboard__eye"
        :aria-label="t('adminScreens.adminDashboard.profileAria')"
        @click="router.push({ name: 'admin-profile' })"
      >
        <IconProfile :size="22" />
      </button>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="admin-dashboard__loader">
      <VLoader size="lg" />
    </div>

    <template v-else>
      <!-- Counters unread: the missing banners would read as "nothing pending" (FE-242). -->
      <Banner
        v-if="countersFailed"
        variant="alert"
        :title="t('common.loadError')"
        data-testid="counters-error"
      >
        <template #icon><IconWarning :size="28" /></template>
        <template #body>
          <VButton size="sm" variant="outline" @click="adminStats.reload()">{{
            t('common.retry')
          }}</VButton>
        </template>
      </Banner>

      <!-- Alert banners -->
      <Banner
        v-if="pendingVerifications > 0"
        variant="warning"
        :title="verificationTitle"
        clickable
        @click="router.push({ name: 'admin-masters' })"
      >
        <template #icon><IconPending :size="28" /></template>
      </Banner>
      <Banner
        v-if="pendingModeration > 0"
        variant="alert"
        :title="moderationTitle"
        clickable
        @click="router.push({ name: 'admin-reports', query: { tab: 'complaints' } })"
      >
        <template #icon><IconWarning :size="28" /></template>
      </Banner>

      <!-- Statistics (i18n:adminScreens.adminDashboard.statistics): title + period toggle -->
      <div class="admin-dashboard__section">
        <span class="admin-dashboard__section-title">{{
          t('adminScreens.adminDashboard.statistics')
        }}</span>
        <VSegment
          compact
          :model-value="period"
          :options="periodOptions"
          :aria-label="t('analytics.statsPeriod')"
          @update:model-value="selectPeriod"
        />
      </div>

      <div class="admin-dashboard__stats">
        <VStatCard
          :value="practicesValue"
          :label="t('adminScreens.adminDashboard.practicesStat')"
          :delta="practicesDelta"
          :delta-tone="practicesDeltaTone"
          clickable
          @click="router.push({ name: 'admin-practices' })"
        />
        <VStatCard
          :value="mastersValue"
          :label="t('adminScreens.adminDashboard.mastersStat')"
          :delta="mastersDelta"
          :delta-tone="mastersDeltaTone"
          clickable
          @click="router.push({ name: 'admin-masters' })"
        />
        <VStatCard
          :value="participantsValue"
          :label="t('adminScreens.adminDashboard.participantsStat')"
          :delta="participantsDelta"
          :delta-tone="participantsDeltaTone"
          clickable
          @click="router.push({ name: 'admin-participants' })"
        />
      </div>

      <!-- Period stepper: ← / → over the navigated week/month (D3) -->
      <div class="admin-dashboard__week">
        <button
          class="admin-dashboard__week-nav admin-dashboard__week-nav--prev"
          :aria-label="t('adminScreens.adminDashboard.prevPeriod')"
          @click="stepPrev"
        >
          <IconArrowRight :size="20" />
        </button>
        <span class="admin-dashboard__week-range">{{ periodRange }}</span>
        <button
          class="admin-dashboard__week-nav"
          :aria-label="t('adminScreens.adminDashboard.nextPeriod')"
          :disabled="!canStepNext"
          @click="stepNext"
        >
          <IconArrowRight :size="20" />
        </button>
      </div>

      <!-- Revenue (i18n:adminScreens.adminDashboard.revenue) -->
      <div class="admin-dashboard__section">
        <span class="admin-dashboard__section-title">{{
          t('adminScreens.adminDashboard.revenue')
        }}</span>
      </div>
      <VCard class="admin-dashboard__revenue">
        <div class="admin-dashboard__revenue-amount">{{ revenueValue }}</div>
        <div v-if="revenueDelta" class="admin-dashboard__revenue-delta">{{ revenueDelta }}</div>
      </VCard>
      <VMoreLink
        :label="t('adminScreens.adminDashboard.mastersBalance')"
        @click="router.push({ name: 'admin-revenue' })"
      />
      <!-- FE-112 (tz-whitelabel §4): the payout queue is the payments
           option's admin surface -- with the option off (FE-151) there is
           no dashboard entry leading to a closed route. -->
      <VListRow
        v-if="paymentsEnabled"
        :title="t('adminScreens.adminDashboard.payoutsSection')"
        :subtitle="t('adminScreens.adminDashboard.withdrawalRequestsLink')"
        clickable
        @click="router.push({ name: 'admin-withdrawals' })"
      >
        <template #trailing><IconArrowRight :size="20" /></template>
      </VListRow>
      <VListRow
        :title="t('adminScreens.adminDashboard.promocodesSection')"
        :subtitle="t('adminScreens.adminDashboard.promocodesLink')"
        clickable
        @click="router.push({ name: 'admin-promos' })"
      >
        <template #trailing><IconArrowRight :size="20" /></template>
      </VListRow>

      <!-- Engagement -->
      <div class="admin-dashboard__section">
        <span class="admin-dashboard__section-title">Engagement</span>
      </div>
      <VCard class="admin-dashboard__engagement">
        <VProgressRow
          label="Check-in rate"
          :value="checkinRate"
          clickable
          @click="router.push({ name: 'admin-checkin-rate', query: engagementQuery })"
        />
        <VProgressRow
          label="Feedback rate"
          :value="feedbackRate"
          clickable
          @click="router.push({ name: 'admin-feedback-rate', query: engagementQuery })"
        />
        <VProgressRow
          label="Return rate"
          :value="returnRate"
          clickable
          @click="router.push({ name: 'admin-return-rate', query: engagementQuery })"
        />
      </VCard>

      <!-- System (i18n:adminScreens.adminDashboard.system): users + method-change requests (i18n:adminScreens.adminDashboard.methodRequestsLink) -->
      <div class="admin-dashboard__section">
        <span class="admin-dashboard__section-title">{{
          t('adminScreens.adminDashboard.system')
        }}</span>
      </div>
      <VListRow
        :title="t('adminScreens.adminDashboard.usersSection')"
        :subtitle="t('adminScreens.adminDashboard.usersLink')"
        clickable
        @click="router.push({ name: 'admin-users' })"
      >
        <template #trailing><IconArrowRight :size="20" /></template>
      </VListRow>
      <VListRow
        :title="t('adminScreens.adminDashboard.methodRequestsLink')"
        :subtitle="t('adminScreens.adminDashboard.methodRequestsHint')"
        clickable
        @click="router.push({ name: 'admin-method-requests' })"
      >
        <template #trailing>
          <span class="admin-dashboard__row-trailing">
            <VBadge v-if="pendingMethodChanges > 0" variant="error">{{
              pendingMethodChanges
            }}</VBadge>
            <IconArrowRight :size="20" />
          </span>
        </template>
      </VListRow>
      <VListRow
        :title="t('adminScreens.adminDashboard.catalogLink')"
        :subtitle="t('adminScreens.adminDashboard.catalogHint')"
        clickable
        @click="router.push({ name: 'admin-catalog' })"
      >
        <template #trailing><IconArrowRight :size="20" /></template>
      </VListRow>
    </template>
  </div>
</template>

<script setup lang="ts">
import { t, getLocale } from '@/locales'
import { ref, computed } from 'vue'
import { useQuery } from '@pinia/colada'
import { useRouter } from 'vue-router'
import {
  VStatCard,
  VCard,
  VLoader,
  VProgressRow,
  VListRow,
  VBadge,
  VMoreLink,
  VSegment,
  VButton,
} from '@/components/ui'
import type { SegmentOption } from '@/components/ui'
import Banner from '@/components/shared/Banner.vue'
import { IconProfile, IconPending, IconWarning, IconArrowRight } from '@/components/icons'
import {
  adminOverviewQuery,
  checkinMetricQuery,
  feedbackMetricQuery,
  onFailedRequest,
  returnMetricQuery,
  revenueQuery,
  useAdminStats,
} from '@/composables/queries/admin'
import { extractApiError } from '@/composables/useApiError'
import { formatMoney } from '@/utils/format'
import { formatPeriodRange } from '@/utils/periodRange'
import { useToast } from '@/composables/useToast'
import { isOptionEnabled } from '@/platform/instance'

const router = useRouter()
const adminStats = useAdminStats()
const toast = useToast()

// FE-112 (tz-whitelabel §4): hides the payouts card on instances with
// the payments option off (FE-151) (see the template comment at the row).
const paymentsEnabled = isOptionEnabled('payments')

// Period toggle (i18n:common.periodWeek / i18n:common.periodMonth) + stepper
// offset (0 = current, -1 = previous …).
const period = ref<'week' | 'month'>('week')
const periodOffset = ref(0)

const periodOptions: SegmentOption[] = [
  { value: 'week', label: t('common.periodWeek') },
  { value: 'month', label: t('common.periodMonth') },
]

// VSegment emits a plain string; narrow it back to the period union.
function selectPeriod(p: string): void {
  if (p !== 'week' && p !== 'month') return
  periodOffset.value = 0 // switching granularity resets to the current period
  period.value = p
}
function stepPrev(): void {
  periodOffset.value -= 1
}
function stepNext(): void {
  if (periodOffset.value < 0) periodOffset.value += 1 // no stepping into the future
}
const canStepNext = computed((): boolean => periodOffset.value < 0)

// The counters (queries/admin.ts, shared with the shell's badges): the
// loader stands only until their first answer; a failure is the shell's
// toast AND this screen's banner with Retry (an absent banner would read as
// "nothing pending", FE-242).
const loading = adminStats.loading
const countersFailed = adminStats.failed

const pendingVerifications = adminStats.pendingVerifications
const pendingModeration = adminStats.pendingModeration
// A2: unread indicator for incoming master method-change requests.
const pendingMethodChanges = adminStats.pendingMethodChanges

// The period window every figure below answers (the selected one).
const periodWindow = computed(() => ({ period: period.value, offset: periodOffset.value }))

const verificationTitle = computed(() =>
  t('adminScreens.adminDashboard.verificationBanner', pendingVerifications.value),
)
const moderationTitle = computed(() =>
  t('adminScreens.adminDashboard.moderationBanner', pendingModeration.value),
)

// =========================================================================
// Stat cards (period-new, option A): values + percent deltas come from the
// period-scoped overview (E7). Practices (i18n:adminScreens.adminDashboard.practicesStat)
// = practices scheduled in period, masters (i18n:adminScreens.adminDashboard.mastersStat)
// = new masters, participants (i18n:adminScreens.adminDashboard.participantsStat) = new
// users. Deltas are period-over-period percent (green up / rose down); null
// (no prior base) hides the trend line.
// =========================================================================
// One entry per window; a period switch keeps the previous window's cards
// until the new answer lands, a failed one shows "—" (queries/admin.ts).
const overviewQuery = useQuery(() => adminOverviewQuery(periodWindow.value))
const overview = overviewQuery.data

function pctDelta(v: number | null | undefined): string {
  if (v === null || v === undefined) return ''
  return `${v >= 0 ? '+' : ''}${v}%`
}
function pctTone(v: number | null | undefined): 'up' | 'down' | 'muted' {
  if (v === null || v === undefined) return 'muted'
  return v >= 0 ? 'up' : 'down'
}

const practicesValue = computed((): string => String(overview.value?.practices_count ?? '—'))
const mastersValue = computed((): string => String(overview.value?.new_masters ?? '—'))
const participantsValue = computed((): string => String(overview.value?.new_users ?? '—'))
const practicesDelta = computed((): string => pctDelta(overview.value?.practices_delta_pct))
const mastersDelta = computed((): string => pctDelta(overview.value?.new_masters_delta_pct))
const participantsDelta = computed((): string => pctDelta(overview.value?.new_users_delta_pct))
const practicesDeltaTone = computed(() => pctTone(overview.value?.practices_delta_pct))
const mastersDeltaTone = computed(() => pctTone(overview.value?.new_masters_delta_pct))
const participantsDeltaTone = computed(() => pctTone(overview.value?.new_users_delta_pct))

// Revenue (E9). Weekly GMV from /admin/revenue, best-effort. €0.00 while seed
// practices are free (priced templates land with the seed-pricing task). Delta
// needs E7 (not delivered) -> blank.
const revenue = useQuery(() => revenueQuery(periodWindow.value))
const revenueValue = computed((): string => {
  const cents = revenue.data.value?.revenue_cents
  return cents !== undefined ? formatMoney(cents, 'EUR', getLocale(), true) : '—'
})
const revenueDelta = computed((): string => '')

// Engagement headline rates (E9), best-effort: each is its own query, so a
// failed metric leaves only its row at an empty track + "—". The detail
// screens carry the breakdown.
const checkin = useQuery(() => checkinMetricQuery(periodWindow.value))
const feedback = useQuery(() => feedbackMetricQuery(periodWindow.value))
const returning = useQuery(() => returnMetricQuery(periodWindow.value))
const checkinRate = computed((): number | null => checkin.data.value?.rate_pct ?? null)
const feedbackRate = computed((): number | null => feedback.data.value?.rate_pct ?? null)
const returnRate = computed((): number | null => returning.data.value?.rate_pct ?? null)

// Navigated period label (shared util so the Engagement drill-in shows the same
// week — batch P, P1).
const periodRange = computed((): string => formatPeriodRange(period.value, periodOffset.value))

// Query carried into the Engagement drill-in views so they fetch the SELECTED
// week/month, not the current one (P1). offset is stringified for the URL.
const engagementQuery = computed(() => ({
  period: period.value,
  offset: String(periodOffset.value),
}))

// W14 fix (PROMPT №409): a failed overview used to leave the stat cards
// silently stale. Toast it -- once per failed request (the shell toasts
// the counters, so no double toast).
onFailedRequest(overviewQuery, (error) =>
  toast.error(extractApiError(error, t('storeErrors.admin.overview'))),
)
</script>

<style scoped>
.admin-dashboard {
  /* Horizontal rail comes from AdminLayout's fog mode (--velo-rail-pad-x); the
     top/bottom clearance (under the header fade + over the tab bar) is the
     layout's too. Only the vertical rhythm between blocks lives here. */
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* -- Header -- */
.admin-dashboard__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: var(--velo-size-44);
}

.admin-dashboard__title {
  font-family: var(--font-heading);
  font-size: var(--velo-fs-20);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: 0;
}

.admin-dashboard__eye {
  width: var(--velo-size-40);
  height: var(--velo-size-40);
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-full);
  background: var(--velo-primary);
  color: var(--velo-white);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.admin-dashboard__eye:active {
  opacity: 0.85;
}

/* -- Loader -- */
.admin-dashboard__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-8) 0;
}

/* -- Section header (+ optional period toggle) -- */
.admin-dashboard__section {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.admin-dashboard__section-title {
  font-family: var(--font-body);
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

/* A2: trailing badge + chevron on the method-requests row */
.admin-dashboard__row-trailing {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

/* -- Stats grid -- */
.admin-dashboard__stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-3);
}

/* -- Week stepper -- */
.admin-dashboard__week {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--space-1);
}

.admin-dashboard__week-nav {
  width: var(--velo-size-60);
  height: var(--velo-size-35);
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-xl);
  background: var(--velo-white);
  color: var(--velo-text-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.admin-dashboard__week-nav:active {
  opacity: 0.8;
}

/* Reuse the single arrow glyph, mirrored for "previous". */
.admin-dashboard__week-nav--prev {
  transform: scaleX(-1);
}

.admin-dashboard__week-range {
  font-family: var(--font-body);
  font-size: var(--velo-fs-16);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

/* -- Revenue -- */
.admin-dashboard__revenue {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.admin-dashboard__revenue-amount {
  font-family: var(--font-heading);
  font-size: var(--velo-fs-32);
  color: var(--velo-text-primary);
  letter-spacing: var(--velo-letter-spacing-05);
  line-height: 1.1;
}

.admin-dashboard__revenue-delta {
  font-family: var(--font-body);
  font-size: var(--velo-fs-18);
  color: var(--velo-teal-600);
}

/* -- Engagement -- */
.admin-dashboard__engagement {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}
</style>
