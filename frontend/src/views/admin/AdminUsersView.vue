<!--
  VELO Frontend -- AdminUsersView (all-users list + make-master, ПРОМТ №292)

  The «Пользователи» admin screen: lists ALL users (any role), mirroring the
  AdminMastersView DS (header + count + fog-feed cards). Reached from the admin
  dashboard «Система» section.

  DATA IS REAL: GET /admin/users -> avatar + name + telegram_id + role badge.
  The server has no search endpoint, so the search box filters the fetched
  (accumulated) pages client-side (by name OR telegram id) — a query only
  matches users already loaded; «Показать ещё» loads more. Paginated
  («Показать ещё»), mirroring AdminParticipantsView's load-more.

  Per-row «Сделать мастером» (role='user' only) -> confirm dialog -> POST
  /admin/users/{id}/make-master (creates a verified MasterProfile + role flip).
  The button is gated to role='user' so an admin can't be demoted to master by
  accident.
-->

<template>
  <div class="admin-users">
    <header class="admin-users__top">
      <VBackButton @click="router.back()" />
      <span class="admin-users__title">Пользователи</span>
      <span class="admin-users__count">{{ headerCount }}</span>
    </header>

    <VInput v-model="search" placeholder="Поиск по имени или Telegram ID" />

    <!-- Loading -->
    <div v-if="loading" class="admin-users__loader"><VLoader size="lg" /></div>

    <!-- Fetch error -->
    <VEmptyState
      v-else-if="error"
      icon="warning"
      title="Не удалось загрузить пользователей"
      description="Проверьте соединение и попробуйте ещё раз"
    >
      <template #action><VButton variant="primary" @click="load(true)">Повторить</VButton></template>
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

          <VButton
            v-if="u.role === 'user'"
            variant="secondary"
            block
            @click="askMakeMaster(u)"
          >
            Сделать мастером
          </VButton>
        </div>
      </div>

      <div v-if="hasMore" class="admin-users__more">
        <VButton variant="outline" :loading="loadingMore" @click="loadMore">Показать ещё</VButton>
      </div>
    </template>

    <!-- Empty -->
    <VCard v-else><p class="admin-users__empty">{{ emptyText }}</p></VCard>

    <VConfirmDialog
      :open="confirm.open"
      :message="confirm.message"
      confirm-label="Назначить"
      :loading="confirm.loading"
      @confirm="doMakeMaster"
      @cancel="closeConfirm"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, reactive, onMounted } from 'vue'
import { useRouter } from 'vue-router'
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
import { getUsersList, makeMaster } from '@/api/admin'
import type { UserResponse } from '@/api/admin'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'

const router = useRouter()
const toast = useToast()

const PAGE = 100

const users = ref<UserResponse[]>([])
const total = ref(0)
const loading = ref(false)
const loadingMore = ref(false)
const error = ref(false)
const search = ref('')
const hasMore = computed<boolean>(() => users.value.length < total.value)

function nameOf(u: UserResponse): string {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
  return name || 'Без имени'
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
  search.value.trim() ? 'Никого не найдено' : 'Пользователей пока нет',
)

function roleLabel(role: string): string {
  if (role === 'admin') return 'Админ'
  if (role === 'master') return 'Мастер'
  return 'Пользователь'
}

function roleVariant(role: string): 'success' | 'warning' | 'info' {
  if (role === 'admin') return 'warning'
  if (role === 'master') return 'success'
  return 'info'
}

async function load(reset: boolean): Promise<void> {
  if (reset) {
    loading.value = true
  } else {
    if (loadingMore.value) return
    loadingMore.value = true
  }
  error.value = false
  try {
    const offset = reset ? 0 : users.value.length
    const res = await getUsersList(undefined, PAGE, offset)
    users.value = reset ? res.items : [...users.value, ...res.items]
    total.value = res.total
  } catch (e) {
    error.value = true
    toast.error(extractApiError(e, 'Ошибка загрузки пользователей'))
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

function loadMore(): void {
  load(false)
}

// -- Make-master confirm flow --
const confirm = reactive<{ open: boolean; loading: boolean; message: string; target: UserResponse | null }>({
  open: false,
  loading: false,
  message: '',
  target: null,
})

function askMakeMaster(u: UserResponse): void {
  confirm.target = u
  confirm.message = `Назначить пользователя «${nameOf(u)}» мастером?`
  confirm.open = true
}

function closeConfirm(): void {
  if (confirm.loading) return
  confirm.open = false
  confirm.target = null
}

async function doMakeMaster(): Promise<void> {
  if (!confirm.target || confirm.loading) return
  confirm.loading = true
  try {
    await makeMaster(confirm.target.id)
    toast.success('Пользователь назначен мастером')
    confirm.open = false
    confirm.target = null
    await load(true)
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось назначить мастером'))
  } finally {
    confirm.loading = false
  }
}

onMounted(() => load(true))
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
  font-size: var(--text-sm);
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
  font-size: var(--text-base);
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
  font-size: var(--text-sm);
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
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.ucard__tg {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
}
</style>
