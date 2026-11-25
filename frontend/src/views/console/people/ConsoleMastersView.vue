<!--
  VELO Frontend -- ConsoleMastersView (FE-262, slice 1)

  The masters module of the web console: a table of masters in three tabs
  (all, under review, rejected) with the count of each on its label, and the
  "Invite a master" button. A row opens the master's card
  (console-masters-detail). The tab and the page live in the URL.

  DATA IS REAL: GET /admin/masters/list?status= one page at a time; the
  counts are one-row requests of the same endpoint. Not on the backend yet,
  so not here: search, the direction and school filters, export, and the
  columns for sessions, rating and the per-session rate.
-->

<template>
  <ConsolePage
    :title="t('console.modules.masters')"
    :crumbs="t('console.groups.people')"
    testid="console-masters"
  >
    <template #actions>
      <VButton variant="primary" @click="inviteOpen = true">{{
        t('console.masters.invite')
      }}</VButton>
    </template>
    <template #tabs>
      <VSegment
        :model-value="tab"
        :options="tabOptions"
        compact
        @update:model-value="(value) => setTab(value as ConsoleMastersTab)"
      />
    </template>

    <PeopleListCard
      :loading="loading"
      :failed="failed"
      :error-title="t('adminScreens.adminMasters.loadFailed')"
      @retry="query.refetch()"
    >
      <ConsoleTable
        :columns="columns"
        :rows="rows"
        :label="t('console.modules.masters')"
        clickable
        @row-click="(row) => open(row.master)"
      >
        <template #cell-master="{ row }">
          <PersonCell
            :name="masterDisplayName(row.master)"
            :url="row.master.avatar_url"
            :sub="telegramLine(row.master.telegram_id)"
          />
        </template>
        <template #cell-methods="{ row }">
          <span v-if="row.directions" class="masters-methods" :title="row.methods">{{
            row.directions
          }}</span>
          <span v-else class="masters-muted">{{ DASH }}</span>
        </template>
        <template #cell-status="{ row }">
          <div class="masters-status">
            <PeoplePill :tone="masterStatusTone(row.master.master_status)">
              {{ masterStatusLabel(row.master.master_status) }}
            </PeoplePill>
            <!-- A school counts active and frozen alike (the admin needs to see what stays attached). -->
            <PeoplePill v-if="(row.master.schools_count ?? 0) > 0" tone="accent">
              {{ t('adminScreens.adminMasters.curatorRole') }} · {{ row.master.schools_count }}
            </PeoplePill>
          </div>
        </template>
        <template #cell-practices="{ row }">{{ countText(row.master.practices_count) }}</template>
        <template #cell-students="{ row }">{{ countText(row.master.students_count) }}</template>
        <template #cell-payout="{ row }">{{ payoutText(row.master.available_cents) }}</template>
        <template #empty>{{ emptyText }}</template>
      </ConsoleTable>
      <PeoplePager
        :page="page"
        :page-size="CONSOLE_PAGE_SIZE"
        :total="total"
        :shown="rows.length"
        @update:page="setPage"
      />
    </PeopleListCard>

    <MasterInviteModal :open="inviteOpen" @close="inviteOpen = false" />
  </ConsolePage>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useQuery } from '@pinia/colada'
import { VButton, VSegment } from '@/components/ui'
import { isOptionEnabled } from '@/platform/instance'
import ConsolePage from '@/components/console/ConsolePage.vue'
import ConsoleTable, { type ConsoleTableColumn } from '@/components/console/ConsoleTable.vue'
import MasterInviteModal from '@/components/console/people/MasterInviteModal.vue'
import PeopleListCard from '@/components/console/people/PeopleListCard.vue'
import PeoplePager from '@/components/console/people/PeoplePager.vue'
import PeoplePill from '@/components/console/people/PeoplePill.vue'
import PersonCell from '@/components/console/people/PersonCell.vue'
import {
  DASH,
  countText,
  masterStatusLabel,
  masterStatusTone,
  methodChips,
  payoutText,
  tabOptions as tabOptionsOf,
} from '@/components/console/people/peopleTable'
import type { AdminMasterListItem } from '@/api/admin'
import {
  CONSOLE_PAGE_SIZE,
  consoleMastersCountQuery,
  consoleMastersPageQuery,
  onFailedRequest,
  type ConsoleMastersTab,
} from '@/composables/queries/admin'
import { screenQueryState } from '@/composables/queries/screenState'
import { lastPageOf, useRouteListState } from '@/composables/console/useRouteListState'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { masterDisplayName } from '@/utils/adminHelpers'

