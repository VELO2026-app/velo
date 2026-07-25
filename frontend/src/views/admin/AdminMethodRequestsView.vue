<!--
  VELO Frontend -- AdminMethodRequestsView (M3, FLAT)

  The «Заявки на смену методов» admin moderation screen. Lists masters with a
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
      <span class="amr__title">Заявки на смену методов</span>
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
      title="Не удалось загрузить"
      description="Проверьте соединение и попробуйте ещё раз"
    >
      <template #action>
        <VButton variant="primary" @click="loadInitial">Повторить</VButton>
      </template>
    </VEmptyState>

    <!-- Empty -->
    <VEmptyState
      v-else-if="items.length === 0"
      icon="success"
      title="Заявок нет"
      description="Мастера не запрашивали смену методов"
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
            <div class="mrq__blabel">Сейчас</div>
            <div class="mrq__chips">
              <VChip v-for="m in item.current_methods ?? []" :key="m" size="sm">{{ m }}</VChip>
              <span v-if="!item.current_methods?.length" class="mrq__empty">—</span>
            </div>
          </div>

          <div class="mrq__block">
            <div class="mrq__blabel">Предложено</div>
            <div class="mrq__chips">
              <VChip v-for="m in item.proposed_methods ?? []" :key="m" size="sm">{{ m }}</VChip>
            </div>
          </div>

          <div class="mrq__actions">
            <VButton variant="ghost" :disabled="busyId === item.user_id" @click="openReject(item)">
              Отклонить
            </VButton>
            <VButton
              variant="primary"
              :loading="busyId === item.user_id && !rejectTarget"
              :disabled="busyId === item.user_id"
              @click="onApprove(item)"
            >
              Одобрить
            </VButton>
          </div>
        </VCard>
      </div>

      <div v-if="hasMore" class="amr__more">
        <VButton variant="outline" block :loading="loadingMore" @click="loadMore">
          Показать ещё
        </VButton>
      </div>
    </template>

    <!-- Reject reason (bottom-sheet, mirrors AdminMasterReview) -->
    <VBottomSheet
      :open="!!rejectTarget"
      title="Причина отказа"
      save-label="Отклонить заявку"
      @save="onReject"
      @close="closeReject"
    >
      <VTextarea
        v-model="rejectReason"
        placeholder="Укажите причину отклонения запроса"
        :rows="3"
        :error="rejectError"
      />
    </VBottomSheet>

    <!-- Custom method not in the catalog (R5 stage 4, operator decision 3=Б) -->
    <VConfirmDialog
      :open="!!promoteTarget"
      :message="`Метода «${promoteLabel}» нет в каталоге — добавить для всех мастеров?`"
      confirm-label="Добавить в каталог"
      cancel-label="Только этому мастеру"
      :loading="!!promoteTarget && busyId === promoteTarget.user_id"
      @confirm="onPromoteConfirm"
      @cancel="onPromoteCancel"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
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
import { getMethodChangeRequests, approveMethodChange, rejectMethodChange } from '@/api/admin'
import type { AdminMethodChangeItem } from '@/api/admin'
import { extractApiError } from '@/composables/useApiError'
import { masterDisplayName, formatRelative } from '@/utils/adminHelpers'
import { parseMethods, primeMethodTaxonomyCatalog } from '@/utils/methodTaxonomy'

const LIMIT = 20

const router = useRouter()
const toast = useToast()

const items = ref<AdminMethodChangeItem[]>([])
const total = ref(0)
const loading = ref(false)
const loadingMore = ref(false)
const hasMore = ref(false)
const error = ref(false)

// The user_id currently being approved/rejected (disables that row's buttons).
const busyId = ref<string | null>(null)

// Reject bottom-sheet target + reason.
const rejectTarget = ref<AdminMethodChangeItem | null>(null)
const rejectReason = ref('')
const rejectError = ref('')

