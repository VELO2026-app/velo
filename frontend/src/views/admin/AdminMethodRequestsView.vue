<!--
  VELO Frontend -- AdminMethodRequestsView (M3, FLAT)

  The method-change-request admin moderation screen
  (i18n:adminScreens.adminMethodRequests.methodRequestsLink). Lists masters with a
  pending method change-request (GET /admin/masters/method-change-requests) and
  lets an admin approve (methods go live) or reject (with a reason). DS-composed
  from the AdminReports / AdminMasterReview patterns — no operator mockup (the
  master-side block is drawn separately; the admin surface is composed from DS).

  DATA. All real: identity + current vs proposed flat method sets + submitted
  date come straight from the list payload, so a decision needs no second fetch.
  After approve/reject the row is removed locally and the header count updated.

  Route: /admin/method-requests (name: 'admin-method-requests')
-->

<template>
  <div class="amr">
    <header class="amr__top">
      <VBackButton @click="router.back()" />
      <h1 class="amr__title">
        {{ t('adminScreens.adminMethodRequests.methodRequestsLink') }}
      </h1>
      <span class="amr__count">{{ headerCount }}</span>
    </header>

    <!-- Loading: initial -->
    <div v-if="loading && items.length === 0" class="amr__loader">
      <VLoader size="lg" />
    </div>

    <!-- Fetch error -->
    <VEmptyState
      v-else-if="error"
      icon="warning"
      :title="t('common.loadFailed')"
      :description="t('common.checkConnection')"
    >
      <template #action>
        <VButton variant="primary" @click="retry">{{ t('common.retry') }}</VButton>
      </template>
    </VEmptyState>

    <!-- Empty -->
    <VEmptyState
      v-else-if="items.length === 0"
      icon="success"
      :title="t('adminScreens.adminMethodRequests.emptyTitle')"
      :description="t('adminScreens.adminMethodRequests.noChangeRequests')"
    />

    <template v-else>
      <div class="amr__list">
        <VCard v-for="item in items" :key="item.user_id" class="mrq" padding="none">
          <div class="mrq__head">
            <VAvatar :name="nameOf(item)" :url="item.avatar_url ?? undefined" size="md" />
            <div class="mrq__id">
              <div class="mrq__name">{{ nameOf(item) }}</div>
              <div class="mrq__when">{{ formatRelative(item.submitted_at) }}</div>
            </div>
          </div>

          <div class="mrq__block">
            <div class="mrq__blabel">{{ t('adminScreens.adminMethodRequests.now') }}</div>
            <div class="mrq__chips">
              <VChip v-for="m in item.current_methods ?? []" :key="m" size="sm">{{ m }}</VChip>
              <span v-if="!item.current_methods?.length" class="mrq__empty">—</span>
            </div>
          </div>

          <div class="mrq__block">
            <div class="mrq__blabel">{{ t('adminScreens.adminMethodRequests.offered') }}</div>
            <div class="mrq__chips">
              <VChip v-for="m in item.proposed_methods ?? []" :key="m" size="sm">{{ m }}</VChip>
            </div>
          </div>

          <div class="mrq__actions">
            <VButton variant="ghost" :disabled="busyId === item.user_id" @click="openReject(item)">
              {{ t('adminScreens.adminMethodRequests.reject') }}
            </VButton>
            <VButton
              variant="primary"
              :loading="busyId === item.user_id && !rejectTarget"
              :disabled="busyId === item.user_id"
              @click="onApprove(item)"
            >
              {{ t('adminScreens.adminMethodRequests.approve') }}
            </VButton>
          </div>
        </VCard>
      </div>

      <div v-if="hasMore" class="amr__more">
        <VButton variant="outline" block :loading="loadingMore" @click="loadMore">
          {{ t('common.showMore') }}
        </VButton>
      </div>
    </template>

    <!-- Reject reason (bottom-sheet, mirrors AdminMasterReview) -->
    <VBottomSheet
      :open="!!rejectTarget"
      :title="t('adminScreens.adminMethodRequests.rejectionReason')"
      :save-label="t('adminScreens.adminMethodRequests.rejectCta')"
      @save="onReject"
      @close="closeReject"
    >
      <VTextarea
        v-model="rejectReason"
        :placeholder="t('adminScreens.adminMethodRequests.rejectionReasonPlaceholder')"
        :rows="3"
        :error="rejectError"
      />
    </VBottomSheet>

    <!-- Custom method not in the catalog (R5 stage 4, operator decision 3=B) -->
    <VConfirmDialog
      :open="!!promoteTarget"
      :message="promoteMessage"
      :confirm-label="t('adminScreens.adminMethodRequests.addToCatalog')"
      :cancel-label="t('adminScreens.adminMethodRequests.thisMasterOnly')"
      :loading="!!promoteTarget && busyId === promoteTarget.user_id"
      @confirm="onPromoteConfirm"
      @cancel="onPromoteCancel"
    />
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useInfiniteQuery, useQueryCache } from '@pinia/colada'
import {
  VBackButton,
  VButton,
  VLoader,
  VEmptyState,
  VCard,
  VAvatar,
  VChip,
  VBottomSheet,
  VTextarea,
  VConfirmDialog,
} from '@/components/ui'
import { useToast } from '@/composables/useToast'
import { approveMethodChange, rejectMethodChange } from '@/api/admin'
import type { AdminMethodChangeItem } from '@/api/admin'
import { extractApiError } from '@/composables/useApiError'
import {
  adminMethodRequestsQuery,
  dropMethodRequest,
  useAdminMutation,
  usePagedListFailures,
} from '@/composables/queries/admin'
import { screenQueryState } from '@/composables/queries/screenState'
import { masterDisplayName, formatRelative } from '@/utils/adminHelpers'
import { parseMethods } from '@/utils/methodTaxonomy'