const router = useRouter()
const toast = useToast()

const TABS = ['all', 'pending', 'rejected'] as const satisfies readonly ConsoleMastersTab[]

const { tab, page, setTab, setPage, clampTo } = useRouteListState<ConsoleMastersTab>(TABS)

const inviteOpen = ref(false)

const query = useQuery(() => consoleMastersPageQuery({ tab: tab.value, page: page.value }))
const { loading, failed } = screenQueryState(query)
clampTo(() => lastPageOf(query.data.value?.total, CONSOLE_PAGE_SIZE))
onFailedRequest(query, (e) =>
  toast.error(extractApiError(e, t('adminScreens.adminMasters.loadFailedToast'))),
)

// One row per master: ConsoleTable wants a plain record, the cells read the master.
const rows = computed(() =>
  (query.data.value?.items ?? []).map((m) => {
    const chips = methodChips(m)
    return {
      id: m.id,
      master: m,
      // The row names the directions; the tooltip carries the styles too.
      directions: chips
        .filter((c) => !c.muted)
        .map((c) => c.label)
        .join(', '),
      methods: chips.map((c) => c.label).join(', '),
    }
  }),
)
const total = computed(() => query.data.value?.total ?? 0)

// A tab's total is its own one-row request; the label shows it once it is there.
const counts = {
  all: useQuery(() => consoleMastersCountQuery('all')),
  pending: useQuery(() => consoleMastersCountQuery('pending')),
  rejected: useQuery(() => consoleMastersCountQuery('rejected')),
} as const
const tabOptions = computed(() =>
  tabOptionsOf(
    TABS,
    (value) => t(`console.masters.tabs.${value}`),
    (value) => counts[value].data.value,
  ),
)

// FE-264: practices, students and payout stand in for the design's sessions,
// rating and per-session rate columns until the backend has them (BE-246, BE-249).
const columns = computed<ConsoleTableColumn[]>(() =>
  [
    { key: 'master', label: t('console.masters.columns.master') },
    { key: 'methods', label: t('console.masters.columns.methods') },
    { key: 'status', label: t('console.masters.columns.status'), width: 200 },
    {
      key: 'practices',
      label: t('adminScreens.adminMasters.practicesStat'),
      width: 80,
      align: 'end' as const,
      secondary: true,
    },
    {
      key: 'students',
      label: t('adminScreens.adminMasters.studentsStat'),
      width: 90,
      align: 'end' as const,
      secondary: true,
    },
    {
      key: 'payout',
      label: t('adminScreens.adminMasters.toWithdrawStat'),
      width: 110,
      align: 'end' as const,
      secondary: true,
    },
    // The payout balance is the payments option's: without it the column is not there.
  ].filter((column) => column.key !== 'payout' || isOptionEnabled('payments')),
)

const emptyText = computed(() => t(`console.masters.empty.${tab.value}`))

function telegramLine(id: number | null | undefined): string | undefined {
  return id === null || id === undefined ? undefined : t('console.telegramId', { id })
}

function open(master: AdminMasterListItem): void {
  void router.push({ name: 'console-masters-detail', params: { id: master.id } })
}
</script>

<style scoped>
.masters-methods {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow-wrap: anywhere;
}

.masters-status {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  padding: var(--space-2) 0;
}

.masters-muted {
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
}
</style>
