<!--
  VELO Frontend -- WithdrawalsPanel (FE-267)

  The payout queue of the web console's Finance module: a tab per status
  (awaiting a verdict, approved, rejected), a table of the requests, a pager.
  A pending request is approved after a recap of the money (the one step
  before an irreversible payout) or rejected with a reason.

  Data: `GET /admin/withdrawals?status=&limit=&offset=`, one Colada entry per
  status and page (composables/queries/admin.ts); the status and the page ride
  the URL. The answer has no master name (BE-226), no available balance and no
  master handle: the first column shows the name on the payout account, or a
  dash. Verdicts are `POST /admin/withdrawals/{id}/approve|reject`.
-->

<template>
  <div class="withdrawals" data-testid="finance-withdrawals">
    <VSegment
      compact
      :model-value="status"
      :options="statusOptions"
      :aria-label="t('console.finance.withdrawals.statusLabel')"
      @update:model-value="setStatus"
    />

    <ConsoleCard flush>
      <ConsoleLoading v-if="loading" data-testid="finance-loading" />
      <VEmptyState
        v-else-if="failed"
        icon="warning"
        :title="t('console.finance.withdrawals.loadFailed')"
        :description="errorText"
      >
        <VButton size="sm" variant="outline" @click="retry">{{ t('common.retry') }}</VButton>
      </VEmptyState>
      <template v-else>
        <ConsoleTable
          :columns="columns"
          :rows="rows"
          :label="t('console.finance.withdrawals.tableLabel')"
        >
          <template #cell-master="{ row }">
            <span class="withdrawals__stack">
              <span class="withdrawals__strong">{{ holder(row) || '—' }}</span>
              <span v-if="medium" class="withdrawals__sub">{{ methodLabel(row) }}</span>
              <span v-if="narrow" class="withdrawals__sub">{{ stamp(row.created_at) }}</span>
            </span>
          </template>
          <template #cell-amount="{ row }">
            <span class="withdrawals__stack withdrawals__stack--end">
              <span class="withdrawals__amount">{{ gross(row) }}</span>
              <span v-if="medium" class="withdrawals__sub">
                {{ t('console.finance.withdrawals.netLine', { amount: net(row) }) }}
              </span>
            </span>
          </template>
          <template #cell-net="{ row }">{{ net(row) }}</template>
          <template #cell-details="{ row }">{{ methodLabel(row) }}</template>
          <template #cell-requested="{ row }">{{ stamp(row.created_at) }}</template>
          <template #cell-decision="{ row }">
            <div v-if="row.status === 'pending'" class="withdrawals__actions">
              <VButton
                size="sm"
                :disabled="busy"
                :aria-label="t('console.finance.withdrawals.approveFor', { amount: gross(row) })"
                @click="askApprove(row)"
              >
                {{ t('console.finance.withdrawals.approve') }}
              </VButton>
              <VButton
                size="sm"
                variant="outline"
                :disabled="busy"
                :aria-label="t('console.finance.withdrawals.rejectFor', { amount: gross(row) })"
                @click="askReject(row)"
              >
                {{ t('console.finance.withdrawals.reject') }}
              </VButton>
            </div>
            <span v-else class="withdrawals__stack">
              <ConsoleBadge :tone="row.status === 'approved' ? 'success' : 'error'">
                {{
                  row.status === 'approved'
                    ? t('console.finance.withdrawals.approved')
                    : t('console.finance.withdrawals.rejected')
                }}
              </ConsoleBadge>
              <span
                v-if="row.status === 'rejected' && row.admin_note"
                class="withdrawals__reason"
                :title="row.admin_note"
              >
                {{ row.admin_note }}
              </span>
              <span v-if="decidedAt(row)" class="withdrawals__sub">{{ decidedAt(row) }}</span>
            </span>
          </template>
          <template #empty>{{ t(`console.finance.withdrawals.empty.${status}`) }}</template>
        </ConsoleTable>
        <ConsolePager
          v-if="total > 0"
          :page="page"
          :page-size="ADMIN_WITHDRAWALS_PAGE_SIZE"
          :total="total"
          :shown="rows.length"
          @update:page="setPage"
        />
      </template>
    </ConsoleCard>

    <p v-if="status === 'pending'" class="withdrawals__note">
      {{ t('console.finance.withdrawals.note') }}
    </p>

    <ConfirmPaymentModal
      :open="mode === 'approve'"
      :amount="target ? gross(target) : ''"
      :fee="target ? money(target, target.fee_cents) : ''"
      :net="target ? net(target) : ''"
      :bank="target ? methodLabel(target) : ''"
      :master="target ? holder(target) || '—' : ''"
      :master-label="t('console.finance.withdrawals.columns.recipient')"
      :loading="approving"
      @confirm="onApprove"
      @close="closeDecision"
    />
    <WithdrawalRejectModal
      :open="mode === 'reject'"
      :amount="target ? gross(target) : ''"
      :reason="reason"
      :error="reasonError"
      :loading="rejecting"
      @update:reason="reason = $event"
      @confirm="onReject"
      @close="closeDecision"
    />
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed, ref, watch } from 'vue'
import { useQuery, useQueryCache } from '@pinia/colada'
import { VButton, VEmptyState, VSegment } from '@/components/ui'
import type { SegmentOption } from '@/components/ui'
import ConsoleCard from '@/components/console/ConsoleCard.vue'
import ConsoleTable, { type ConsoleTableColumn } from '@/components/console/ConsoleTable.vue'
import ConfirmPaymentModal from '@/components/shared/ConfirmPaymentModal.vue'
import ConsoleLoading from '@/components/console/ConsoleLoading.vue'
import ConsolePager from '@/components/console/ConsolePager.vue'
import ConsoleBadge from '@/components/console/ConsoleBadge.vue'
import WithdrawalRejectModal from '@/components/console/finance/WithdrawalRejectModal.vue'
import { countedLabel, formatStamp } from '@/components/console/finance/financeFormat'
import { payoutHolder, payoutMethodLabel } from '@/components/console/finance/payoutMethod'
import { useUrlChoice } from '@/composables/console/useUrlChoice'
import { useUrlPage } from '@/composables/console/useUrlPage'
import { approveWithdrawal, rejectWithdrawal } from '@/api/admin'
import { ApiResponseError } from '@/api/client'
import type { AdminWithdrawalResponse, WithdrawalStatus } from '@/api/admin'
import {
  ADMIN_INVALIDATES,
  ADMIN_WITHDRAWALS_PAGE_SIZE,
  adminPendingWithdrawalsQuery,
  adminWithdrawalsPageQuery,
  onFailedRequest,
  useAdminMutation,
} from '@/composables/queries/admin'
import { invalidateKeys } from '@/composables/queries/invalidation'
import { screenQueryState } from '@/composables/queries/screenState'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { useConsoleWidth } from '@/composables/useConsoleWidth'
import { useViewerTimezone } from '@/composables/useViewerTimezone'
import { formatMoney } from '@/utils/format'

