<!--
  VELO Frontend -- AdminUsersView (all-users list + make-master, PROMPT №292)

  The all-users admin screen (i18n:adminScreens.adminUsers.title): lists ALL
  users (any role), mirroring the
  AdminMastersView DS (header + count + fog-feed cards). Reached from the admin
  dashboard system section (i18n:adminScreens.adminDashboard.system).

  DATA IS REAL: GET /admin/users -> avatar + name + telegram_id + role badge.
  The server has no search endpoint, so the search box filters the fetched
  (accumulated) pages client-side (by name OR telegram id) — a query only
  matches users already loaded; the show-more button (i18n:common.showMore)
  loads more. Paginated
  (show-more), mirroring AdminParticipantsView's load-more.

  Per-row make-master action (i18n:adminScreens.adminUsers.makeMaster,
  role='user' only) -> confirm dialog -> POST
  /admin/users/{id}/make-master (creates a verified MasterProfile + role flip).
  The button is gated to role='user' so an admin can't be demoted to master by
  accident.

  The list is a Pinia Colada infinite query and make-master runs through
  useAdminMutation (composables/queries/admin.ts, FE-181): the list
  refetches in place after a promotion.
-->

<template>
  <div class="admin-users">
    <header class="admin-users__top">
      <VBackButton @click="router.back()" />
      <h1 class="admin-users__title">{{ t('adminScreens.adminUsers.title') }}</h1>
      <span class="admin-users__count">{{ headerCount }}</span>
    </header>

    <VInput v-model="search" :placeholder="t('adminScreens.adminUsers.searchPlaceholder')" />

    <!-- Loading -->
    <div v-if="loading" class="admin-users__loader"><VLoader size="lg" /></div>

    <!-- Fetch error -->
    <VEmptyState
      v-else-if="error"
      icon="warning"
      :title="t('adminScreens.adminUsers.usersLoadFailed')"
      :description="t('common.checkConnection')"
    >
      <template #action
        ><VButton variant="primary" @click="retry">{{ t('common.retry') }}</VButton></template
      >
    </VEmptyState>

    <!-- List -->
    <template v-else-if="filtered.length">
      <div class="admin-users__items">
        <div v-for="u in filtered" :key="u.id" class="ucard">
          <div class="ucard__head">
            <VAvatar :name="nameOf(u)" :url="u.avatar_url ?? undefined" size="md" />
            <div class="ucard__id">
              <span class="ucard__name">{{ nameOf(u) }}</span>
              <span class="ucard__tg">ID: {{ u.telegram_id ?? '—' }}</span>
            </div>
            <VBadge :variant="roleVariant(u.role)">{{ roleLabel(u.role) }}</VBadge>
          </div>

          <VButton v-if="u.role === 'user'" variant="secondary" block @click="askMakeMaster(u)">
            {{ t('adminScreens.adminUsers.makeMaster') }}
          </VButton>
        </div>
      </div>

      <div v-if="hasMore" class="admin-users__more">
        <VButton variant="outline" :loading="loadingMore" @click="loadMore">{{
          t('common.showMore')
        }}</VButton>
      </div>
    </template>

    <!-- Empty -->
    <VCard v-else
      ><p class="admin-users__empty">{{ emptyText }}</p></VCard
    >

    <VConfirmDialog
      :open="confirm.open"
      :message="confirm.message"
      :confirm-label="t('adminScreens.adminUsers.appoint')"
      :loading="confirm.loading"
      @confirm="doMakeMaster"
      @cancel="closeConfirm"
    />
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { ref, computed, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { useInfiniteQuery, useQueryCache } from '@pinia/colada'
import {
  VBackButton,
  VInput,
  VAvatar,
  VBadge,
  VCard,
  VLoader,
  VEmptyState,
  VButton,
  VConfirmDialog,
} from '@/components/ui'
import { makeMaster } from '@/api/admin'
import type { UserResponse } from '@/api/admin'
import {
  adminUsersQuery,
  markUserMaster,
  useAdminMutation,
  usePagedListFailures,
} from '@/composables/queries/admin'
import { screenQueryState } from '@/composables/queries/screenState'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'

const router = useRouter()
const toast = useToast()

// Every user, page by page (Pinia Colada, composables/queries/admin.ts).
const usersQuery = useInfiniteQuery(adminUsersQuery)
const users = computed<UserResponse[]>(
  () => usersQuery.data.value?.pages.flatMap((page) => page.items) ?? [],
)
const total = computed(() => usersQuery.data.value?.pages.at(-1)?.total ?? 0)
// A failed first page is the error state; a failed next page keeps the
// pages shown (the toast tells it).
const { loading, failed: error } = screenQueryState(usersQuery)
const search = ref('')
const hasMore = usersQuery.hasNextPage

function nameOf(u: UserResponse): string {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
  return name || t('adminScreens.adminUsers.noName')
}

const headerCount = computed<string>(() => (total.value ? String(total.value) : '—'))

// Client-side search: server has no search param, so filter the fetched page
// by name OR telegram id.
const filtered = computed<UserResponse[]>(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return users.value
  return users.value.filter((u) => {
    const name = nameOf(u).toLowerCase()
    const tg = String(u.telegram_id ?? '')
    return name.includes(q) || tg.includes(q)
  })
})

