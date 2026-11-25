<!--
  VELO Frontend -- TodayCard (FE-268)

  The dashboard's "today" block: the practices still to come today, nearest
  first. The list is the nearest page of the upcoming scope of
  `GET /admin/practices` (the entry the practices module reads, so a visit
  there paints at once). The API's upcoming scope starts at "now": a practice
  that has begun is in the past scope and is not here. A row opens the
  practice.
-->

<template>
  <ConsoleCard :title="t('console.dashboard.today.title')" :note="note" data-testid="today-card">
    <template #header-right>
      <RouterLink class="today__all" :to="{ name: consoleRouteName('practices') }">
        {{ t('console.dashboard.today.all') }}
        <IconArrowRight :size="16" aria-hidden="true" />
      </RouterLink>
    </template>

    <ConsoleLoading v-if="loading" data-testid="today-loading" />
    <OverviewEmpty
      v-else-if="failed"
      icon="warning"
      :title="t('console.dashboard.today.loadFailed')"
      :description="errorText"
    >
      <VButton size="sm" variant="outline" @click="retry">{{ t('common.retry') }}</VButton>
    </OverviewEmpty>
    <ConsoleTable
      v-else
      clickable
      :columns="columns"
      :rows="rows"
      :label="t('console.dashboard.today.tableLabel')"
      @row-click="openPractice"
    >
      <template #cell-time="{ row }">{{ formatTime(row.scheduled_at, row.timezone) }}</template>
      <template #cell-title="{ row }">
        <span class="today__stack">
          <span class="today__title">{{ row.title }}</span>
          <span class="today__sub">{{ row.master_name }}</span>
        </span>
      </template>
      <template #cell-booked="{ row }">
        <CapacityBar :booked="row.booked" :capacity="row.capacity" />
      </template>
      <template #empty>{{ t('console.dashboard.today.empty') }}</template>
    </ConsoleTable>
  </ConsoleCard>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useQuery } from '@pinia/colada'
import { VButton } from '@/components/ui'
import { IconArrowRight } from '@/components/icons'
import ConsoleCard from '@/components/console/ConsoleCard.vue'
import ConsoleTable, { type ConsoleTableColumn } from '@/components/console/ConsoleTable.vue'
import CapacityBar from '@/components/console/content/CapacityBar.vue'
import ConsoleLoading from '@/components/console/content/ConsoleLoading.vue'
import OverviewEmpty from '@/components/console/overview/OverviewEmpty.vue'
import { adminPracticesPageQuery, onFailedRequest } from '@/composables/queries/admin'
import { screenQueryState } from '@/composables/queries/screenState'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { consoleRouteName } from '@/utils/console/modules'
import { formatTime, relativeDayCode } from '@/utils/format'

const router = useRouter()
const toast = useToast()

// Page 1 of the upcoming scope is the nearest practices (queries/admin.ts).
const listQuery = useQuery(() => adminPracticesPageQuery({ scope: 'upcoming', page: 1 }))
const { loading, failed } = screenQueryState(listQuery)
const errorText = computed(() => extractApiError(listQuery.error.value, t('common.loadError')))

// A failed refetch over the list shown (a return to the app) is told once.
onFailedRequest(listQuery, (error) => {
  if (listQuery.data.value !== undefined)
    toast.error(extractApiError(error, t('console.dashboard.today.loadFailed')))
})

function retry(): void {
  void listQuery.refetch()
}

// A practice is today in its own time zone, as the practices table dates it.
const rows = computed(() =>
  (listQuery.data.value?.items ?? [])
    .filter((p) => relativeDayCode(p.scheduled_at, p.timezone) === 'today')
    .map((p) => ({ ...p })),
)

// The count after the title; an empty day says so in the table instead.
const note = computed(() =>
  rows.value.length === 0 ? undefined : t('console.dashboard.today.remaining', rows.value.length),
)

const columns = computed<ConsoleTableColumn[]>(() => [
  { key: 'time', label: t('console.dashboard.today.columns.time'), width: 72 },
  { key: 'title', label: t('console.dashboard.today.columns.practice') },
  { key: 'booked', label: t('console.dashboard.today.columns.booked'), width: 110 },
])

function openPractice(row: { id: string }): void {
  void router.push({ name: 'console-practices-detail', params: { id: row.id } })
}
</script>

<style scoped>
.today__all {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--velo-fs-14);
  color: var(--velo-text-primary);
  text-decoration: none;
}

.today__all:hover {
  text-decoration: underline;
}

.today__stack {
  display: flex;
  flex-direction: column;
  gap: var(--space-hairline);
  min-width: 0;
}

.today__title {
  overflow-wrap: anywhere;
}

.today__sub {
  font-size: var(--velo-fs-12);
  color: var(--velo-text-secondary);
}
</style>