const toast = useToast()
const zone = useViewerTimezone()

/** A payout request as the table row holds it (a plain record, the table's row type). */
type WithdrawalRow = { [K in keyof AdminWithdrawalResponse]: AdminWithdrawalResponse[K] }

const STATUSES: readonly [WithdrawalStatus, ...WithdrawalStatus[]] = [
  'pending',
  'approved',
  'rejected',
]

// The URL is the state; a value it does not know falls back to the default.
const { value: status, set: setStatus } = useUrlChoice('status', STATUSES)
const { page, setPage } = useUrlPage()

// One entry per status and page: a switch shows the loader, never the rows of
// the other status.
const listQuery = useQuery(() =>
  adminWithdrawalsPageQuery({ status: status.value, page: page.value }),
)
const { loading, failed } = screenQueryState(listQuery)
const errorText = computed(() =>
  extractApiError(listQuery.error.value, t('console.finance.withdrawals.loadFailed')),
)

// A page past the end (a kept link, a queue that shrank after a verdict) goes
// to the last page; an empty list goes to the first.
watch(
  () => listQuery.data.value,
  (data) => {
    if (data === undefined) return
    const last = Math.max(1, Math.ceil(data.total / ADMIN_WITHDRAWALS_PAGE_SIZE))
    if (page.value > last) setPage(last)
  },
  { immediate: true },
)

