<!--
  VELO Frontend -- ConsoleUsersView (FE-262, slice 1)

  The users module of the web console: a table of every user in four tabs
  (all, members, masters, admins) with the count of each on its label. A
  member row carries the "Make a master" button: confirm, then
  POST /admin/users/{id}/make-master (a verified master profile and the role
  flip). The button is only on role=user rows, so an admin cannot be demoted
  to master by accident. The tab and the page live in the URL.

  DATA IS REAL: GET /admin/users?role= one page at a time; the counts are
  one-row requests of the same endpoint. Not on the backend yet, so not
  here: search, the activity and registration-date filters, export, and the
  practice count column.
-->

<template>
  <ConsolePage
    :title="t('console.modules.users')"
    :crumbs="t('console.groups.people')"
    testid="console-users"
  >
    <template #tabs>
      <VSegment
        :model-value="tab"
        :options="tabOptions"
        compact
        @update:model-value="(value) => setTab(value as ConsoleUsersTab)"
      />
    </template>

    <ConsoleCard flush>
      <div v-if="loading" class="people-state"><VLoader size="lg" /></div>
      <VEmptyState
        v-else-if="failed"
        icon="warning"
        :title="t('adminScreens.adminUsers.usersLoadFailed')"
        :description="t('common.checkConnection')"
      >
        <template #action
          ><VButton variant="primary" @click="query.refetch()">{{
            t('common.retry')
          }}</VButton></template
        >
      </VEmptyState>
      <template v-else>
        <ConsoleTable :columns="columns" :rows="rows" :label="t('console.modules.users')">
          <template #cell-user="{ row }">
            <PersonCell
              :name="nameOf(row.user)"
              :url="row.user.avatar_url"
              :sub="telegramLine(row.user.telegram_id)"
            />
          </template>
          <template #cell-role="{ row }">
            <VBadge :variant="roleVariant(row.user.role)">{{ roleLabel(row.user.role) }}</VBadge>
          </template>
          <template #cell-registered="{ row }">{{ formatDay(row.user.created_at) }}</template>
          <template #cell-lastSeen="{ row }">
            {{ row.user.last_login_at ? formatRelative(row.user.last_login_at) : DASH }}
          </template>
          <template #cell-action="{ row }">
            <VButton
              v-if="row.user.role === 'user'"
              variant="secondary"
              size="sm"
              @click="askMakeMaster(row.user)"
            >
              {{ t('adminScreens.adminUsers.makeMaster') }}
            </VButton>
          </template>
          <template #empty>{{ t('adminScreens.adminUsers.empty.title') }}</template>
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

    <VConfirmDialog
      :open="target !== null"
      :message="t('adminScreens.adminUsers.promoteConfirm', { name: target ? nameOf(target) : '' })"
      :confirm-label="t('adminScreens.adminUsers.appoint')"
      :loading="promoting"
      @confirm="doMakeMaster"
      @cancel="closeConfirm"
    />
  </ConsolePage>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed, ref } from 'vue'
import { useQuery } from '@pinia/colada'
import { VBadge, VButton, VConfirmDialog, VEmptyState, VLoader, VSegment } from '@/components/ui'
import type { SegmentOption } from '@/components/ui'
import ConsoleCard from '@/components/console/ConsoleCard.vue'
import ConsolePage from '@/components/console/ConsolePage.vue'
import ConsoleTable, { type ConsoleTableColumn } from '@/components/console/ConsoleTable.vue'
import PeoplePager from '@/components/console/people/PeoplePager.vue'
import PersonCell from '@/components/console/people/PersonCell.vue'
import { formatDay } from '@/components/console/people/peopleTable'
import { makeMaster } from '@/api/admin'
import type { UserResponse } from '@/api/admin'
import {
  CONSOLE_PAGE_SIZE,
  consoleUsersCountQuery,
  consoleUsersPageQuery,
  onFailedRequest,
  useAdminMutation,
  type ConsoleUsersTab,
} from '@/composables/queries/admin'
import { screenQueryState } from '@/composables/queries/screenState'
import { useRouteListState } from '@/composables/console/useRouteListState'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { formatRelative } from '@/utils/adminHelpers'

const DASH = '—'

const toast = useToast()

const TABS = ['all', 'user', 'master', 'admin'] as const satisfies readonly ConsoleUsersTab[]
const { tab, page, setTab, setPage } = useRouteListState<ConsoleUsersTab>(TABS)

const query = useQuery(() => consoleUsersPageQuery({ tab: tab.value, page: page.value }))
const { loading, failed } = screenQueryState(query)
onFailedRequest(query, (e) =>
  toast.error(extractApiError(e, t('adminScreens.adminUsers.usersLoadError'))),
)

// One row per user: ConsoleTable wants a plain record, the cells read the user.
const rows = computed(() => (query.data.value?.items ?? []).map((u) => ({ id: u.id, user: u })))
const total = computed(() => query.data.value?.total ?? 0)

// A tab's count is its own one-row request; the label shows it once it is there.
const counts = {
  all: useQuery(() => consoleUsersCountQuery('all')),
  user: useQuery(() => consoleUsersCountQuery('user')),
  master: useQuery(() => consoleUsersCountQuery('master')),
  admin: useQuery(() => consoleUsersCountQuery('admin')),
} as const
const tabOptions = computed<SegmentOption[]>(() =>
  TABS.map((value) => {
    const name = t(`console.users.tabs.${value}`)
    const n = counts[value].data.value
    return { value, label: n === undefined ? name : `${name} · ${n}` }
  }),
)

const columns = computed<ConsoleTableColumn[]>(() => [
  { key: 'user', label: t('console.users.columns.user') },
  { key: 'role', label: t('console.users.columns.role'), width: 160 },
  { key: 'registered', label: t('console.users.columns.registered'), width: 150 },
  { key: 'lastSeen', label: t('console.users.columns.lastSeen'), width: 170 },
  { key: 'action', label: '', width: 180, align: 'end' },
])

function nameOf(u: UserResponse): string {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
  return name || t('adminScreens.adminUsers.noName')
}

function telegramLine(id: number | null): string | undefined {
  return id === null ? undefined : t('console.telegramId', { id })
}

function roleLabel(role: string): string {
  if (role === 'admin') return t('adminScreens.adminUsers.roleAdmin')
  if (role === 'master') return t('adminScreens.adminUsers.roleMaster')
  return t('adminScreens.adminUsers.roleUser')
}

function roleVariant(role: string): 'success' | 'warning' | 'info' {
  if (role === 'admin') return 'warning'
  if (role === 'master') return 'success'
  return 'info'
}

// -- Make-master confirm flow --
const target = ref<UserResponse | null>(null)
const promoting = ref(false)

function askMakeMaster(user: UserResponse): void {
  target.value = user
}

function closeConfirm(): void {
  if (promoting.value) return
  target.value = null
}

// The invalidation of the mutation row refetches the page on screen and the
// counts (the role leaves one tab and joins another); the spinner of the
// confirm covers it.
const promote = useAdminMutation('makeMaster', (userId: string) => makeMaster(userId))

async function doMakeMaster(): Promise<void> {
  if (!target.value || promoting.value) return
  promoting.value = true
  try {
    await promote.mutateAsync(target.value.id)
    toast.success(t('adminScreens.adminUsers.toast.promotedToMaster'))
    target.value = null
  } catch (e) {
    toast.error(extractApiError(e, t('adminScreens.adminUsers.toast.promoteFailed')))
  } finally {
    promoting.value = false
  }
}
</script>

<style scoped>
.people-state {
  display: flex;
  justify-content: center;
  padding: var(--space-10) 0;
}
</style>
