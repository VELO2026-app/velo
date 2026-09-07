<!--
  VELO Frontend -- UserInboxView (FE-11 bell)

  The user dashboard's bell feed -- the user-zone mirror of the master's
  T-26 inbox (MasterInboxView.vue), reached by tapping the bell
  (UserDashboardView.vue's onBell). Same comms-proxy endpoints, same rows
  (NotificationRow), same copy: the title, empty state and «Прочитать всё»
  wording was owner-confirmed for the master inbox (PROMPT №703) and carries
  over verbatim.

  DEEP LINKS (owner ruling, FE-11): a tap navigates AND marks the row read.
  The map follows velo's own action vocabulary (the emit sites name the
  intent): open_practice / confirm_waitlist -> the practice page,
  open_feedback -> the feedback screen, open_wallet -> top-up, open_thread
  -> THAT message dialog (msg.* emitted by comms' messaging engine; without
  a thread reference it falls back to the messages list). An unmapped action
  or a missing/malformed id falls back to mark-read-only -- honest, never a
  broken route. The MASTER inbox keeps its tap=read boundary (T-26).
  PAGINATION: deliberately absent -- one page (comms default limit 20);
  "load more" is future scope.

  TYPE SLIDER (owner ask): Все / Сообщения / Мероприятия / Другое, a
  client-side view filter over the ONE loaded page. Buckets follow velo's
  own emit vocabulary: msg.* = the messaging engine; booking.* / practice.* /
  waitlist.* = practice life; «Другое» = the complement (finance and every
  future kind with no tab of its own) -- the vocabulary grows, so prefixes,
  not an enum. The track is SCROLLABLE (owner ask): four tabs do not squeeze
  into equal segments, they stay content-sized and the last one is reached
  by a horizontal swipe (VSegmentTrack scrollable).

  Route: /user/notifications (name: 'user-inbox') -- deliberately NOT
  'user-notifications': that name is already the preference screen at
  profile/notifications (NotificationsView.vue).
-->

<template>
  <div class="user-inbox">
    <VHeader title="Уведомления" show-back @back="router.back()">
      <template v-if="unread > 0" #action>
        <button type="button" class="user-inbox__read-all" @click="markAll">Прочитать всё</button>
      </template>
    </VHeader>

    <div v-if="loading" class="user-inbox__center">
      <VLoader size="lg" />
    </div>

    <div v-else-if="error" class="user-inbox__center">
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

    <template v-else>
      <!-- Type slider: a view filter, not a refetch -- one page is loaded and
           sliced locally. Only rendered when the feed itself has rows. -->
      <VSegmentTrack
        v-model="filter"
        :options="FILTER_OPTIONS"
        variant="tabs"
        scrollable
        class="user-inbox__filter"
        aria-label="Тип уведомлений"
      />

      <div v-if="visibleItems.length === 0" class="user-inbox__center">
        <p class="user-inbox__filter-empty">В этой категории пока нет уведомлений</p>
      </div>

      <div v-else class="user-inbox__list">
        <NotificationRow
          v-for="item in visibleItems"
          :key="item.id"
          :title="item.title"
          :body="item.body"
          :sent-at="item.sent_at"
          :unread="item.read_at === null"
          :icon="item.type.startsWith('msg.') ? 'message' : 'event'"
          @open="onRow(item)"
        />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import { VButton, VEmptyState, VLoader, VSegmentTrack } from '@/components/ui'
import { IconBellPlain } from '@/components/icons'
import NotificationRow from '@/components/shared/NotificationRow.vue'
import { useToast } from '@/composables/useToast'
import { extractApiError } from '@/composables/useApiError'
import { useNotificationsStore } from '@/stores/notifications'
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationItem,
} from '@/api/notifications'

const router = useRouter()
const toast = useToast()
// The dock bell's presence dot (UserShell) reads this store; every
// server-confirmed badge below keeps it in step with this screen's actions.
const notifications = useNotificationsStore()

const loading = ref(true)
const error = ref<string | null>(null)
const items = ref<NotificationItem[]>([])
const unread = ref(0)

// -- Type slider (Все / Сообщения / Мероприятия / Другое) -----------------------
// A client-side view filter. Buckets are PREFIX rules over velo's emit
// vocabulary (see header): msg.* = messages; booking.*/practice.*/waitlist.*
// = practice life; «Другое» = everything else (finance, future kinds).
type InboxFilter = 'all' | 'messages' | 'events' | 'other'
const FILTER_OPTIONS: ReadonlyArray<{ value: InboxFilter; label: string }> = [
  { value: 'all', label: 'Все' },
  { value: 'messages', label: 'Сообщения' },
  { value: 'events', label: 'Мероприятия' },
  { value: 'other', label: 'Другое' },
]
const filter = ref<InboxFilter>('all')

