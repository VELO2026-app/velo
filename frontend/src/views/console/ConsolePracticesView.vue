<!--
  VELO Frontend -- ConsolePracticesView (FE-262, slice 3)

  The practices module of the web console: every practice of the platform
  (not drafts, not deleted) in one table, a tab per scope (upcoming / past /
  all) and a pager. A row opens the practice (console-practices-detail).

  Data: `GET /admin/practices?scope=&limit=&offset=`, one Colada entry per
  scope and page (composables/queries/admin.ts). The scope and the page live
  in the URL (`?scope=past&page=2`), so a reload and the back button keep
  them. The upcoming scope is shown nearest first whichever way the API
  lists it (loadPracticesPage reads the order and sorts the page). The API has
  no search, filter by direction / master / date, format or price: the table
  shows what the answer carries.
-->

<template>
  <ConsolePage
    :title="t('console.modules.practices')"
    :crumbs="t('console.groups.content')"
    testid="console-practices"
  >
    <template #tabs>
      <VSegment
        compact
        :model-value="scope"
        :options="scopeOptions"
        :aria-label="t('console.practices.scopesLabel')"
        @update:model-value="setScope"
      />
    </template>

    <ConsoleCard flush>
      <ConsoleLoading v-if="loading" data-testid="console-practices-loading" />
      <VEmptyState
        v-else-if="failed"
        icon="warning"
        :title="t('console.practices.loadFailed')"
        :description="errorText"
      >
        <VButton size="sm" variant="outline" @click="retry">{{ t('common.retry') }}</VButton>
      </VEmptyState>
      <template v-else>
        <ConsoleTable
          clickable
          :columns="columns"
          :rows="rows"
          :label="t('console.practices.tableLabel')"
          @row-click="openPractice"
        >
          <template #cell-when="{ row }">
            <span class="console-practices__stack">
              <span>{{ formatWhen(row.scheduled_at, row.timezone) }}</span>
              <span class="console-practices__sub">{{
                `${row.duration_minutes} ${t('common.duration.min')}`
              }}</span>
            </span>
          </template>
          <template #cell-title="{ row }">
            <span class="console-practices__stack">
              <span class="console-practices__title">{{ row.title }}</span>
              <span v-if="subline(row)" class="console-practices__sub">{{ subline(row) }}</span>
            </span>
          </template>
          <template #cell-master_name="{ row }">
            <VAvatar class="console-practices__avatar" :name="row.master_name" size="sm" />
            <span class="console-practices__master">{{ row.master_name }}</span>
          </template>
          <template #cell-booked="{ row }">
            <CapacityBar :booked="row.booked" :capacity="row.capacity" />
          </template>
          <template #empty>{{ t('console.practices.empty') }}</template>
        </ConsoleTable>
        <ConsolePager
          v-if="total > 0"
          :page="page"
          :page-size="ADMIN_PRACTICES_PAGE_SIZE"
          :total="total"
          :shown="rows.length"
          @update:page="setPage"
        />
      </template>
    </ConsoleCard>
  </ConsolePage>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useQuery } from '@pinia/colada'
import { VAvatar, VButton, VEmptyState, VSegment } from '@/components/ui'
import type { SegmentOption } from '@/components/ui'
import ConsoleCard from '@/components/console/ConsoleCard.vue'
import ConsolePage from '@/components/console/ConsolePage.vue'
import ConsoleTable, { type ConsoleTableColumn } from '@/components/console/ConsoleTable.vue'
import CapacityBar from '@/components/console/content/CapacityBar.vue'
import ConsoleLoading from '@/components/console/ConsoleLoading.vue'
import ConsolePager from '@/components/console/ConsolePager.vue'
import { formatWhen } from '@/utils/console/date'
import { useConsoleWidth } from '@/composables/useConsoleWidth'
import type { AdminPracticeScope } from '@/api/admin'
import {
  ADMIN_PRACTICES_PAGE_SIZE,
  adminPracticesPageQuery,
  onFailedRequest,
} from '@/composables/queries/admin'
import { screenQueryState } from '@/composables/queries/screenState'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { formatCount } from '@/utils/format'
import { directionLabel } from '@/utils/methodTaxonomy'

