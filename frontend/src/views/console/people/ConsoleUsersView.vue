<!--
  VELO Frontend -- ConsoleUsersView (FE-262, slice 1)

  The users module of the web console: a table of every user in four tabs
  (all, members, masters, admins) with the total of each on its label, and an
  activity filter (every user, the active, the inactive: the server's
  `is_active`). A member row carries the "Make a master" button: confirm, then
  POST /admin/users/{id}/make-master (a verified master profile and the role
  flip). The button is only on role=user rows, so an admin cannot be demoted
  to master by accident. The tab, the filter and the page live in the URL.

  DATA IS REAL: GET /admin/users?role=&is_active= one page at a time; the
  totals are one-row requests of the same endpoint. Not on the backend yet,
  so not here: search, the registration-date filter, export, and the practice
  count column.
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
      <div class="users-filter">
        <VSelect
          flush
          outlined
          :model-value="activity"
          :options="activityOptions"
          :aria-label="t('console.users.filter.label')"
          @update:model-value="(value) => setActivity(value as ConsoleUsersActivity)"
        />
      </div>
    </template>

    <PeopleListCard
      :loading="loading"
      :failed="failed"
      :error-title="t('adminScreens.adminUsers.usersLoadFailed')"
      @retry="query.refetch()"
    >
      <ConsoleTable :columns="columns" :rows="rows" :label="t('console.modules.users')">
        <template #cell-user="{ row }">
          <PersonCell
            :name="nameOf(row.user)"
            :url="row.user.avatar_url"
            :sub="telegramLine(row.user.telegram_id)"
          />
        </template>
        <template #cell-role="{ row }">
          <ConsoleBadge :tone="roleTone(row.user.role)">{{
            roleLabel(row.user.role)
          }}</ConsoleBadge>
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
      <ConsolePager
        :page="page"
        :page-size="CONSOLE_PAGE_SIZE"
        :total="total"
        :shown="rows.length"
        @update:page="setPage"
      />
    </PeopleListCard>

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
import { useRoute } from 'vue-router'
import { useQuery } from '@pinia/colada'
import { VButton, VConfirmDialog, VSegment, VSelect } from '@/components/ui'
import ConsolePage from '@/components/console/ConsolePage.vue'
import ConsoleTable, { type ConsoleTableColumn } from '@/components/console/ConsoleTable.vue'
import PeopleListCard from '@/components/console/people/PeopleListCard.vue'
import ConsolePager from '@/components/console/ConsolePager.vue'
import ConsoleBadge from '@/components/console/ConsoleBadge.vue'
import PersonCell from '@/components/console/people/PersonCell.vue'
import {
  DASH,
  formatDay,
  roleTone,
  tabOptions as tabOptionsOf,
} from '@/components/console/people/peopleTable'
import { makeMaster } from '@/api/admin'
import type { UserResponse } from '@/api/admin'
import {
  CONSOLE_PAGE_SIZE,
  consoleUsersCountQuery,
  consoleUsersPageQuery,
  onFailedRequest,
  useAdminMutation,
  type ConsoleUsersActivity,
  type ConsoleUsersTab,
} from '@/composables/queries/admin'
import { screenQueryState } from '@/composables/queries/screenState'
import { lastPageOf, useRouteListState } from '@/composables/console/useRouteListState'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { formatRelative } from '@/utils/adminHelpers'

const route = useRoute()
const toast = useToast()

const TABS = ['all', 'user', 'master', 'admin'] as const satisfies readonly ConsoleUsersTab[]
const ACTIVITIES = ['all', 'active', 'inactive'] as const satisfies readonly ConsoleUsersActivity[]
/** The activity filter's mark in the URL (`?active=1`); none -- every user. */
const ACTIVITY_MARK = { all: undefined, active: '1', inactive: '0' } as const

const { tab, page, setTab, setPage, setQuery, clampTo } = useRouteListState<ConsoleUsersTab>(TABS)

const activity = computed<ConsoleUsersActivity>(() =>
  route.query.active === '1' ? 'active' : route.query.active === '0' ? 'inactive' : 'all',
)
const activityOptions = computed(() =>
  ACTIVITIES.map((value) => ({ value, label: t(`console.users.filter.${value}`) })),
)

function setActivity(value: ConsoleUsersActivity): void {
  setQuery({ active: ACTIVITY_MARK[value] })
}

const query = useQuery(() =>
  consoleUsersPageQuery({ tab: tab.value, activity: activity.value, page: page.value }),
)
const { loading, failed } = screenQueryState(query)
clampTo(() => lastPageOf(query.data.value?.total, CONSOLE_PAGE_SIZE))
onFailedRequest(query, (e) =>
  toast.error(extractApiError(e, t('adminScreens.adminUsers.usersLoadError'))),
)

// One row per user: ConsoleTable wants a plain record, the cells read the user.
const rows = computed(() => (query.data.value?.items ?? []).map((u) => ({ id: u.id, user: u })))
const total = computed(() => query.data.value?.total ?? 0)

// A tab's total is its own one-row request (under the same filter); the label
// shows it once it is there.
const counts = {
  all: useQuery(() => consoleUsersCountQuery({ tab: 'all', activity: activity.value })),
  user: useQuery(() => consoleUsersCountQuery({ tab: 'user', activity: activity.value })),
  master: useQuery(() => consoleUsersCountQuery({ tab: 'master', activity: activity.value })),
  admin: useQuery(() => consoleUsersCountQuery({ tab: 'admin', activity: activity.value })),
} as const
const tabOptions = computed(() =>
  tabOptionsOf(
    TABS,
    (value) => t(`console.users.tabs.${value}`),
    (value) => counts[value].data.value,
  ),
)

const columns = computed<ConsoleTableColumn[]>(() => [
  { key: 'user', label: t('console.users.columns.user') },
  { key: 'role', label: t('console.users.columns.role'), width: 160 },
  { key: 'registered', label: t('console.users.columns.registered'), width: 150, secondary: true },
  { key: 'lastSeen', label: t('console.users.columns.lastSeen'), width: 170, secondary: true },
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
// totals (the role leaves one tab and joins another); the spinner of the
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
.users-filter {
  width: 200px;
}
</style>
