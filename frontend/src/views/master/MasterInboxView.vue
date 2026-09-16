<!--
  VELO Frontend -- MasterInboxView (T-26 bell, PROMPT №704; brought to the
  user inbox's working state 2026-09-08)

  The master dashboard's bell feed. Reached by tapping the bell
  (MasterDashboardView.vue's onBell). Same comms-proxy endpoints, same row
  component and same owner-confirmed copy (PROMPT №703) as the user inbox
  (UserInboxView.vue).

  THE T-26 TAP=READ BOUNDARY IS LIFTED (2026-09-08). The old header here
  deferred master-side deep links to "their own decision, not a gap quietly
  filled by proximity" -- this is that decision. A tap now navigates AND
  marks the row read, by the SAME action vocabulary as the user map, into
  MASTER-zone routes:
    open_practice          -> that practice's master detail
                               (booking.cancelled_by_user,
                               practice.cancelled_by_curator)
    open_wallet            -> master finance (withdrawal outcomes)
    open_thread            -> that message dialog (msg.* emitted by comms'
                               messaging engine; the action name/param are
                               the stand-stub contract until confirmed
                               against comms, same note as the user map)
    msg.* without a thread -> the master messages list
  An unmapped action or a missing/malformed id falls back to mark-read-only
  -- honest, never a broken route. confirm_waitlist and open_feedback stay
  deliberately UNMAPPED here: their emit sites address students, never a
  master.

  TYPE SLIDER (same ask): Сообщения / Практики / Финансы / Другое -- there
  is no «Все» tab: the master's traffic concentrates in msg.* and wallet.*,
  so the buckets split where his feed actually lives instead of borrowing
  the user's «Мероприятия» (nearly empty for a master) or «Другое» (which
  would bury the withdrawals). Buckets are PREFIX rules over velo's emit
  vocabulary: msg.* = the messaging engine; booking.* / practice.* /
  waitlist.* = practice life; wallet.* = the money flow; «Другое» = the
  complement (announcements and every future kind with no bucket of its
  own) -- the vocabulary grows, so prefixes, not an enum. The first bucket
  is the default. A client-side view filter over the ONE loaded page; the
  track is SCROLLABLE (the user slider's owner recipe): four content-sized
  tabs, the last one reached by a horizontal swipe.

  PAGINATION: still deliberately absent. `next_cursor` arrives on every
  response and is not used -- one page (comms default limit 20) is what the
  owner saw and confirmed; "load more" is future scope.

  BADGE: this screen keeps NO store sync -- the notifications store is the
  USER dock bell's state; the master dashboard fetches its own badge and
  remounts (refetches) on return from here.

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

    <template v-else>
      <!-- Type slider: a view filter, not a refetch -- one page is loaded and
           sliced locally. Only rendered when the feed itself has rows. -->
      <VSegmentTrack
        v-model="filter"
        :options="FILTER_OPTIONS"
        variant="tabs"
        scrollable
        class="master-inbox__filter"
        aria-label="Тип уведомлений"
      />

      <div v-if="visibleItems.length === 0" class="master-inbox__center">
        <p class="master-inbox__filter-empty">В этой категории пока нет уведомлений</p>
      </div>

      <div v-else class="master-inbox__list">
        <NotificationRow
          v-for="item in visibleItems"
          :key="item.id"
          :title="item.title"
          :body="item.body"
          :sent-at="item.sent_at"
          :unread="item.read_at === null"
          :icon="rowIcon(item.type)"
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

// -- Type slider (Сообщения / Практики / Финансы / Другое) ----------------------
// A client-side view filter over the one loaded page. Bucket rules and the
// row icons share ONE classifier so a tab and its glyph can never disagree.
type InboxFilter = 'messages' | 'practices' | 'finance' | 'other'
const FILTER_OPTIONS: ReadonlyArray<{ value: InboxFilter; label: string }> = [
  { value: 'messages', label: 'Сообщения' },
  { value: 'practices', label: 'Практики' },
  { value: 'finance', label: 'Финансы' },
  { value: 'other', label: 'Другое' },
]
const filter = ref<InboxFilter>('messages')

const EVENT_PREFIXES = ['booking.', 'practice.', 'waitlist.'] as const

function isEvent(type: string): boolean {
  return EVENT_PREFIXES.some((p) => type.startsWith(p))
}

function bucketOf(type: string): InboxFilter {
  if (type.startsWith('msg.')) return 'messages'
  if (isEvent(type)) return 'practices'
  if (type.startsWith('wallet.')) return 'finance'
  return 'other'
}

const visibleItems = computed((): NotificationItem[] =>
  items.value.filter((i) => bucketOf(i.type) === filter.value),
)

/** The row glyph follows the same bucket: message / calendar / finance. */
function rowIcon(type: string): 'message' | 'event' | 'finance' {
  if (bucketOf(type) === 'messages') return 'message'
  if (bucketOf(type) === 'finance') return 'finance'
  return 'event'
}

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

// -- Deep links -----------------------------------------------------------------
// The routing key is action_data.action -- velo's emit sites NAME the intent
// (same vocabulary as the user map), but every target is a MASTER-zone
// route. IDs are narrowed from unknown at this boundary; a missing or
// malformed id means mark-read-only, never a push with an undefined param.
function routeFor(
  item: NotificationItem,
): { name: string; params?: Record<string, string> } | null {
  const action = item.action_data?.action
  const params = item.action_data?.params ?? {}
  const practiceId = typeof params.practice_id === 'string' ? params.practice_id : null

  switch (action) {
    case 'open_practice':
      return practiceId ? { name: 'master-practice-detail', params: { id: practiceId } } : null
    case 'open_wallet':
      return { name: 'master-finance' }
    case 'open_thread': {
      // A message notification names ITS dialog. The action name/param are
      // the stand-stub contract for now -- the real comms msg.* vocabulary
      // must be confirmed against comms when it is reachable (same FE
      // follow-up note as the user map).
      const threadId = typeof params.thread_id === 'string' ? params.thread_id : null
      return threadId ? { name: 'master-chat', params: { id: threadId } } : null
    }
    default:
      // msg.* without a thread reference: the messages list, one hop away.
      return item.type.startsWith('msg.') ? { name: 'master-messages' } : null
  }
}

/** Tap = navigate + mark read. Navigation always happens (a read row is a
 *  link too); the read-mark itself is idempotent via markOne's guard. */
function onRow(item: NotificationItem): void {
  void markOne(item)
  const target = routeFor(item)
  if (target) void router.push(target)
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

/* Frosted track (the user slider's owner recipe): the tab-dock frost
   (white over blur+saturate) instead of the default blue tint. Scoped to
   THIS screen's slider only; VSegmentTrack keeps its approved look
   everywhere else. The extra .master-inbox ancestor lifts specificity
   above the component's own .v-segment-track[data-v] so the override
   cannot lose on style order. */
.master-inbox .master-inbox__filter {
  background: var(--velo-glass-white-25);
  backdrop-filter: blur(18px) saturate(180%);
  -webkit-backdrop-filter: blur(18px) saturate(180%);
}

.master-inbox__filter {
  margin: 0 var(--space-4) var(--space-3);
}

.master-inbox__filter-empty {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  text-align: center;
  padding: 0 var(--space-4);
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