// A failed refetch over a table shown (a return to the app) is told once per
// run of failures; a failed first load is the error state, not a toast.
onFailedRequest(listQuery, (e) => {
  if (listQuery.data.value !== undefined)
    toast.error(extractApiError(e, t('console.finance.withdrawals.loadFailed')))
})

function retry(): void {
  void listQuery.refetch()
}

const rows = computed<WithdrawalRow[]>(() =>
  (listQuery.data.value?.items ?? []).map((item) => ({ ...item })),
)
const total = computed(() => listQuery.data.value?.total ?? 0)

// The pending counter is its own request, so it stays right on any tab and page.
const pendingQuery = useQuery(() => adminPendingWithdrawalsQuery(true))
const statusOptions = computed<SegmentOption[]>(() =>
  STATUSES.map((value) => {
    const label = t(`console.finance.withdrawals.status.${value}`)
    return {
      value,
      label: value === 'pending' ? countedLabel(label, pendingQuery.data.value ?? 0) : label,
    }
  }),
)

// -- Columns. Below 1400 px the payout details move under the name and the net
//    amount under the amount; below 1200 px the date moves under the name. --
const { narrow, medium } = useConsoleWidth()
const columns = computed<ConsoleTableColumn[]>(() => [
  { key: 'master', label: t('console.finance.withdrawals.columns.recipient') },
  {
    key: 'amount',
    label: t('console.finance.withdrawals.columns.amount'),
    width: 120,
    align: 'end',
  },
  ...(medium.value
    ? []
    : [
        {
          key: 'net',
          label: t('console.finance.withdrawals.columns.net'),
          width: 110,
          align: 'end' as const,
        },
        { key: 'details', label: t('console.finance.withdrawals.columns.details'), width: 190 },
      ]),
  ...(narrow.value
    ? []
    : [
        { key: 'requested', label: t('console.finance.withdrawals.columns.requested'), width: 110 },
      ]),
  status.value === 'pending'
    ? { key: 'decision', label: t('console.finance.withdrawals.columns.actions'), width: 220 }
    : { key: 'decision', label: t('console.finance.withdrawals.columns.decision'), width: 190 },
])

// -- What a row says --
function stamp(iso: string): string {
  return formatStamp(iso, zone.value)
}
function money(row: WithdrawalRow, cents: number): string {
  return formatMoney(cents, row.currency, undefined, true)
}
function gross(row: WithdrawalRow): string {
  return money(row, row.amount_cents)
}
function net(row: WithdrawalRow): string {
  return money(row, row.amount_cents - row.fee_cents)
}
function methodLabel(row: WithdrawalRow): string {
  return payoutMethodLabel(row.payout_details)
}
function holder(row: WithdrawalRow): string {
  return payoutHolder(row.payout_details)
}
function decidedAt(row: WithdrawalRow): string {
  const at = row.status === 'approved' ? row.approved_at : row.rejected_at
  return at ? stamp(at) : ''
}

// -- A verdict: one at a time, approve and reject block each other. --
const target = ref<WithdrawalRow | null>(null)
const mode = ref<'approve' | 'reject' | null>(null)
const reason = ref('')
const reasonError = ref('')
const approving = ref(false)
const rejecting = ref(false)
const busy = computed(() => approving.value || rejecting.value)

