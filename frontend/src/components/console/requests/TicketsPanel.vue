<!--
  VELO Frontend -- TicketsPanel (FE-262, slice 2)

  The tickets tabs of the support screen: a list of tickets on the left and
  the open one (TicketDetail) next to it. Three scopes over one list API:
  `open` -- tickets still open; `mine` -- the open ones this admin holds (the
  API has no "held by" filter, so they are picked from the open pages loaded
  so far); `closed` -- one closing status at a time (resolved by default),
  chosen with the chips over the list. Category, rating and period filter all
  three (TicketFilters).

  The open ticket and the filters ride the URL (`?ticket=`, `?cat=`,
  `?rating=`, `?period=`), so a reload or the back button lands on them;
  without a ticket in the URL the first ticket of the list is open. The list
  is a Pinia Colada infinite query, one entry per status and filter
  (composables/queries/admin.ts): a slow answer for an earlier tab lands in
  its own entry. Every failed request is told once.

  A row has no last message and the list has no total: the API gives neither
  (the mobile list has the same row).
-->

<template>
  <ConsoleSplit :list-width="layout.listWidth(340, 300)" :pane="layout.pane.value">
    <template #list>
      <ConsoleCard class="tickets-list" data-testid="tickets-list">
        <TicketFilters :model-value="filter" @update:model-value="setFilter" />

        <div v-if="scope === 'closed'" class="tickets-list__chips">
          <RequestChip
            v-for="s in CLOSED_STATUSES"
            :key="s"
            clickable
            :active="closedStatus === s"
            @click="setClosed(s)"
          >
            {{ supportStatusLabel(s) }}
          </RequestChip>
        </div>

        <div v-if="loading && items.length === 0" class="tickets-list__center">
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

        <template v-else>
          <VEmptyState
            v-if="shown.length === 0"
            icon="empty"
            :title="t('adminScreens.adminSupport.empty.title')"
            :description="emptyText"
          />
          <ul v-else class="tickets-list__items">
            <li v-for="item in shown" :key="item.id">
              <button
                type="button"
                class="ticket-row"
                :class="{ 'ticket-row--selected': item.id === selectedId }"
                :aria-current="item.id === selectedId ? 'true' : undefined"
                data-testid="ticket-row"
                @click="select(item)"
              >
                <span class="ticket-row__top">
                  <RequestStatusBadge :tone="supportStatusBadge(item.status)">
                    {{ supportStatusLabel(item.status) }}
                  </RequestStatusBadge>
                  <span class="ticket-row__time">{{ formatRelative(item.created_at) }}</span>
                </span>
                <span class="ticket-row__title">{{ supportTopicLabel(item.topic) }}</span>
                <span class="ticket-row__sub">
                  {{ openerName(item) }} · {{ supportCategoryLabel(item.category) }}
                </span>
                <span class="ticket-row__claim">{{ takerLabel(item.claimed_by, myId) }}</span>
                <RatingStars
                  v-if="item.rating"
                  :stars="item.rating.stars"
                  :size="14"
                  data-testid="ticket-row-rating"
                />
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
        class="tickets-back"
        variant="ghost"
        size="sm"
        data-testid="tickets-back"
        @click="back"
      >
        ‹ {{ t('console.support.backToList') }}
      </VButton>
      <TicketDetail
        v-if="selectedId"
        :key="selectedId"
        :ticket-id="selectedId"
        :handed="selectedRow"
      />
      <ConsoleCard v-else class="tickets-pick">
        <VEmptyState
          icon="empty"
          :title="t('console.support.pickTitle')"
          :description="t('console.support.pickText')"
        />
      </ConsoleCard>
    </template>
  </ConsoleSplit>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useInfiniteQuery } from '@pinia/colada'
import { VButton, VEmptyState, VLoader } from '@/components/ui'
import RatingStars from '@/components/console/requests/RatingStars.vue'
import RequestChip from '@/components/console/requests/RequestChip.vue'
import RequestStatusBadge from '@/components/console/requests/RequestStatusBadge.vue'
import ConsoleCard from '@/components/console/ConsoleCard.vue'
import ConsoleSplit from '@/components/console/ConsoleSplit.vue'
import TicketDetail from '@/components/console/requests/TicketDetail.vue'
import TicketFilters from '@/components/console/requests/TicketFilters.vue'
import {
  filterFromQuery,
  filterToQuery,
  isFiltered,
  ticketQueryOf,
  type TicketFilter,
} from '@/components/console/requests/ticketFilters'
import { takerLabel } from '@/components/console/requests/ticketTaker'
import { useSplitLayout } from '@/components/console/requests/useSplitLayout'
import { useUrlSelection } from '@/components/console/requests/useUrlSelection'
import type { AdminSupportTicket, SupportTicketStatus } from '@/api/support'
import { adminSupportTicketsQuery, usePagedListFailures } from '@/composables/queries/admin'
import { screenQueryState } from '@/composables/queries/screenState'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { useAuthStore } from '@/stores/auth'
import { formatRelative } from '@/utils/adminHelpers'
import {
  supportCategoryLabel,
  supportStatusBadge,
  supportStatusLabel,
  supportTopicLabel,
} from '@/utils/supportTopics'

