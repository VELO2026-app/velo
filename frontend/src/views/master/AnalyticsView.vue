<!--
  VELO Frontend -- AnalyticsView (master analytics, FE-190)

  Master analytics hub. Route: /master/analytics (inside MasterShell). Built
  after the school's analytics screen (SchoolAnalyticsView), one server
  aggregate per calendar period (GET /masters/me/analytics?period=, BE-34;
  the practices list is BE-222):

    1. Header + the period slider: week / month / quarter
       (i18n:common.periodWeek, i18n:common.periodMonth,
       i18n:user.screens.schoolAnalytics.period.quarter). A tap refetches; the
       last selected period wins and an earlier period's numbers are never
       left under the new label -- a failed request swaps the screen for the
       retry state.
    2. Check-in / Feedback rates (the server's percents).
    3. The feedback share (i18n:user.screens.schoolAnalytics.feedbackPercent):
       the shared DistributionCard, "N of M" on the heading line.
    4. Needs attention (i18n:masterScreens.analytics.sections.attention):
       students whose review the server flagged (attention=true, BE-77); the
       section is not shown when there are none.
    5. The period's conducted practices (the shared ConductedPracticeCard,
       first PAST_PREVIEW then the reveal), each with its before / after /
       came-left / reviews blocks. A tap opens the practice analytics screen.

  Payments tab: parked (owner 2026-10-01, PAYMENTS_TAB_ENABLED below) -- the
  pane and its E2 wiring stay intact for the flip-back.
-->

