<!--
  VELO Frontend -- AnalyticsView (Phase-3 Master DS rebuild)

  Master analytics hub. Route: /master/analytics (inside MasterShell).

  Two tabs (operator design 2026-06-11), each under a shared period toggle:
    1. Отзывы  -- aggregate stats (Check-in / Feedback / Отзывов) + overall
                  rating distribution bars + "Требуют внимания" + past-practice
                  cards with inline rating badges.
    2. Платежи -- period income + transactions list + link to full Finance.

  Controls are the track+thumb pattern (single glass track, active fill pill) --
  the same shape as the master-dashboard period toggle, NOT the two-pill VSegment
  (operator design; VSegment<->track+thumb unification is a SHELL task).

  Data reality (decisions locked with operator 2026-06-11):
    REAL: past completed practices (masterStore) + per-practice insights
          (GET /practices/{id}/insights -> anonymous rating/mood distributions).
          Insights are eager-loaded for the visible page so the inline badges and
          the aggregate are populated without a tap.
    STUB (no backend yet -> master-ds-zod-roadmap.md):
      - Период «Неделя/Месяц»: no period-scoped API -> toggle is visual-only.
      - «Требуют внимания»: insights are anonymous (no names / comment texts), so
        the de-anonymised attention feed has no source. Section is scaffolded and
        renders its empty state until Zod adds a NON-anonymous endpoint.
      - «Платежи» (E2 wired 2026-06-16): getIncome(period) drives «Доход за период»
        + signed delta_pct; getTransactions drives the feed. Currency canon = EUR;
        €0.00 / empty while seed practices are free (seed-pricing task next). Full
        finance (balance, payout, withdrawals) lives on /master/finance -> link.
-->