// R5 stage 4 (operator decision 3=Б): a proposed_methods entry that doesn't
// match the taxonomy (parseMethods surfaces it as customText) pauses the
// approval on a confirm -- add the custom label to the catalog, or approve
// as-is (this master only, today's behavior). Dismissing the dialog (overlay
// tap) is treated the same as "this master only" -- it always still
// approves, it just never fails to act on an accidental dismiss.
const promoteTarget = ref<AdminMethodChangeItem | null>(null)
const promoteLabel = ref('')

const headerCount = computed<string>(() => (total.value ? String(total.value) : '—'))

function nameOf(item: AdminMethodChangeItem): string {
  return item.display_name || masterDisplayName(item)
}

async function loadInitial(): Promise<void> {
  loading.value = true
  error.value = false
  items.value = []
  total.value = 0
  hasMore.value = false
  try {
    // Bug 2 fix (ПРОМТ №405): prime the taxonomy catalog cache alongside the
    // requests fetch, so a proposed method already promoted from an earlier
    // approval renders as a recognized chip instead of "custom".
    const [res] = await Promise.all([getMethodChangeRequests(LIMIT, 0), primeMethodTaxonomyCatalog()])
    items.value = res.items
    total.value = res.total
    hasMore.value = res.items.length < res.total
  } catch (e) {
    error.value = true
    toast.error(extractApiError(e, 'Ошибка загрузки заявок'))
  } finally {
    loading.value = false
  }
}

async function loadMore(): Promise<void> {
  loadingMore.value = true
  try {
    const res = await getMethodChangeRequests(LIMIT, items.value.length)
    items.value.push(...res.items)
    hasMore.value = items.value.length < res.total
  } catch (e) {
    toast.error(extractApiError(e, 'Ошибка загрузки'))
  } finally {
    loadingMore.value = false
  }
}

// Drop a decided request from the list + decrement the header count.
function removeItem(userId: string): void {
  items.value = items.value.filter((i) => i.user_id !== userId)
  total.value = Math.max(0, total.value - 1)
}

/** Tap "Одобрить": pause on a confirm if any proposed method doesn't match
 *  the taxonomy (custom/unmatched), else approve immediately (unchanged). */
function onApprove(item: AdminMethodChangeItem): void {
  if (busyId.value) return
  const parsed = parseMethods(item.proposed_methods ?? [])
  if (parsed.customEnabled && parsed.customText) {
    promoteTarget.value = item
    promoteLabel.value = parsed.customText
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
    await approveMethodChange(item.user_id, promote, masterOnly)
    toast.success('Методы обновлены')
    removeItem(item.user_id)
  } catch (e) {
    toast.error(extractApiError(e, 'Ошибка при одобрении'))
  } finally {
    busyId.value = null
    promoteTarget.value = null
  }
}

/** «Добавить в каталог» -- approve AND promote the custom label. */
function onPromoteConfirm(): void {
  const item = promoteTarget.value
  if (!item) return
  void doApprove(item, [promoteLabel.value])
}

/** «Только этому мастеру» (or dialog dismissed) -- approve, scoped to this
 *  master only (T22-6, ПРОМТ №561): a real taxonomy row, just not a shared
 *  one -- was silently nothing before this. */
function onPromoteCancel(): void {
  const item = promoteTarget.value
  if (!item) return
  void doApprove(item, undefined, [promoteLabel.value])
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
    rejectError.value = 'Укажите причину отказа'
    return
  }
  busyId.value = target.user_id
  try {
    await rejectMethodChange(target.user_id, rejectReason.value.trim())
    toast.success('Заявка отклонена')
    removeItem(target.user_id)
    rejectTarget.value = null
  } catch (e) {
    toast.error(extractApiError(e, 'Ошибка при отклонении'))
  } finally {
    busyId.value = null
  }
}

onMounted(loadInitial)
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
  font-size: var(--text-sm);
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
  font-size: var(--text-base);
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
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

.mrq__when {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
}

.mrq__block {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.mrq__blabel {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
}

.mrq__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.mrq__empty {
  font-size: var(--text-sm);
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