<template>
  <div class="analytics">
    <VHeader :title="t('masterScreens.analytics.title')" />

    <!-- Tab segment (track+thumb, DS primitive). Parked while payments are
         not live (owner 2026-10-01) -- a single-option slider is meaningless. -->
    <VSegmentTrack
      v-if="PAYMENTS_TAB_ENABLED"
      v-model="activeTab"
      :options="TAB_OPTIONS"
      variant="tabs"
    />

    <!-- ================================================================
         TAB: REVIEWS
         ================================================================ -->
    <div v-show="activeTab === 'reviews'" class="analytics__body">
      <!-- Full-width period slider (variant="tabs": equal segments). -->
      <VSegmentTrack
        v-model="period"
        class="analytics__period"
        :options="PERIOD_OPTIONS"
        variant="tabs"
        :aria-label="t('analytics.statsPeriod')"
      />

      <div v-if="loading" class="analytics__loader"><VLoader size="lg" /></div>

      <!-- Transient failure: honest retry, no stale numbers. -->
      <VEmptyState
        v-else-if="failed"
        icon="warning"
        :title="t('common.loadFailed')"
        :description="t('common.checkConnection')"
      >
        <template #action>
          <VButton variant="outline" @click="retry">{{ t('common.retry') }}</VButton>
        </template>
      </VEmptyState>

      <template v-else-if="data">
        <div class="analytics__stats">
          <VStatCard :value="`${Math.round(data.checkin_rate_pct)}%`" label="Check-in" />
          <VStatCard :value="`${Math.round(data.feedback_rate_pct)}%`" label="Feedback" />
        </div>

        <DistributionCard
          :title="t('user.screens.schoolAnalytics.feedbackPercent')"
          :count-label="feedbackCountLabel"
          :bars="feedbackBars"
          :empty-text="t('user.screens.schoolAnalytics.noFeedbacks')"
        />

        <!-- Needs attention: the server already narrowed the page to the
             attention reviews (attention=true: ratings 1-4, zones bad and low,
             BE-77). The section (heading included) is NOT shown when there are
             none. Card tap goes to the student's profile; the message button
             is @click.stop -- it sends a message without navigating. -->
        <section v-if="attentionItems.length > 0" class="analytics__section">
          <h2 class="velo-section-title">{{ t('masterScreens.analytics.sections.attention') }}</h2>
          <div
            v-for="(item, i) in attentionItems"
            :key="i"
            class="analytics__attention"
            role="button"
            tabindex="0"
            @click="goStudent(item)"
            @keydown.enter.space.prevent="goStudent(item)"
          >
            <span class="analytics__attention-ident">
              <component :is="MOOD_SCALE_ICON[item.rating]" :size="36" />
            </span>
            <div class="analytics__attention-body">
              <div class="analytics__attention-name">{{ item.reviewer_name }}</div>
              <div class="analytics__attention-pr">{{ item.practice_title }}</div>
              <div v-if="item.comment" class="analytics__attention-quote">«{{ item.comment }}»</div>
            </div>
            <button
              class="analytics__attention-msg"
              :aria-label="t('common.writeMessage')"
              @click.stop="openMessage(item.user_id, item.reviewer_name)"
            >
              <IconMessages :size="22" />
            </button>
          </div>
        </section>

        <!-- The period's conducted practices, newest first. -->
        <section class="analytics__section">
          <h2 class="velo-section-title">{{ periodSectionTitle }}</h2>

          <VEmptyState
            v-if="periodPractices.length === 0"
            variant="note"
            :title="t('masterScreens.analytics.empty.noPractices')"
          />

          <template v-else>
            <ConductedPracticeCard
              v-for="p in visiblePractices"
              :key="p.practice.practice_id"
              class="analytics__practice"
              :practice="p.practice"
              :detail="p.detail"
              clickable
              @open="openReviews"
            />

            <!-- First PAST_PREVIEW + the reveal (i18n:masterScreens.analytics.morePractices). -->
            <VShowMore
              v-if="!practicesExpanded && hiddenPracticesCount > 0"
              plus
              :label="t('masterScreens.analytics.morePractices', hiddenPracticesCount)"
              @click="practicesExpanded = true"
            />
          </template>
        </section>
      </template>
    </div>

    <!-- ================================================================
         TAB: PAYMENTS
         ================================================================ -->
    <div v-if="PAYMENTS_TAB_ENABLED" v-show="activeTab === 'payments'" class="analytics__body">
      <div v-if="paymentsLoading" class="analytics__loader"><VLoader /></div>

      <VCard v-else-if="paymentsError" class="analytics__pay-error">
        <p class="analytics__empty">{{ paymentsError }}</p>
        <VButton size="sm" variant="outline" @click="loadPayments">{{ t('common.retry') }}</VButton>
      </VCard>

      <template v-else>
        <!-- Income (E2: getIncome by period; delta_pct vs previous period). -->
        <div class="analytics__income">
          <div class="analytics__income-value">{{ income }}</div>
          <div class="analytics__income-label">
            {{ t('masterScreens.analytics.sections.revenue') }}
          </div>
          <div
            v-if="incomeDelta"
            class="analytics__income-delta"
            :class="
              incomeDeltaPositive ? 'analytics__income-delta--up' : 'analytics__income-delta--down'
            "
          >
            {{ incomeDelta }}
          </div>
        </div>

        <!-- Transactions (E2: getTransactions — signed title-tagged ledger rows). -->
        <section class="analytics__section">
          <h2 class="velo-section-title">
            {{ t('masterScreens.analytics.sections.transactions') }}
          </h2>
          <div v-if="transactions.length > 0" class="analytics__txns">
            <div v-for="(tx, i) in transactions" :key="i" class="analytics__txn">
              <div class="analytics__txn-info">
                <div class="analytics__txn-title">{{ txnTitle(tx) }}</div>
                <div class="analytics__txn-meta">
                  {{ formatShortDate(tx.created_at)
                  }}<template v-if="tx.counterparty_name"> · {{ tx.counterparty_name }}</template>
                </div>
              </div>
              <div
                class="analytics__txn-amt"
                :class="tx.amount_cents >= 0 ? 'analytics__txn-amt--in' : 'analytics__txn-amt--out'"
              >
                {{ formatTxnAmount(tx.amount_cents) }}
              </div>
            </div>
            <div v-if="hasMoreTx" class="analytics__more">
              <VButton variant="ghost" @click="loadMoreTx">{{ t('common.showMore') }}</VButton>
            </div>
          </div>
          <VEmptyState v-else variant="note" :title="t('common.noData')" />
        </section>
      </template>
    </div>

    <!-- Needs-attention message flow: open the DM modal for the student. -->
    <SendMessageModal
      :open="msgOpen"
      :student-id="msgId"
      :name="msgName"
      @close="msgOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { t, getLocale } from '@/locales'
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useQuery } from '@pinia/colada'
import { masterAnalyticsQuery } from '@/composables/queries/master'
import { screenQueryState } from '@/composables/queries/screenState'
import { VLoader, VButton, VStatCard, VCard, VSegmentTrack, VEmptyState } from '@/components/ui'
import { VHeader } from '@/components/layout'
import ConductedPracticeCard from '@/components/shared/ConductedPracticeCard.vue'
import { masterPracticeCard, moodStripBars } from '@/components/shared/conductedPractice'
import DistributionCard from '@/components/shared/DistributionCard.vue'
import VShowMore from '@/components/shared/VShowMore.vue'
import SendMessageModal from '@/components/shared/SendMessageModal.vue'
import { IconMessages } from '@/components/icons'
import { MOOD_SCALE_ICON } from '@/utils/ratingIcons'
import { formatMoney, formatShortDate } from '@/utils/format'
import {
  getIncome,
  getTransactions,
  getMasterReviews,
  type MasterAnalyticsPeriod,
} from '@/api/masters'
import { extractApiError } from '@/composables/useApiError'
import { PAYMENTS_TAB_ENABLED } from '@/views/master/analyticsFlags'
import type { IncomeResponse, MasterTransactionItem, MasterReviewItem } from '@/api/types'

