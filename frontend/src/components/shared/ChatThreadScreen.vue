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
      <!-- [FE-4] The fog lives on the WRAPPER, not the scroller: iOS WebKit
           silently skips painting a mask attached to the scroll container's
           own scrolled content (mask + overflow scroll = broken on-device,
           device-proven: computed GRAD yet zero visible clipping, while the
           diary -- identical mask on a NON-scrolling parent's child pattern --
           fades fine). Wrapper masks + inner scroller is the working shape. -->
      <div ref="wrapEl" class="chat-thread__feed-wrap">
        <div
          ref="feedEl"
          class="chat-thread__feed"
          data-testid="chat-feed"
          @scroll="rememberBottomState"
        >
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
      </div>

      <!-- Composer -- shared with DiaryComposer (PROMPT №740, track 2). B38:
           the send control lives INSIDE the bordered field. B47: this
           consumer's own placeholder wording. B48: the control renders only
           once there is text, replacing the old always-present "Отправить"
           button. `send-test-id` preserves the existing `chat-send` hook.
           `grow-cap` (PROMPT №741, track 3): the SAME viewport-aware formula
           diary uses, via useComposerGrowCap -- see that file for the numbers
           and the CHROME_OFFSET caveat (diary-measured, reused here as an
           approximation, not re-measured for this screen). -->
      <div class="chat-thread__composer">
        <Composer
          placeholder="Написать сообщение…"
          :max-length="4000"
          :send="handleSend"
          :grow-cap="growCap"
          send-test-id="chat-send"
          @composing-change="composing = $event"
        />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { VHeader } from '@/components/layout'
import { VEmptyState, VLoader, VButton } from '@/components/ui'
import { IconMessages } from '@/components/icons'
import Composer, { type ComposerSendResult } from './Composer.vue'
import {
  listChatMessages,
  markChatRead,
  sendChatMessage,
  type ChatMessage,
  type ChatPeer,
} from '@/api/chats'
import { useAuthStore } from '@/stores/auth'
import { extractApiError } from '@/composables/useApiError'
import { useComposerGrowCap } from '@/composables/useComposerGrowCap'

const props = defineProps<{
  threadId: string
  /** P-1 display block; null when the proxy could not resolve the user. */
  peer?: ChatPeer | null
  /** Role-appropriate fallback when peer/name is absent («Мастер»/«Ученик»). */
  peerFallback: string
}>()

const emit = defineEmits<{ back: [] }>()

const POLL_MS = 12_000

const authStore = useAuthStore()
const myId = computed(() => authStore.user?.id ?? '')

const peerTitle = computed(() => props.peer?.name || props.peerFallback)

const loading = ref(true)
const error = ref<string | null>(null)
const messages = ref<ChatMessage[]>([])
const feedEl = ref<HTMLElement | null>(null)

// [FE-4] The fog must reach the REAL header, not a guess. The teleported
// VHeader island's height varies (back-pill row + title + island padding,
// taller than the hardcoded 96px the first fog shipped with -- the mask WAS
// rendering, device-proven, but ended above the header's bottom edge, so
// bubbles emerged fully opaque right under the title). Same pattern
// MobileLayout uses for its own clearance: measure the island, follow it.
const fogTop = ref(96)
let islandObserver: ResizeObserver | null = null

// The wrapEl carries the fog vars INLINE as literal px strings -- the exact
// recipe MobileLayout's own (device-proven, owner-praised) fog uses: mask
// stops must be PLAIN var() (no fallback chains) whose values are inline px.
// [FE-4] The NUMBERS are MobileLayout's too, 1:1: hard zone = --velo-fog-z2
// (40), fade = (island height + --velo-fog-z1 gap) - hard -- the same
// arithmetic mainStyle runs for the master pages' fog. Read from the same
// tokens at runtime so a re-tune of z1/z2 re-tunes both fogs together.
const wrapEl = ref<HTMLElement | null>(null)

function cssTok(name: string, fallback: number): number {
  const v = parseInt(getComputedStyle(document.documentElement).getPropertyValue(name), 10)
  return Number.isFinite(v) ? v : fallback
}

