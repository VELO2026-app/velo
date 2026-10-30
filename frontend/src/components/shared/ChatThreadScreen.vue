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
    - updates: polling of the visible thread only (approved plan §4) -- the
      plain 12s cadence, tightening to 3s while any support message is
      still «Переводится…» (BE-166). Paused while document.hidden; an
      immediate refetch on return. No websockets -- behind the fence.

  Bubbles align by sender === my user id; the peer's name falls back to the
  role wording the PARENT supplies (a student sees «Мастер», a master sees
  «Ученик») -- peer may be null when the proxy could not resolve the user.

  BE-163 support conversation: the wrapper passes `support` (the row's
  `channel === 'support'`) and the screen then renders the VELO logo in the
  header, the «Поддержка» caption on peer bubbles (never an admin's name),
  the BE-166 translation states for body-less messages, and sends with an
  Idempotency-Key minted HERE (a failed draft's key rides its retry, so a
  lost answer can never become a twin message).

  FE-108: a support appeal deleted with its spam ticket takes its thread
  along; a delivered notification then lands here and the messages read
  answers 404. That is not a load failure -- the screen becomes «Этой
  переписки больше нет» (chat.goneTitle), with a way back and no retry.
  The same holds for a deletion discovered MID-SESSION by the poll: the
  404 flips the very same flag, the feed and composer give way, and the
  ticks stop (a missed poll is silent, a gone thread is not a miss).
-->

<template>
  <div class="chat-thread">
    <VHeader :title="peerTitle" :logo="support" show-back @back="emit('back')" />

    <!-- Loading (first fetch only; polls refresh silently): bubble skeletons
         settled at the bottom, where the newest messages will land. Once
         seen they stay a visible minimum (useLoadingHold) and the feed then
         fades in where they stood. -->
    <div v-if="feedSkeleton" class="chat-thread__skeleton">
      <VSkeletonBubbles />
    </div>

    <!-- FE-108: the thread is GONE (a support appeal deleted with its spam
         ticket after the retention; the proxy 404s the id -- deliberately,
         "not yours" and "not there" are indistinguishable). Not an error
         with a retry: an honest screen and a way back. -->
    <div v-else-if="gone" class="chat-thread__center">
      <VEmptyState :title="t('chat.goneTitle')" :description="t('chat.goneHint')">
        <template #icon>
          <IconMessages :size="48" />
        </template>
      </VEmptyState>
      <VButton size="sm" @click="emit('back')">{{ t('ui.back') }}</VButton>
    </div>

    <!-- Load failure: the thread may well exist -- offer a retry. -->
    <div v-else-if="error" class="chat-thread__center">
      <VEmptyState :title="t('chat.loadFailed')" :description="error">
        <template #icon>
          <IconMessages :size="48" />
        </template>
      </VEmptyState>
      <VButton size="sm" @click="reload">{{ t('common.retry') }}</VButton>
    </div>

    <template v-else>
      <!-- [FE-4] The fog lives on the WRAPPER, not the scroller: iOS WebKit
           silently skips painting a mask attached to the scroll container's
           own scrolled content (mask + overflow scroll = broken on-device,
           device-proven: computed GRAD yet zero visible clipping, while the
           diary -- identical mask on a NON-scrolling parent's child pattern --
           fades fine). Wrapper masks + inner scroller is the working shape. -->
      <div ref="wrapEl" class="chat-thread__feed-wrap" :class="{ 'velo-reveal': feedReveal }">
        <div
          ref="feedEl"
          class="chat-thread__feed"
          data-testid="chat-feed"
          @scroll="rememberBottomState"
        >
          <!-- Empty thread: an honest invitation, not a fake history. -->
          <div v-if="rows.length === 0" class="chat-thread__empty">
            {{ t('chat.empty') }}
          </div>

          <!-- Optimistic send: an own message shows at once as a "sending"
               bubble (dimmed) keyed by its idempotency key; the server copy
               takes over the SAME key, so the bubble stays one DOM node and
               only brightens -- no flicker, no reorder. A failed one stays
               in place with a retry. -->
          <div
            v-for="row in rows"
            :key="row.key"
            class="chat-thread__row"
            :class="{ 'chat-thread__row--mine': row.mine }"
          >
            <!-- ONE bubble element for both states: delivery only drops the
                 --sending class (an opacity transition on the same node). -->
            <div
              class="chat-thread__bubble"
              :class="{
                'chat-thread__bubble--mine': row.mine,
                'chat-thread__bubble--sending': row.pending?.status === 'sending',
                'chat-thread__bubble--failed': row.pending?.status === 'failed',
              }"
              :data-testid="row.mine ? 'bubble-mine' : 'bubble-peer'"
              :data-state="row.pending?.status"
              :aria-busy="row.pending?.status === 'sending' ? 'true' : undefined"
            >
              <!-- Support threads (BE-163): the caption is the SERVICE, never
                   an admin's name -- `sender` is a technical id, good only
                   for the me/not-me split. -->
              <div
                v-if="support && !row.mine"
                class="chat-thread__sender"
                data-testid="bubble-sender"
              >
                {{ t('chat.supportSender') }}
              </div>
              <div
                class="chat-thread__body"
                :class="{ 'chat-thread__body--state': row.message?.body === null }"
              >
                {{ row.message ? messageText(row.message) : row.pending?.body }}
              </div>
              <button
                v-if="row.pending?.status === 'failed'"
                type="button"
                class="chat-thread__retry"
                data-testid="bubble-retry"
                @click="retry(row.pending)"
              >
                {{ t('chat.notSent') }}
              </button>
              <div v-else class="chat-thread__time">
                <span v-if="row.pending" class="velo-sr-only">{{ t('chat.sending') }}</span>
                {{ formatTime(row.message?.created_at ?? row.pending?.createdAt ?? '') }}
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
      <div class="chat-thread__composer" :class="{ 'velo-reveal': feedReveal }">
        <Composer
          ref="composerRef"
          :placeholder="t('chat.threadPlaceholder')"
          :max-length="4000"
          :send="handleSend"
          :grow-cap="growCap"
          :voice-input="COMPOSER_VOICE_INPUT"
          send-test-id="chat-send"
          @composing-change="composing = $event"
        />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import {
  onDocumentEvent,
  offDocumentEvent,
  isDocumentHidden,
  queryDocument,
  rootStyleValue,
} from '@/platform/dom'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useLoadingHold } from '@/composables/useLoadingHold'
import { useToast } from '@/composables/useToast'
import { VHeader } from '@/components/layout'
import { VEmptyState, VSkeletonBubbles, VButton } from '@/components/ui'
import { IconMessages } from '@/components/icons'
import Composer from './Composer.vue'
import { COMPOSER_VOICE_INPUT } from '@/utils/constants'
import {
  listChatMessages,
  markChatRead,
  sendChatMessage,
  newIdempotencyKey,
  type ChatMessage,
  type ChatPeer,
} from '@/api/chats'
import { useAuthStore } from '@/stores/auth'
import { extractApiError } from '@/composables/useApiError'
import { ApiResponseError } from '@/api/client'
import { useComposerGrowCap } from '@/composables/useComposerGrowCap'

