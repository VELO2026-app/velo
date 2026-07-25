<!--
  VELO Frontend -- AdminDashboardView (Admin DS rebuild 2026-06-14)

  Admin dashboard, rebuilt to the operator's design (SVG: ПАНЕЛЬ / 1 Dashboard).
  Rendered inside AdminShell -> AdminLayout (fog feed + 24px rail + VAdminTabBar).

  Structure (DS-first — every value is a --velo-* token / DS component):
    - Header: "Admin" + an eye/observe button (stub until its target screen lands).
    - Alert banners: masters awaiting verification (warning) + reports awaiting
      moderation (alert) — shown only when their count > 0.
    - Статистика: title + period toggle (Неделя / Месяц, user/master pattern) +
      3 VStatCard + a week stepper.
    - Выручка: amount card + "Баланс по мастерам" link.
    - Engagement: 3 VProgressRow (Check-in / Feedback / Return rate).

  DATA SOURCES:
    - Stat cards (Практик/Мастеров/Участников) + percent deltas + revenue come
      from the period-scoped /admin/stats/overview (E7), refetched on the
      Неделя/Месяц toggle and the ← / → period stepper (offset).
    - Alert banners + tab badges come from /admin/stats (cumulative pending
      counts) via adminStore.fetchDashboard.
    - Engagement rates (Check-in/Feedback/Return) still use the per-metric
      endpoints here; they are rewired to period+offset in a follow-up.
-->

<template>
  <div class="admin-dashboard">
    <!-- Header (scrolls within the fog feed, like the master greeting) -->
    <div class="admin-dashboard__header">
      <h1 class="admin-dashboard__title">Admin</h1>
      <button
        class="admin-dashboard__eye"
        aria-label="Профиль"
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
        @click="router.push({ name: 'admin-reports' })"
      >
        <template #icon><IconWarning :size="28" /></template>
      </Banner>

      <!-- Статистика: title + period toggle -->
      <div class="admin-dashboard__section">
        <span class="admin-dashboard__section-title">Статистика</span>
        <VSegment
          compact
          :model-value="period"
          :options="periodOptions"
          aria-label="Период статистики"
          @update:model-value="selectPeriod"
        />
      </div>

      <div class="admin-dashboard__stats">
        <VStatCard
          :value="practicesValue"
          label="Практик"
          :delta="practicesDelta"
          :delta-tone="practicesDeltaTone"
          clickable
          @click="router.push({ name: 'admin-practices' })"
        />
        <VStatCard
          :value="mastersValue"
          label="Мастеров"
          :delta="mastersDelta"
          :delta-tone="mastersDeltaTone"
          clickable
          @click="router.push({ name: 'admin-masters' })"
        />
        <VStatCard
          :value="participantsValue"
          label="Участников"
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
          aria-label="Предыдущий период"
          @click="stepPrev"
        >
          <IconArrowRight :size="20" />
        </button>
        <span class="admin-dashboard__week-range">{{ periodRange }}</span>
        <button
          class="admin-dashboard__week-nav"
          aria-label="Следующий период"
          :disabled="!canStepNext"
          @click="stepNext"
        >
          <IconArrowRight :size="20" />
        </button>
      </div>

      <!-- Выручка -->
      <div class="admin-dashboard__section">
        <span class="admin-dashboard__section-title">Выручка</span>
      </div>
      <VCard class="admin-dashboard__revenue">
        <div class="admin-dashboard__revenue-amount">{{ revenueValue }}</div>
        <div v-if="revenueDelta" class="admin-dashboard__revenue-delta">{{ revenueDelta }}</div>
      </VCard>
      <VMoreLink label="Баланс по мастерам" @click="router.push({ name: 'admin-revenue' })" />
      <VListRow
        title="Выплаты"
        subtitle="Запросы мастеров на вывод"
        clickable
        @click="router.push({ name: 'admin-withdrawals' })"
      >
        <template #trailing><IconArrowRight :size="20" /></template>
      </VListRow>
      <VListRow
        title="Промокоды"
        subtitle="Все промокоды: платформы и мастеров"
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

      <!-- Система: пользователи + заявки на смену методов -->
      <div class="admin-dashboard__section">
        <span class="admin-dashboard__section-title">Система</span>
      </div>
      <VListRow
        title="Пользователи"
        subtitle="Все пользователи · назначение мастеров"
        clickable
        @click="router.push({ name: 'admin-users' })"
      >
        <template #trailing><IconArrowRight :size="20" /></template>
      </VListRow>
      <VListRow
        title="Заявки на смену методов"
        subtitle="Мастера меняют свои направления"
        clickable
        @click="router.push({ name: 'admin-method-requests' })"
      >
        <template #trailing>
          <span class="admin-dashboard__row-trailing">
            <VBadge v-if="pendingMethodChanges > 0" variant="error">{{ pendingMethodChanges }}</VBadge>
            <IconArrowRight :size="20" />
          </span>
        </template>
      </VListRow>
      <VListRow
        title="Каталог практик"
        subtitle="Направления и виды практик"
        clickable
        @click="router.push({ name: 'admin-catalog' })"
      >
        <template #trailing><IconArrowRight :size="20" /></template>
      </VListRow>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { VStatCard, VCard, VLoader, VProgressRow, VListRow, VBadge, VMoreLink, VSegment } from '@/components/ui'
