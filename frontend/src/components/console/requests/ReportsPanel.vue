<!--
  VELO Frontend -- ReportsPanel (FE-262, slice 2)

  The complaints tabs of the moderation screen: the list on the left, the
  open complaint (ReportDetail) next to it. `pending` shows the complaints
  waiting for a decision; `decided` the ones already decided, one verdict at
  a time (resolved by default) -- the API filters by one status.

  The open complaint rides the URL (`?id=<id>`); without one, the first of
  the list is open. A complaint that is in the URL but not in the loaded list
  (a deep link, a reload) is read by itself. After a verdict the URL drops
  the id, so the next complaint of the list opens. The list is a Pinia Colada
  infinite query, one entry per status; every failed request is told once.

  The search field of the mockup is not here: the API has no text search.
-->

<template>
  <ConsoleSplit :list-width="layout.listWidth(400, 320)" :pane="layout.pane.value">
    <template #list>
      <ConsoleCard class="reports-list" data-testid="reports-list">
        <div v-if="mode === 'decided'" class="reports-list__chips">
          <RequestChip
            v-for="s in DECIDED_STATUSES"
            :key="s"
            clickable
            :active="decidedStatus === s"
            @click="setDecided(s)"
          >
            {{ reportStatusLabel(s) }}
          </RequestChip>
        </div>

        <div v-if="loading && items.length === 0" class="reports-list__center">
          <VLoader size="lg" />
        </div>

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

        <VEmptyState
          v-else-if="items.length === 0"
          icon="success"
          :title="t('adminScreens.adminReports.empty.title')"
          :description="
            mode === 'pending'
              ? t('console.moderation.emptyPending')
              : t('console.moderation.emptyDecided')
          "
        />

        <template v-else>
          <ul class="reports-list__items">
            <li v-for="item in items" :key="item.id">
              <button
                type="button"
                class="report-row"
                :class="{ 'report-row--selected': item.id === selectedId }"
                :aria-current="item.id === selectedId ? 'true' : undefined"
                data-testid="report-row"
                @click="select(item)"
              >
                <span class="report-row__top">
                  <ConsoleBadge :tone="reportStatusVariant(item.status)">
                    {{ reportStatusLabel(item.status) }}
                  </ConsoleBadge>
                  <span class="report-row__time">{{ formatRelative(item.created_at) }}</span>
                </span>
                <span class="report-row__title">{{ reportTitle(item) }}</span>
                <span class="report-row__reason">{{ decodeReportReason(item.reason) }}</span>
              </button>
            </li>
          </ul>

          <VButton v-if="hasMore" variant="outline" block :loading="loadingMore" @click="loadMore">
            {{ t('common.showMore') }}
          </VButton>
        </template>
      </ConsoleCard>
    </template>

    <template #detail>
      <VButton
        v-if="layout.single.value"
        class="reports-back"
        variant="ghost"
        size="sm"
        data-testid="reports-back"
        @click="reportInUrl.clear"
      >
        ‹ {{ t('console.moderation.backToList') }}
      </VButton>
      <ReportDetail v-if="report" :key="report.id" :report="report" @decided="onDecided" />
      <ConsoleCard v-else class="reports-pick">
        <div v-if="lookingUp" class="reports-list__center"><VLoader size="lg" /></div>
        <VEmptyState
          v-else-if="selectedId"
          icon="notfound"
          :title="t('adminScreens.adminReportDetail.notFoundTitle')"
          :description="t('adminScreens.adminReportDetail.backToList')"
        />
        <VEmptyState
          v-else
          icon="empty"
          :title="t('console.moderation.pickTitle')"
          :description="t('console.moderation.pickText')"
        />
      </ConsoleCard>
    </template>
  </ConsoleSplit>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed, ref } from 'vue'
import { useInfiniteQuery, useQuery, useQueryCache } from '@pinia/colada'
import { VButton, VEmptyState, VLoader } from '@/components/ui'
import RequestChip from '@/components/console/requests/RequestChip.vue'
import ConsoleBadge from '@/components/console/ConsoleBadge.vue'
import ConsoleCard from '@/components/console/ConsoleCard.vue'
import ConsoleSplit from '@/components/console/ConsoleSplit.vue'
import ReportDetail from '@/components/console/requests/ReportDetail.vue'
import { reportTitle } from '@/components/console/requests/reportTitle'
import { useSplitLayout } from '@/components/console/requests/useSplitLayout'
import { useUrlSelection } from '@/composables/console/useUrlSelection'
import type { ReportResponse, ReportStatusFilter } from '@/api/admin'
import {
  adminReportQuery,
  adminReportsQuery,
  dropReport,
  usePagedListFailures,
} from '@/composables/queries/admin'
import { screenQueryState } from '@/composables/queries/screenState'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { formatRelative, reportStatusLabel, reportStatusVariant } from '@/utils/adminHelpers'
import { decodeReportReason } from '@/utils/reportReasons'

