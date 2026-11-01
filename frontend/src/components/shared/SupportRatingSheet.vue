<!--
  VELO Frontend -- SupportRatingSheet (FE-107 / BE-162 delivery 3)

  «Как мы помогли?» -- the rating sheet of the person's RESOLVED support
  ticket: 1..5 stars and, if they like, a comment (up to 1000 characters).
  One rating per ticket; the notification's button, the bell row and the
  Telegram deep link (`open_support_rating__<id>`) all land on the chat with
  ?rate=1, and the wrappers hand THAT ticket in as `preferredTicketId`.

  SELF-CONTAINED on purpose: the wrappers (UserChatView / MasterChatView)
  only say WHEN it may run (`active` -- the opened thread is the support
  row) and WHICH ticket the deep link named. Everything else is here:
    - the queue: GET /api/v1/support/ratings/pending -- «Решена» without a
      rating, newest resolution first; a ticket the person reopened with a
      message is not waiting and will be asked again once re-resolved;
    - the sheet opens on the deep-linked ticket when it is still waiting,
      else (no deep link) on the newest waiting one. A deep link to a ticket
      that no longer waits (rated on another device, reopened) opens
      NOTHING: the person came for that ticket's conversation;
    - a submitted rating advances to the next waiting ticket; «Позже»
      (or the scrim) stops asking for this visit -- the sheet returns when
      the screen is opened again and something still waits.

  LOOK IS A PLACEHOLDER (the ticket's own words: the вид всплывашки is a
  design task): functional, on the existing components and --velo-* tokens.
  Until the mockup arrives, only behaviour is contractual here.
-->

<template>
  <VBottomSheet
    :open="open"
    :title="t('chat.rating.title')"
    compact-title
    :save-label="t('chat.rating.submit')"
    :save-disabled="stars === null || sending"
    :cancel-label="t('chat.rating.later')"
    @save="onSubmit"
    @close="onLater"
  >
    <div class="rating-sheet">
      <p v-if="current" class="rating-sheet__topic">
        {{ t('chat.rating.topicLine', { topic: supportTopicLabel(current.topic) }) }}
      </p>

      <div class="rating-sheet__stars" role="radiogroup" :aria-label="t('chat.rating.starsAria')">
        <button
          v-for="n in STAR_VALUES"
          :key="n"
          type="button"
          class="rating-sheet__star"
          :class="{ 'rating-sheet__star--on': stars !== null && n <= stars }"
          role="radio"
          :aria-checked="stars === n"
          :aria-label="t('chat.rating.starAria', { stars: n })"
          :disabled="sending"
          :data-testid="`rating-star-${n}`"
          @click="stars = n"
        >
          <IconStar :size="32" :filled="stars !== null && n <= stars" />
        </button>
      </div>

      <VTextarea
        v-model="comment"
        class="rating-sheet__comment"
        :placeholder="t('chat.rating.commentPlaceholder')"
        :rows="2"
        autogrow
        maxlength="1000"
        :disabled="sending"
      />
    </div>
  </VBottomSheet>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { ref, watch } from 'vue'
import { VBottomSheet, VTextarea } from '@/components/ui'
import { IconStar } from '@/components/icons'
import { useToast } from '@/composables/useToast'
import { ApiResponseError } from '@/api/client'
import { extractApiError } from '@/composables/useApiError'
import { listPendingRatings, rateTicket, type PendingRatingTicket } from '@/api/support'
import { supportTopicLabel } from '@/utils/supportTopics'

const props = defineProps<{
  /** True once the opened thread is known to be the caller's support row --
   *  the sheet's fetch runs only then. */
  active: boolean
  /** The ticket the bell row / Telegram deep link named (`?rate=1`: the
   *  route's own id), or null when the chat was opened on its own. */
  preferredTicketId?: string | null
}>()

const STAR_VALUES = [1, 2, 3, 4, 5] as const

const toast = useToast()

const queue = ref<PendingRatingTicket[]>([])
const current = ref<PendingRatingTicket | null>(null)
const open = ref(false)
const stars = ref<number | null>(null)
const comment = ref('')
const sending = ref(false)

// One ask per screen visit: once dismissed, the queue stays but the sheet
// does not reopen here -- it asks again the next time the screen opens.
let dismissed = false

watch(
  () => props.active,
  (isActive) => {
    if (isActive) void loadQueue()
  },
  { immediate: true },
)

async function loadQueue(): Promise<void> {
  let waiting: PendingRatingTicket[]
  try {
    waiting = (await listPendingRatings()).tickets
  } catch {
    // The conversation must not pay for the ask: a failed read is silent.
    return
  }
  queue.value = waiting
  if (dismissed || waiting.length === 0) return
  const preferred = props.preferredTicketId
  // A deep link names ITS ticket. No longer waiting -- rated already or
  // reopened -- the sheet stays closed; the chat behind it is the answer.
  const first = preferred ? waiting.find((tk) => tk.id === preferred) : waiting[0]
  if (first) show(first)
}

function show(ticket: PendingRatingTicket): void {
  current.value = ticket
  stars.value = null
  comment.value = ''
  open.value = true
}

/** The ticket just asked about leaves the queue: rated, or no longer
 *  waiting (a 409 -- reopened or rated elsewhere; a 404 -- the ticket is
 *  gone, the spam bin's retention emptied it) -- either way it must not be
 *  asked again here. */
function dropCurrent(): void {
  queue.value = queue.value.filter((tk) => tk.id !== current.value?.id)
}

function advance(): void {
  const next = queue.value[0] ?? null
  if (next) show(next)
  else open.value = false
}

async function onSubmit(): Promise<void> {
  const ticket = current.value
  if (!ticket || stars.value === null || sending.value) return
  sending.value = true
  try {
    await rateTicket(ticket.id, stars.value, comment.value)
    toast.success(t('chat.rating.thanks'))
    dropCurrent()
    advance()
  } catch (e) {
    if (e instanceof ApiResponseError && (e.status === 409 || e.status === 404)) {
      // Unanswerable, each in its own way: 409 -- not «Решена» any more or
      // rated on another device; 404 -- not the caller's ticket any more
      // (deleted past the spam retention). The ask is closed either way:
      // move on to what still waits.
      dropCurrent()
      advance()
    } else {
      toast.error(extractApiError(e, t('chat.rating.sendFailed')))
    }
  } finally {
    sending.value = false
  }
}

function onLater(): void {
  // A tap in flight lands nowhere: while the rating is being sent the sheet
  // is not dismissable (the scrim, Escape and «Позже» all come through
  // here) -- a dismissal mid-flight would race the answer's advance().
  if (sending.value) return
  dismissed = true
  open.value = false
}
</script>

<style scoped>
.rating-sheet {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.rating-sheet__topic {
  margin: 0;
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
}

.rating-sheet__stars {
  display: flex;
  justify-content: center;
  gap: var(--space-2);
}

.rating-sheet__star {
  display: inline-flex;
  padding: var(--space-1);
  border: none;
  background: none;
  color: var(--velo-text-muted);
  cursor: pointer;
  transition: color var(--transition-fast);
}

/* Filled stars keep the analytics "fire" tone of the 1..10 scale's best
   zone -- the one warm star colour the tokens already own. */
.rating-sheet__star--on {
  color: var(--velo-peach-500);
}

.rating-sheet__star:disabled {
  opacity: 0.6;
  cursor: default;
}

.rating-sheet__comment {
  width: 100%;
}
</style>