const props = defineProps<{
  /** Which tickets the list shows (see the header). */
  scope: 'open' | 'mine' | 'closed'
}>()

/** The closed statuses the chips offer, in the order of the close menu. */
const CLOSED_STATUSES: readonly SupportTicketStatus[] = [
  'resolved',
  'rejected',
  'duplicate',
  'spam',
]

const route = useRoute()
const router = useRouter()
const toast = useToast()
const authStore = useAuthStore()

const closedStatus = ref<SupportTicketStatus>('resolved')
const myId = computed(() => authStore.user?.id ?? '')

const filter = computed<TicketFilter>(() => filterFromQuery(route.query))

const ticketsQuery = useInfiniteQuery(() =>
  adminSupportTicketsQuery(
    ticketQueryOf(
      props.scope === 'closed' ? closedStatus.value : 'open',
      filter.value,
      authStore.user?.timezone,
    ),
  ),
)
const items = computed<AdminSupportTicket[]>(
  () => ticketsQuery.data.value?.pages.flatMap((page) => page.tickets) ?? [],
)
/** The tickets on screen: for "mine", the open ones this admin holds. */
const shown = computed<AdminSupportTicket[]>(() =>
  props.scope === 'mine'
    ? items.value.filter((i) => i.claimed_by?.user_id === myId.value)
    : items.value,
)
const emptyText = computed(() => {
  if (isFiltered(filter.value)) return t('adminScreens.adminReports.filterNoHits')
  return props.scope === 'mine'
    ? t('console.support.emptyMine')
    : t('adminScreens.adminSupport.empty.text')
})
const { loading, failed: error } = screenQueryState(ticketsQuery)
const hasMore = ticketsQuery.hasNextPage

// Every failed request is told: a next page with its own fallback, the list
// itself (its first load, a refetch) with the list's.
const { loadingMore, loadMore } = usePagedListFailures(ticketsQuery, (e, nextPage) =>
  toast.error(
    extractApiError(
      e,
      nextPage ? t('common.loadError') : t('adminScreens.adminSupport.ticketsLoadError'),
    ),
  ),
)

function retry(): void {
  void ticketsQuery.refetch()
}

const ticketInUrl = useUrlSelection('ticket')
const layout = useSplitLayout(() => ticketInUrl.urlId.value !== null)

/** Switch the closed-status chips: the open ticket belonged to the other list. */
function setClosed(next: SupportTicketStatus): void {
  closedStatus.value = next
  ticketInUrl.clear()
}

/** A filter changed: the URL takes it, and the open ticket may no longer be in the list. */
function setFilter(next: TicketFilter): void {
  void router.replace({
    query: { ...route.query, ...filterToQuery(next), ticket: undefined },
  })
}

/** The ticket in the URL, else the first of the list (a narrow window shows the list until one is picked). */
const selectedId = computed<string | null>(
  () => ticketInUrl.urlId.value ?? shown.value[0]?.id ?? null,
)
const selectedRow = computed<AdminSupportTicket | null>(
  () => items.value.find((i) => i.id === selectedId.value) ?? null,
)

function select(item: AdminSupportTicket): void {
  ticketInUrl.select(item.id)
}

/** Back to the list on a narrow window: the ticket leaves the URL. */
function back(): void {
  ticketInUrl.clear()
}

function openerName(item: AdminSupportTicket): string {
  return item.opener?.name ?? t('adminScreens.adminSupport.userFallback')
}
</script>

<style scoped>
.tickets-list {
  flex: 1 0 auto;
}

.tickets-list__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.tickets-list__center {
  display: flex;
  justify-content: center;
  padding: var(--space-6) 0;
}

.tickets-list__items {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.ticket-row {
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

.ticket-row:hover {
  background: var(--velo-bg-subtle);
}

.ticket-row--selected {
  border-color: var(--velo-primary);
}

.ticket-row:focus-visible {
  outline: 2px solid var(--velo-primary);
  outline-offset: -2px;
}

.ticket-row__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.ticket-row__time {
  font-size: var(--velo-fs-12);
  color: var(--velo-text-secondary);
}

.ticket-row__title {
  font-size: var(--velo-fs-16);
  color: var(--velo-text-primary);
  overflow-wrap: anywhere;
}

.ticket-row__sub,
.ticket-row__claim {
  font-size: var(--velo-fs-12);
  color: var(--velo-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ticket-row__claim {
  color: var(--velo-text-secondary);
}

.tickets-pick {
  flex: 1 1 auto;
  justify-content: center;
}

.tickets-back {
  align-self: flex-start;
  flex-shrink: 0;
}
</style>