function measureIsland(): void {
  const island = document.querySelector('.mobile-layout__island')
  if (!island) return
  const h = Math.round(island.getBoundingClientRect().height)
  if (h > 0) fogTop.value = h + 8
  const hard = cssTok('--velo-fog-z2', 40)
  const gap = cssTok('--velo-fog-z1', 16)
  const islandH = h > 0 ? h : 88
  wrapEl.value?.style.setProperty('--chat-fog-hard', `${hard}px`)
  wrapEl.value?.style.setProperty('--chat-fog-fade', `${Math.max(0, islandH + gap - hard)}px`)
  wrapEl.value?.style.setProperty('--chat-fog-live', `${fogTop.value}px`)
  feedEl.value?.style.setProperty('--chat-fog-live', `${fogTop.value}px`)
}

onMounted(() => {
  measureIsland()
  islandObserver = new ResizeObserver(measureIsland)
  const island = document.querySelector('.mobile-layout__island')
  if (island) islandObserver.observe(island)
})

onBeforeUnmount(() => {
  islandObserver?.disconnect()
  islandObserver = null
  feedWrapObserver?.disconnect()
  feedWrapObserver = null
})

// PROMPT №741 (track 3, B40): the same viewport-aware cap diary uses.
const composing = ref(false)
const growCap = useComposerGrowCap(composing)

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

/* [owner pass] KEEP-BOTTOM ON GEOMETRY SHIFTS: the column is sized to the
 * LIVE viewport, so the feed's height changes whenever the keyboard opens or
 * closes -- on a shrink the visible window loses its bottom edge and the last
 * message slides under the fold ("saw it without the keyboard, must see it
 * with it"). The decision CANNOT be made from the post-resize geometry (a
 * keyboard subtracts 150-300px, blowing past NEAR_BOTTOM_PX), so the
 * bottom-state is remembered from the reader's own scroll events and the
 * resize consults the PRE-shift state: pinned -> re-pin, instant scrollTop
 * (never smooth); reading history -> untouched (CH-3). Attached from
 * reload() once the v-else branch mounts the wrap; idempotent. */
let pinnedToBottom = true

function rememberBottomState(): void {
  pinnedToBottom = readerNearBottom()
}

let feedWrapObserver: ResizeObserver | null = null

function attachKeepBottom(): void {
  if (feedWrapObserver || !wrapEl.value) return
  feedWrapObserver = new ResizeObserver(() => {
    if (pinnedToBottom) void scrollToBottom()
  })
  feedWrapObserver.observe(wrapEl.value)
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
    // B49: flip `loading` BEFORE scrolling. `scrollToBottom` needs `feedEl`
    // mounted, and Vue only swaps in the v-else feed branch (where `feedEl`
    // lives) once `loading` goes false. Calling it while still on the
    // loading branch is a silent no-op (`feedEl.value` is null) -- a fresh
    // thread landed at the top of the history instead of the newest message.
    loading.value = false
    await scrollToBottom()
    // [owner pass] keep-bottom: the wrap is mounted only now (v-else branch).
    attachKeepBottom()
  } catch (e) {
    error.value = extractApiError(e, 'Попробуйте ещё раз')
    loading.value = false
  }
}

/** Silent poll of the visible thread. Any drift (new tail, an edit-free
 *  world still allows resync/repoint) replaces the local copy; a NEW tail
 *  additionally marks read and -- only when the reader is already at the
 *  bottom (CH-3) -- follows the conversation down. */
