<!--
  VELO Frontend -- TodayCard (FE-268)

  The dashboard's "today" block: the practices still to come today, nearest
  first, every page of them up to a cap -- past it the count reads "N+"
  (adminTodayPracticesQuery, FE-260). The API's upcoming scope starts at
  "now": a practice that has begun is in the past scope and is not here. A
  row opens the practice.
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
import ConsoleLoading from '@/components/console/ConsoleLoading.vue'
import OverviewEmpty from '@/components/console/overview/OverviewEmpty.vue'
import { adminTodayPracticesQuery, onFailedRequest } from '@/composables/queries/admin'
import { screenQueryState } from '@/composables/queries/screenState'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { consoleRouteName } from '@/utils/console/modules'
import { formatTime } from '@/utils/format'

const router = useRouter()
const toast = useToast()

const listQuery = useQuery(adminTodayPracticesQuery)
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

const rows = computed(() => (listQuery.data.value?.items ?? []).map((p) => ({ ...p })))

// The count after the title ("N+" when the read stopped at its cap); an
// empty day says so in the table instead.
const note = computed(() => {
  const count = rows.value.length
  if (count === 0) return undefined
  return listQuery.data.value?.more
    ? t('console.dashboard.today.remainingMore', { n: count })
    : t('console.dashboard.today.remaining', count)
})

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
