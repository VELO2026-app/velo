<!--
  VELO Frontend -- AdminWithdrawalsView (Admin DS, 2026-06-14)

  Dedicated withdrawals list (i18n:adminScreens.adminWithdrawals.title) -- the
  entry that resolves the withdrawal-detail orphan
  (audit №39 O-1, operator Q1=B). Lists payout requests from the LIVE admin endpoint
  (GET /api/v1/admin/withdrawals via getAdminWithdrawals -- previously defined but
  never called; this screen revives it). Tapping a row hands the withdrawal to
  AdminWithdrawalDetailView via router state (the detail has no GET-by-id; it reads
  window.history.state.withdrawal), mirroring the practices/reports list pattern.

  Modelled on AdminReportsView (header + loader/empty/error + list + load-more); no
  bespoke control -- VCard rows + the shared status-icon pattern (IconPending /
  IconCheck / IconClose, colours --velo-warning/success/error), matching the master
  finance history.

  Honest-empty: the master display name is not on AdminWithdrawalResponse (backend
  gap E9) -> shown «—». Status filter omitted for v1 (add when the list grows).
-->

<template>
  <div class="admin-withdrawals">
    <header class="admin-withdrawals__top">
      <VBackButton @click="router.back()" />
      <h1 class="admin-withdrawals__title">{{ t('adminScreens.adminWithdrawals.title') }}</h1>
      <span class="admin-withdrawals__count">{{ headerCount }}</span>
    </header>

    <!-- Loading: initial -->
    <div v-if="loading && items.length === 0" class="admin-withdrawals__loader">
      <VLoader size="lg" />
    </div>

    <!-- Fetch error -->
    <VEmptyState
      v-else-if="error"
      icon="warning"
      :title="t('common.loadFailed')"
      :description="t('common.checkConnection')"
    >
      <template #action
        ><VButton variant="primary" @click="retry">{{ t('common.retry') }}</VButton></template
      >
    </VEmptyState>

    <!-- Empty -->
    <VEmptyState
      v-else-if="items.length === 0"
      icon="success"
      :title="t('adminScreens.adminWithdrawals.empty.title')"
      :description="t('adminScreens.adminWithdrawals.empty.text')"
    />

    <template v-else>
      <div class="admin-withdrawals__list">
        <VCard
          v-for="w in items"
          :key="w.id"
          class="wrow"
          clickable
          padding="none"
          @click="openDetail(w)"
        >
          <span
            class="wrow__icon"
            :class="`wrow__icon--${w.status}`"
            :title="statusLabel(w.status)"
          >
            <component :is="statusIcon(w.status)" :size="28" />
          </span>
          <div class="wrow__text">
            <div class="wrow__amount">{{ gross(w) }}</div>
            <div class="wrow__sub">{{ masterName }} · {{ methodLabel(w.payout_details) }}</div>
          </div>
          <div class="wrow__right">
            <span class="wrow__time">{{ formatRelative(w.created_at) }}</span>
            <span class="wrow__net">{{
              t('adminScreens.adminWithdrawals.toReceive', { amount: net(w) })
            }}</span>
          </div>
        </VCard>
      </div>

      <div v-if="hasMore" class="admin-withdrawals__more">
        <VButton variant="outline" block :loading="loadingMore" @click="loadMore">
          {{ t('common.showMore') }}
        </VButton>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { toHistoryState } from '@/utils/historySnapshot'
import { computed, type Component } from 'vue'
import { useRouter } from 'vue-router'
import { useInfiniteQuery } from '@pinia/colada'
import { VBackButton, VButton, VLoader, VEmptyState, VCard } from '@/components/ui'
import { IconPending, IconCheck, IconClose } from '@/components/icons'
import { useToast } from '@/composables/useToast'
import { adminWithdrawalsQuery, usePagedListFailures } from '@/composables/queries/admin'
import { screenQueryState } from '@/composables/queries/screenState'
import type { AdminWithdrawalResponse, WithdrawalStatus, PayoutDetails } from '@/api/admin'
import { extractApiError } from '@/composables/useApiError'
import { formatMoney } from '@/utils/format'
import { formatRelative } from '@/utils/adminHelpers'

const router = useRouter()
const toast = useToast()

