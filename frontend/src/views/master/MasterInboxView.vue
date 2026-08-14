<!--
  VELO Frontend -- MasterInboxView (T-26 bell, PROMPT №704)

  The master dashboard's bell feed. Reached by tapping the bell
  (MasterDashboardView.vue's onBell), which used to toast "Уведомления
  пока недоступны" and go nowhere -- four comms-proxy endpoints
  (GET/notifications, POST/{id}/read, POST/read-all) were already live and
  called by nobody. This screen is their first caller.

  COPY: title, empty-state text and the "Прочитать всё" label were shown to
  the owner in the .tmp/ preview (PROMPT №703) and CONFIRMED 2026-08-14.
  Still a two-line edit if he wants a different wording later -- confirmed
  is not frozen, it is simply not a proposal any more.

  SCOPE BOUNDARY, DELIBERATE: a tap marks the item read and stops. Every
  item carries `action_data` (comms' navigational intent -- "open this
  booking / this thread"), but NOTHING in this app reads that field yet
  (checked: zero consumers anywhere in frontend/src). Building per-type
  deep-link routing is a distinct, larger task this screen does not attempt
  -- the boundary is the point, not a gap to fill in quietly later.

  PAGINATION: also deliberately absent. `next_cursor` arrives on every
  response and is not used -- one page (comms default limit 20) is what the
  owner saw and confirmed; "load more" is future scope.

  Route: /master/notifications (name: 'master-inbox') -- distinct from
  'master-notifications' (the T-26 preference screen at profile/notifications).
-->

<template>
  <div class="master-inbox">
    <VHeader title="Уведомления" show-back @back="router.back()">
      <template v-if="unread > 0" #action>
        <button type="button" class="master-inbox__read-all" @click="markAll">Прочитать всё</button>
      </template>
    </VHeader>

    <div v-if="loading" class="master-inbox__center">
      <VLoader size="lg" />
    </div>

    <div v-else-if="error" class="master-inbox__center">
      <VEmptyState title="Не удалось загрузить" :description="error">
        <template #icon>
          <IconBellPlain :size="48" />
        </template>
      </VEmptyState>
      <VButton size="sm" @click="load">Повторить</VButton>
    </div>

    <VEmptyState
      v-else-if="items.length === 0"
      title="Здесь появятся уведомления о записях, сообщениях и операциях"
    >
      <template #icon>
        <IconBellPlain :size="48" />
      </template>
    </VEmptyState>

    <div v-else class="master-inbox__list">
      <NotificationRow
        v-for="item in items"
        :key="item.id"
        :title="item.title"
        :body="item.body"
        :sent-at="item.sent_at"
        :unread="item.read_at === null"
        @open="markOne(item)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import { VButton, VEmptyState, VLoader } from '@/components/ui'
import { IconBellPlain } from '@/components/icons'
import NotificationRow from '@/components/shared/NotificationRow.vue'
import { useToast } from '@/composables/useToast'
import { extractApiError } from '@/composables/useApiError'
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationItem,
} from '@/api/notifications'

const router = useRouter()
const toast = useToast()

const loading = ref(true)
const error = ref<string | null>(null)
const items = ref<NotificationItem[]>([])
const unread = ref(0)

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const page = await listNotifications()
    items.value = page.items
    unread.value = page.unread
  } catch (e) {
    error.value = extractApiError(e, 'Попробуйте ещё раз')
  } finally {
    loading.value = false
  }
}
onMounted(load)

// Optimistic: flip locally, revert on failure so the row never shows a state
// the server did not accept -- same shape as NotificationsView.vue's toggle
// revert (T-26).
async function markOne(item: NotificationItem): Promise<void> {
  if (item.read_at !== null) return // already read -- nothing to mark, no call
  const previousReadAt = item.read_at
  const previousUnread = unread.value
  item.read_at = new Date().toISOString()
  unread.value = Math.max(0, unread.value - 1)
  try {
    const result = await markNotificationRead(item.id)
    unread.value = result.unread
  } catch (e) {
    item.read_at = previousReadAt
    unread.value = previousUnread
    toast.error(extractApiError(e, 'Не удалось отметить прочитанным'))
  }
}

async function markAll(): Promise<void> {
  const previous = items.value.map((i) => i.read_at)
  const previousUnread = unread.value
  const now = new Date().toISOString()
  items.value.forEach((i) => {
    if (i.read_at === null) i.read_at = now
  })
  unread.value = 0
  try {
    const result = await markAllNotificationsRead()
    unread.value = result.unread
  } catch (e) {
    items.value.forEach((i, idx) => {
      i.read_at = previous[idx] ?? null
    })
    unread.value = previousUnread
    toast.error(extractApiError(e, 'Не удалось отметить прочитанным'))
  }
}
</script>

<style scoped>
.master-inbox {
  display: flex;
  flex-direction: column;
  margin: calc(-1 * var(--space-4));
}

.master-inbox__center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-8) 0;
}

.master-inbox__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: 0 var(--space-4) var(--space-8);
}

.master-inbox__read-all {
  background: none;
  border: none;
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-primary);
  cursor: pointer;
  padding: var(--space-2);
}
</style>