<template>
  <div class="analytics">
    <!-- Header (DS VHeader — uniform with the rest of the master zone, rides
         MobileLayout's floating island; ПРОМТ №162). -->
    <VHeader title="Аналитика" />

    <!-- Tab segment (track+thumb, DS primitive) -->
    <VSegmentTrack v-model="activeTab" :options="TAB_OPTIONS" variant="tabs" />

    <!-- Period toggle -- visual-only until a period-scoped analytics API exists. -->
    <div class="analytics__period-row">
      <VSegmentTrack
        v-model="period"
        :options="PERIOD_OPTIONS"
        variant="toggle"
        aria-label="Период статистики"
      />
    </div>

    <!-- ================================================================
         TAB: ОТЗЫВЫ
         ================================================================ -->
    <div v-show="activeTab === 'reviews'" class="analytics__body">
      <!-- Aggregate stats (over loaded insights; period scoping has no API). -->
      <div class="analytics__stats">
        <VStatCard :value="aggregateCheckinPct" label="Check-in" />
        <VStatCard :value="aggregateFeedbackPct" label="Feedback" />
        <VStatCard :value="aggregateTotalFeedbacks" label="Отзывов" />
      </div>

      <!-- Общая статистика -->
      <section class="analytics__section">
        <h2 class="velo-section-title">Общая статистика</h2>
        <VRatingDistribution
          :fire="ratingTotals.fire"
          :good="ratingTotals.good"
          :confused="ratingTotals.confused"
        />
      </section>

      <!-- Требуют внимания: ученики, оставившие в фидбэке «Есть вопросы» (confused)
           за период. Секция (вместе с заголовком) НЕ показывается, если таких нет.
           Тап по карточке → профиль ученика (E1: user_id на MasterReviewItem);
           кнопка сообщения — @click.stop, шлёт сообщение, не навигируя (ПРОМТ №229). -->
      <section v-if="attentionItems.length > 0" class="analytics__section">
        <h2 class="velo-section-title">Требуют внимания</h2>
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
            <component
              :is="RATING_ICON[item.rating as FeedbackRating]"
              :size="36"
              :style="{ color: RATING_ICON_COLOR[item.rating as FeedbackRating] }"
            />
          </span>
          <div class="analytics__attention-body">
            <div class="analytics__attention-name">{{ item.reviewer_name }}</div>
            <div class="analytics__attention-pr">{{ item.practice_title }}</div>
            <div v-if="item.comment" class="analytics__attention-quote">«{{ item.comment }}»</div>
          </div>
          <button
            class="analytics__attention-msg"
            aria-label="Написать сообщение"
            @click.stop="openMessage(item.reviewer_name)"
          >
            <IconMessages :size="22" />
          </button>
        </div>
      </section>

      <!-- Прошедшие практики -->
      <section class="analytics__section">
        <h2 class="velo-section-title">Прошедшие практики</h2>

        <div
          v-if="masterStore.practicesPastLoading && pastPractices.length === 0"
          class="analytics__loader"
        >
          <VLoader />
        </div>

        <VEmptyState
          v-else-if="periodPractices.length === 0"
          variant="note"
          title="За выбранный период практик нет"
        />

        <template v-else>
          <button
            v-for="p in visiblePast"
            :key="p.id"
            type="button"
            class="analytics__pcard"
            @click="openReviews(p.id)"
          >
            <div class="analytics__pcard-top">
              <span class="analytics__pcard-icon">
                <component :is="practiceIconFor(p)" :size="46" />
              </span>
              <div class="analytics__pcard-info">
                <div class="analytics__pcard-title">{{ p.title }}</div>
                <div class="analytics__pcard-meta">
                  {{ formatShortDate(p.scheduled_at, p.timezone) }} · {{ p.current_participants }} участников
                </div>
              </div>
            </div>

            <!-- Inline rating badges (insights eager-loaded for the page). -->
            <VRatingBadges
              v-if="insightsCache.has(p.id) && totalFeedbacks(p.id) > 0"
              class="analytics__pcard-badges"
              :fire="ratingPct(p.id, 'fire')"
              :good="ratingPct(p.id, 'good')"
              :confused="ratingPct(p.id, 'confused')"
            />
          </button>

          <!-- Первые 3 + раскрытие «+ ещё N практик» (#5). -->
          <VShowMore
            v-if="!pastExpanded && hiddenPastCount > 0"
            :count="hiddenPastCount"
            noun="практик"
            @click="pastExpanded = true"
          />
          <div v-else-if="pastExpanded && masterStore.practicesPastHasMore" class="analytics__more">
            <VButton variant="ghost" :loading="masterStore.practicesPastLoading" @click="onLoadMore">
              Показать ещё
            </VButton>
          </div>
        </template>
      </section>
    </div>

    <!-- ================================================================
         TAB: ПЛАТЕЖИ
         ================================================================ -->
    <div v-show="activeTab === 'payments'" class="analytics__body">
      <div v-if="paymentsLoading" class="analytics__loader"><VLoader /></div>

      <VCard v-else-if="paymentsError" class="analytics__pay-error">
        <p class="analytics__empty">{{ paymentsError }}</p>
        <VButton size="sm" variant="outline" @click="loadPayments">Повторить</VButton>
      </VCard>

      <template v-else>
        <!-- Income (E2: getIncome by period; delta_pct vs previous period). -->
        <div class="analytics__income">
          <div class="analytics__income-value">{{ income }}</div>
          <div class="analytics__income-label">Доход за период</div>
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

        <!-- Транзакции (E2: getTransactions — signed title-tagged ledger rows). -->
        <section class="analytics__section">
          <h2 class="velo-section-title">Транзакции</h2>
          <div v-if="transactions.length > 0" class="analytics__txns">
            <div v-for="(t, i) in transactions" :key="i" class="analytics__txn">
              <div class="analytics__txn-info">
                <div class="analytics__txn-title">{{ txnTitle(t) }}</div>
                <div class="analytics__txn-meta">
                  {{ formatShortDate(t.created_at)
                  }}<template v-if="t.counterparty_name"> · {{ t.counterparty_name }}</template>
                </div>
              </div>
              <div
                class="analytics__txn-amt"
                :class="t.amount_cents >= 0 ? 'analytics__txn-amt--in' : 'analytics__txn-amt--out'"
              >
                {{ formatTxnAmount(t.amount_cents) }}
              </div>
            </div>
            <div v-if="hasMoreTx" class="analytics__more">
              <VButton variant="ghost" @click="loadMoreTx">Показать ещё</VButton>
            </div>
          </div>
          <VEmptyState v-else variant="note" title="Данных пока нет" />
        </section>
      </template>
    </div>

    <!-- «Требуют внимания» tap → message the student (stub modal, E4). -->
    <SendMessageModal :open="msgOpen" :name="msgName" @close="msgOpen = false" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useMasterStore } from '@/stores/master'
import { useDiaryStore } from '@/stores/diary'
import {
  VLoader,
  VButton,
  VStatCard,
  VCard,
  VSegmentTrack,
  VRatingBadges,
  VEmptyState,
} from '@/components/ui'
import { VHeader } from '@/components/layout'
import VRatingDistribution from '@/components/shared/VRatingDistribution.vue'
import VShowMore from '@/components/shared/VShowMore.vue'
import SendMessageModal from '@/components/shared/SendMessageModal.vue'
import { IconMessages } from '@/components/icons'
import { practiceIconFor, RATING_ICON_COLOR } from '@/utils/displayHelpers'
import { RATING_ICON } from '@/utils/ratingIcons'
import { formatMoney, formatShortDate } from '@/utils/format'
import { getIncome, getTransactions, getMasterReviews } from '@/api/masters'
import { extractApiError } from '@/composables/useApiError'
import type {
  IncomeResponse,
  MasterTransactionItem,
  MasterReviewItem,
  FeedbackRating,
} from '@/api/types'

const router = useRouter()
const masterStore = useMasterStore()
const diaryStore = useDiaryStore()

// Reactive Map<practiceId, insights> -- computeds below track additions.
const insightsCache = diaryStore.insightsCache

// =========================================================================
// Tabs (track+thumb segment) + period toggle (visual-only)
// =========================================================================

const activeTab = ref<'reviews' | 'payments'>('reviews')
const TAB_OPTIONS: Array<{ value: 'reviews' | 'payments'; label: string }> = [
  { value: 'reviews', label: 'Отзывы' },
  { value: 'payments', label: 'Платежи' },
]

// Period scoping has no backend yet -> the toggle only moves the active pill
// (mirrors the master-dashboard pattern). Roadmap: period-scoped summary API.
const period = ref<'week' | 'month'>('week')
const PERIOD_OPTIONS: ReadonlyArray<{ value: 'week' | 'month'; label: string }> = [
  { value: 'week', label: 'Неделя' },
  { value: 'month', label: 'Месяц' },
]

// =========================================================================
// Past practices (completed, newest first)
// =========================================================================

// T22-5 (ПРОМТ №561): the server now owns the completed-only, most-recent-
// first ordering -- no client-side filter/sort left to hide the next
// ordering bug.
const pastPractices = computed(() => masterStore.practicesPast)

// Period scoping (#1, fork В): until a period-scoped reviews API exists, filter
// the loaded past practices client-side (Неделя = 7 days, Месяц = 30) so the
// toggle moves real numbers. Swap to the Zod summary endpoint when it lands.
const PERIOD_DAYS: Record<'week' | 'month', number> = { week: 7, month: 30 }
const periodPractices = computed(() => {
  const cutoff = Date.now() - PERIOD_DAYS[period.value] * 86_400_000
  return pastPractices.value.filter((p) => new Date(p.scheduled_at).getTime() >= cutoff)
})
const periodInsights = computed(() =>
  periodPractices.value.map((p) => insightsCache.get(p.id)).filter((i) => i != null),
)

// Past list: first 3 + «+ ещё N практик» reveal (#5).
const PAST_PREVIEW = 3
const pastExpanded = ref(false)
const visiblePast = computed(() =>
  pastExpanded.value ? periodPractices.value : periodPractices.value.slice(0, PAST_PREVIEW),
)
const hiddenPastCount = computed(() => Math.max(0, periodPractices.value.length - PAST_PREVIEW))

// =========================================================================
// Aggregate stats (over the selected period's loaded insights)
// =========================================================================

const aggregateTotalFeedbacks = computed((): number =>
  periodInsights.value.reduce(
    (t, ins) => t + ins.feedbacks.fire + ins.feedbacks.good + ins.feedbacks.confused,
    0,
  ),
)

const aggregateTotalCheckins = computed((): number =>
  periodInsights.value.reduce(
    (t, ins) => t + ins.checkins.high + ins.checkins.mid + ins.checkins.low,
    0,
  ),
)

const aggregateTotalParticipants = computed((): number =>
  periodInsights.value.reduce((t, ins) => t + ins.participants, 0),
)

/** Check-in rate over loaded insights. "—" when there is no data yet. */
const aggregateCheckinPct = computed((): string => {
  if (aggregateTotalParticipants.value === 0) return '—'
  return `${Math.round((aggregateTotalCheckins.value / aggregateTotalParticipants.value) * 100)}%`
})

/** Feedback rate over loaded insights. "—" when there is no data yet. */
const aggregateFeedbackPct = computed((): string => {
  if (aggregateTotalParticipants.value === 0) return '—'
  return `${Math.round((aggregateTotalFeedbacks.value / aggregateTotalParticipants.value) * 100)}%`
})

// =========================================================================
// Overall rating distribution (Общая статистика) — VRatingDistribution owns the
// bar config/palettes/markup; we just feed it the period's summed feedback counts.
// =========================================================================

const ratingTotals = computed((): { fire: number; good: number; confused: number } => {
  const totals = { fire: 0, good: 0, confused: 0 }
  periodInsights.value.forEach((ins) => {
    totals.fire += ins.feedbacks.fire
    totals.good += ins.feedbacks.good
    totals.confused += ins.feedbacks.confused
  })
  return totals
})

// =========================================================================
// Per-practice rating (inline badges)
// =========================================================================

function totalFeedbacks(practiceId: string): number {
  const ins = insightsCache.get(practiceId)
  if (!ins) return 0
  return ins.feedbacks.fire + ins.feedbacks.good + ins.feedbacks.confused
}

function ratingPct(practiceId: string, rating: 'fire' | 'good' | 'confused'): number {
  const total = totalFeedbacks(practiceId)
  if (total === 0) return 0
  return Math.round((insightsCache.get(practiceId)!.feedbacks[rating] / total) * 100)
}

// =========================================================================
// Последние отзывы (#3: GET /masters/me/reviews — cross-practice named feed)
// =========================================================================

const REVIEWS_PAGE = 20
const reviews = ref<MasterReviewItem[]>([])

async function loadReviews(): Promise<void> {
  try {
    // E1: fetch the negative (confused) bucket server-side — the «Требуют
    // внимания» block is the only consumer, so a full page of low-rated
    // reviews beats a mixed page where negatives may be sparse. The period
    // cutoff still narrows client-side (no period param on the endpoint).
    const res = await getMasterReviews(REVIEWS_PAGE, 0, true)
    reviews.value = res.items
  } catch {
    /* leave the section empty on error */
  }
}

// Требуют внимания: «Есть вопросы» (confused) reviews within the active period
// (client-side, mirroring the past list). Empty ⇒ the section + title are hidden.
const attentionItems = computed((): MasterReviewItem[] => {
  const cutoff = Date.now() - PERIOD_DAYS[period.value] * 86_400_000
  return reviews.value.filter(
    (r) => r.rating === 'confused' && new Date(r.created_at).getTime() >= cutoff,
  )
})

// E1 (ПРОМТ №229): tap an attention card → the reviewer's student profile
// (user_id now on MasterReviewItem). Mirrors PracticeReviewsView.goStudent.
function goStudent(item: MasterReviewItem): void {
  router.push({
    name: 'master-student-profile',
    params: { id: item.user_id },
    query: { name: item.reviewer_name },
  })
}

// The message button (@click.stop) → open the (stub, E4) send-message modal by
// name, as a distinct action that does not trigger the card's profile-nav.
const msgOpen = ref(false)
const msgName = ref('')
function openMessage(name: string): void {
  msgName.value = name
  msgOpen.value = true
}

// =========================================================================
// Платежи (E2: income by period + transaction feed)
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
  incomeData.value ? formatMoney(incomeData.value.income_cents, 'EUR', 'ru', true) : '—',
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
  return `${sign}${formatMoney(Math.abs(cents), 'EUR', 'ru', true)}`
}