const EVENT_PREFIXES = ['booking.', 'practice.', 'waitlist.'] as const

function isEvent(type: string): boolean {
  return EVENT_PREFIXES.some((p) => type.startsWith(p))
}

const visibleItems = computed((): NotificationItem[] => {
  if (filter.value === 'messages') {
    return items.value.filter((i) => i.type.startsWith('msg.'))
  }
  if (filter.value === 'events') {
    return items.value.filter((i) => isEvent(i.type))
  }
  if (filter.value === 'other') {
    return items.value.filter((i) => !i.type.startsWith('msg.') && !isEvent(i.type))
  }
  return items.value
})

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const page = await listNotifications()
    items.value = page.items
    unread.value = page.unread
    notifications.applyUnread(page.unread)
  } catch (e) {
    error.value = extractApiError(e, 'Попробуйте ещё раз')
  } finally {
    loading.value = false
  }
}
onMounted(load)

// Optimistic: flip locally, revert on failure so the row never shows a state
// the server did not accept -- same shape as MasterInboxView.vue (T-26).
async function markOne(item: NotificationItem): Promise<void> {
  if (item.read_at !== null) return // already read -- nothing to mark, no call
  const previousReadAt = item.read_at
  const previousUnread = unread.value
  item.read_at = new Date().toISOString()
  unread.value = Math.max(0, unread.value - 1)
  try {
    const result = await markNotificationRead(item.id)
    unread.value = result.unread
    notifications.applyUnread(result.unread)
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
    notifications.applyUnread(result.unread)
  } catch (e) {
    items.value.forEach((i, idx) => {
      i.read_at = previous[idx] ?? null
    })
    unread.value = previousUnread
    toast.error(extractApiError(e, 'Не удалось отметить прочитанным'))
  }
}

// -- Deep links -----------------------------------------------------------------
// The routing key is action_data.action -- velo's emit sites NAME the intent
// (open_practice / open_feedback / confirm_waitlist / open_wallet), so the map
// is over actions, not notification types. IDs are narrowed from unknown at
// this boundary; a missing/malformed id means mark-read-only, never a push
// with an undefined param.
function routeFor(
  item: NotificationItem,
): { name: string; params?: Record<string, string> } | null {
  const action = item.action_data?.action
  const params = (item.action_data?.params ?? {}) as Record<string, unknown>
  const practiceId = typeof params.practice_id === 'string' ? params.practice_id : null

  switch (action) {
    case 'open_practice':
    case 'confirm_waitlist': // no dedicated confirm screen: the practice page owns the waitlist CTA
      return practiceId ? { name: 'practice-detail', params: { id: practiceId } } : null
    case 'open_feedback':
      return practiceId ? { name: 'user-feedback', params: { practiceId } } : null
    case 'open_wallet':
      return { name: 'user-topup' }
    case 'open_thread': {
      // A message notification names ITS dialog. The action name/param are the
      // stand-stub contract for now -- the real comms msg.* vocabulary must be
      // confirmed against comms when it is reachable (FE follow-up note).
      const threadId = typeof params.thread_id === 'string' ? params.thread_id : null
      return threadId ? { name: 'user-chat', params: { id: threadId } } : null
    }
    default:
      // msg.* without a thread reference: the messages list, one hop away.
      return item.type.startsWith('msg.') ? { name: 'user-messages' } : null
  }
}

/** Tap = navigate + mark read. Navigation always happens (a read row is a
 *  link too); the read-mark itself is idempotent via markOne's guard. */
function onRow(item: NotificationItem): void {
  void markOne(item)
  const target = routeFor(item)
  if (target) router.push(target)
}
</script>

<style scoped>
.user-inbox {
  display: flex;
  flex-direction: column;
  margin: calc(-1 * var(--space-4));
}

.user-inbox__center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-8) 0;
}

/* Frosted track (owner ask): the tab-dock frost recipe (VTabBar -- white over
   blur+saturate) instead of the default blue tint. Scoped to THIS screen's
   slider only; VSegmentTrack keeps its approved look everywhere else. The
   extra .user-inbox ancestor lifts specificity above the component's own
   .v-segment-track[data-v] so the override cannot lose on style order. */
.user-inbox .user-inbox__filter {
  background: var(--velo-glass-white-25);
  backdrop-filter: blur(18px) saturate(180%);
  -webkit-backdrop-filter: blur(18px) saturate(180%);
}

.user-inbox__filter {
  margin: 0 var(--space-4) var(--space-3);
}

.user-inbox__filter-empty {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  text-align: center;
  padding: 0 var(--space-4);
}

.user-inbox__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: 0 var(--space-4) var(--space-8);
}

.user-inbox__read-all {
  background: none;
  border: none;
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-primary);
  cursor: pointer;
  padding: var(--space-2);
}
</style>
