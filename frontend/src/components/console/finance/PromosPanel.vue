<!--
  VELO Frontend -- PromosPanel (FE-267)

  The promo codes of the web console's Finance module: a tab per owner (all,
  the company's, the masters'), a table, a pager, deactivation after a
  confirmation and a form that creates a company promo.

  Data: `GET /admin/promos?type=&limit=&offset=`, one Colada entry per tab and
  page (composables/queries/admin.ts); the tab and the page ride the URL. A
  deactivated promo stays in the list with its status; there is no tab for
  them. `PATCH /admin/promos/{id}/deactivate` works on any promo, a master's
  too; only the company's can be created here (`POST /admin/promos`).
-->

<template>
  <div class="promos" data-testid="finance-promos">
    <div class="promos__toolbar">
      <VSegment
        compact
        :model-value="filter"
        :options="filterOptions"
        :aria-label="t('console.finance.promos.filterLabel')"
        @update:model-value="setFilter"
      />
      <VButton @click="createOpen = true">{{ t('console.finance.promos.create') }}</VButton>
    </div>

    <ConsoleCard flush>
      <ConsoleLoading v-if="loading" data-testid="finance-loading" />
      <VEmptyState
        v-else-if="failed"
        icon="warning"
        :title="t('console.finance.promos.loadFailed')"
        :description="errorText"
      >
        <VButton size="sm" variant="outline" @click="retry">{{ t('common.retry') }}</VButton>
      </VEmptyState>
      <template v-else>
        <ConsoleTable
          :columns="columns"
          :rows="rows"
          :label="t('console.finance.promos.tableLabel')"
        >
          <template #cell-code="{ row }">
            <span class="promos__stack">
              <span class="promos__code">{{ row.code }}</span>
              <span v-if="medium" class="promos__sub">{{ owner(row) }}</span>
            </span>
          </template>
          <template #cell-owner="{ row }">{{ owner(row) }}</template>
          <template #cell-discount="{ row }">
            {{ t('console.finance.promos.percent', { n: row.discount_percent }) }}
          </template>
          <template #cell-used="{ row }">
            <span class="promos__stack promos__stack--end">
              <span>{{ used(row) }}</span>
              <span v-if="narrow" class="promos__sub">{{ untilLine(row) }}</span>
            </span>
          </template>
          <template #cell-until="{ row }">{{ until(row) }}</template>
          <template #cell-state="{ row }">
            <span class="promos__stack">
              <ConsoleStatusBadge :tone="row.status === 'active' ? 'success' : 'muted'">
                {{ t(`console.finance.promos.status.${row.status}`) }}
              </ConsoleStatusBadge>
              <VButton
                v-if="narrow && row.status === 'active'"
                size="sm"
                variant="outline"
                :loading="deactivatingId === row.id"
                :aria-label="t('console.finance.promos.deactivateFor', { code: row.code })"
                @click="askDeactivate(row)"
              >
                {{ t('console.finance.promos.deactivate') }}
              </VButton>
            </span>
          </template>
          <template #cell-action="{ row }">
            <VButton
              v-if="row.status === 'active'"
              size="sm"
              variant="outline"
              :loading="deactivatingId === row.id"
              :aria-label="t('console.finance.promos.deactivateFor', { code: row.code })"
              @click="askDeactivate(row)"
            >
              {{ t('console.finance.promos.deactivate') }}
            </VButton>
          </template>
          <template #empty>{{ t(`console.finance.promos.empty.${filter}`) }}</template>
        </ConsoleTable>
        <ConsolePager
          v-if="total > 0"
          :page="page"
          :page-count="pageCount"
          :summary="summary"
          @update:page="setPage"
        />
      </template>
    </ConsoleCard>

    <PromoCreateModal :open="createOpen" @created="onCreated" @close="createOpen = false" />
    <VConfirmDialog
      :open="confirmTarget !== null"
      :message="confirmMessage"
      :confirm-label="t('console.finance.promos.deactivate')"
      danger
      :loading="deactivatingId !== null"
      @confirm="onConfirmDeactivate"
      @cancel="cancelDeactivate"
    />
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed, ref, watch } from 'vue'
import { useQuery } from '@pinia/colada'
import { VButton, VConfirmDialog, VEmptyState, VSegment } from '@/components/ui'
import type { SegmentOption } from '@/components/ui'
import ConsoleCard from '@/components/console/ConsoleCard.vue'
import ConsoleTable, { type ConsoleTableColumn } from '@/components/console/ConsoleTable.vue'
import ConsoleLoading from '@/components/console/content/ConsoleLoading.vue'
import ConsolePager from '@/components/console/content/ConsolePager.vue'
import ConsoleStatusBadge from '@/components/console/content/ConsoleStatusBadge.vue'
import PromoCreateModal from '@/components/console/finance/PromoCreateModal.vue'
import { formatDay } from '@/components/console/finance/financeFormat'
import { promoStatus, type PromoStatus } from '@/components/console/finance/promoStatus'
import { useUrlChoice } from '@/components/console/finance/useUrlChoice'
import { useUrlPage } from '@/components/console/finance/useUrlPage'
import { deactivateAdminPromo } from '@/api/admin'
import type { AdminPromoResponse } from '@/api/admin'
import {
  ADMIN_PROMOS_PAGE_SIZE,
  adminPromosPageQuery,
  onFailedRequest,
  useAdminMutation,
  type ConsolePromoFilter,
} from '@/composables/queries/admin'
import { screenQueryState } from '@/composables/queries/screenState'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { useConsoleWidth } from '@/composables/useConsoleWidth'
import { useViewerTimezone } from '@/composables/useViewerTimezone'