const router = useRouter()

// =========================================================================
// Tabs (track+thumb segment) + period toggle (visual-only)
// =========================================================================

// The payments flag lives in ./analyticsFlags.ts (one copy, shared with the tests).

const activeTab = ref<'reviews' | 'payments'>('reviews')
const TAB_OPTIONS: Array<{ value: 'reviews' | 'payments'; label: string }> = [
  { value: 'reviews', label: t('masterScreens.analytics.sections.reviews') },
  { value: 'payments', label: t('masterScreens.analytics.sections.payments') },
]

// The slider names the calendar period the server bounds in the master's own
// timezone (GET /masters/me/analytics, BE-34); the screen sends the name only.
const period = ref<MasterAnalyticsPeriod>('week')
const PERIOD_OPTIONS: ReadonlyArray<{ value: MasterAnalyticsPeriod; label: string }> = [
  { value: 'week', label: t('common.periodWeek') },
  { value: 'month', label: t('common.periodMonth') },
  { value: 'quarter', label: t('user.screens.schoolAnalytics.period.quarter') },
]

// =========================================================================
// The period's analytics (Pinia Colada, one entry per period)
// =========================================================================

// An entry per period and no placeholder from the previous one (see
// masterAnalyticsQuery): while a period loads, the screen shows the loader --
// never another period's numbers under this period's label. The last selected
// period wins: a late answer lands in its own entry.
const analyticsQuery = useQuery(() => masterAnalyticsQuery(period.value))
const analyticsState = screenQueryState(analyticsQuery)
const data = computed(() => analyticsQuery.data.value ?? null)
const loading = computed(() => analyticsState.loading.value)
const failed = computed(() => analyticsState.failed.value)

function retry(): void {
  void analyticsQuery.refetch()
}

// The feedback block: reviews out of the period's bookings; the server owns the
// percent and both numbers, the screen divides nothing.
const feedbackCountLabel = computed((): string =>
  t('user.screens.schoolAnalytics.conversion', {
    pct: Math.round(data.value?.feedback_rate_pct ?? 0),
    reviews: data.value?.feedbacks_count ?? 0,
    visits: data.value?.bookings_count ?? 0,
  }),
)
const feedbackBars = computed(() => moodStripBars(data.value?.feedbacks))

// =========================================================================
// The period's conducted practices (BE-222), newest first
// =========================================================================

const periodSectionTitle = computed(
  (): string =>
    ({
      week: t('user.screens.schoolAnalytics.practicesOfWeek'),
      month: t('user.screens.schoolAnalytics.practicesOfMonth'),
      quarter: t('user.screens.schoolAnalytics.practicesOfQuarter'),
    })[period.value],
)
// The server's list (BE-222), newest first; an empty period is an empty list.
const periodPractices = computed(() =>
  (data.value?.conducted_practices ?? []).map(masterPracticeCard),
)

// First PAST_PREVIEW + the reveal (i18n:masterScreens.analytics.morePractices).
const PAST_PREVIEW = 3
const practicesExpanded = ref(false)
const visiblePractices = computed(() =>
  practicesExpanded.value ? periodPractices.value : periodPractices.value.slice(0, PAST_PREVIEW),
)
const hiddenPracticesCount = computed(() =>
  Math.max(0, periodPractices.value.length - PAST_PREVIEW),
)