const emptyText = computed<string>(() =>
  search.value.trim() ? t('common.searchNoHits') : t('adminScreens.adminUsers.empty.title'),
)

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

// Every failed request is told (a first page, a next page, a refetch).
const { loadingMore, loadMore } = usePagedListFailures(usersQuery, (e) =>
  toast.error(extractApiError(e, t('adminScreens.adminUsers.usersLoadError'))),
)

function retry(): void {
  void usersQuery.refetch()
}

// -- Make-master confirm flow --
const confirm = reactive<{
  open: boolean
  loading: boolean
  message: string
  target: UserResponse | null
}>({
  open: false,
  loading: false,
  message: '',
  target: null,
})

function askMakeMaster(u: UserResponse): void {
  confirm.target = u
  confirm.message = t('adminScreens.adminUsers.promoteConfirm', { name: nameOf(u) })
  confirm.open = true
}

function closeConfirm(): void {
  if (confirm.loading) return
  confirm.open = false
  confirm.target = null
}

// The row shows the new role at once; then the users and masters lists,
// the detail, the badge and the schools go stale (ADMIN_INVALIDATES.makeMaster)
// and the list on screen refetches in place.
const queryCache = useQueryCache()
const promote = useAdminMutation('makeMaster', (userId: string) => makeMaster(userId), {
  write: (_res, userId) => markUserMaster(queryCache, userId),
  waitForRefetch: false,
})

async function doMakeMaster(): Promise<void> {
  if (!confirm.target || confirm.loading) return
  confirm.loading = true
  try {
    await promote.mutateAsync(confirm.target.id)
    toast.success(t('adminScreens.adminUsers.toast.promotedToMaster'))
    confirm.open = false
    confirm.target = null
  } catch (e) {
    toast.error(extractApiError(e, t('adminScreens.adminUsers.toast.promoteFailed')))
  } finally {
    confirm.loading = false
  }
}
</script>

<style scoped>
.admin-users {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* -- Header: back + title + count badge (mirrors AdminMastersView) -- */
.admin-users__top {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: var(--velo-size-44);
}

.admin-users__title {
  flex: 1;
  font-family: var(--font-body);
  font-weight: 400;
  font-size: var(--velo-fs-16);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

.admin-users__count {
  min-width: var(--velo-size-48);
  height: var(--velo-size-36);
  padding: 0 var(--velo-inset-12);
  flex-shrink: 0;
  border-radius: var(--radius-md);
  background: var(--velo-primary);
  color: var(--velo-white);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-body);
  font-size: var(--velo-fs-18);
  letter-spacing: 0.02em;
}

.admin-users__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-8) 0;
}

.admin-users__items {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.admin-users__more {
  display: flex;
  justify-content: center;
  padding-top: var(--space-1);
}

.admin-users__empty {
  margin: 0;
  text-align: center;
  color: var(--velo-text-muted);
  font-size: var(--velo-fs-16);
  padding: var(--space-4) var(--space-2);
}

/* -- User card -- */
.ucard {
  background: var(--velo-bg-card-solid);
  border: var(--velo-border-width) solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  font-family: var(--font-body);
}

.ucard__head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.ucard__id {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  align-items: flex-start;
}

.ucard__name {
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.ucard__tg {
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
}
</style>