// M5: show the practice NAME instead of the generic stored label («Оплата за
// практику»). practice_title is added by the backend join; read it defensively
// because generated.ts is regenerated at deploy (not hand-edited here), so the
// field may be absent from the local type until then.
function txnTitle(t: MasterTransactionItem): string {
  const withPractice = t as MasterTransactionItem & { practice_title?: string | null }
  return withPractice.practice_title || t.title
}

async function loadIncome(): Promise<void> {
  incomeData.value = await getIncome(period.value)
}

async function loadPayments(): Promise<void> {
  paymentsLoading.value = true
  paymentsError.value = null
  try {
    const [, txRes] = await Promise.all([loadIncome(), getTransactions(TX_PAGE, 0)])
    transactions.value = txRes.items
    txTotal.value = txRes.total
  } catch (e) {
    paymentsError.value = extractApiError(e, 'Ошибка загрузки')
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
  // Collapse the past list back to the preview when the period changes (#5).
  pastExpanded.value = false
  void loadIncome().catch(() => {
    /* keep the previous income value on a transient refetch error */
  })
})

// =========================================================================
// Helpers
// =========================================================================

// Eager-load insights for the visible page -- feeds both the aggregate stats and
// the inline practice-card badges. loadInsights() skips already-cached ids, so
// this is idempotent across re-runs and load-more.
function loadVisibleInsights(): Promise<void[]> {
  return Promise.all(pastPractices.value.map((p) => diaryStore.loadInsights(p.id)))
}