// =========================================================================
// Latest reviews (#3: GET /masters/me/reviews — cross-practice named feed)
// =========================================================================

const REVIEWS_PAGE = 20
const reviews = ref<MasterReviewItem[]>([])

async function loadReviews(): Promise<void> {
  try {
    // E1: fetch the attention reviews server-side (attention=true: ratings
    // 1-4, BE-77) — the needs-attention block is the only consumer, so a
    // full page of them beats a mixed page where they may be sparse. The
    // server owns the threshold; the period cutoff still narrows client-side
    // (no period param on the endpoint).
    const res = await getMasterReviews(REVIEWS_PAGE, 0, true)
    reviews.value = res.items
  } catch {
    /* leave the section empty on error */
  }
}

// Needs attention: the server already narrowed the page to the attention
// reviews (attention=true) -- no zone check here, a second copy of the
// threshold would drift. Only the active period's cutoff is applied
// client-side (the endpoint has no period param). Empty ⇒ the section + title
// are hidden.
const PERIOD_DAYS: Record<MasterAnalyticsPeriod, number> = { week: 7, month: 30, quarter: 90 }
const attentionItems = computed((): MasterReviewItem[] => {
  const cutoff = Date.now() - PERIOD_DAYS[period.value] * 86_400_000
  return reviews.value.filter((r) => new Date(r.created_at).getTime() >= cutoff)
})

// E1 (PROMPT №229): tap an attention card → the reviewer's student profile
// (user_id now on MasterReviewItem). Mirrors PracticeReviewsView.goStudent.
function goStudent(item: MasterReviewItem): void {
  void router.push({
    name: 'master-student-profile',
    params: { id: item.user_id },
    query: { name: item.reviewer_name },
  })
}

// The message button (@click.stop) → open the send-message modal (which posts
// into the DM), as a distinct action that does not trigger the card's profile-nav.
const msgOpen = ref(false)
const msgId = ref('')
const msgName = ref('')
function openMessage(id: string, name: string): void {
  msgId.value = id
  msgName.value = name
  msgOpen.value = true
}

// =========================================================================
// Payments (E2: income by period + transaction feed)
// =========================================================================

const TX_PAGE = 20

const incomeData = ref<IncomeResponse | null>(null)
const transactions = ref<MasterTransactionItem[]>([])
const txTotal = ref(0)
const paymentsLoading = ref(false)
const paymentsError = ref<string | null>(null)
const hasMoreTx = computed((): boolean => transactions.value.length < txTotal.value)

// Income value + signed period delta. Currency canon = EUR; €0.00 while free seed.
const income = computed((): string =>
  incomeData.value ? formatMoney(incomeData.value.income_cents, 'EUR', getLocale(), true) : '—',
)
const incomeDeltaPositive = computed((): boolean => (incomeData.value?.delta_pct ?? 0) >= 0)
// delta_pct is null when the previous period had no net-positive turnover -> hidden.
const incomeDelta = computed((): string => {
  const d = incomeData.value?.delta_pct
  if (d == null) return ''
  const sign = d >= 0 ? '+' : '−'
  return `${sign}${Math.abs(Math.round(d))}%`
})

function formatTxnAmount(cents: number): string {
  const sign = cents >= 0 ? '+' : '−'
  return `${sign}${formatMoney(Math.abs(cents), 'EUR', getLocale(), true)}`
}

// M5: show the practice NAME instead of the generic stored ledger label
// (the backend's default "payment for a practice" transaction title).
// practice_title is added by the backend join; read it defensively
// because generated.ts is regenerated at deploy (not hand-edited here), so the
// field may be absent from the local type until then.
function txnTitle(t: MasterTransactionItem): string {
  const withPractice = t as MasterTransactionItem & { practice_title?: string | null }
  return withPractice.practice_title || t.title
}

async function loadIncome(): Promise<void> {
  // Income is bounded by week or month only: a quarter reads the month.
  incomeData.value = await getIncome(period.value === 'week' ? 'week' : 'month')
}

async function loadPayments(): Promise<void> {
  paymentsLoading.value = true
  paymentsError.value = null
  try {
    const [, txRes] = await Promise.all([loadIncome(), getTransactions(TX_PAGE, 0)])
    transactions.value = txRes.items
    txTotal.value = txRes.total
  } catch (e) {
    paymentsError.value = extractApiError(e, t('common.loadError'))
  } finally {
    paymentsLoading.value = false
  }
}