const router = useRouter()
const toast = useToast()

// The pending requests, page by page (Pinia Colada,
// composables/queries/admin.ts); the taxonomy catalog loads with the
// first page (Bug 2, PROMPT №405), so a method promoted by an earlier
// approval renders as a recognized chip instead of "custom".
const queryCache = useQueryCache()
const requestsQuery = useInfiniteQuery(adminMethodRequestsQuery)
const items = computed<AdminMethodChangeItem[]>(
  () => requestsQuery.data.value?.pages.flatMap((page) => page.items) ?? [],
)
const total = computed(() => requestsQuery.data.value?.pages.at(-1)?.total ?? 0)
const { loading, failed: error } = screenQueryState(requestsQuery)
const hasMore = requestsQuery.hasNextPage

// The user_id currently being approved/rejected (disables that row's buttons).
const busyId = ref<string | null>(null)

// Reject bottom-sheet target + reason.
const rejectTarget = ref<AdminMethodChangeItem | null>(null)
const rejectReason = ref('')
const rejectError = ref('')

// R5 stage 4 (operator decision 3=B): a proposed_methods entry that doesn't
// match the taxonomy (parseMethods surfaces it as customText) pauses the
// approval on a confirm -- add the custom label to the catalog, or approve
// as-is (this master only, today's behavior). Dismissing the dialog (overlay
// tap) is treated the same as "this master only" -- it always still
// approves, it just never fails to act on an accidental dismiss.
const promoteTarget = ref<AdminMethodChangeItem | null>(null)
/** FE-89: one entry per unmatched method -- scoped/promoted separately, so a
 *  master's already-approved private method is never glued to the new one. */
const promoteLabels = ref<string[]>([])
const promoteMessage = computed((): string => {
  const labels = promoteLabels.value
  if (labels.length <= 1) {
    return t('adminScreens.adminCommon.methodSingle', { label: labels[0] ?? '' })
  }
  return t('adminScreens.adminCommon.methodPlural', {
    labels: labels.map((l) => `«${l}»`).join(', '),
  })
})

const headerCount = computed<string>(() => (total.value ? String(total.value) : '—'))

function nameOf(item: AdminMethodChangeItem): string {
  return item.display_name || masterDisplayName(item)
}

// Every failed request is told: a next page with its own fallback, the
// list itself (its first load, a refetch) with the list's.
const { loadingMore, loadMore } = usePagedListFailures(requestsQuery, (e, nextPage) =>
  toast.error(
    extractApiError(
      e,
      nextPage ? t('common.loadError') : t('adminScreens.adminMethodRequests.loadFailedToast'),
    ),
  ),
)

function retry(): void {
  void requestsQuery.refetch()
}

// The verdicts (ADMIN_INVALIDATES): the decided request leaves the list (and
// the header count) at once; then the queue, its dashboard badge, the
// master's detail and list chips refetch; a promoted method is a new
// catalog row.
const approve = useAdminMutation(
  'approveMethodChange',
  (vars: { userId: string; promote?: string[]; masterOnly?: string[] }) =>
    approveMethodChange(vars.userId, vars.promote, vars.masterOnly),
  { write: (_res, vars) => dropMethodRequest(queryCache, vars.userId), waitForRefetch: false },
)
const reject = useAdminMutation(
  'rejectMethodChange',
  (vars: { userId: string; reason: string }) => rejectMethodChange(vars.userId, vars.reason),
  { write: (_res, vars) => dropMethodRequest(queryCache, vars.userId), waitForRefetch: false },
)

