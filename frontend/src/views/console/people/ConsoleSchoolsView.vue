<!--
  VELO Frontend -- ConsoleSchoolsView (FE-262, slice 1)

  The schools module of the web console (instance option `schools`): a
  read-only table of EVERY school, frozen ones included -- the only place
  where an inactive school is visible at all (for its own members it looks
  deleted). is_active is a status badge, not a filter. There is no delete or
  edit here on purpose: the one lever on a school is the revocation of its
  curator's verification, so a row opens the curator's card, where that
  lever is.

  DATA IS REAL: GET /admin/schools one page at a time. Not on the backend
  yet, so not here: companies (a school type), the type and status filters,
  the company card, the session price and the "Add a company" button.
-->

<template>
  <ConsolePage
    :title="t('console.modules.schools')"
    :crumbs="t('console.groups.people')"
    testid="console-schools"
  >
    <ConsoleCard flush>
      <div v-if="loading" class="people-state"><VLoader size="lg" /></div>
      <VEmptyState
        v-else-if="failed"
        icon="warning"
        :title="t('school.loadFailed')"
        :description="t('common.checkConnection')"
      >
        <template #action
          ><VButton variant="primary" @click="query.refetch()">{{
            t('common.retry')
          }}</VButton></template
        >
      </VEmptyState>
      <template v-else>
        <ConsoleTable
          :columns="columns"
          :rows="rows"
          :label="t('console.modules.schools')"
          clickable
          @row-click="(row) => open(row.school)"
        >
          <template #cell-name="{ row }">{{ row.school.name }}</template>
          <template #cell-curator="{ row }">
            <PersonCell :name="row.school.curator.display_name || DASH" />
          </template>
          <template #cell-masters="{ row }">{{ row.school.masters_count }}</template>
          <template #cell-students="{ row }">{{ row.school.students_count }}</template>
          <template #cell-created="{ row }">{{ formatDay(row.school.created_at) }}</template>
          <template #cell-status="{ row }">
            <PeoplePill :tone="row.school.is_active ? 'success' : 'neutral'">
              {{
                row.school.is_active
                  ? t('adminScreens.adminSchools.active')
                  : t('adminScreens.adminSchools.frozen')
              }}
            </PeoplePill>
          </template>
          <template #empty>{{ t('adminScreens.adminSchools.emptyNote') }}</template>
        </ConsoleTable>
        <PeoplePager
          :page="page"
          :page-size="CONSOLE_PAGE_SIZE"
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
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useQuery } from '@pinia/colada'
import { VButton, VEmptyState, VLoader } from '@/components/ui'
import ConsoleCard from '@/components/console/ConsoleCard.vue'
import ConsolePage from '@/components/console/ConsolePage.vue'
import ConsoleTable, { type ConsoleTableColumn } from '@/components/console/ConsoleTable.vue'
import PeoplePager from '@/components/console/people/PeoplePager.vue'
import PeoplePill from '@/components/console/people/PeoplePill.vue'
import PersonCell from '@/components/console/people/PersonCell.vue'
import { formatDay } from '@/components/console/people/peopleTable'
import type { AdminSchoolListItem } from '@/api/types'
import {
  CONSOLE_PAGE_SIZE,
  consoleSchoolsPageQuery,
  onFailedRequest,
} from '@/composables/queries/admin'
import { screenQueryState } from '@/composables/queries/screenState'
import { useRouteListState } from '@/composables/console/useRouteListState'
import { useToast } from '@/composables/useToast'

const DASH = '—'

const router = useRouter()
const toast = useToast()

// No tabs: the one tab keeps the page in the URL like the other tables.
const { page, setPage } = useRouteListState(['all'])

const query = useQuery(() => consoleSchoolsPageQuery(page.value))
const { loading, failed } = screenQueryState(query)
onFailedRequest(query, () => toast.error(t('school.loadFailed')))

// One row per school: ConsoleTable wants a plain record, the cells read the school.
const rows = computed(() => (query.data.value?.items ?? []).map((s) => ({ id: s.id, school: s })))
const total = computed(() => query.data.value?.total ?? 0)

const columns = computed<ConsoleTableColumn[]>(() => [
  { key: 'name', label: t('console.schools.columns.name') },
  { key: 'curator', label: t('console.schools.columns.curator') },
  {
    key: 'masters',
    label: t('console.schools.columns.masters'),
    width: 100,
    align: 'end',
    secondary: true,
  },
  {
    key: 'students',
    label: t('console.schools.columns.students'),
    width: 110,
    align: 'end',
    secondary: true,
  },
  { key: 'created', label: t('console.schools.columns.created'), width: 150, secondary: true },
  { key: 'status', label: t('console.schools.columns.status'), width: 150 },
])

function open(school: AdminSchoolListItem): void {
  void router.push({ name: 'console-masters-detail', params: { id: school.curator.user_id } })
}
</script>

<style scoped>
.people-state {
  display: flex;
  justify-content: center;
  padding: var(--space-10) 0;
}
</style>