// Every payout request, page by page (Pinia Colada, composables/queries/admin.ts).
const withdrawalsQuery = useInfiniteQuery(adminWithdrawalsQuery)
const items = computed<AdminWithdrawalResponse[]>(
  () => withdrawalsQuery.data.value?.pages.flatMap((page) => page.items) ?? [],
)
const total = computed(() => withdrawalsQuery.data.value?.pages.at(-1)?.total ?? 0)
const { loading, failed: error } = screenQueryState(withdrawalsQuery)
const hasMore = withdrawalsQuery.hasNextPage

const headerCount = computed<string>(() => (total.value ? String(total.value) : '—'))

// -- Status icon + label (shared pattern with the master finance history). --
const STATUS_ICON: Record<WithdrawalStatus, Component> = {
  pending: IconPending,
  approved: IconCheck,
  rejected: IconClose,
}
function statusIcon(s: WithdrawalStatus): Component {
  return STATUS_ICON[s]
}
const STATUS_LABEL: Record<WithdrawalStatus, string> = {
  pending: t('adminScreens.adminWithdrawals.status.pending'),
  approved: t('adminScreens.adminWithdrawals.approved'),
  rejected: t('adminScreens.adminWithdrawals.statusRejected'),
}
function statusLabel(s: WithdrawalStatus): string {
  return STATUS_LABEL[s] ?? s
}

// -- Money (gross / net, in the withdrawal's own currency). --
function gross(w: AdminWithdrawalResponse): string {
  return formatMoney(w.amount_cents, w.currency, 'ru', true)
}
function net(w: AdminWithdrawalResponse): string {
  return formatMoney(w.amount_cents - w.fee_cents, w.currency, 'ru', true)
}

// -- Master display name is not on the payload yet (backend gap E9) -> honest «—». --
const masterName = '—'

// -- Masked payout method (mirrors AdminWithdrawalDetailView.bankLabel). --
function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
function methodLabel(p: PayoutDetails): string {
  const d = p.details ?? {}
  if (p.method === 'bank_transfer') {
    const bank = str(d.bank_name) || t('adminScreens.adminWithdrawals.bank')
    const acc = (str(d.iban) || str(d.account)).replace(/\s+/g, '')
    const tail = acc ? acc.slice(-4) : ''
    return tail ? `${bank} •••• ${tail}` : bank
  }
  if (p.method === 'paypal') return str(d.email) || 'PayPal'
  if (p.method === 'revolut') return str(d.tag) || str(d.phone) || 'Revolut'
  return p.method
}

// -- Tap a row -> hand the withdrawal to the detail via router state (no GET-by-id;
//    the detail reads window.history.state.withdrawal). Closes the orphan. --
function openDetail(w: AdminWithdrawalResponse): void {
  void router.push({
    name: 'admin-withdrawal-detail',
    params: { id: w.id },
    state: { withdrawal: toHistoryState(w) },
  })
}

// Every failed request is told: a next page with its own fallback, the
// list itself (its first load, a refetch) with the list's.
const { loadingMore, loadMore } = usePagedListFailures(withdrawalsQuery, (e, nextPage) =>
  toast.error(
    extractApiError(
      e,
      nextPage ? t('common.loadError') : t('adminScreens.adminWithdrawals.withdrawalsLoadError'),
    ),
  ),
)

function retry(): void {
  void withdrawalsQuery.refetch()
}
</script>

<style scoped>
.admin-withdrawals {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.admin-withdrawals__top {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: var(--velo-size-44);
}

.admin-withdrawals__title {
  flex: 1;
  font-family: var(--font-body);
  font-weight: 400;
  font-size: var(--velo-fs-20);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

.admin-withdrawals__count {
  font-size: var(--velo-fs-16);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
}

.admin-withdrawals__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-8) 0;
}

.admin-withdrawals__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

/* -- Withdrawal row (VCard padding=none + custom layout, like the reports rcard) -- */
.wrow {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
}

.wrow__icon {
  flex-shrink: 0;
  display: inline-flex;
}

.wrow__icon--pending {
  color: var(--velo-warning);
}

.wrow__icon--approved {
  color: var(--velo-success);
}

.wrow__icon--rejected {
  color: var(--velo-error);
}

.wrow__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--velo-gap-3);
}

.wrow__amount {
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

.wrow__sub {
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.wrow__right {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--velo-gap-3);
}

.wrow__time {
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
}

.wrow__net {
  font-size: var(--velo-fs-14);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

.admin-withdrawals__more {
  padding-top: var(--space-1);
}
</style>