// tz-i18n 2.2b: load-failed/empty states via chat.* / common.retry.

const props = defineProps<{
  threadId: string
  /** P-1 display block; null when the proxy could not resolve the user. */
  peer?: ChatPeer | null
  /** Role-appropriate fallback when peer/name is absent («Мастер»/«Ученик»);
   *  the support thread's wrapper passes «Поддержка {brand}» here. */
  peerFallback: string
  /** BE-163: the thread is the caller's own support conversation -- the
   *  header carries the VELO logo and peer bubbles the «Поддержка» caption. */
  support?: boolean
}>()

const emit = defineEmits<{ back: [] }>()

const POLL_MS = 12_000

/** BE-166: while any support message is still «Переводится…», the feed is
 *  re-read on a short leash until the state resolves (owner ruling 24.10,
 *  variant 1) -- the plain 12s cadence would leave the placeholder hanging
 *  up to a quarter minute past the translated answer. The leash is bounded
 *  (owner brief 25.10): 2 minutes of translating, then back to the plain
 *  cadence; and the whole loop parks while the screen is hidden. */
const TRANSLATING_POLL_MS = 3_000
const TRANSLATING_LEASE_MS = 2 * 60_000

const authStore = useAuthStore()
const myId = computed(() => authStore.user?.id ?? '')

const peerTitle = computed(() => props.peer?.name || props.peerFallback)

const loading = ref(true)
const {
  showSkeleton: feedSkeleton,
  reveal: feedReveal,
  settled: feedSettled,
} = useLoadingHold(loading)
const error = ref<string | null>(null)
/** FE-108: the messages read answered 404 -- the thread is gone (deleted
 *  with its spam ticket, or never the caller's). Terminal: no retry, no poll. */