const props = defineProps<{
  /** `pending`: awaiting a decision; `decided`: already resolved or dismissed. */
  mode: 'pending' | 'decided'
}>()

/** The verdicts the "decided" chips offer. */
const DECIDED_STATUSES = ['resolved', 'dismissed'] as const

const queryCache = useQueryCache()
const toast = useToast()

const decidedStatus = ref<(typeof DECIDED_STATUSES)[number]>('resolved')
const status = computed<ReportStatusFilter>(() =>
  props.mode === 'pending' ? 'pending' : decidedStatus.value,
)

const reportsQuery = useInfiniteQuery(() =>
  adminReportsQuery({ status: status.value, enabled: true }),
)
const items = computed<ReportResponse[]>(
  () => reportsQuery.data.value?.pages.flatMap((page) => page.items) ?? [],
)
const { loading, failed: error } = screenQueryState(reportsQuery)
const hasMore = reportsQuery.hasNextPage

// Every failed request is told: a next page with its own fallback, the list
// itself (its first load, a refetch) with the list's.
const { loadingMore, loadMore } = usePagedListFailures(reportsQuery, (e, nextPage) =>
  toast.error(
    extractApiError(
      e,
      nextPage ? t('common.loadError') : t('adminScreens.adminReports.ticketsLoadError'),
    ),
  ),
)

function retry(): void {
  void reportsQuery.refetch()
}

const reportInUrl = useUrlSelection('id')
const layout = useSplitLayout(() => reportInUrl.urlId.value !== null)

/** The complaint in the URL, else the first of the list (a narrow window shows the list until one is picked). */
const selectedId = computed<string | null>(
  () => reportInUrl.urlId.value ?? items.value[0]?.id ?? null,
)
const listed = computed(() => items.value.find((r) => r.id === selectedId.value) ?? null)

// A complaint the list does not hold (a deep link, a reload) is read by
// itself, once the list has answered.
const listAnswered = computed(
  () => reportsQuery.data.value !== undefined || reportsQuery.error.value != null,
)
const lookup = useQuery(() =>
  adminReportQuery({
    reportId: selectedId.value ?? '',
    enabled: selectedId.value !== null && listed.value === null && listAnswered.value,
  }),
)
const report = computed<ReportResponse | null>(() => listed.value ?? lookup.data.value ?? null)
const lookingUp = computed(
  () =>
    selectedId.value !== null && report.value === null && lookup.asyncStatus.value === 'loading',
)

function select(item: ReportResponse): void {
  reportInUrl.select(item.id)
}

/** Switch the verdict chips: the open complaint belonged to the other list. */
function setDecided(next: (typeof DECIDED_STATUSES)[number]): void {
  decidedStatus.value = next
  reportInUrl.clear()
}

/**
 * A verdict landed: the complaint leaves the lists held at once (the
 * verdict's refetch is still on its way), and the URL lets go of it, so the
 * next complaint opens on a wide window and the list shows on a narrow one.
 */
function onDecided(reportId: string): void {
  dropReport(queryCache, reportId)
  reportInUrl.clear()
}
</script>

<style scoped>
.reports-list {
  flex: 1 0 auto;
}

.reports-list__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.reports-list__center {
  display: flex;
  justify-content: center;
  padding: var(--space-6) 0;
}

.reports-list__items {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.report-row {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  width: 100%;
  box-sizing: border-box;
  padding: var(--space-3) var(--space-4);
  border: 1px solid transparent;
  border-radius: var(--velo-radius-10);
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.report-row:hover {
  background: var(--velo-bg-subtle);
}

.report-row--selected {
  border-color: var(--velo-primary);
}

.report-row:focus-visible {
  outline: 2px solid var(--velo-primary);
  outline-offset: -2px;
}

.report-row__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.report-row__time {
  font-size: var(--velo-fs-12);
  color: var(--velo-text-secondary);
}

.report-row__title {
  font-size: var(--velo-fs-16);
  color: var(--velo-text-primary);
  overflow-wrap: anywhere;
}

.report-row__reason {
  font-size: var(--velo-fs-12);
  color: var(--velo-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reports-pick {
  flex: 1 1 auto;
  justify-content: center;
}

.reports-back {
  align-self: flex-start;
  flex-shrink: 0;
}
</style>