async function onLoadMore(): Promise<void> {
  await masterStore.loadMorePastPractices()
  await loadVisibleInsights()
}

/** Open the per-practice reviews detail (Г2: closes the card-tap from Г4). */
function openReviews(practiceId: string): void {
  router.push({ name: 'master-practice-reviews', params: { id: practiceId } })
}

// =========================================================================
// Lifecycle
// =========================================================================

onMounted(async () => {
  void loadPayments()
  void loadReviews()
  // T22-5 (ПРОМТ №561): this tab only ever needs "Прошедшие" -- fetching the
  // combined bucket here would warm "Предстоящие" for no reason.
  await masterStore.fetchPastPractices()
  await loadVisibleInsights()
})
</script>

<style scoped>
.analytics {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

/* ===== Controls: period-toggle row (the track+thumb control itself is now the
   shared VSegmentTrack DS primitive). ===== */
.analytics__period-row {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--space-3);
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
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-3);
}

/* ===== Section ===== */
.analytics__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

/* ===== Требуют внимания (tappable card → message) ===== */
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
  font-size: var(--text-base);
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
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
}

.analytics__attention-quote {
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  font-style: italic;
}

/* Message button — distinct action (@click.stop), does not navigate to the
   profile. Same DS shape as MasterSummaryView's «Требуют внимания» msg button. */
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
  font-size: var(--text-sm);
  line-height: 1.5;
}

