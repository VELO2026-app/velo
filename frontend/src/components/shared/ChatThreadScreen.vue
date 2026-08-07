<!--
  VELO Frontend -- ChatThreadScreen (Phase 6 / T2, H-T2-UI phase «а»)

  THE chat thread, shared by both roles: UserChatView and MasterChatView are
  thin wrappers that resolve the peer and hand over threadId + peer display
  props. Function-first skeleton on existing primitives (VHeader / VAvatar /
  VTextarea / VButton / VLoader / VEmptyState) -- the «3 Students» restyle is
  phase «б» and does not change this component's contract.

  Data contract (api/chats.ts over the T2 proxy):
    - history: GET messages, NEWEST-FIRST from comms -> reversed here so the
      feed reads top-down; one page of 100 (deeper history pagination is
      outside phase «а» -- recorded in the handoff report).
    - send: POST message -> the returned message is appended locally (no
      refetch round-trip for one's own words).
    - read: POST read on mount AND whenever the poll delivers new messages
      while the tab is visible -- the list badge dies exactly when the
      messages were actually seen.
    - updates: plain 12s polling of the visible thread only (approved plan
      §4). Paused while document.hidden; an immediate refetch on return.
      No websockets -- behind the fence.

  Bubbles align by sender === my user id; the peer's name falls back to the
  role wording the PARENT supplies (a student sees «Мастер», a master sees
  «Ученик») -- peer may be null when the proxy could not resolve the user.
-->

<template>
  <div class="chat-thread">
    <VHeader :title="peerTitle" show-back @back="emit('back')" />

    <!-- Loading (first fetch only; polls refresh silently) -->
    <div v-if="loading" class="chat-thread__center">
      <VLoader size="lg" />
    </div>

    <!-- Load failure: the thread may well exist -- offer a retry. -->
    <div v-else-if="error" class="chat-thread__center">
      <VEmptyState title="Не удалось загрузить переписку" :description="error">
        <template #icon>
          <IconMessages :size="48" />
        </template>
      </VEmptyState>
      <VButton size="sm" @click="reload"> Повторить </VButton>
    </div>

    <template v-else>
      <div ref="feedEl" class="chat-thread__feed" data-testid="chat-feed">
        <!-- Empty thread: an honest invitation, not a fake history. -->
        <div v-if="messages.length === 0" class="chat-thread__empty">
          Сообщений пока нет — напишите первое.
        </div>

        <div
          v-for="m in messages"
          :key="m.id"
          class="chat-thread__row"
          :class="{ 'chat-thread__row--mine': m.sender === myId }"
        >
          <div
            class="chat-thread__bubble"
            :class="{ 'chat-thread__bubble--mine': m.sender === myId }"
            :data-testid="m.sender === myId ? 'bubble-mine' : 'bubble-peer'"
          >
            <div class="chat-thread__body">
              {{ m.body }}
            </div>
            <div class="chat-thread__time">
              {{ formatTime(m.created_at) }}
            </div>
          </div>
        </div>
      </div>

      <!-- Composer. NB: VTextarea forwards attrs (incl. class) onto its inner
           <textarea> (inheritAttrs:false), so the stretch class lives on a
           wrapper of ours, not on the component. `autogrow` + rows=1 is the DS
           chat-composer shape: single-line start, grows to the token cap
           (--velo-textarea-autogrow-max), then scrolls internally. -->
      <div class="chat-thread__composer">
        <div class="chat-thread__input">
          <VTextarea
            v-model="draft"
            placeholder="Сообщение…"
            :rows="1"
            autogrow
            maxlength="4000"
            :disabled="sending"
          />
        </div>
        <VButton
          variant="primary"
          size="sm"
          :disabled="sending || !draft.trim()"
          :loading="sending"
          data-testid="chat-send"
          @click="onSend"
        >
          Отправить
        </VButton>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { VHeader } from '@/components/layout'
import { VButton, VEmptyState, VLoader, VTextarea } from '@/components/ui'
import { IconMessages } from '@/components/icons'
import {
  listChatMessages,
  markChatRead,
  sendChatMessage,
  type ChatMessage,
  type ChatPeer,
} from '@/api/chats'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import { extractApiError } from '@/composables/useApiError'

const props = defineProps<{
  threadId: string
  /** P-1 display block; null when the proxy could not resolve the user. */
  peer?: ChatPeer | null
  /** Role-appropriate fallback when peer/name is absent («Мастер»/«Ученик»). */
  peerFallback: string
}>()

const emit = defineEmits<{ back: [] }>()

const POLL_MS = 12_000

const toast = useToast()
const authStore = useAuthStore()
const myId = computed(() => authStore.user?.id ?? '')

const peerTitle = computed(() => props.peer?.name || props.peerFallback)

const loading = ref(true)
const error = ref<string | null>(null)
const messages = ref<ChatMessage[]>([])
const draft = ref('')
const sending = ref(false)
const feedEl = ref<HTMLElement | null>(null)

let pollTimer: ReturnType<typeof setInterval> | null = null

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

async function scrollToBottom(): Promise<void> {
  await nextTick()
  if (feedEl.value) feedEl.value.scrollTop = feedEl.value.scrollHeight
}

/** CH-3: pixels the reader may drift from the bottom and still be counted
 *  "at" it -- an incoming message then auto-scrolls; further up (reading
 *  history) it must not yank them down. */
const NEAR_BOTTOM_PX = 120

/** Pure over the three scroll numbers, so tests can drive it by stubbing
 *  the feed element's metrics (happy-dom measures nothing by itself). */
function isNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold = NEAR_BOTTOM_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold
}