import type { SegmentOption } from '@/components/ui/VSegment.vue'
import Banner from '@/components/shared/Banner.vue'
import { IconProfile, IconPending, IconWarning, IconArrowRight } from '@/components/icons'
import { useAdminStore } from '@/stores/admin'
import { getCheckinMetric, getFeedbackMetric, getReturnMetric, getAdminRevenue } from '@/api/admin'
import { formatMoney } from '@/utils/format'
import { formatPeriodRange } from '@/utils/periodRange'
import { plural } from '@/utils/plural'
import { useToast } from '@/composables/useToast'

const router = useRouter()
const adminStore = useAdminStore()
const toast = useToast()

// Period toggle (Неделя/Месяц) + stepper offset (0 = current, -1 = previous …).
const period = ref<'week' | 'month'>('week')
const periodOffset = ref(0)

const periodOptions: SegmentOption[] = [
  { value: 'week', label: 'Неделя' },
  { value: 'month', label: 'Месяц' },
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

const loading = computed((): boolean => adminStore.loading && !adminStore.stats)

const pendingVerifications = computed((): number => adminStore.pendingVerifications)
const pendingModeration = computed((): number => adminStore.pendingModeration)
// A2: unread indicator for incoming master method-change requests.
const pendingMethodChanges = computed((): number => adminStore.pendingMethodChanges)

const verificationTitle = computed(
  (): string =>
    `${pendingVerifications.value} ${plural(pendingVerifications.value, 'мастер', 'мастера', 'мастеров')} на верификации`,
)
const moderationTitle = computed(
  (): string =>
    `${pendingModeration.value} ${plural(pendingModeration.value, 'обращение', 'обращения', 'обращений')} на модерации`,
)

// =========================================================================
// Stat cards (period-new, option А): values + percent deltas come from the
// period-scoped overview (E7). Практик = practices scheduled in period,
// Мастеров = new masters, Участников = new users. Deltas are period-over-period
// percent (green up / rose down); null (no prior base) hides the trend line.
// =========================================================================
const overview = computed(() => adminStore.overview)

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
const revenueCents = ref<number | null>(null)
const revenueValue = computed((): string =>
  revenueCents.value !== null ? formatMoney(revenueCents.value, 'EUR', 'ru', true) : '—',
)
const revenueDelta = computed((): string => '')

// Engagement headline rates (E9). Fetched best-effort on mount; a failed metric
// leaves its row at an empty track + "—". The detail screens carry the breakdown.
const checkinRate = ref<number | null>(null)
const feedbackRate = ref<number | null>(null)
const returnRate = ref<number | null>(null)

async function loadEngagement(): Promise<void> {
  const p = period.value
  const off = periodOffset.value
  const [checkin, feedback, ret, revenue] = await Promise.allSettled([
    getCheckinMetric(p, off),
    getFeedbackMetric(p, off),
    getReturnMetric(p, off),
    getAdminRevenue(p, off),
  ])
  if (checkin.status === 'fulfilled') checkinRate.value = checkin.value.rate_pct
  if (feedback.status === 'fulfilled') feedbackRate.value = feedback.value.rate_pct
  if (ret.status === 'fulfilled') returnRate.value = ret.value.rate_pct
  if (revenue.status === 'fulfilled') revenueCents.value = revenue.value.revenue_cents
}

// Navigated period label (shared util so the Engagement drill-in shows the same
// week — batch P, P1).
const periodRange = computed((): string => formatPeriodRange(period.value, periodOffset.value))

// Query carried into the Engagement drill-in views so they fetch the SELECTED
// week/month, not the current one (P1). offset is stringified for the URL.
const engagementQuery = computed(() => ({
  period: period.value,
  offset: String(periodOffset.value),
}))

// Refetch the overview + engagement rates whenever the period or the stepper
// offset changes (D1/D3 cards + D4/D5 engagement share one window).
// W14 fix (ПРОМТ №409): fetchOverview used to be an unhandled rejection on
// failure -- the stat cards just silently stayed stale. Toast here (the sole
// caller of fetchOverview, so no double-toast risk with AdminShell's own
// fetchDashboard toast).
function loadOverview(): void {
  void adminStore.fetchOverview(period.value, periodOffset.value).then(() => {
    if (adminStore.overviewError) toast.error(adminStore.overviewError)
  })
}

watch([period, periodOffset], () => {
  loadOverview()
  void loadEngagement()
})

onMounted(() => {
  void adminStore.fetchDashboard()
  loadOverview()
  void loadEngagement()
})
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
  font-size: var(--text-lg);
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
  font-size: var(--text-base);
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
  font-size: var(--text-sm);
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
  font-size: var(--text-xl);
  color: var(--velo-text-primary);
  letter-spacing: var(--velo-letter-spacing-064);
  line-height: 1.1;
}

.admin-dashboard__revenue-delta {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-teal-600);
}

/* -- Engagement -- */
.admin-dashboard__engagement {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}
</style>