// The list and the pending counter refetch through the invalidation, and the
// verdict's spinner covers the table catching up.
const approve = useAdminMutation('decideWithdrawal', (id: string) => approveWithdrawal(id))
const reject = useAdminMutation('decideWithdrawal', ({ id, note }: { id: string; note: string }) =>
  rejectWithdrawal(id, note),
)

function askApprove(row: WithdrawalRow): void {
  target.value = row
  mode.value = 'approve'
}

function askReject(row: WithdrawalRow): void {
  target.value = row
  reason.value = ''
  reasonError.value = ''
  mode.value = 'reject'
}

const queryCache = useQueryCache()

/**
 * Tell why a verdict failed. A 409 means another admin decided this request
 * first: say so, drop the window and read the queue again, so the row leaves
 * "pending" instead of waiting for the next return to the app with live
 * buttons that can only answer 409 again.
 */
async function tellVerdictFailure(error: unknown, fallback: string): Promise<void> {
  if (error instanceof ApiResponseError && error.status === 409) {
    toast.error(t('console.finance.withdrawals.toast.alreadyDecided'))
    mode.value = null
    await invalidateKeys(queryCache, ADMIN_INVALIDATES.decideWithdrawal)
    return
  }
  toast.error(extractApiError(error, fallback))
}

function closeDecision(): void {
  // A verdict in flight keeps its window: closing it would hide the outcome.
  if (busy.value) return
  mode.value = null
}

async function onApprove(): Promise<void> {
  if (busy.value || !target.value) return
  approving.value = true
  try {
    await approve.mutateAsync(target.value.id)
    toast.success(t('console.finance.withdrawals.toast.approved'))
    mode.value = null
  } catch (e) {
    await tellVerdictFailure(e, t('console.finance.withdrawals.toast.approveFailed'))
  } finally {
    approving.value = false
  }
}

async function onReject(): Promise<void> {
  // The guard comes before the input check: a second press while the first
  // refusal is in flight must neither validate nor send.
  if (busy.value || !target.value) return
  const note = reason.value.trim()
  if (note === '') {
    reasonError.value = t('console.finance.withdrawals.rejectModal.required')
    return
  }
  reasonError.value = ''
  rejecting.value = true
  try {
    await reject.mutateAsync({ id: target.value.id, note })
    toast.success(t('console.finance.withdrawals.toast.rejected'))
    mode.value = null
  } catch (e) {
    await tellVerdictFailure(e, t('console.finance.withdrawals.toast.rejectFailed'))
  } finally {
    rejecting.value = false
  }
}

// Typing a reason takes its error away at once; typing never adds one.
watch(reason, (value) => {
  if (reasonError.value && value.trim()) reasonError.value = ''
})
</script>

<style scoped>
.withdrawals {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-4);
}

.withdrawals > :deep(.console-card) {
  align-self: stretch;
}

.withdrawals__stack {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-hairline);
  min-width: 0;
  /* A cell of two or three lines is taller than the row's minimum: keep it off the rules. */
  padding-block: var(--space-2);
}

.withdrawals__stack--end {
  align-items: flex-end;
}

.withdrawals__strong {
  overflow-wrap: anywhere;
}

.withdrawals__amount {
  font-size: var(--velo-fs-16);
  color: var(--velo-text-primary);
  -webkit-text-stroke: var(--velo-text-stroke-strong);
}

.withdrawals__sub {
  font-size: var(--velo-fs-12);
  color: var(--velo-text-secondary);
}

.withdrawals__reason {
  display: -webkit-box;
  overflow: hidden;
  font-size: var(--velo-fs-12);
  color: var(--velo-text-secondary);
  overflow-wrap: anywhere;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
}

.withdrawals__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.withdrawals__note {
  align-self: stretch;
  margin: 0;
  padding: var(--space-3) var(--space-4);
  border-radius: var(--velo-radius-10);
  background: var(--velo-glass-blue-15);
  font-size: var(--velo-fs-12);
  color: var(--velo-text-primary);
}
</style>
