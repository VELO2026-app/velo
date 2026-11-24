<!--
  VELO Frontend -- ConsolePracticesView (FE-262, slice 3)

  The practices module of the web console: every practice of the platform
  (not drafts, not deleted) in one table, a tab per scope (upcoming / past /
  all) and a pager. A row opens the practice (console-practices-detail).

  Data: `GET /admin/practices?scope=&limit=&offset=`, one Colada entry per
  scope and page (composables/queries/admin.ts). The scope and the page live
  in the URL (`?scope=past&page=2`), so a reload and the back button keep
  them. The API has no search, filter by direction / master / date, format or
  price: the table shows what the answer carries.
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
      <div v-if="loading" class="console-practices__state" data-testid="console-practices-loading">
        <VLoader size="lg" />
      </div>
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
          :columns="columns"
          :rows="rows"
          :label="t('console.practices.tableLabel')"
          @row-click="openPractice"
        >
          <template #cell-when="{ row }">
            <span class="console-practices__stack">
              <span>{{ formatWhen(row.scheduled_at, row.timezone) }}</span>
              <span class="console-practices__sub">{{
                t('console.practices.duration', { n: row.duration_minutes })
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
            <VAvatar :name="row.master_name" size="sm" />
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
          :page-count="pageCount"
          :summary="summary"
          @update:page="setPage"
        />
      </template>
    </ConsoleCard>
  </ConsolePage>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useQuery } from '@pinia/colada'
import { VAvatar, VButton, VEmptyState, VLoader, VSegment } from '@/components/ui'
import type { SegmentOption } from '@/components/ui'
import ConsoleCard from '@/components/console/ConsoleCard.vue'
import ConsolePage from '@/components/console/ConsolePage.vue'
import ConsoleTable, { type ConsoleTableColumn } from '@/components/console/ConsoleTable.vue'
import CapacityBar from '@/components/console/content/CapacityBar.vue'
import ConsolePager from '@/components/console/content/ConsolePager.vue'
import { formatWhen } from '@/components/console/content/consoleDate'
import { useConsoleWidth } from '@/components/console/content/useConsoleWidth'
import type { AdminPracticeScope } from '@/api/admin'
import {
  ADMIN_PRACTICES_PAGE_SIZE,
  adminPracticesPageQuery,
  onFailedRequest,
} from '@/composables/queries/admin'
import { screenQueryState } from '@/composables/queries/screenState'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
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
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / ADMIN_PRACTICES_PAGE_SIZE)))
const summary = computed(() => {
  const from = (page.value - 1) * ADMIN_PRACTICES_PAGE_SIZE + 1
  return t('console.pager.shown', {
    from,
    to: Math.min(total.value, from + rows.value.length - 1),
    total: total.value,
  })
})

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

// The count of the tab on screen is the answer's total; the others are not
// known without a request of their own.
const scopeOptions = computed<SegmentOption[]>(() =>
  SCOPES.map((value) => ({
    value,
    label: t(`console.practices.scope.${value}`),
    badge: value === scope.value && listQuery.data.value !== undefined ? total.value : undefined,
  })),
)

function openPractice(row: { id: string }): void {
  void router.push({ name: 'console-practices-detail', params: { id: row.id } })
}
</script>

<style scoped>
.console-practices__state {
  display: flex;
  justify-content: center;
  padding: var(--space-8) 0;
}

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
  color: var(--velo-text-muted);
}

.console-practices__master {
  overflow-wrap: anywhere;
}
</style>
