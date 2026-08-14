<!--
  VELO Frontend -- AdminSupportView (B34, PROMPT №713)

  The support queue: every section thread, opener + topic + triage state.
  STRAIGHT REUSE of AdminReportsView's shape (header + count, VCard row list,
  loading/error/empty ladder, "Показать ещё") -- no new layout, so no .tmp/
  preview: this is the "say so and proceed" branch of that instruction, not
  the "build one first" branch. Tapping a card opens the thread detail with
  a state hand-off (mirrors AdminReportDetailView's `history.state`), same
  reason: skip a redundant fetch for the common case.

  TRIAGE STATE, ONE BADGE PER ROW, deliberately no "unread" count: comms'
  unread-count is per-PARTICIPANT (backend/app/modules/support/service.py's
  own recon, PROMPT №713 report) -- meaningless for an admin who has never
  claimed a thread, and misleading if computed anyway (N+1 calls for a
  number nobody has earned yet). What actually drives triage here: resolved/
  closed (done), unclaimed (needs someone), claimed by me, claimed by
  someone else -- covers the full state space with one badge, no N+1.

  THE TOPIC rides comms' own `title` (service.py::open_support_thread sets
  it at creation) -- the only one of the two №712 channels (message prefix,
  notification text) that reaches a LIST without an N+1 feed fetch.

  WHO: `opener` is resolved server-side (service.py::list_admin_support_
  threads, P-1) -- a raw client uuid tells an admin nothing.
-->

<template>
  <div class="admin-support">
    <header class="admin-support__top">
      <VBackButton @click="router.back()" />
      <h1 class="admin-support__title">Поддержка</h1>
      <span v-if="items.length" class="admin-support__count">{{ items.length }}</span>
    </header>

    <div v-if="loading && items.length === 0" class="admin-support__loader">
      <VLoader size="lg" />
    </div>

    <VEmptyState
      v-else-if="error"
      icon="warning"
      title="Не удалось загрузить"
      description="Проверьте соединение и попробуйте ещё раз"
    >
      <template #action
        ><VButton variant="primary" @click="loadInitial">Повторить</VButton></template
      >
    </VEmptyState>

    <VEmptyState
      v-else-if="items.length === 0"
      icon="empty"
      title="Обращений нет"
      description="Сюда попадут все обращения в поддержку"
    />

    <template v-else>
      <div class="admin-support__list">
        <VCard
          v-for="item in items"
          :key="item.id"
          class="scard"
          clickable
          padding="none"
          @click="openDetail(item)"
        >
          <span class="scard__icon"><IconSupportChat :size="30" /></span>
          <div class="scard__text">
            <div class="scard__title">{{ openerName(item) }}</div>
            <div v-if="item.title" class="scard__topic">{{ item.title }}</div>
            <div class="scard__sub">
              {{ formatRelative(item.last_message_at ?? item.created_at) }}
            </div>
          </div>
          <VBadge :variant="triageBadge(item).variant" class="scard__badge">
            {{ triageBadge(item).label }}
          </VBadge>
        </VCard>
      </div>

      <div v-if="nextCursor" class="admin-support__more">
        <VButton variant="outline" block :loading="loadingMore" @click="loadMore">
          Показать ещё
        </VButton>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { VBackButton, VButton, VLoader, VEmptyState, VCard, VBadge } from '@/components/ui'
import { IconSupportChat } from '@/components/icons'
import { useToast } from '@/composables/useToast'
import { useAuthStore } from '@/stores/auth'
import { listAdminSupportThreads } from '@/api/support'
import type { SupportThread } from '@/api/support'
import { extractApiError } from '@/composables/useApiError'
import { formatRelative } from '@/utils/adminHelpers'

const LIMIT = 20

const router = useRouter()
const toast = useToast()
const authStore = useAuthStore()

const items = ref<SupportThread[]>([])
const nextCursor = ref<string | null>(null)
const loading = ref(false)
const loadingMore = ref(false)
const error = ref(false)

function openerName(item: SupportThread): string {
  return item.opener?.name ?? 'Пользователь'
}

function triageBadge(item: SupportThread): {
  variant: 'warning' | 'success' | 'info'
  label: string
} {
  if (item.status === 'resolved') return { variant: 'success', label: 'Решено' }
  if (item.status === 'closed') return { variant: 'info', label: 'Закрыто' }
  if (!item.assignee) return { variant: 'warning', label: 'Не взято' }
  if (item.assignee === authStore.user?.id) return { variant: 'success', label: 'У меня' }
  return { variant: 'info', label: 'Занято' }
}

async function loadInitial(): Promise<void> {
  loading.value = true
  error.value = false
  items.value = []
  nextCursor.value = null
  try {
    const res = await listAdminSupportThreads(LIMIT)
    items.value = res.threads
    nextCursor.value = res.next_cursor
  } catch (e) {
    error.value = true
    toast.error(extractApiError(e, 'Ошибка загрузки обращений'))
  } finally {
    loading.value = false
  }
}

async function loadMore(): Promise<void> {
  if (!nextCursor.value) return
  loadingMore.value = true
  try {
    const res = await listAdminSupportThreads(LIMIT, nextCursor.value)
    items.value.push(...res.threads)
    nextCursor.value = res.next_cursor
  } catch (e) {
    toast.error(extractApiError(e, 'Ошибка загрузки'))
  } finally {
    loadingMore.value = false
  }
}

function openDetail(item: SupportThread): void {
  router.push({
    name: 'admin-support-detail',
    params: { id: item.id },
    state: { thread: JSON.parse(JSON.stringify(item)) },
  })
}

onMounted(loadInitial)
</script>

<style scoped>
.admin-support {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.admin-support__top {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: var(--velo-size-44);
}

.admin-support__title {
  flex: 1;
  font-family: var(--font-body);
  font-weight: 400;
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

.admin-support__count {
  min-width: var(--velo-size-38);
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

.admin-support__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-8) 0;
}

.admin-support__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.scard {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-4);
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.scard:active {
  opacity: 0.85;
}

.scard__icon {
  display: inline-flex;
  flex-shrink: 0;
  color: var(--velo-primary);
}

.scard__text {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.scard__title {
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.scard__topic {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.scard__sub {
  font-size: var(--text-xs);
  color: var(--velo-text-muted);
  letter-spacing: 0.02em;
}

.scard__badge {
  flex-shrink: 0;
}

.admin-support__more {
  padding-top: var(--space-1);
}
</style>