async function poll(): Promise<void> {
  if (document.hidden || loading.value || sendInFlight.value) return
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

// (a): the shared Composer owns the draft and its own submit-button in-flight
// guard (prevents a double-click double-send) -- this is the persistence
// callback it calls, unchanged in substance from the old onSend (same
// endpoint, same local append, same scroll-to-bottom, same error message).
// Toasting on failure now happens inside Composer itself, from the `error`
// this returns.
//
// `sendInFlight` is a SEPARATE guard the old single-file version also had
// (as `sending.value` in poll()'s own condition) -- it stops a concurrent
// poll from racing the optimistic local append: a poll response that lands
// between "sent" and "appended" would otherwise overwrite `messages.value`
// with a copy that does not yet include the just-sent message, making it
// flicker out until the next 12s tick. Composer's internal submitting state
// is not exposed to this component, so this is tracked independently rather
// than reached into.
const sendInFlight = ref(false)

async function handleSend(body: string): Promise<ComposerSendResult> {
  sendInFlight.value = true
  try {
    const sent = await sendChatMessage(props.threadId, body)
    messages.value = [...messages.value, sent]
    await scrollToBottom()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: extractApiError(e, 'Не удалось отправить сообщение') }
  } finally {
    sendInFlight.value = false
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
   mirroring the honest-stub predecessor's note in MasterChatView.
   B39 (PROMPT №741, track 3): sized to the LIVE visible height, mirroring
   DiaryFeedView.vue's own corrected formula VERBATIM, including the
   safe-top subtraction -- copied because that subtraction is load-bearing
   (binding straight to --velo-vvh alone reintroduces the Telegram-fullscreen
   overshoot defect DiaryFeedView.vue:689-706 documents finding the hard way),
   not because this screen independently needed it. `--velo-content-safe-top`
   is published by AppFrame.vue and inherited here the same way it reaches
   DiaryFeedView -- no new publisher, no touch to AppFrame/useViewportGeometry/
   #app-bg (BG-ROOT, closed, untouched). Falls back to 100% (of the frozen
   ancestor) until --velo-vvh publishes, same fallback DiaryFeedView uses. */
.chat-thread {
  height: 100%;
  height: calc(var(--velo-vvh, 100%) - var(--velo-content-safe-top, 0px));
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

/* B37 (PROMPT №741, track 3): the feed is the ONLY flexible row (flex:1,
   min-height:0 so it can shrink below content and scroll internally); the
   composer below is flex:0 0 auto (fixed to its own content) -- ordinary
   flex competition, the exact mechanism DiaryFeedView.vue's
   `.diary-feed__body`/`.diary-feed__composer` pair already uses. Once B39
   sizes `.chat-thread` to the live viewport, growing the composer
   (B40's growCap) eats into the column's available height and the feed
   shrinks to match -- "rides up" with zero new code, same as diary. */
/* [FE-4] Fog carrier: the NON-scrolling wrapper owns the mask; the feed
   inside scrolls. The recipe is MobileLayout's own fog copied LITERALLY
   (the owner confirms it renders beautifully on his device): PLAIN var()
   stops whose values are set INLINE as px strings by the component, a
   hard-transparent zone of --velo-fog-z2 (40px) then a long fade to opaque
   -- the same z1/z2 arithmetic mainStyle runs for the master pages' fog.
   The BOTTOM keeps a modest 24px (not the master pages' 70+90): there is
   no 160px tab bar under this feed -- the composer sits at its bottom edge,
   and a master-sized bottom fade would swallow the last messages.
   var(--x, fallback) chains inside mask stops computed fine but never
   painted on-device -- do not reintroduce them. */
.chat-thread__feed-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  --chat-fog-hard: 40px;
  --chat-fog-fade: 64px;
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent 0,
    transparent var(--chat-fog-hard),
    #000 calc(var(--chat-fog-hard) + var(--chat-fog-fade)),
    #000 calc(100% - 24px),
    transparent 100%
  );
  mask-image: linear-gradient(
    to bottom,
    transparent 0,
    transparent var(--chat-fog-hard),
    #000 calc(var(--chat-fog-hard) + var(--chat-fog-fade)),
    #000 calc(100% - 24px),
    transparent 100%
  );
}

.chat-thread__feed {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* [FE-4] Diary-feed parity, property for property (the diary's fog is the
     one configuration PROVEN to render in this Telegram/iOS webview):
     the momentum scrolling layer + overscroll containment the diary body
     carries. */
  -webkit-overflow-scrolling: touch;
  overscroll-behavior-y: contain;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  /* Fill-mode top clearance: the floating VHeader island's measured height
     (fallback 96px = HEADER_FALLBACK 88 + gap 8), set as --chat-fog-live by
     the component so padding and mask share ONE live number. */
  padding: var(--chat-fog-live, var(--velo-chat-fog-top, 96px))
    var(--velo-rail-pad-x, var(--space-4)) var(--space-3);
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
  flex: 0 0 auto;
  padding: var(--space-2) var(--velo-rail-pad-x, var(--space-4)) var(--space-3);
}
</style>
