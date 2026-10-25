<!--
  VELO Frontend -- AdminSupportView (B34, PROMPT №713; tickets since FE-100)

  The support queue: every ticket (BE-162 -- each appeal through a form is
  its own), newest appeal first, from velo's own table (GET
  /api/v1/support/tickets). Without a status filter the backend returns
  every ticket but spam (owner ruling: spam leaves the common list); no
  filter is sent from here -- filters and the spam tab are delivery B.

  STRAIGHT REUSE of AdminReportsView's shape (header + count, VCard row list,
  loading/error/empty ladder, "Показать ещё"). Tapping a card opens the
  ticket card with a state hand-off (mirrors AdminReportDetailView's
  `history.state`): the row IS what the card needs.

  ONE ROW: who wrote (`opener`, resolved server-side -- a raw uuid tells an
  admin nothing), the topic (a CODE, labelled by the one front table,
  utils/supportTopics.ts), the date of the appeal, who took it (`claimed_by`)
  and one badge -- the ticket's status. A row carries no last message: the
  list does not pay a feed call per ticket (known gap, BE-162).
-->

<template>
  <div class="admin-support">
    <header class="admin-support__top">
      <VBackButton @click="router.back()" />
      <h1 class="admin-support__title">{{ t('adminScreens.adminSupport.title') }}</h1>
      <span v-if="items.length" class="admin-support__count">{{ items.length }}</span>
    </header>

    <div v-if="loading && items.length === 0" class="admin-support__loader">
      <VLoader size="lg" />
    </div>

    <VEmptyState
      v-else-if="error"
      icon="warning"
      :title="t('common.loadFailed')"
      :description="t('common.checkConnection')"
    >
      <template #action
        ><VButton variant="primary" @click="loadInitial">{{ t('common.retry') }}</VButton></template
      >
    </VEmptyState>

    <VEmptyState
      v-else-if="items.length === 0"
      icon="empty"
      :title="t('adminScreens.adminSupport.empty.title')"
      :description="t('adminScreens.adminSupport.empty.text')"
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
            <div class="scard__topic">{{ supportTopicLabel(item.topic) }}</div>
            <div class="scard__sub">{{ formatRelative(item.created_at) }}</div>
            <div class="scard__sub">{{ claimText(item) }}</div>
          </div>
          <VBadge :variant="supportStatusBadge(item.status)" class="scard__badge">
            {{ supportStatusLabel(item.status) }}
          </VBadge>
        </VCard>
      </div>

      <div v-if="nextCursor" class="admin-support__more">
        <VButton variant="outline" block :loading="loadingMore" @click="loadMore">
          {{ t('common.showMore') }}
        </VButton>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { toHistoryState } from '@/utils/historySnapshot'
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { VBackButton, VButton, VLoader, VEmptyState, VCard, VBadge } from '@/components/ui'
import { IconSupportChat } from '@/components/icons'
import { useToast } from '@/composables/useToast'
import { useAuthStore } from '@/stores/auth'
import { listAdminTickets, type AdminSupportTicket } from '@/api/support'
import { extractApiError } from '@/composables/useApiError'
import { formatRelative } from '@/utils/adminHelpers'
import { supportStatusBadge, supportStatusLabel, supportTopicLabel } from '@/utils/supportTopics'

const LIMIT = 20

const router = useRouter()
const toast = useToast()
const authStore = useAuthStore()

const items = ref<AdminSupportTicket[]>([])
const nextCursor = ref<string | null>(null)
const loading = ref(false)
const loadingMore = ref(false)
const error = ref(false)

function openerName(item: AdminSupportTicket): string {
  return item.opener?.name ?? t('adminScreens.adminSupport.userFallback')
}

/** Who took the ticket: nobody, me, or another admin by name. */
function claimText(item: AdminSupportTicket): string {
  const taker = item.claimed_by
  if (!taker) return t('adminScreens.adminSupport.claimedBy.none')
  if (taker.user_id === authStore.user?.id) return t('adminScreens.adminSupport.claimedBy.mine')
  const name = taker.name ?? t('adminScreens.adminSupport.claimedBy.adminFallback')
  return t('adminScreens.adminSupport.claimedBy.other', { name })
}

async function loadInitial(): Promise<void> {
  loading.value = true
  error.value = false
  items.value = []
  nextCursor.value = null
  try {
    const res = await listAdminTickets(LIMIT)
    items.value = res.tickets
    nextCursor.value = res.next_cursor
  } catch (e) {
    error.value = true
    toast.error(extractApiError(e, t('adminScreens.adminSupport.ticketsLoadError')))
  } finally {
    loading.value = false
  }
}

async function loadMore(): Promise<void> {
  if (!nextCursor.value || loadingMore.value) return
  loadingMore.value = true
  try {
    const res = await listAdminTickets(LIMIT, nextCursor.value)
    items.value.push(...res.tickets)
    nextCursor.value = res.next_cursor
  } catch (e) {
    toast.error(extractApiError(e, t('common.loadError')))
  } finally {
    loadingMore.value = false
  }
}

function openDetail(item: AdminSupportTicket): void {
  void router.push({
    name: 'admin-support-detail',
    params: { id: item.id },
    state: { ticket: toHistoryState(item) },
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
