<!--
  VELO Frontend -- AdminSupportDetailView (B34, PROMPT №713; tickets since FE-100)

  One support TICKET (BE-162): its status, the claim, the feed and the reply,
  and -- read-only -- the person's conversation from before tickets. Page shell
  reused from AdminReportDetailView (VHeader + content sections, plain page
  scroll; the status buttons and the «already processed» card follow its
  action section). The bubbles/composer visual language is copied from
  ChatThreadScreen.vue's markup+CSS WITHOUT reusing that component: it is
  hardwired to api/chats.ts, a different backend contract.

  THE TICKET comes from the list's state hand-off; without it -- a deep link
  (`open_admin_support__<id>`, BE-172), a reload -- and whenever it must be
  read again (a 409 on the status, after a claim) it is ONE read: GET
  /api/v1/support/tickets/{id}, the same row as in the list, spam included.
  404 is the not-found screen.

  STATUS: an OPEN ticket offers the four closing statuses to ANY admin (the
  backend asks no claim for it); any other status shows itself. A 409 means
  the ticket is no longer open or changed meanwhile (a person's message bumps
  it): a toast and a fresh read -- if it is still open, the admin may retry.

  CLAIM IS WRITE-AUTHZ, MADE LEGIBLE. comms admits only the thread's client or
  its ASSIGNEE to post; an admin who has not claimed gets comms' own 403 on a
  reply. So the composer shows only to the admin in `claimed_by`; everybody
  else sees a notice, and the claim button
  (i18n:adminScreens.adminSupportDetail.take) while nobody holds it. A ticket
  held by another admin is a 409 on the claim; after any claim answer the
  ticket is read again, so `claimed_by` is always the server's.

  THE HANDOVER (FE-108, BE-162 delivery 2) lives in the same ⋯ menu as the
  statuses: assign (i18n:adminScreens.adminSupportDetail.menu.assign; a
  roster of admins -- the admin users list, myself not offered), release
  (i18n:adminScreens.adminSupportDetail.menu.release; a held ticket), reopen
  (i18n:adminScreens.adminSupportDetail.menu.reopen; a closed ticket) and
  not-spam (i18n:adminScreens.adminSupportDetail.menu.notSpam; spam inside
  the 30-day retention). All three routes
  answer the ticket's FULL row, so their answers replace the card outright.
  A 409 means the ticket moved on meanwhile: a toast and a fresh read; a 404
  on reopen means the spam bin emptied it: the not-found screen. The card only
  ever holds a ticket (a history thread id 404s at the one-ticket read), so
  the routes' "on a history thread" 409s are a backend backstop, not a state
  this screen can reach.

  POLLING: bounded, and only while a message is in flight. While a message
  (or a history message) is still being translated, the feeds are re-read
  every POLL_MS, at most POLL_LIMIT times per cycle; it stops when nothing is
  in flight or the screen is left. Otherwise there is no polling -- a manual
  refresh (i18n:adminScreens.adminSupportDetail.refresh) covers it.

  DELIBERATELY NOT BUILT (scope trim, stated not silent): unbounded polling
  like ChatThreadScreen has; mark-read for admins.
-->

