<!--
  VELO Frontend -- MethodRequestsPanel (FE-262, slice 2)

  The "method change" tab of the moderation screen: one card per master who
  asked to change their methods (GET /admin/masters/method-change-requests):
  who, when, the methods now next to the methods after (the added ones stand
  out), and the two decisions. Everything needed to decide is in the list
  row, so a decision needs no second read.

  Approve: when a proposed method is not in the taxonomy (a custom one) the
  approval first asks whether to add it to the catalog for every master or to
  keep it with this master only (FE-89: every unmatched label separately).
  Reject: asks for a reason in a dialog. After either, the request leaves the
  list and the moderation badge at once; then the queue, the badge, the
  master and the catalog read again.

  Not in the API, so not on screen: the master's comment and attachments.
-->

<template>
  <div class="methods" data-testid="method-requests">
    <div v-if="loading && items.length === 0" class="methods__center">
      <VLoader size="lg" />
    </div>

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

    <VEmptyState
      v-else-if="items.length === 0"
      icon="success"
      :title="t('adminScreens.adminMethodRequests.emptyTitle')"
      :description="t('adminScreens.adminMethodRequests.noChangeRequests')"
    />

    <template v-else>
      <ConsoleCard v-for="item in items" :key="item.user_id" data-testid="method-request">
        <header class="methods__head">
          <VAvatar :name="nameOf(item)" :url="item.avatar_url ?? undefined" size="md" />
          <h2 class="methods__title">
            {{ t('console.moderation.methodsAsk', { name: nameOf(item) }) }}
          </h2>
          <span class="methods__when">{{ formatRelative(item.submitted_at) }}</span>
        </header>

        <div class="methods__blocks">
          <section class="methods__block">
            <h3 class="methods__caption">{{ t('adminScreens.adminMethodRequests.now') }}</h3>
            <div class="methods__chips">
              <RequestChip v-for="m in item.current_methods ?? []" :key="m">{{ m }}</RequestChip>
              <span v-if="!item.current_methods?.length" class="methods__empty">—</span>
            </div>
          </section>
          <section class="methods__block">
            <h3 class="methods__caption">{{ t('adminScreens.adminMethodRequests.offered') }}</h3>
            <div class="methods__chips">
              <template v-for="m in item.proposed_methods ?? []" :key="m">
                <RequestStatusBadge
                  v-if="isAdded(item, m)"
                  tone="success"
                  data-testid="method-added"
                  >{{ m }}</RequestStatusBadge
                >
                <RequestChip v-else>{{ m }}</RequestChip>
              </template>
            </div>
          </section>
        </div>

        <div class="methods__actions">
          <VButton
            :loading="busyId === item.user_id && !rejectTarget"
            :disabled="busyId === item.user_id"
            @click="onApprove(item)"
          >
            {{ t('adminScreens.adminMethodRequests.approve') }}
          </VButton>
          <VButton
            variant="secondary"
            :disabled="busyId === item.user_id"
            @click="openReject(item)"
          >
            {{ t('console.moderation.rejectWithReason') }}
          </VButton>
        </div>
      </ConsoleCard>

      <VButton v-if="hasMore" variant="outline" :loading="loadingMore" @click="loadMore">
        {{ t('common.showMore') }}
      </VButton>
    </template>

    <!-- Reject reason -->
    <VModal :open="!!rejectTarget" @close="closeReject">
      <div class="methods__dialog">
        <h2 class="methods__dialog-title">
          {{ t('adminScreens.adminMethodRequests.rejectionReason') }}
        </h2>
        <VTextarea
          v-model="rejectReason"
          :label="t('adminScreens.adminMethodRequests.rejectionReason')"
          hide-label
          :placeholder="t('adminScreens.adminMethodRequests.rejectionReasonPlaceholder')"
          :rows="3"
          :error="rejectError"
        />
        <div class="methods__dialog-actions">
          <VButton variant="ghost" @click="closeReject">{{ t('ui.cancel') }}</VButton>
          <VButton :loading="!!rejectTarget && busyId === rejectTarget.user_id" @click="onReject">
            {{ t('adminScreens.adminMethodRequests.rejectCta') }}
          </VButton>
        </div>
      </div>
    </VModal>

    <!-- A custom method that is not in the catalog -->
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
import { computed, ref } from 'vue'
import { useInfiniteQuery, useQueryCache } from '@pinia/colada'
import {
  VAvatar,
  VButton,
  VConfirmDialog,
  VEmptyState,
  VLoader,
  VModal,
  VTextarea,
} from '@/components/ui'
import ConsoleCard from '@/components/console/ConsoleCard.vue'
import RequestChip from '@/components/console/requests/RequestChip.vue'
import RequestStatusBadge from '@/components/console/requests/RequestStatusBadge.vue'
import { approveMethodChange, rejectMethodChange, type AdminMethodChangeItem } from '@/api/admin'
import {
  adminMethodRequestsQuery,
  dropMethodRequest,
  useAdminMutation,
  usePagedListFailures,
} from '@/composables/queries/admin'
import { screenQueryState } from '@/composables/queries/screenState'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { formatRelative, masterDisplayName } from '@/utils/adminHelpers'
import { parseMethods } from '@/utils/methodTaxonomy'