async function loadMoreTx(): Promise<void> {
  if (!hasMoreTx.value) return
  const res = await getTransactions(TX_PAGE, transactions.value.length)
  transactions.value = [...transactions.value, ...res.items]
  txTotal.value = res.total
}

// Period drives income only (transactions are not period-scoped).
watch(period, () => {
  // Collapse the practices back to the preview when the period changes.
  practicesExpanded.value = false
  if (PAYMENTS_TAB_ENABLED) {
    void loadIncome().catch(() => {
      /* keep the previous income value on a transient refetch error */
    })
  }
})

// =========================================================================
// Helpers
// =========================================================================

/** Open the per-practice reviews detail (G2: closes the card-tap from G4). */
function openReviews(practiceId: string): void {
  void router.push({ name: 'master-practice-reviews', params: { id: practiceId } })
}

// =========================================================================
// Lifecycle
// =========================================================================

onMounted(() => {
  if (PAYMENTS_TAB_ENABLED) void loadPayments()
  void loadReviews()
})
</script>

<style scoped>
.analytics {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

/* ===== Body ===== */
.analytics__body {
  flex: 1;
  padding: var(--space-4) 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* ===== Stats grid ===== */
.analytics__stats {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--space-3);
}

/* ===== Section ===== */
.analytics__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

/* ===== Needs attention (tappable card → message) ===== */
.analytics__attention {
  width: 100%;
  text-align: left;
  font: inherit;
  cursor: pointer;
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--velo-card-padding-y) var(--velo-card-padding-x);
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
  transition: opacity var(--transition-fast);
}

.analytics__attention:active {
  opacity: 0.85;
}

.analytics__attention-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.analytics__attention-name {
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
}

.analytics__attention-ident {
  width: var(--velo-size-40);
  height: var(--velo-size-40);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.analytics__attention-pr {
  font-size: var(--velo-fs-16);
  color: var(--velo-text-secondary);
}

.analytics__attention-quote {
  font-size: var(--velo-fs-16);
  color: var(--velo-text-secondary);
  font-style: italic;
}

/* Message button — distinct action (@click.stop), does not navigate to the
   profile. Same DS shape as MasterSummaryView's needs-attention message button. */
.analytics__attention-msg {
  width: var(--velo-size-46);
  height: var(--velo-size-46);
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

.analytics__attention-msg:active {
  opacity: 0.85;
}

/* ===== Empty card ===== */
.analytics__empty {
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--space-4);
  text-align: center;
  color: var(--velo-text-muted);
  font-size: var(--velo-fs-16);
  line-height: 1.5;
}

/* ===== Period slider ===== */
.analytics__period {
  width: 100%;
}

/* ===== Load more ===== */
.analytics__more {
  display: flex;
  justify-content: center;
  padding-top: var(--space-2);
}

.analytics__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-5) 0;
}

/* ===== Payments ===== */
.analytics__income {
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--space-5);
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: var(--velo-gap-6);
}

.analytics__income-value {
  font-family: var(--font-heading);
  font-size: var(--velo-fs-32);
  color: var(--velo-text-primary);
  letter-spacing: 0.5px;
}

.analytics__income-label {
  font-size: var(--velo-fs-16);
  color: var(--velo-text-secondary);
}

.analytics__income-delta {
  font-size: var(--velo-fs-14);
  line-height: 1;
}

.analytics__income-delta--up {
  color: var(--velo-teal-600);
}

.analytics__income-delta--down {
  color: var(--velo-pink-500);
}

.analytics__pay-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4);
}

.analytics__txns {
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: 0 var(--space-4);
}

.analytics__txn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--velo-border-light);
}

.analytics__txn:last-child {
  border-bottom: none;
}

.analytics__txn-info {
  min-width: 0;
}

.analytics__txn-title {
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
}

.analytics__txn-meta {
  font-size: var(--velo-fs-14);
  color: var(--velo-text-muted);
}

.analytics__txn-amt {
  font-size: var(--velo-fs-18);
  white-space: nowrap;
}

.analytics__txn-amt--in {
  color: var(--velo-teal-600);
}

.analytics__txn-amt--out {
  color: var(--velo-pink-300);
}
</style>
