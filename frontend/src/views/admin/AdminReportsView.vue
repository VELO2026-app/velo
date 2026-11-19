<!--
  VELO Frontend -- AdminReportsView (Admin DS rebuild 2026-06-14, operator SVGs
  "1 Moderation" + "2 Filter" + request date (i18n:moderation.reportDate))

  The Moderation tab (i18n:adminScreens.adminReports.moderationTab; route
  admin-reports). Rebuilt to the operator design, replacing the F8.3 layout
  (VHeader + two VSelects): header (back + count badge) + filter pill
  (i18n:adminScreens.adminReports.filter) → ModerationFilterModal + all label
  (i18n:common.all) + report cards (warning glyph + reason + relative time), on
  the fog feed with the admin tab bar. Tapping a card opens the report detail.

  DATA. Real: GET /admin/reports (paginated) → reason (title) + created_at (relative
  time); verify/resolve live in the detail. Status filter is wired
  (i18n:moderation.statuses.open → pending, i18n:moderation.statuses.closed →
  resolved). STUB «honest» (build-full-design-now): the card category glyph
  (single warning — ReportResponse has no category) and the reporter name (no name in the
  payload) are honest placeholders; category (i18n:moderation.category) / priority
  (i18n:moderation.priority) / date filters have no backend.
  Roadmap (Zod): extend GET /admin/reports — category (ticket/complaint/payment) + priority
  (P0–P3) + date filtering + reporter name. Recorded in master-ds-zod-roadmap.

  FE-100 (owner ruling 25.10): Moderation (i18n:adminScreens.adminReports.moderationTab)
  is two channels behind a tickets | complaints switch
  (i18n:adminScreens.adminReports.tabTickets | i18n:adminScreens.adminReports.tabComplaints).
  Tickets -- support tickets (components/admin/SupportTicketsPanel.vue, the
  former admin-support screen); complaints -- everything above, unchanged. The tab rides
  the query (`?tab=complaints`; anything else is tickets, the default), so the
  back button from a card lands on the tab it left. The header count is gone (owner).
-->

<template>
  <div class="admin-reports">
    <header class="admin-reports__top">
      <VBackButton @click="router.back()" />
      <h1 class="admin-reports__title">{{ t('adminScreens.adminReports.moderationTab') }}</h1>
    </header>

    <VSegment v-model="tab" :options="tabOptions" />

    <SupportTicketsPanel v-if="tab === 'tickets'" />

    <template v-else>
      <!-- Filter trigger (label echoes the active category, operator variants) -->
      <button type="button" class="admin-reports__filter" @click="showFilter = true">
        <span>{{ pillLabel }}</span>
        <IconFilter :size="22" />
      </button>

      <div v-if="!filter.categories.length" class="admin-reports__active">
        {{ t('common.all') }}
      </div>

      <!-- Loading: initial -->
      <div v-if="loading && items.length === 0" class="admin-reports__loader">
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
        :title="t('adminScreens.adminReports.empty.title')"
        :description="t('adminScreens.adminReports.filterNoHits')"
      />

      <template v-else>
        <div class="admin-reports__list">
          <VCard
            v-for="item in items"
            :key="item.id"
            class="rcard"
            clickable
            padding="none"
            @click="openDetail(item)"
          >
            <span v-if="isPayments" class="rcard__icon rcard__icon--pay">
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.9" />
                <path
                  d="M12 6.5v11M14.6 9c-.5-.8-1.5-1.3-2.6-1.3-1.5 0-2.6.8-2.6 2s1 1.7 2.6 2 2.6.8 2.6 2-1.1 2-2.6 2c-1.1 0-2.1-.5-2.6-1.3"
                  stroke="currentColor"
                  stroke-width="1.7"
                  stroke-linecap="round"
                />
              </svg>
            </span>
            <span v-else class="rcard__icon"><IconWarning :size="34" /></span>
            <div class="rcard__text">
              <div class="rcard__title">{{ item.reason }}</div>
              <div class="rcard__sub">{{ formatRelative(item.created_at) }}</div>
            </div>
          </VCard>
        </div>

        <div v-if="hasMore" class="admin-reports__more">
          <VButton variant="outline" block :loading="loadingMore" @click="loadMore">
            {{ t('common.showMore') }}
          </VButton>
        </div>
      </template>

      <ModerationFilterModal
        :open="showFilter"
        :value="filter"
        @apply="onApply"
        @close="showFilter = false"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useInfiniteQuery } from '@pinia/colada'
import { VBackButton, VButton, VLoader, VEmptyState, VCard, VSegment } from '@/components/ui'
import { IconFilter, IconWarning } from '@/components/icons'
import ModerationFilterModal from '@/components/shared/ModerationFilterModal.vue'
import SupportTicketsPanel from '@/components/admin/SupportTicketsPanel.vue'
import type { ModerationFilter } from '@/components/shared/moderationFilter'
import { toHistoryState } from '@/utils/historySnapshot'
import { useToast } from '@/composables/useToast'
import type { ReportResponse, ReportStatusFilter } from '@/api/admin'
import { extractApiError } from '@/composables/useApiError'
import { adminReportsQuery, onFailedRequest } from '@/composables/queries/admin'
import { screenQueryState } from '@/composables/queries/screenState'
import { formatRelative } from '@/utils/adminHelpers'

const router = useRouter()
const route = useRoute()
const toast = useToast()