const toast = useToast()
const zone = useViewerTimezone()

/** A promo as the table row holds it: the answer's fields and the status the table shows. */
type PromoRow = { [K in keyof AdminPromoResponse]: AdminPromoResponse[K] } & { status: PromoStatus }

const FILTERS: readonly [ConsolePromoFilter, ...ConsolePromoFilter[]] = ['all', 'company', 'master']

// The URL is the state; a value it does not know falls back to the default.
const { value: filter, set: setFilter } = useUrlChoice('filter', FILTERS)
const { page, setPage } = useUrlPage()

// One entry per tab and page: a switch shows the loader, never the rows of
// the other tab.
const listQuery = useQuery(() => adminPromosPageQuery({ filter: filter.value, page: page.value }))
const { loading, failed } = screenQueryState(listQuery)
const errorText = computed(() =>
  extractApiError(listQuery.error.value, t('console.finance.promos.loadFailed')),
)

// A page past the end goes to the last page; an empty list goes to the first.
watch(
  () => listQuery.data.value,
  (data) => {
    if (data === undefined) return
    const last = Math.max(1, Math.ceil(data.total / ADMIN_PROMOS_PAGE_SIZE))
    if (page.value > last) setPage(last)
  },
  { immediate: true },
)

// A failed refetch over a table shown (a return to the app) is told once per
// run of failures; a failed first load is the error state, not a toast.
onFailedRequest(listQuery, (e) => {
  if (listQuery.data.value !== undefined)
    toast.error(extractApiError(e, t('console.finance.promos.loadFailed')))
})

function retry(): void {
  void listQuery.refetch()
}

const filterOptions = computed<SegmentOption[]>(() =>
  FILTERS.map((value) => ({ value, label: t(`console.finance.promos.filter.${value}`) })),
)

const rows = computed<PromoRow[]>(() => {
  const now = Date.now()
  return (listQuery.data.value?.items ?? []).map((item) => ({
    ...item,
    status: promoStatus(item, now),
  }))
})
const total = computed(() => listQuery.data.value?.total ?? 0)
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / ADMIN_PROMOS_PAGE_SIZE)))
const summary = computed(() => {
  const from = (page.value - 1) * ADMIN_PROMOS_PAGE_SIZE + 1
  return t('console.pager.shown', {
    from,
    to: Math.min(total.value, from + rows.value.length - 1),
    total: total.value,
  })
})