<template>
  <div class="support-detail">
    <VHeader :title="headerTitle" show-back @back="router.back()">
      <template v-if="menuActions.length" #action>
        <button
          type="button"
          class="support-detail__menu"
          :aria-label="t('adminScreens.adminSupportDetail.menu.aria')"
          @click="menuOpen = true"
        >
          <IconDots :size="20" />
        </button>
      </template>
    </VHeader>

    <div class="support-detail__content">
      <div v-if="loadingTicket" class="support-detail__loader">
        <VLoader size="lg" />
      </div>

      <VEmptyState
        v-else-if="ticketError"
        icon="warning"
        :title="t('common.loadError')"
        :description="ticketError"
      >
        <VButton size="sm" variant="outline" @click="fetchTicket">{{ t('common.retry') }}</VButton>
      </VEmptyState>

      <template v-else-if="ticket">
        <div class="support-detail__header">
          <VBadge :variant="supportStatusBadge(ticket.status)">
            {{ supportStatusLabel(ticket.status) }}
          </VBadge>
          <span class="support-detail__topic">{{ supportTopicLabel(ticket.topic) }}</span>
          <!-- FE-107: who moved it to resolved
               (i18n:adminScreens.adminSupport.statuses.resolved) last -- the
               admin the rating (when one comes) is most likely about. -->
          <span
            v-if="ticket.status === 'resolved' && ticket.resolved_by"
            class="support-detail__resolved-by"
          >
            {{ resolvedByName }}
          </span>
        </div>

        <!-- Status: an open ticket's actions live in the ⋯ menu (header). -->
        <VCard v-if="ticket.status !== 'open'" class="support-detail__processed">
          {{ t('adminScreens.adminSupportDetail.currentStatus') }}
          <strong>{{ supportStatusLabel(ticket.status) }}</strong>
        </VCard>

        <!-- FE-107: the person's rating of this ticket -- the stars, the
             comment AS WRITTEN (the backend does not translate it; BE-175
             will), the language the comment is most likely in, when, and
             the admin whose resolution it rated. -->
        <VCard v-if="ticket.rating" class="support-detail__rating" data-testid="ticket-rating">
          <div class="support-detail__rating-stars">
            <IconStar
              v-for="n in STAR_VALUES"
              :key="n"
              :size="22"
              :filled="n <= ticket.rating.stars"
              :class="{ 'support-detail__star--on': n <= ticket.rating.stars }"
            />
          </div>
          <p v-if="ticket.rating.comment" class="support-detail__rating-comment">
            {{ ticket.rating.comment }}
          </p>
          <div class="support-detail__rating-meta">
            <span v-if="ticket.rating.comment && ticket.rating.comment_locale">
              {{
                t('adminScreens.adminSupport.rating.commentIn', {
                  language: localeName(ticket.rating.comment_locale),
                })
              }}
            </span>
            <span v-if="ratingResolverName">
              {{
                t('adminScreens.adminSupport.rating.aboutResolver', { name: ratingResolverName })
              }}
            </span>
          </div>
        </VCard>

        <!-- Claim notice: shown whenever the caller is NOT the taker, so
             "why can't I type" is answered before it is asked. -->
        <div v-if="!canReply" class="support-detail__claim-panel">
          <p class="support-detail__claim-text">{{ claimPanelText }}</p>
          <VButton
            v-if="!ticket.claimed_by"
            variant="primary"
            size="sm"
            :loading="claiming"
            @click="onClaim"
          >
            {{ t('adminScreens.adminSupportDetail.take') }}
          </VButton>
        </div>

        <!-- Feed -->
        <div v-if="loadingMessages" class="support-detail__loader">
          <VLoader size="lg" />
        </div>
        <VEmptyState
          v-else-if="messagesError"
          icon="warning"
          :title="t('adminScreens.adminSupportDetail.messagesLoadFailed')"
          :description="messagesError"
        >
          <VButton size="sm" variant="outline" @click="loadMessages">{{
            t('common.retry')
          }}</VButton>
        </VEmptyState>
        <template v-else>
          <div class="support-detail__feed">
            <div v-if="messages.length === 0" class="support-detail__empty">
              {{ t('adminScreens.adminSupportDetail.noMessages') }}
            </div>
            <SupportMessageBubble
              v-for="m in messages"
              :key="m.id"
              :message="m"
              :from-person="isPerson(m)"
              :mine="m.sender === myId"
              :show-original="originalShown.has(m.id)"
              :retrying="retrying.has(m.id)"
              :time="formatTime(m.created_at)"
              @toggle="toggleOriginal(m.id)"
              @retry="onRetry(ticketId, m.id)"
            />
            <button type="button" class="support-detail__refresh" @click="loadMessages">
              {{ t('adminScreens.adminSupportDetail.refresh') }}
            </button>
          </div>

          <!-- Composer: only when the caller may actually post. -->
          <div v-if="canReply" class="support-detail__composer">
            <div class="support-detail__input">
              <VTextarea
                v-model="draft"
                :placeholder="t('adminScreens.adminSupportDetail.reply')"
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
              @click="onSend"
            >
              {{ t('common.submitSend') }}
            </VButton>
          </div>
        </template>

        <!-- The person's conversation before tickets: read-only, on demand. -->
        <template v-if="ticket.history_thread_id">
          <VButton
            v-if="!historyShown"
            variant="outline"
            block
            class="support-detail__history-open"
            @click="loadHistory"
          >
            {{ t('adminScreens.adminSupportDetail.history.show') }}
          </VButton>
          <div v-else class="support-detail__section">
            <div class="support-detail__section-title">
              {{ t('adminScreens.adminSupportDetail.history.title') }}
            </div>
            <div v-if="loadingHistory" class="support-detail__loader">
              <VLoader size="lg" />
            </div>
            <VEmptyState
              v-else-if="historyError"
              icon="warning"
              :title="t('adminScreens.adminSupportDetail.messagesLoadFailed')"
              :description="historyError"
            >
              <VButton size="sm" variant="outline" @click="loadHistory">{{
                t('common.retry')
              }}</VButton>
            </VEmptyState>
            <div v-else class="support-detail__feed">
              <div v-if="historyMessages.length === 0" class="support-detail__empty">
                {{ t('adminScreens.adminSupportDetail.noMessages') }}
              </div>
              <SupportMessageBubble
                v-for="m in historyMessages"
                :key="m.id"
                :message="m"
                :from-person="isPerson(m)"
                :mine="m.sender === myId"
                :show-original="originalShown.has(m.id)"
                :retrying="retrying.has(m.id)"
                :time="formatTime(m.created_at)"
                @toggle="toggleOriginal(m.id)"
                @retry="onRetry(historyThreadId, m.id)"
              />
            </div>
          </div>
        </template>
      </template>

      <div v-else class="support-detail__not-found">
        <VEmptyState
          icon="notfound"
          :title="t('adminScreens.adminSupportDetail.notFoundTitle')"
          :description="t('adminScreens.adminSupportDetail.backToList')"
        />
        <VButton variant="outline" block @click="router.back()">{{ t('ui.back') }}</VButton>
      </div>
    </div>

    <!-- The ⋯ menu: rows from TICKET_ACTIONS (one entry per action). -->
    <VBottomSheet
      :open="menuOpen"
      :title="t('adminScreens.adminSupportDetail.menu.title')"
      compact-title
      @close="menuOpen = false"
    >
      <div class="support-detail__menu-rows">
        <VMenuRow
          v-for="action in menuActions"
          :key="action.key"
          :label="action.label()"
          :show-arrow="false"
          @click="runAction(action)"
        />
      </div>
    </VBottomSheet>

    <!-- Assign (i18n:adminScreens.adminSupportDetail.menu.assign): the admin
         roster (FE-108). Read fresh on every open --
         the roster is one small GET, and a stale handover target is a 422. -->
    <VBottomSheet
      :open="assignOpen"
      :title="t('adminScreens.adminSupportDetail.menu.assignTitle')"
      compact-title
      @close="assignOpen = false"
    >
      <div class="support-detail__assign">
        <div v-if="loadingAdmins" class="support-detail__loader">
          <VLoader size="lg" />
        </div>
        <VEmptyState
          v-else-if="adminsError"
          icon="warning"
          :title="t('adminScreens.adminSupportDetail.menu.assignLoadFailed')"
          :description="adminsError"
        >
          <VButton size="sm" variant="outline" @click="loadAdmins">{{ t('common.retry') }}</VButton>
        </VEmptyState>
        <div v-else-if="admins.length === 0" class="support-detail__empty">
          {{ t('adminScreens.adminSupportDetail.menu.assignEmpty') }}
        </div>
        <div v-else class="support-detail__menu-rows">
          <VMenuRow
            v-for="admin in admins"
            :key="admin.id"
            :label="admin.name"
            :show-arrow="false"
            @click="onAssign(admin)"
          />
        </div>
      </div>
    </VBottomSheet>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { ref, computed, nextTick, onMounted, onBeforeUnmount, watch, type Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { routeParam } from '@/router/routeParam'
import { useQuery, useQueryCache } from '@pinia/colada'
import { VHeader } from '@/components/layout'
import {
  VBadge,
  VBottomSheet,
  VButton,
  VCard,
  VMenuRow,
  VTextarea,
  VEmptyState,
  VLoader,
} from '@/components/ui'
import { IconDots, IconStar } from '@/components/icons'
import SupportMessageBubble from '@/components/admin/SupportMessageBubble.vue'
import { useToast } from '@/composables/useToast'
import { useViewerTimezone } from '@/composables/useViewerTimezone'
import { formatTime as formatClockTime } from '@/utils/format'
import { useAuthStore } from '@/stores/auth'
import { ApiResponseError } from '@/api/client'
import {
  SUPPORT_CLOSING_STATUSES,
  assignTicket,
  claimSupportThread,
  releaseTicket,
  reopenTicket,
  retrySupportTranslation,
  sendAdminSupportReply,
  setTicketStatus,
  spamWithinRetention,
  type AdminSupportTicket,
  type SupportClosingStatus,
  type SupportMessage,
  type SupportTicketStatus,
} from '@/api/support'
import type { UserResponse } from '@/api/admin'
import {
  adminAdminsQuery,
  adminSupportMessagesQuery,
  adminSupportTicketQuery,
  hasSupportTicket,
  onFailedRequest,
  setSupportTicket,
  updateSupportFeed,
  useAdminMutation,
} from '@/composables/queries/admin'
import { extractApiError } from '@/composables/useApiError'
import { supportStatusBadge, supportStatusLabel, supportTopicLabel } from '@/utils/supportTopics'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const authStore = useAuthStore()

const ticketId = routeParam(route, 'id')
const myId = computed(() => authStore.user?.id ?? '')

const queryCache = useQueryCache()

// -- The ticket (Pinia Colada, composables/queries/admin.ts) --
// The list hands its row via router state: written into the ticket's entry,
// so the card paints at once and no request leaves. A deep link reads the
// ticket. A 404 -- that read, a later one, a reopen -- is the not-found
// screen; any other failure with nothing shown is the error rung.
const handedTicket = (history.state as { ticket?: AdminSupportTicket } | null)?.ticket
// Only into an empty entry: a held one may be newer than the list's row (a
// decision made here a moment ago, the list's refetch still on its way).
if (handedTicket && handedTicket.id === ticketId && !hasSupportTicket(queryCache, ticketId))
  setSupportTicket(queryCache, handedTicket)
const ticketQuery = useQuery(() => adminSupportTicketQuery(ticketId))
/** A reopen answered 404: the spam bin emptied the ticket. */
const gone = ref(false)
const ticketSettledError = computed(() =>
  ticketQuery.asyncStatus.value === 'idle' ? ticketQuery.error.value : null,
)
/** The ticket answered 404: the not-found screen shows, so the feed behind
 *  it must not keep polling (the feed loads in parallel and may still have
 *  translations in flight). */
const ticketMissing = computed(() => gone.value || isStatus(ticketSettledError.value, 404))
const ticket = computed<AdminSupportTicket | null>(() =>
  ticketMissing.value ? null : (ticketQuery.data.value ?? null),
)
const loadingTicket = computed(
  () =>
    !ticketMissing.value &&
    ticketQuery.data.value === undefined &&
    ticketSettledError.value == null,
)
const ticketError = computed<string | null>(() =>
  !ticketMissing.value && ticketQuery.data.value === undefined && ticketSettledError.value != null
    ? extractApiError(
        ticketSettledError.value,
        t('adminScreens.adminSupportDetail.ticketLoadError'),
      )
    : null,
)

// -- The feeds: the ticket's thread and, on demand, the person's history --
// With nothing shown yet, a read shows the loader and, failed, the error
// rung. Over a shown feed only a read the screen asks for itself (the
// refresh button, a retry) is "loud" and takes the feed's place; every other
// read keeps the feed and the composer (and its draft) on screen. The
// translation polling's reads are quiet: a failed one waits for the next
// poll. Colada's own (a return to the app) are told once when they fail
// (onFailedRequest).
interface FeedQuery {
  data: Readonly<Ref<SupportMessage[] | undefined>>
  error: Readonly<Ref<unknown>>
  asyncStatus: Readonly<Ref<'idle' | 'loading'>>
}

function feedState(query: FeedQuery, shown: () => boolean) {
  const loud = ref(false)
  const loudFailed = ref(false)
  let quiet = false
  onFailedRequest(query, (e) => {
    // Runs before the reads' own continuations: a loud read is its rung's,
    // a quiet one the next poll's.
    if (!loud.value && !quiet && query.data.value !== undefined)
      toast.error(extractApiError(e, t('adminScreens.adminSupportDetail.messagesLoadFailed')))
  })
  return {
    loading: computed(
      () =>
        shown() &&
        query.asyncStatus.value === 'loading' &&
        (query.data.value === undefined || loud.value),
    ),
    error: computed<string | null>(() => {
      const e = query.error.value
      return shown() &&
        e != null &&
        query.asyncStatus.value === 'idle' &&
        (query.data.value === undefined || loudFailed.value)
        ? extractApiError(e, t('adminScreens.adminSupportDetail.tryAgain'))
        : null
    }),
    /** Run a read of the polling, quietly. */
    async readQuietly(read: () => Promise<unknown>): Promise<void> {
      quiet = true
      try {
        await read()
      } finally {
        quiet = false
      }
    },
    /** Run a read the screen asks for itself, loudly. */
    async readLoudly(read: () => Promise<{ status: string }>): Promise<boolean> {
      loud.value = true
      try {
        const state = await read()
        loudFailed.value = state.status === 'error'
        return state.status === 'success'
      } finally {
        loud.value = false
      }
    },
  }
}

const messagesQuery = useQuery(() =>
  adminSupportMessagesQuery({ threadId: ticketId, enabled: true }),
)
const messages = computed<SupportMessage[]>(() => messagesQuery.data.value ?? [])
const messagesFeed = feedState(messagesQuery, () => true)
const loadingMessages = messagesFeed.loading
const messagesError = messagesFeed.error

const draft = ref('')
const sending = ref(false)
const claiming = ref(false)
const changingTo = ref<SupportClosingStatus | null>(null)
const releasing = ref(false)
const reopening = ref(false)

const menuOpen = ref(false)
const originalShown = ref<ReadonlySet<string>>(new Set())
const retrying = ref<ReadonlySet<string>>(new Set())

const historyShown = ref(false)
const historyQuery = useQuery(() =>
  adminSupportMessagesQuery({
    threadId: ticket.value?.history_thread_id ?? '',
    enabled: historyShown.value && !!ticket.value?.history_thread_id,
  }),
)
const historyMessages = computed<SupportMessage[]>(() =>
  historyShown.value ? (historyQuery.data.value ?? []) : [],
)
const historyFeed = feedState(historyQuery, () => historyShown.value)
const loadingHistory = historyFeed.loading
const historyError = historyFeed.error

const headerTitle = computed(
  () => ticket.value?.opener?.name ?? t('adminScreens.adminSupportDetail.threadFallback'),
)
const canReply = computed(() => !!myId.value && ticket.value?.claimed_by?.user_id === myId.value)

const claimPanelText = computed(() =>
  ticket.value?.claimed_by
    ? t('adminScreens.adminSupportDetail.claimedByOtherHint')
    : t('adminScreens.adminSupportDetail.unclaimedHint'),
)

const historyThreadId = computed(() => ticket.value?.history_thread_id ?? '')

/** The rating's five stars, one row value at a time. */
const STAR_VALUES = [1, 2, 3, 4, 5] as const

/** Who moved the ticket to resolved
 *  (i18n:adminScreens.adminSupport.statuses.resolved) last, by name (the
 *  fallback names an admin the row could not name). */
const resolvedByName = computed(() =>
  ticket.value?.resolved_by
    ? t('adminScreens.adminSupportDetail.resolvedBy', {
        name:
          ticket.value.resolved_by.name ?? t('adminScreens.adminSupport.claimedBy.adminFallback'),
      })
    : '',
)

/** The admin whose resolution the rating named (kept at rating time -- a
 *  later reopen and another admin's resolution do not move it). */
const ratingResolverName = computed(() => {
  const resolver = ticket.value?.rating?.rated_resolver
  if (!resolver) return ''
  return resolver.name ?? t('adminScreens.adminSupport.claimedBy.adminFallback')
})

/** The comment's likely language, signed for the admin (owner's example:
 *  i18n:adminScreens.adminSupport.rating.locales.ru). An unknown code shows
 *  itself -- honest, never wrong. t() is called with the template literal
 *  INLINE so the key audit sees the dynamic prefix (scripts/key-audit.mjs). */
function localeName(code: string): string {
  const label = t(`adminScreens.adminSupport.rating.locales.${code}`)
  return label === `adminScreens.adminSupport.rating.locales.${code}` ? code : label
}

/** A message of the person the ticket is about (not of support). */
function isPerson(m: SupportMessage): boolean {
  return !!ticket.value?.opener && m.sender === ticket.value.opener.user_id
}

// -- The ⋯ menu ---------------------------------------------------------------
// ONE ENTRY PER ACTION (owner ruling FE-100): the four closing statuses,
// then the handover of BE-162 delivery 2 (FE-108) -- assign
// (i18n:adminScreens.adminSupportDetail.menu.assign), release
// (i18n:adminScreens.adminSupportDetail.menu.release), reopen
// (i18n:adminScreens.adminSupportDetail.menu.reopen), not-spam
// (i18n:adminScreens.adminSupportDetail.menu.notSpam) -- each its own entry,
// nothing else changes. The button shows only while some entry applies.
interface TicketMenuAction {
  key: string
  label: () => string
  visible: (ticket: AdminSupportTicket) => boolean
  run: () => Promise<void>
}

/** A closed-but-not-spam ticket: reopen (i18n:adminScreens.adminSupportDetail.menu.reopen) reopens it. */
const REOPENABLE_STATUSES: readonly SupportTicketStatus[] = ['resolved', 'rejected', 'duplicate']

const TICKET_ACTIONS: readonly TicketMenuAction[] = [
  // Assign (i18n:adminScreens.adminSupportDetail.menu.assign) -- always, on a
  // ticket. A history thread never reaches the
  // card (its id 404s at the one-ticket read), so the "except history threads"
  // rule holds by construction; the route's 409 is the backend backstop.
  {
    key: 'assign',
    label: () => t('adminScreens.adminSupportDetail.menu.assign'),
    visible: () => true,
    run: () => openAssignSheet(),
  },
  {
    key: 'release',
    label: () => t('adminScreens.adminSupportDetail.menu.release'),
    visible: (tk) => tk.claimed_by !== null,
    run: () => onRelease(),
  },
  ...SUPPORT_CLOSING_STATUSES.map<TicketMenuAction>((status) => ({
    key: status,
    label: () => supportStatusLabel(status),
    visible: (tk) => tk.status === 'open',
    run: () => onSetStatus(status),
  })),
  {
    key: 'reopen',
    label: () => t('adminScreens.adminSupportDetail.menu.reopen'),
    visible: (tk) => REOPENABLE_STATUSES.includes(tk.status),
    run: () => onReopen(),
  },
  // Not-spam (i18n:adminScreens.adminSupportDetail.menu.notSpam) is the same
  // reopen route, offered only while the verdict is
  // inside the retention (past it the bin deletes the ticket with its
  // conversation -- the route would 404/409 anyway).
  {
    key: 'not-spam',
    label: () => t('adminScreens.adminSupportDetail.menu.notSpam'),
    visible: (tk) => tk.status === 'spam' && spamWithinRetention(tk.status_changed_at),
    run: () => onReopen(),
  },
]

const menuActions = computed<TicketMenuAction[]>(() => {
  const tk = ticket.value
  return tk ? TICKET_ACTIONS.filter((a) => a.visible(tk)) : []
})

function runAction(action: TicketMenuAction): void {
  menuOpen.value = false
  void action.run()
}

// -- Assign (i18n:adminScreens.adminSupportDetail.menu.assign): the roster and the handover (FE-108) --------

interface AdminOption {
  id: string
  name: string
}

const assignOpen = ref(false)
const assigning = ref(false)
// Read each time the sheet opens (staleTime 0); a held roster shows meanwhile.
const adminsQuery = useQuery(() => adminAdminsQuery(assignOpen.value))
const admins = computed<readonly AdminOption[]>(() =>
  (adminsQuery.data.value ?? [])
    .filter((u) => u.id !== myId.value)
    .map((u) => ({ id: u.id, name: adminName(u) })),
)
const loadingAdmins = computed(
  () => adminsQuery.asyncStatus.value === 'loading' && adminsQuery.data.value === undefined,
)
const adminsError = computed<string | null>(() =>
  adminsQuery.data.value === undefined &&
  adminsQuery.error.value != null &&
  adminsQuery.asyncStatus.value === 'idle'
    ? extractApiError(
        adminsQuery.error.value,
        t('adminScreens.adminSupportDetail.menu.assignLoadFailed'),
      )
    : null,
)

// A failed read over a roster already shown (a return, a 422 re-read) is
// told; the roster stays for a pick.
onFailedRequest(adminsQuery, (e) => {
  if (adminsQuery.data.value !== undefined)
    toast.error(extractApiError(e, t('adminScreens.adminSupportDetail.menu.assignLoadFailed')))
})

/** The roster source is the admin users list (the same one AdminUsersView
 *  reads). The caller themselves is not offered: handing a ticket to
 *  yourself is the take button (i18n:adminScreens.adminSupportDetail.take),
 *  not a handover. */
function adminName(u: UserResponse): string {
  return (
    [u.first_name, u.last_name].filter(Boolean).join(' ') ||
    t('adminScreens.adminSupportDetail.menu.adminFallback')
  )
}

async function loadAdmins(): Promise<void> {
  if (adminsQuery.asyncStatus.value === 'loading') return
  await adminsQuery.refetch()
}

function openAssignSheet(): Promise<void> {
  // Opening the sheet turns the roster query on, which reads it.
  assignOpen.value = true
  return Promise.resolve()
}

// -- The ticket's writes (ADMIN_INVALIDATES): the answer is written into the
// ticket, then the lists and the stats refetch. --
const writeTicket = {
  write: (answer: AdminSupportTicket) => setSupportTicket(queryCache, answer),
  waitForRefetch: false,
}
const assign = useAdminMutation(
  'changeTicketTaker',
  (to: string) => assignTicket(ticketId, to),
  writeTicket,
)
const release = useAdminMutation('changeTicketTaker', () => releaseTicket(ticketId), writeTicket)
const reopen = useAdminMutation('changeTicketStatus', () => reopenTicket(ticketId), writeTicket)
const changeStatus = useAdminMutation(
  'changeTicketStatus',
  (status: SupportClosingStatus) => setTicketStatus(ticketId, status),
  {
    write: (changed) => {
      if (ticket.value) setSupportTicket(queryCache, { ...ticket.value, ...changed })
    },
    waitForRefetch: false,
  },
)
// The take answers no ticket: the screen reads it again (refreshTicket).
const claim = useAdminMutation('changeTicketTaker', () => claimSupportThread(ticketId), {
  waitForRefetch: false,
})
const reply = useAdminMutation(
  'replySupport',
  (body: string) => sendAdminSupportReply(ticketId, body),
  { waitForRefetch: false },
)
const retryTranslation = useAdminMutation(
  'retryTranslation',
  ({ threadId, messageId }: { threadId: string; messageId: string }) =>
    retrySupportTranslation(threadId, messageId),
)

async function onAssign(target: AdminOption): Promise<void> {
  if (assigning.value) return
  assigning.value = true
  try {
    await assign.mutateAsync(target.id)
    assignOpen.value = false
    toast.success(t('adminScreens.adminSupportDetail.toast.assigned', { name: target.name }))
  } catch (e) {
    if (isStatus(e, 409)) {
      // Handed over (or freed) meanwhile: the fresh read below is now the
      // card, and the roster on the sheet names the past -- close it.
      assignOpen.value = false
      toast.error(t('adminScreens.adminSupportDetail.toast.handoverConflict'))
      await refreshTicket()
    } else if (isStatus(e, 422)) {
      // The chosen admin stopped being one between the list and the pick:
      // the roster re-reads, the sheet stays open for another choice.
      toast.error(t('adminScreens.adminSupportDetail.toast.assignNotAdmin'))
      await loadAdmins()
    } else {
      toast.error(extractApiError(e, t('adminScreens.adminSupportDetail.toast.assignFailed')))
    }
  } finally {
    assigning.value = false
  }
}

async function onRelease(): Promise<void> {
  if (!ticket.value || releasing.value) return
  releasing.value = true
  try {
    await release.mutateAsync()
    toast.success(t('adminScreens.adminSupportDetail.toast.released'))
  } catch (e) {
    if (isStatus(e, 409)) {
      toast.error(t('adminScreens.adminSupportDetail.toast.handoverConflict'))
      await refreshTicket()
    } else {
      toast.error(extractApiError(e, t('adminScreens.adminSupportDetail.toast.releaseFailed')))
    }
  } finally {
    releasing.value = false
  }
}

/** Reopen (i18n:adminScreens.adminSupportDetail.menu.reopen) and not-spam
 *  (i18n:adminScreens.adminSupportDetail.menu.notSpam) -- one route (FE-108). */
async function onReopen(): Promise<void> {
  if (!ticket.value || reopening.value) return
  reopening.value = true
  try {
    await reopen.mutateAsync()
    toast.success(t('adminScreens.adminSupportDetail.toast.reopened'))
  } catch (e) {
    if (isStatus(e, 404)) {
      // The spam bin emptied it between the read and the click: there is no
      // ticket to show -- the not-found screen, no toast on top of it.
      gone.value = true
    } else if (isStatus(e, 409)) {
      toast.error(t('adminScreens.adminSupportDetail.toast.reopenConflict'))
      await refreshTicket()
    } else {
      toast.error(extractApiError(e, t('adminScreens.adminSupportDetail.toast.reopenFailed')))
    }
  } finally {
    reopening.value = false
  }
}

// -- Translation (BE-166) -----------------------------------------------------

function toggleOriginal(id: string): void {
  const next = new Set(originalShown.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  originalShown.value = next
}

/** On its way: comms' `preparing`, or `not_requested` before the job is
 *  taken. Polled until it settles (owner ruling FE-100). */
function inFlight(list: readonly SupportMessage[]): boolean {
  return list.some(
    (m) => m.translation?.state === 'preparing' || m.translation?.state === 'not_requested',
  )
}

// POLL: every POLL_MS while a message is in flight, at most POLL_LIMIT reads
// per cycle (a cycle restarts on a load, a history open, a retry); stops when
// nothing is in flight or the screen is left.
const POLL_MS = 5000
const POLL_LIMIT = 24
let pollTimer: ReturnType<typeof setTimeout> | null = null
let polls = 0
let disposed = false

function stopPolling(): void {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
}

function schedulePoll(): void {
  if (pollTimer || disposed || ticketMissing.value || polls >= POLL_LIMIT) return
  if (!inFlight(messages.value) && !inFlight(historyMessages.value)) return
  pollTimer = setTimeout(() => {
    pollTimer = null
    polls += 1
    void rereadFeeds().then(schedulePoll)
  }, POLL_MS)
}

function restartPolling(): void {
  polls = 0
  schedulePoll()
}

/** Read the feeds again in place, silently: a failed read keeps what is
 *  shown -- the next poll or the refresh button
 *  (i18n:adminScreens.adminSupportDetail.refresh) tries again. */
async function rereadFeeds(): Promise<void> {
  await Promise.all([
    messagesFeed.readQuietly(() => messagesQuery.refetch()),
    historyShown.value && historyThreadId.value
      ? historyFeed.readQuietly(() => historyQuery.refetch())
      : undefined,
  ])
}

function markPreparing(messageId: string): void {
  const settle = (list: SupportMessage[]): SupportMessage[] =>
    list.map((m) =>
      m.id === messageId && m.translation
        ? { ...m, translation: { ...m.translation, state: 'preparing', retryable: false } }
        : m,
    )
  updateSupportFeed(queryCache, ticketId, settle)
  if (historyThreadId.value) updateSupportFeed(queryCache, historyThreadId.value, settle)
}

async function onRetry(threadId: string, messageId: string): Promise<void> {
  if (retrying.value.has(messageId)) return
  retrying.value = new Set(retrying.value).add(messageId)
  try {
    await retryTranslation.mutateAsync({ threadId, messageId })
    toast.success(t('adminScreens.adminSupportDetail.toast.retryQueued'))
    markPreparing(messageId)
    restartPolling()
  } catch (e) {
    if (isStatus(e, 409)) {
      toast.error(t('adminScreens.adminSupportDetail.toast.retryNothing'))
      await rereadFeeds()
      restartPolling()
    } else {
      toast.error(extractApiError(e, t('adminScreens.adminSupportDetail.toast.retryFailed')))
    }
  } finally {
    const next = new Set(retrying.value)
    next.delete(messageId)
    retrying.value = next
  }
}

function isStatus(e: unknown, status: number): boolean {
  return e instanceof ApiResponseError && e.status === status
}

/** Message clock time in the viewer's profile timezone and the active locale. */
const viewerTz = useViewerTimezone()

function formatTime(iso: string): string {
  if (Number.isNaN(new Date(iso).getTime())) return ''
  return formatClockTime(iso, viewerTz.value)
}

/** The ticket again, behind the page loader (the error rung's retry). */
async function fetchTicket(): Promise<void> {
  await ticketQuery.refetch()
}

/** Read the ticket again in place -- after a 409 or a claim -- without
 *  hiding the page: a failure toasts and keeps what is shown (a 404 is the
 *  not-found screen). */
async function refreshTicket(): Promise<void> {
  const state = await ticketQuery.refetch()
  if (state.error && !isStatus(state.error, 404))
    toast.error(extractApiError(state.error, t('adminScreens.adminSupportDetail.ticketLoadError')))
}

/** The feed again, loudly (the refresh button, the error rung's retry). */
async function loadMessages(): Promise<void> {
  if (await messagesFeed.readLoudly(() => messagesQuery.refetch())) restartPolling()
}

/** Show the person's history (the button), or read it again (its retry). */
async function loadHistory(): Promise<void> {
  if (!historyThreadId.value || loadingHistory.value) return
  historyShown.value = true
  // The query turns on with historyShown; refresh joins the read it starts,
  // and reads again after a failure.
  await nextTick()
  if (await historyFeed.readLoudly(() => historyQuery.refresh())) restartPolling()
}

async function onSetStatus(status: SupportClosingStatus): Promise<void> {
  if (!ticket.value || changingTo.value) return
  changingTo.value = status
  try {
    // The answer carries no admin-only fields; the status change does not
    // touch them, so they stay as read (the mutation merges it in).
    await changeStatus.mutateAsync(status)
    toast.success(t('adminScreens.adminSupportDetail.toast.statusChanged'))
  } catch (e) {
    if (isStatus(e, 409)) {
      toast.error(t('adminScreens.adminSupportDetail.toast.statusConflict'))
      await refreshTicket()
    } else {
      toast.error(extractApiError(e, t('adminScreens.adminSupportDetail.toast.statusFailed')))
    }
  } finally {
    changingTo.value = null
  }
}

async function onClaim(): Promise<void> {
  if (claiming.value) return
  claiming.value = true
  try {
    await claim.mutateAsync()
    toast.success(t('adminScreens.adminSupportDetail.toast.claimedByYou'))
    await refreshTicket()
  } catch (e) {
    if (isStatus(e, 409)) {
      toast.error(t('adminScreens.adminSupportDetail.toast.claimedByOther'))
      await refreshTicket()
    } else {
      toast.error(extractApiError(e, t('adminScreens.adminSupportDetail.toast.claimFailed')))
    }
  } finally {
    claiming.value = false
  }
}

async function onSend(): Promise<void> {
  const body = draft.value.trim()
  if (!body || sending.value) return
  sending.value = true
  try {
    const sent = await reply.mutateAsync(body)
    // Shown at once as written; its translation for the person (BE-166) is
    // known only to the feed -- read it again, and poll if it is on its way.
    updateSupportFeed(queryCache, ticketId, (list) => [
      ...list,
      { ...sent, original: sent.body, translation: null },
    ])
    draft.value = ''
    void rereadFeeds().then(restartPolling)
  } catch (e) {
    toast.error(extractApiError(e, t('adminScreens.adminSupportDetail.toast.replyFailed')))
  } finally {
    sending.value = false
  }
}

onBeforeUnmount(() => {
  disposed = true
  if (pollTimer) clearTimeout(pollTimer)
})

// The ticket and its feed load together (their queries start at once): the
// feed is keyed by the same id, so it does not wait for the ticket row. If
// the ticket turns out missing (404) the not-found screen simply wins over
// whatever the feed answered. The polling starts once the feed answered.
onMounted(async () => {
  const state = await messagesQuery.refresh()
  if (state.status === 'success') restartPolling()
})

watch(ticketMissing, (missing) => {
  if (missing) stopPolling()
})

// A 404 is for good: Colada asks an entry in error again (a return to the
// app), and the not-found screen must not flicker back to a loader.
watch(ticketSettledError, (e) => {
  if (isStatus(e, 404)) gone.value = true
})
</script>

<style scoped>
.support-detail {
  min-height: 100%;
}

.support-detail__content {
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.support-detail__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-8) 0;
}

.support-detail__header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.support-detail__topic {
  font-size: var(--velo-fs-16);
  color: var(--velo-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.support-detail__resolved-by {
  margin-left: auto;
  flex-shrink: 0;
  font-size: var(--text-xs);
  color: var(--velo-text-muted);
  letter-spacing: 0.02em;
}

/* FE-107: the rating block -- stars, the comment as written, the meta line. */
.support-detail__rating {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.support-detail__rating-stars {
  display: flex;
  gap: var(--space-1);
  color: var(--velo-text-muted);
}

.support-detail__star--on {
  color: var(--velo-peach-500);
}

.support-detail__rating-comment {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.support-detail__rating-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  font-size: var(--text-xs);
  color: var(--velo-text-muted);
}

/* Peach warning panel, same convention as ReportUserSheet.vue's support
   notice: --velo-warning-bg, no icon, --velo-peach-500 text. */
.support-detail__claim-panel {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  background: var(--velo-warning-bg);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--space-4);
}

.support-detail__claim-text {
  margin: 0;
  font-size: var(--velo-fs-14);
  color: var(--velo-peach-500);
  line-height: 1.5;
}

.support-detail__feed {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.support-detail__empty {
  text-align: center;
  color: var(--velo-text-muted);
  font-size: var(--velo-fs-16);
  padding: var(--space-4) 0;
}

.support-detail__refresh {
  align-self: center;
  margin-top: var(--space-2);
  background: none;
  border: none;
  color: var(--velo-primary);
  font-size: var(--velo-fs-14);
  text-decoration: underline;
  cursor: pointer;
}

.support-detail__composer {
  display: flex;
  align-items: flex-end;
  gap: var(--space-2);
}

.support-detail__input {
  flex: 1;
  min-width: 0;
}

.support-detail__not-found {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.support-detail__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.support-detail__section-title {
  font-size: var(--velo-fs-14);
  color: var(--velo-text-muted);
  text-transform: uppercase;
  letter-spacing: var(--velo-letter-spacing-05);
}

.support-detail__processed {
  text-align: center;
  font-size: var(--velo-fs-16);
  color: var(--velo-text-muted);
}

.support-detail__menu {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--velo-size-40);
  height: var(--velo-size-40);
  padding: 0;
  border: none;
  border-radius: var(--radius-full);
  background: var(--velo-primary);
  color: var(--velo-white);
  cursor: pointer;
}

.support-detail__menu-rows {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
</style>