const route = useRoute()
const router = useRouter()
const toast = useToast()

const SCOPES: readonly AdminPracticeScope[] = ['upcoming', 'past', 'all']

// The URL is the state; a value it does not know falls back to the default.
const scope = computed<AdminPracticeScope>(() => {
  const raw = route.query.scope
  return SCOPES.find((s) => s === raw) ?? 'upcoming'
})
const page = computed<number>(() => {
  const n = Number(route.query.page)
  return Number.isInteger(n) && n >= 1 ? n : 1
})

function setScope(value: string): void {
  const next = SCOPES.find((s) => s === value)
  if (next === undefined || next === scope.value) return
  // A new scope starts at its first page (no `page` in the URL).
  void router.replace({ query: { scope: next } })
}

function setPage(next: number): void {
  void router.replace({
    query: { scope: scope.value, ...(next > 1 ? { page: String(next) } : {}) },
  })
}

// One entry per scope and page: a switch shows the loader, never the rows of
// the previous scope.
const listQuery = useQuery(() => adminPracticesPageQuery({ scope: scope.value, page: page.value }))
const { loading, failed } = screenQueryState(listQuery)
const errorText = computed(() => extractApiError(listQuery.error.value, t('common.loadError')))

// A page past the end (a kept link, a list that shrank) goes to the last page;
// an empty list goes to the first. The answer's total says where the end is.
watch(
  () => listQuery.data.value,
  (data) => {
    if (data === undefined) return
    const last = Math.max(1, Math.ceil(data.total / ADMIN_PRACTICES_PAGE_SIZE))
    if (page.value > last) setPage(last)
  },
  { immediate: true },
)

// A failed refetch over a table shown (a return to the app) is told.
onFailedRequest(listQuery, (e) => {
  if (listQuery.data.value !== undefined)
    toast.error(extractApiError(e, t('console.practices.loadFailed')))
})

function retry(): void {
  void listQuery.refetch()
}

// Spread: ConsoleTable rows are plain records, the API items are interfaces.
const rows = computed(() => (listQuery.data.value?.items ?? []).map((item) => ({ ...item })))
const total = computed(() => listQuery.data.value?.total ?? 0)

// Below 1200 px the master column goes: its name moves under the title.
const { narrow } = useConsoleWidth()

const columns = computed<ConsoleTableColumn[]>(() => [
  { key: 'when', label: t('console.practices.columns.when'), width: narrow.value ? 150 : 180 },
  { key: 'title', label: t('console.practices.columns.practice') },
  ...(narrow.value
    ? []
    : [{ key: 'master_name', label: t('console.practices.columns.master'), width: 220 }]),
  { key: 'booked', label: t('console.practices.columns.booked'), width: narrow.value ? 120 : 160 },
])

/** The grey line under a practice title: its direction, and the master when the column is gone. */
function subline(row: { direction: string | null; master_name: string }): string {
  return [
    row.direction ? directionLabel(row.direction) : null,
    narrow.value ? row.master_name : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

// The count of the tab on screen is the answer's total ("Upcoming · 64"); the
// others are not known without a request of their own.
const scopeOptions = computed<SegmentOption[]>(() =>
  SCOPES.map((value) => {
    const label = t(`console.practices.scope.${value}`)
    const counted = value === scope.value && listQuery.data.value !== undefined
    return { value, label: counted ? `${label} · ${formatCount(total.value)}` : label }
  }),
)

function openPractice(row: { id: string }): void {
  void router.push({ name: 'console-practices-detail', params: { id: row.id } })
}
</script>

<style scoped>
.console-practices__stack {
  display: flex;
  flex-direction: column;
  gap: var(--space-hairline);
  min-width: 0;
}

.console-practices__title {
  overflow-wrap: anywhere;
}

.console-practices__sub {
  font-size: var(--velo-fs-12);
  color: var(--velo-text-secondary);
}

.console-practices__master {
  overflow-wrap: anywhere;
}

/* The kit paints the initials in the primary colour on a tint (4.09:1 on gold). */
.console-practices__avatar :deep(.v-avatar__initials) {
  color: var(--velo-text-primary);
}
</style>