const gone = ref(false)
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
  const v = parseInt(rootStyleValue(name), 10)
  return Number.isFinite(v) ? v : fallback
}

function measureIsland(): void {
  const island = queryDocument('.mobile-layout__island')
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
  const island = queryDocument('.mobile-layout__island')
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

let pollTimer: ReturnType<typeof setTimeout> | null = null
let disposed = false

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

/** BE-166: a support feed may hold an admin reply the reader must never see
 *  in the original language -- the backend sends `body: null` and the
 *  translation state IS the wording. Own messages and `chat` feeds are
 *  plain strings (body never null there), so this is inert outside support
 *  threads. */
function messageText(m: ChatMessage): string {
  if (m.body !== null) return m.body
  if (m.translation === 'translating') return t('chat.translating')
  if (m.translation === 'unavailable') return t('chat.translationUnavailable')
  return ''
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

/** The page's translation shape -- per message, null-body+state or plain
 *  string. BE-166: a state can flip on the SAME id («Переводится…» lands as
 *  the translated text) without moving newestId or the length, exactly the
 *  drift the id/length compares are blind to. */
function translationShape(list: ChatMessage[]): string {
  return list.map((m) => (m.body === null ? `null:${m.translation ?? '-'}` : 'body')).join(',')
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
    // A skeleton that was seen stays its minimum: the feed mounts only
    // after it, and the scroll needs the mounted feed.
    if (feedSkeleton.value) await feedSettled()
    await scrollToBottom()
    // [owner pass] keep-bottom: the wrap is mounted only now (v-else branch).
    attachKeepBottom()
    // The feed's translation shape is known only now -- re-time the tick
    // (a thread opened straight into «Переводится…» must not wait 12s).
    schedulePoll()
  } catch (e) {
    // FE-108: a 404 is not a failure to load -- the conversation itself is
    // gone (a support appeal deleted with its spam ticket). The «gone»
    // screen replaces the thread; polling stops with it.
    if (e instanceof ApiResponseError && e.status === 404) {
      gone.value = true
      if (pollTimer !== null) clearTimeout(pollTimer)
      pollTimer = null
    } else {
      error.value = extractApiError(e, t('common.tryAgain'))
    }
    loading.value = false
  }
}

/** Self-scheduling poll loop (was a flat 12s interval): the next tick is
 *  TRANSLATING_POLL_MS while any message is still translating and the 2-minute
 *  lease is young, else the plain cadence. Hidden screen -> the loop PARKS
 *  (no timer booked); onVisibility re-kicks it with an immediate poll.
 *  Idempotent -- re-booking clears the pending tick first, so reload()
 *  (which resolves AFTER the mount-time bootstrap booking, and is what
 *  first learns the feed's translation shape) re-times the same single
 *  loop. The chain books the next tick only from the previous tick's
 *  finally -- parallel requests cannot pile up. */
let translatingSince: number | null = null

function schedulePoll(): void {
  if (disposed || gone.value) return
  if (pollTimer !== null) clearTimeout(pollTimer)
  if (isDocumentHidden()) {
    pollTimer = null
    return
  }
  const translating = messages.value.some((m) => m.translation === 'translating')
  let delay = POLL_MS
  if (translating) {
    const now = Date.now()
    if (translatingSince === null) translatingSince = now
    if (now - translatingSince < TRANSLATING_LEASE_MS) delay = TRANSLATING_POLL_MS
  } else {
    translatingSince = null
  }
  pollTimer = setTimeout(() => void poll(), delay)
}

/** Silent poll of the visible thread. Any drift (new tail, an edit-free
 *  world still allows resync/repoint) replaces the local copy; a NEW tail
 *  additionally marks read and -- only when the reader is already at the
 *  bottom (CH-3) -- follows the conversation down. */
async function poll(): Promise<void> {
  try {
    if (isDocumentHidden() || loading.value || gone.value || sendInFlight.value > 0) return
    try {
      const fresh = await fetchMessages()
      const freshNewest = newestId(fresh)
      const hasNew = freshNewest !== null && freshNewest !== newestId(messages.value)
      const changed =
        hasNew ||
        fresh.length !== messages.value.length ||
        translationShape(fresh) !== translationShape(messages.value)
      if (changed) {
        const followDown = hasNew && readerNearBottom()
        messages.value = fresh
        dropDelivered()
        if (hasNew) {
          markRead()
          if (followDown) await scrollToBottom()
        }
      }
    } catch (e) {
      // A missed poll is silent by design; the next tick retries. A 404 is
      // not a miss -- the thread was deleted WHILE OPEN (its spam ticket
      // past the retention): the same honest «gone» screen as on load, not
      // a stale feed with a live composer. schedulePoll (in the finally
      // below) refuses while gone, so the ticks stop here too.
      if (e instanceof ApiResponseError && e.status === 404) gone.value = true
    }
  } finally {
    schedulePoll()
  }
}

function onVisibility(): void {
  if (!isDocumentHidden()) void poll()
}

// (a): the shared Composer owns the draft; this is the persistence callback
// it calls. OPTIMISTIC (owner decision): Composer clears the field at once,
// this screen shows the message as a "sending" bubble right away, and the
// server's copy replaces it under the same row key. A failure leaves the
// bubble in place marked "not sent" with a retry, and Composer puts the text
// back into the field (toasting the error itself).
//
// `sendInFlight` (a counter: a bubble retry may overlap a new send) stops a
// concurrent poll from racing the local append: a poll response that lands
// between "sent" and "appended" would otherwise overwrite `messages.value`
// with a copy that does not yet include the just-sent message.
const sendInFlight = ref(0)

const toast = useToast()
const composerRef = ref<InstanceType<typeof Composer> | null>(null)

interface PendingSend {
  /** BE-163 idempotency key -- also the row key, before and after delivery. */
  key: string
  body: string
  status: 'sending' | 'failed' | 'sent'
  createdAt: string
  /** The server's copy once delivered (status 'sent'). */
  message?: ChatMessage
}

/** Own messages not yet in `messages`, in send order. */
const pendingSends = ref<PendingSend[]>([])
/** Server id -> the client key its bubble was rendered under (stable rows). */
const clientKeyById = new Map<string, string>()

interface FeedRow {
  key: string
  mine: boolean
  message: ChatMessage | null
  pending: PendingSend | null
}

const rows = computed<FeedRow[]>(() => {
  const ids = new Set(messages.value.map((m) => m.id))
  const out: FeedRow[] = messages.value.map((m) => ({
    key: clientKeyById.get(m.id) ?? m.id,
    mine: m.sender === myId.value,
    message: m,
    pending: null,
  }))
  for (const p of pendingSends.value) {
    if (p.message && ids.has(p.message.id)) continue
    // A delivered one waiting behind an earlier unsent one renders as the
    // message it now is, still at its own place in the queue.
    out.push(
      p.message
        ? { key: p.key, mine: true, message: p.message, pending: null }
        : { key: p.key, mine: true, message: null, pending: p },
    )
  }
  return out
})

/** Moves delivered sends into `messages` from the FRONT of the queue only --
 * a later send that lands first never jumps above an earlier one still
 * sending -- and forgets those a poll has already brought in. */
function dropDelivered(): void {
  const ids = new Set(messages.value.map((m) => m.id))
  const queue = pendingSends.value.filter((p) => !(p.message && ids.has(p.message.id)))
  const moved: ChatMessage[] = []
  while (queue[0]?.status === 'sent' && queue[0].message) {
    moved.push(queue[0].message)
    queue.shift()
  }
  if (moved.length) messages.value = [...messages.value, ...moved]
  pendingSends.value = queue
}

/** ComposerSendResult's shape, declared here: type-aware lint cannot see
 * types exported from a .vue file (see router/tabs.ts). */
interface SendOutcome {
  ok: boolean
  error?: string
}

async function deliver(p: PendingSend): Promise<SendOutcome> {
  sendInFlight.value += 1
  try {
    const sent = await sendChatMessage(props.threadId, p.body, p.key)
    clientKeyById.set(sent.id, p.key)
    p.message = sent
    p.status = 'sent'
    dropDelivered()
    await scrollToBottom()
    return { ok: true }
  } catch (e) {
    p.status = 'failed'
    return { ok: false, error: extractApiError(e, t('chat.sendFailed')) }
  } finally {
    sendInFlight.value -= 1
  }
}

/** BE-163: the idempotency key is chosen HERE, per logical message -- the
 *  key of a FAILED attempt is kept and reused when the same text is sent
 *  again (from the field or the bubble's retry), so a request that created
 *  the message before its answer was lost returns it instead of posting a
 *  twin. A different (edited) text gets a fresh key. */
function handleSend(body: string): Promise<SendOutcome> {
  const failed = pendingSends.value.find((p) => p.status === 'failed' && p.body === body)
  if (failed) {
    failed.status = 'sending'
    return deliver(failed)
  }
  pendingSends.value = [
    ...pendingSends.value,
    { key: newIdempotencyKey(), body, status: 'sending', createdAt: new Date().toISOString() },
  ]
  void scrollToBottom()
  const p = pendingSends.value[pendingSends.value.length - 1]
  return p ? deliver(p) : Promise.resolve({ ok: false })
}

/** The failed bubble's retry: same key, same place. Success also clears the
 * field if Composer had put this very text back into it. */
async function retry(p: PendingSend): Promise<void> {
  if (p.status !== 'failed') return
  p.status = 'sending'
  const result = await deliver(p)
  if (result.ok) composerRef.value?.discardDraft(p.body)
  else toast.error(result.error ?? t('chat.sendFailed'))
}

onMounted(() => {
  void reload()
  schedulePoll()
  onDocumentEvent('visibilitychange', onVisibility)
})

onBeforeUnmount(() => {
  disposed = true
  if (pollTimer !== null) clearTimeout(pollTimer)
  offDocumentEvent('visibilitychange', onVisibility)
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
  /* Same value as the 100% above, as an INTERPOLABLE px calc -- see the
     twin comment in DiaryFeedView.vue (FE-44 close transition). */
  height: calc(var(--velo-frozen-vh, 100%) - var(--velo-content-safe-top, 0px));
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* [FE-44] Same correction as DiaryFeedView's: the live-height binding is
   keyboard-ONLY. This screen copied the diary formula verbatim (B39), so it
   inherited the same staleness defect -- a missed close-resize left the chat
   capped at the keyboard-open height. The class gate makes the at-rest
   height structural (100% of the frozen ancestor). */
:global(html.is-keyboard-open) .chat-thread {
  height: calc(var(--velo-vvh, 100%) - var(--velo-content-safe-top, 0px));
}

/* [FE-44] Close expands at the keyboard's own speed (twin of the global.css
   rule + DiaryFeedView's own). */
:global(html.is-keyboard-closing) .chat-thread {
  height: calc(var(--velo-frozen-vh, 100%) - var(--velo-content-safe-top, 0px));
  transition: height 250ms cubic-bezier(0.22, 0.61, 0.36, 1);
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

/* Same box as the feed it gives way to: bottom-aligned, same paddings. */
.chat-thread__skeleton {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  padding: var(--chat-fog-live, var(--velo-chat-fog-top, 96px))
    var(--velo-rail-pad-x, var(--space-4)) var(--space-3);
  overflow: hidden;
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
    var(--velo-fog-color) calc(var(--chat-fog-hard) + var(--chat-fog-fade)),
    var(--velo-fog-color) calc(100% - 24px),
    transparent 100%
  );
  mask-image: linear-gradient(
    to bottom,
    transparent 0,
    transparent var(--chat-fog-hard),
    var(--velo-fog-color) calc(var(--chat-fog-hard) + var(--chat-fog-fade)),
    var(--velo-fog-color) calc(100% - 24px),
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
  color: var(--velo-white);
  /* sending -> sent brightens in place (same node, see the template). */
  transition: opacity var(--velo-dur-base) var(--velo-ease-out);
}

/* Optimistic send: on its way -- quietly dimmed, nothing else changes, so
   delivery is a pure opacity change (no reflow, no jump). */
.chat-thread__bubble--sending {
  opacity: 0.6;
}

.chat-thread__bubble--failed {
  opacity: 0.85;
}

.chat-thread__retry {
  display: block;
  margin: var(--space-1) 0 0 auto;
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  font-size: var(--velo-fs-11);
  text-decoration: underline;
  cursor: pointer;
}

.chat-thread__body {
  white-space: pre-wrap;
}

/* Support threads (BE-163): the «Поддержка» caption above the body -- the
   service, never an admin's name. */
.chat-thread__sender {
  font-size: var(--velo-fs-11);
  font-weight: 600;
  opacity: 0.65;
  margin-bottom: var(--space-1);
}

/* BE-166 placeholder («Переводится…» / «Перевод недоступен»): not the
   sender's words -- visibly provisional. */
.chat-thread__body--state {
  font-style: italic;
  opacity: 0.7;
}

.chat-thread__time {
  margin-top: var(--space-1);
  font-size: var(--velo-fs-11);
  opacity: 0.6;
  text-align: right;
}

.chat-thread__composer {
  flex: 0 0 auto;
  padding: var(--space-2) var(--velo-rail-pad-x, var(--space-4)) var(--space-3);
}
</style>