function readerNearBottom(): boolean {
  const el = feedEl.value
  if (!el) return true
  return isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight)
}

/** One page, newest-first from comms -> stored oldest-first for rendering. */
async function fetchMessages(): Promise<ChatMessage[]> {
  const page = await listChatMessages(props.threadId)
  return [...page.messages].reverse()
}

/** The newest message's id (oldest-first storage -> it's the tail).
 *  CH-1: THIS, not the array length, is what says "something arrived" --
 *  on an eternal DM past one page the length is pinned at the page size
 *  (100 === 100 forever), and a length compare silently blinds the poll
 *  to exactly the peer's replies. */
function newestId(list: ChatMessage[]): string | null {
  return list.at(-1)?.id ?? null
}

function markRead(): void {
  // Fire-and-forget: the read pointer is a courtesy to the badge, a failed
  // call must never disturb the conversation itself.
  markChatRead(props.threadId).catch(() => {})
}

async function reload(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    messages.value = await fetchMessages()
    markRead()
    await scrollToBottom()
  } catch (e) {
    error.value = extractApiError(e, 'Попробуйте ещё раз')
  } finally {
    loading.value = false
  }
}

/** Silent poll of the visible thread. Any drift (new tail, an edit-free
 *  world still allows resync/repoint) replaces the local copy; a NEW tail
 *  additionally marks read and -- only when the reader is already at the
 *  bottom (CH-3) -- follows the conversation down. */
async function poll(): Promise<void> {
  if (document.hidden || loading.value || sending.value) return
  try {
    const fresh = await fetchMessages()
    const freshNewest = newestId(fresh)
    const hasNew = freshNewest !== null && freshNewest !== newestId(messages.value)
    if (hasNew || fresh.length !== messages.value.length) {
      const followDown = hasNew && readerNearBottom()
      messages.value = fresh
      if (hasNew) {
        markRead()
        if (followDown) await scrollToBottom()
      }
    }
  } catch {
    // A missed poll is silent by design; the next tick retries.
  }
}

function onVisibility(): void {
  if (!document.hidden) void poll()
}

async function onSend(): Promise<void> {
  const body = draft.value.trim()
  if (!body || sending.value) return
  sending.value = true
  try {
    const sent = await sendChatMessage(props.threadId, body)
    messages.value = [...messages.value, sent]
    draft.value = ''
    await scrollToBottom()
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось отправить сообщение'))
  } finally {
    sending.value = false
  }
}

onMounted(() => {
  void reload()
  pollTimer = setInterval(() => void poll(), POLL_MS)
  document.addEventListener('visibilitychange', onVisibility)
})

onBeforeUnmount(() => {
  if (pollTimer !== null) clearInterval(pollTimer)
  document.removeEventListener('visibilitychange', onVisibility)
})
</script>

<style scoped>
/* Fill-mode screen (both chat routes hide the tab bar); own rail padding,
   mirroring the honest-stub predecessor's note in MasterChatView. */
.chat-thread {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.chat-thread__center {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: 0 var(--velo-rail-pad-x, var(--space-4));
}

.chat-thread__feed {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  /* Fill-mode screens own their top clearance: VHeader teleports into the
     MobileLayout island and FLOATS over the feed, and fill mode drops the
     layout's measured mainStyle clearance. 88px mirrors the layout's own
     HEADER_FALLBACK for a floating VHeader (MobileLayout.vue, ПРОМТ №164). */
  padding: calc(88px + var(--space-2)) var(--velo-rail-pad-x, var(--space-4)) var(--space-3);
}

.chat-thread__empty {
  margin: auto;
  color: var(--velo-text-muted);
  font-size: var(--text-sm, 14px);
  text-align: center;
}

.chat-thread__row {
  display: flex;
  justify-content: flex-start;
}
.chat-thread__row--mine {
  justify-content: flex-end;
}

.chat-thread__bubble {
  max-width: 78%;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--velo-bg-card-solid);
  color: var(--velo-text-primary);
  word-break: break-word;
}
.chat-thread__bubble--mine {
  background: var(--velo-primary);
  color: #ffffff;
}

.chat-thread__body {
  white-space: pre-wrap;
}

.chat-thread__time {
  margin-top: var(--space-1);
  font-size: 11px;
  opacity: 0.6;
  text-align: right;
}

.chat-thread__composer {
  display: flex;
  align-items: flex-end;
  gap: var(--space-2);
  padding: var(--space-2) var(--velo-rail-pad-x, var(--space-4)) var(--space-3);
}

.chat-thread__input {
  flex: 1;
  /* Without this the flex item's min-width:auto keeps the textarea's
     intrinsic width and squeezes the send button off-viewport. */
  min-width: 0;
}
</style>