/** Tap t('adminScreens.adminMethodRequests.odobrit'): pause on a confirm if any proposed method doesn't match
 *  the taxonomy (custom/unmatched), else approve immediately (unchanged).
 *  FE-89: the unmatched labels travel SEPARATELY (parsed.custom) -- the old
 *  joined customText string scoped ONE direction named «A, B» and glued the
 *  master's second own method into the first. */
function onApprove(item: AdminMethodChangeItem): void {
  if (busyId.value) return
  const parsed = parseMethods(item.proposed_methods ?? [])
  if (parsed.customEnabled && parsed.custom.length) {
    promoteTarget.value = item
    promoteLabels.value = parsed.custom
    return
  }
  void doApprove(item)
}

async function doApprove(
  item: AdminMethodChangeItem,
  promote?: string[],
  masterOnly?: string[],
): Promise<void> {
  if (busyId.value) return
  busyId.value = item.user_id
  try {
    await approve.mutateAsync({ userId: item.user_id, promote, masterOnly })
    toast.success(t('adminScreens.adminMethodRequests.methodsUpdated'))
  } catch (e) {
    toast.error(extractApiError(e, t('adminScreens.adminMethodRequests.approveError')))
  } finally {
    busyId.value = null
    promoteTarget.value = null
  }
}

/** Add-to-catalog confirm (i18n:adminScreens.adminMethodRequests.addToCatalog) --
 *  approve AND promote the custom labels (each its
 *  own catalog row). */
function onPromoteConfirm(): void {
  const item = promoteTarget.value
  if (!item) return
  void doApprove(item, [...promoteLabels.value])
}

/** This-master-only cancel (i18n:adminScreens.adminMethodRequests.thisMasterOnly;
 *  or dialog dismissed) -- approve, scoped to this
 *  master only (T22-6, PROMPT №561): a real taxonomy row per label, just not
 *  a shared one -- was silently nothing before this. FE-89: per-label, so
 *  the master's earlier private direction is re-scoped idempotently and the
 *  new one is born standalone, never glued together. */
function onPromoteCancel(): void {
  const item = promoteTarget.value
  if (!item) return
  void doApprove(item, undefined, [...promoteLabels.value])
}

function openReject(item: AdminMethodChangeItem): void {
  rejectTarget.value = item
  rejectReason.value = ''
  rejectError.value = ''
}

function closeReject(): void {
  rejectTarget.value = null
}

async function onReject(): Promise<void> {
  const target = rejectTarget.value
  if (!target || busyId.value) return
  rejectError.value = ''
  if (!rejectReason.value.trim()) {
    rejectError.value = t('adminScreens.adminMethodRequests.rejectionReasonHint')
    return
  }
  busyId.value = target.user_id
  try {
    await reject.mutateAsync({ userId: target.user_id, reason: rejectReason.value.trim() })
    toast.success(t('adminScreens.adminMethodRequests.toast.requestRejected'))
    rejectTarget.value = null
  } catch (e) {
    toast.error(extractApiError(e, t('adminScreens.adminMethodRequests.toast.rejectFailed')))
  } finally {
    busyId.value = null
  }
}
</script>

<style scoped>
.amr {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* -- Header: back + title + count badge (mirrors AdminReports) -- */
.amr__top {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: var(--velo-size-44);
}

.amr__title {
  flex: 1;
  font-family: var(--font-body);
  font-weight: 400;
  font-size: var(--velo-fs-16);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

.amr__count {
  min-width: var(--velo-size-38);
  height: var(--velo-size-36);
  padding: 0 var(--velo-inset-12);
  flex-shrink: 0;
  border-radius: var(--radius-md);
  background: var(--velo-primary);
  color: var(--velo-white);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-body);
  font-size: var(--velo-fs-18);
  letter-spacing: 0.02em;
}

.amr__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-8) 0;
}

.amr__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

/* -- Request card -- */
.mrq {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
}

.mrq__head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.mrq__id {
  min-width: 0;
}

.mrq__name {
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

.mrq__when {
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
}

.mrq__block {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.mrq__blabel {
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
}

.mrq__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.mrq__empty {
  font-size: var(--velo-fs-16);
  color: var(--velo-text-muted);
}

.mrq__actions {
  display: flex;
  gap: var(--space-3);
  margin-top: var(--space-1);
}

.mrq__actions > * {
  flex: 1;
}

.amr__more {
  padding-top: var(--space-1);
}
</style>