// FE-100: tickets | complaints (i18n:adminScreens.adminReports.tabTickets |
// i18n:adminScreens.adminReports.tabComplaints), the tab in the query (see the header).
type ModerationTab = 'tickets' | 'complaints'
const tab = computed<ModerationTab>({
  get: () => (route.query.tab === 'complaints' ? 'complaints' : 'tickets'),
  set: (next) => void router.replace({ query: { ...route.query, tab: next } }),
})
const tabOptions = computed(() => [
  { value: 'tickets', label: t('adminScreens.adminReports.tabTickets') },
  { value: 'complaints', label: t('adminScreens.adminReports.tabComplaints') },
])

const showFilter = ref(false)
const filter = ref<ModerationFilter>({
  categories: [],
  priorities: [],
  statuses: [],
  date: '',
})

const CATEGORY_LABELS: Record<string, string> = {
  tickets: t('adminScreens.adminReports.tickets'),
  complaints: t('adminScreens.adminReports.tabComplaints'),
  payments: t('adminScreens.adminReports.payments'),
}

// Section label reflects the active category filter (honest stub: category has no
// backend yet, so this is a display-only echo of the chosen chips).
const categoryLabel = computed<string>(() => {
  const cats = filter.value.categories
  if (cats.length === 0) return t('common.all')
  return cats.map((c) => CATEGORY_LABELS[c] ?? c).join(', ')
})

// The filter pill echoes the active category (operator «payments»/«complaints»
// variants); the payments selection (i18n:adminScreens.adminReports.payments)
// swaps the card glyph to the payment $.
const pillLabel = computed<string>(() =>
  filter.value.categories.length ? categoryLabel.value : t('adminScreens.adminReports.filter'),
)
const isPayments = computed<boolean>(() => filter.value.categories.includes('payments'))

// Only the status chips (i18n:moderation.status) map to the backend
// (i18n:moderation.statuses.open → pending, i18n:moderation.statuses.closed →
// resolved). Both or none selected = no status filter (all). The rest of the
// filter is a Zod stub.
const apiStatus = computed<ReportStatusFilter | undefined>(() => {
  const s = filter.value.statuses
  if (s.length === 1) {
    if (s[0] === 'open') return 'pending'
    if (s[0] === 'closed') return 'resolved'
  }
  return undefined
})

// The complaints of the current status filter, page by page (Pinia Colada,
// composables/queries/admin.ts) -- one entry per filter, so a slow answer
// for an earlier filter lands in its own entry, never over the shown one
// (W-3). Loaded while their tab is shown (on arrival and on every switch to
// it, staleTime 0).
const reportsQuery = useInfiniteQuery(() =>
  adminReportsQuery({ status: apiStatus.value, enabled: tab.value === 'complaints' }),
)
const items = computed<ReportResponse[]>(
  () => reportsQuery.data.value?.pages.flatMap((page) => page.items) ?? [],
)
const { loading, failed: error } = screenQueryState(reportsQuery)
const loadingMore = ref(false)
const hasMore = reportsQuery.hasNextPage

// A failed first page is the error state and its toast; a failed next page
// keeps the list and toasts on its own (loadMore).
onFailedRequest(reportsQuery, (e) => {
  if (reportsQuery.data.value === undefined)
    toast.error(extractApiError(e, t('adminScreens.adminReports.ticketsLoadError')))
})

function retry(): void {
  void reportsQuery.refetch()
}

async function loadMore(): Promise<void> {
  loadingMore.value = true
  try {
    // cancelRefetch false: a tap during a reload joins it instead of gluing
    // a stale page to a fresh one.
    await reportsQuery.loadNextPage({ throwOnError: true, cancelRefetch: false })
  } catch (e) {
    toast.error(extractApiError(e, t('common.loadError')))
  } finally {
    loadingMore.value = false
  }
}

function onApply(next: ModerationFilter): void {
  const status = apiStatus.value
  filter.value = next
  // Applying the same status filter again asks again, as it always did.
  if (apiStatus.value === status) void reportsQuery.refetch()
}

function openDetail(item: ReportResponse): void {
  void router.push({
    name: 'admin-report-detail',
    params: { id: item.id },
    state: { report: toHistoryState(item) },
  })
}
</script>

<style scoped>
.admin-reports {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* -- Header: back + title + count badge -- */
.admin-reports__top {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: var(--velo-size-44);
}

.admin-reports__title {
  flex: 1;
  font-family: var(--font-body);
  font-weight: 400;
  font-size: var(--velo-fs-16);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

/* -- Filter pill -- */
.admin-reports__filter {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  height: var(--velo-size-50);
  padding: 0 var(--space-5);
  border: var(--velo-border-width) solid var(--velo-glass-border);
  border-radius: var(--radius-xl);
  background: var(--velo-primary);
  color: var(--velo-white);
  font-family: var(--font-body);
  font-size: var(--velo-fs-20);
  letter-spacing: 0.02em;
  cursor: pointer;
  box-shadow: var(--velo-shadow-glow);
}

.admin-reports__active {
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: calc(-1 * var(--space-1)) var(--velo-gap-2);
}

.admin-reports__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-8) 0;
}

.admin-reports__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

/* -- Report card -- */
.rcard {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-4);
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.rcard:active {
  opacity: 0.85;
}

.rcard__icon {
  display: inline-flex;
  flex-shrink: 0;
  color: var(--velo-pink-300);
}

.rcard__icon--pay {
  color: var(--velo-peach-300);
}

.rcard__text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.rcard__title {
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rcard__sub {
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
}

.admin-reports__more {
  padding-top: var(--space-1);
}
</style>