// -- Columns. Below 1400 px the owner moves under the code; below 1200 px the
//    end date moves under the use count and the button under the status. --
const { narrow, medium } = useConsoleWidth()
const columns = computed<ConsoleTableColumn[]>(() => [
  { key: 'code', label: t('console.finance.promos.columns.code') },
  ...(medium.value ? [] : [{ key: 'owner', label: t('console.finance.promos.columns.owner') }]),
  {
    key: 'discount',
    label: t('console.finance.promos.columns.discount'),
    width: narrow.value ? 70 : 90,
    align: 'end',
  },
  { key: 'used', label: t('console.finance.promos.columns.used'), width: 120, align: 'end' },
  ...(narrow.value
    ? []
    : [{ key: 'until', label: t('console.finance.promos.columns.until'), width: 110 }]),
  {
    key: 'state',
    label: t('console.finance.promos.columns.status'),
    width: narrow.value ? 150 : 130,
  },
  // Below 1200 px the button sits under the status: no column of its own.
  ...(narrow.value
    ? []
    : [{ key: 'action', label: t('console.finance.promos.columns.actions'), width: 150 }]),
])

// -- What a row says --
function owner(row: PromoRow): string {
  if (row.type === 'company')
    return t('console.finance.promos.ownerCompany', { brand: t('common.brandName') })
  const name = [row.master_first_name, row.master_last_name].filter(Boolean).join(' ')
  return name || t('console.finance.promos.ownerFallback')
}
function used(row: PromoRow): string {
  return row.max_uses === null
    ? String(row.used_count)
    : t('console.finance.promos.usedOf', { used: row.used_count, max: row.max_uses })
}
function until(row: PromoRow): string {
  return row.valid_until ? formatDay(row.valid_until, zone.value) : '—'
}
function untilLine(row: PromoRow): string {
  return row.valid_until ? t('console.finance.promos.untilLine', { date: until(row) }) : ''
}

// -- A new promo. The admin should see it: another owner's tab would hide it. --
const createOpen = ref(false)
function onCreated(): void {
  createOpen.value = false
  if (filter.value === 'master') setFilter('company')
  else if (page.value > 1) setPage(1)
}

// -- Deactivation: after a confirmation, one at a time. The list refetches
//    through the invalidation (ADMIN_INVALIDATES.deactivatePromo). --
const confirmTarget = ref<PromoRow | null>(null)
const deactivatingId = ref<string | null>(null)
const deactivate = useAdminMutation('deactivatePromo', (id: string) => deactivateAdminPromo(id))

const confirmMessage = computed(() =>
  confirmTarget.value
    ? t('console.finance.promos.deactivateConfirm', { code: confirmTarget.value.code })
    : '',
)

function askDeactivate(row: PromoRow): void {
  confirmTarget.value = row
}

function cancelDeactivate(): void {
  // A request in flight keeps its dialog (Escape and the backdrop reach here
  // too): closing it would hide the outcome.
  if (deactivatingId.value !== null) return
  confirmTarget.value = null
}

async function onConfirmDeactivate(): Promise<void> {
  const row = confirmTarget.value
  if (row === null || deactivatingId.value !== null) return
  deactivatingId.value = row.id
  try {
    await deactivate.mutateAsync(row.id)
    toast.success(t('console.finance.promos.toast.deactivated'))
  } catch (e) {
    toast.error(extractApiError(e, t('console.finance.promos.toast.deactivateFailed')))
  } finally {
    deactivatingId.value = null
    confirmTarget.value = null
  }
}
</script>

<style scoped>
.promos {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.promos__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.promos__stack {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-1);
  min-width: 0;
  /* A cell of two lines (code and owner, status and button) is taller than the row's minimum: keep it off the rules. */
  padding-block: var(--space-2);
}

.promos__stack--end {
  align-items: flex-end;
}

.promos__code {
  overflow-wrap: anywhere;
  font-size: var(--velo-fs-16);
  color: var(--velo-text-primary);
  -webkit-text-stroke: var(--velo-text-stroke-strong);
}

.promos__sub {
  font-size: var(--velo-fs-12);
  color: var(--velo-text-secondary);
}
</style>