const toast = useToast()

// The pending requests, page by page (Pinia Colada, composables/queries/
// admin.ts); the taxonomy catalog loads with the first page, so a method
// promoted by an earlier approval renders as a recognized one, not "custom".
const queryCache = useQueryCache()
const requestsQuery = useInfiniteQuery(adminMethodRequestsQuery)
const items = computed<AdminMethodChangeItem[]>(
  () => requestsQuery.data.value?.pages.flatMap((page) => page.items) ?? [],
)
const { loading, failed: error } = screenQueryState(requestsQuery)
const hasMore = requestsQuery.hasNextPage

// Every failed request is told: a next page with its own fallback, the list
// itself (its first load, a refetch) with the list's.
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

function nameOf(item: AdminMethodChangeItem): string {
  return item.display_name || masterDisplayName(item)
}

/** A proposed method the master does not have now: shown apart. */
function isAdded(item: AdminMethodChangeItem, method: string): boolean {
  return !(item.current_methods ?? []).includes(method)
}

// The user_id being approved or rejected (disables that card's buttons).
const busyId = ref<string | null>(null)

const rejectTarget = ref<AdminMethodChangeItem | null>(null)
const rejectReason = ref('')
const rejectError = ref('')

// A proposed method that does not match the taxonomy (parseMethods surfaces
// it as a custom one) pauses the approval on a confirm: add the label to the
// catalog, or approve for this master only. Dismissing the dialog counts as
// "this master only" -- it always still approves.
const promoteTarget = ref<AdminMethodChangeItem | null>(null)
/** One entry per unmatched method, scoped or promoted separately (FE-89). */
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

// The verdicts (ADMIN_INVALIDATES): the decided request leaves the list (and
// the badge) at once; then the queue, its badge, the master's detail and
// list chips refetch; a promoted method is a new catalog row.
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

/**
 * Approve: pause on a confirm if any proposed method is custom, else approve
 * at once. The unmatched labels travel separately (FE-89): one joined string
 * would scope one direction named "A, B" and glue the master's second own
 * method into the first.
 */
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
    await approve.mutateAsync({
      userId: item.user_id,
      ...(promote !== undefined ? { promote } : {}),
      ...(masterOnly !== undefined ? { masterOnly } : {}),
    })
    toast.success(t('adminScreens.adminMethodRequests.methodsUpdated'))
  } catch (e) {
    toast.error(extractApiError(e, t('adminScreens.adminMethodRequests.approveError')))
  } finally {
    busyId.value = null
    promoteTarget.value = null
  }
}

/** "Add to catalog": approve and promote the custom labels (each its own catalog row). */
function onPromoteConfirm(): void {
  const item = promoteTarget.value
  if (!item) return
  void doApprove(item, [...promoteLabels.value])
}

/** "This master only" (or the dialog dismissed): approve, each label scoped to this master. */
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
.methods {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.methods__center {
  display: flex;
  justify-content: center;
  padding: var(--space-8) 0;
}

.methods__head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.methods__title {
  margin: 0;
  min-width: 0;
  font-size: var(--velo-fs-18);
  font-weight: inherit;
  color: var(--velo-text-primary);
  -webkit-text-stroke: var(--velo-text-stroke-strong);
  overflow-wrap: anywhere;
}

.methods__when {
  margin-left: auto;
  flex-shrink: 0;
  font-size: var(--velo-fs-12);
  color: var(--velo-text-secondary);
}

.methods__blocks {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--space-4);
}

@media (max-width: 899px) {
  .methods__blocks {
    grid-template-columns: minmax(0, 1fr);
  }
}

.methods__block {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--velo-radius-10);
  background: var(--velo-bg-subtle);
}

.methods__caption {
  margin: 0;
  font-size: var(--velo-fs-12);
  font-weight: inherit;
  /* On the grey block the secondary text is under 4.5:1. */
  color: var(--velo-text-primary);
}

.methods__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.methods__empty {
  font-size: var(--velo-fs-14);
  color: var(--velo-text-primary);
}

.methods__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.methods__dialog {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.methods__dialog-title {
  margin: 0;
  font-size: var(--velo-fs-18);
  font-weight: inherit;
  color: var(--velo-text-primary);
}

.methods__dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