/* ===== Practice card (PracticeListCard canon padding + inline badges) ===== */
.analytics__pcard {
  width: 100%;
  text-align: left;
  font: inherit;
  cursor: pointer;
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--velo-card-padding-y) var(--velo-card-padding-x);
  display: flex;
  flex-direction: column;
  gap: var(--velo-card-meta-row-gap);
  transition: opacity var(--transition-fast);
}

.analytics__pcard:active {
  opacity: 0.85;
}

.analytics__pcard-top {
  display: flex;
  gap: var(--space-3);
  align-items: center;
}

.analytics__pcard-icon {
  width: var(--velo-size-46);
  height: var(--velo-size-46);
  flex-shrink: 0;
  color: var(--velo-text-primary);
  display: flex;
  align-items: center;
  justify-content: center;
}

.analytics__pcard-info {
  flex: 1;
  min-width: 0;
}

.analytics__pcard-title {
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  letter-spacing: var(--velo-card-letter-spacing-title);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.analytics__pcard-meta {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  letter-spacing: 0.28px;
}

/* Spread the rating trio across the card (operator SVG: 3 equal-width pills,
   gap 10) — analytics-only override; the shared VRatingBadges component layout
   is untouched (other usages keep their left-aligned trio). The icon+% is
   CENTERED within each pill (operator ПРОМТ №235: «по центру, а не с левого
   края / распределены по карточке»). */
.analytics__pcard-badges {
  gap: var(--velo-card-meta-row-gap);
}

.analytics__pcard-badges :deep(.v-rating-badges__badge) {
  flex: 1;
  justify-content: center;
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

/* ===== Платежи ===== */
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
  font-size: var(--text-xl);
  color: var(--velo-text-primary);
  letter-spacing: 0.5px;
}

.analytics__income-label {
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
}

.analytics__income-delta {
  font-size: var(--text-xs);
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
  font-size: var(--text-base);
  color: var(--velo-text-primary);
}

.analytics__txn-meta {
  font-size: var(--text-xs);
  color: var(--velo-text-muted);
}

.analytics__txn-amt {
  font-size: var(--text-base);
  white-space: nowrap;
}

.analytics__txn-amt--in {
  color: var(--velo-teal-600);
}

.analytics__txn-amt--out {
  color: var(--velo-pink-300);
}
</style>
