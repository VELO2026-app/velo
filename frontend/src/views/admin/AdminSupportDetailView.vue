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
  else sees a notice, and «Взять в работу» while nobody holds it. A ticket
  held by another admin is a 409 on the claim; after any claim answer the
  ticket is read again, so `claimed_by` is always the server's.

  THE HANDOVER (FE-108, BE-162 delivery 2) lives in the same ⋯ menu as the
  statuses: «Назначить» (a roster of admins -- the admin users list, myself
  not offered), «Освободить» (a held ticket), «Вернуть в работу» (a closed
  ticket) and «Не спам» (spam inside the 30-day retention). All three routes
  answer the ticket's FULL row, so their answers replace the card outright.
  A 409 means the ticket moved on meanwhile: a toast and a fresh read; a 404
  on reopen means the spam bin emptied it: the not-found screen. The card only
  ever holds a ticket (a history thread id 404s at the one-ticket read), so
  the routes' "on a history thread" 409s are a backend backstop, not a state
  this screen can reach.

  DELIBERATELY NOT BUILT (scope trim, stated not silent): polling like
  ChatThreadScreen has -- a manual «Обновить» covers it; mark-read for admins.
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
        </div>

        <!-- Status: an open ticket's actions live in the ⋯ menu (header). -->
        <VCard v-if="ticket.status !== 'open'" class="support-detail__processed">
          {{ t('adminScreens.adminSupportDetail.currentStatus') }}
          <strong>{{ supportStatusLabel(ticket.status) }}</strong>
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

    <!-- «Назначить»: the admin roster (FE-108). Read fresh on every open --
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
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
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
import { IconDots } from '@/components/icons'
import SupportMessageBubble from '@/components/admin/SupportMessageBubble.vue'
import { useToast } from '@/composables/useToast'
import { useAuthStore } from '@/stores/auth'
import { ApiResponseError } from '@/api/client'
import {
  SUPPORT_CLOSING_STATUSES,
  assignTicket,
  claimSupportThread,
  getAdminSupportMessages,
  getAdminTicket,
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
import { getUsersList, type UserResponse } from '@/api/admin'
import { extractApiError } from '@/composables/useApiError'
import { supportStatusBadge, supportStatusLabel, supportTopicLabel } from '@/utils/supportTopics'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const authStore = useAuthStore()

const ticketId = route.params.id as string
const myId = computed(() => authStore.user?.id ?? '')

const ticket = ref<AdminSupportTicket | null>(null)
const loadingTicket = ref(false)
const ticketError = ref<string | null>(null)

const messages = ref<SupportMessage[]>([])
const loadingMessages = ref(false)
const messagesError = ref<string | null>(null)

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
const historyMessages = ref<SupportMessage[]>([])
const loadingHistory = ref(false)
const historyError = ref<string | null>(null)

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

/** A message of the person the ticket is about (not of support). */
function isPerson(m: SupportMessage): boolean {
  return !!ticket.value?.opener && m.sender === ticket.value.opener.user_id
}

// -- The ⋯ menu ---------------------------------------------------------------
// ONE ENTRY PER ACTION (owner ruling FE-100): the four closing statuses,
// then the handover of BE-162 delivery 2 (FE-108) -- «назначить»,
// «освободить», «вернуть в работу», «не спам» -- each its own entry, nothing
// else changes. The button shows only while some entry applies.
interface TicketMenuAction {
  key: string
  label: () => string
  visible: (ticket: AdminSupportTicket) => boolean
  run: () => Promise<void>
}

/** A closed-but-not-spam ticket: «Вернуть в работу» reopens it. */
const REOPENABLE_STATUSES: readonly SupportTicketStatus[] = ['resolved', 'rejected', 'duplicate']

const TICKET_ACTIONS: readonly TicketMenuAction[] = [
  // «Назначить» -- always, on a ticket. A history thread never reaches the
  // card (its id 404s at the one-ticket read), so "кроме истории" holds by
  // construction; the route's 409 is the backend backstop.
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
  // «Не спам» is the same reopen route, offered only while the verdict is
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

// -- «Назначить»: the roster and the handover (FE-108) ------------------------

interface AdminOption {
  id: string
  name: string
}

const assignOpen = ref(false)
const admins = ref<readonly AdminOption[]>([])
const loadingAdmins = ref(false)
const adminsError = ref<string | null>(null)
const assigning = ref(false)

/** The roster source is the admin users list (the same one AdminUsersView
 *  reads). The caller themselves is not offered: handing a ticket to
 *  yourself is «Взять в работу», not a handover. */
function adminName(u: UserResponse): string {
  return (
    [u.first_name, u.last_name].filter(Boolean).join(' ') ||
    t('adminScreens.adminSupportDetail.menu.adminFallback')
  )
}

async function loadAdmins(): Promise<void> {
  if (loadingAdmins.value) return
  loadingAdmins.value = true
  adminsError.value = null
  try {
    const page = await getUsersList('admin')
    admins.value = page.items
      .filter((u) => u.id !== myId.value)
      .map((u) => ({ id: u.id, name: adminName(u) }))
  } catch (e) {
    adminsError.value = extractApiError(
      e,
      t('adminScreens.adminSupportDetail.menu.assignLoadFailed'),
    )
  } finally {
    loadingAdmins.value = false
  }
}

async function openAssignSheet(): Promise<void> {
  assignOpen.value = true
  await loadAdmins()
}

async function onAssign(target: AdminOption): Promise<void> {
  if (assigning.value) return
  assigning.value = true
  try {
    ticket.value = await assignTicket(ticketId, target.id)
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
    ticket.value = await releaseTicket(ticketId)
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

/** «Вернуть в работу» and «Не спам» -- one route (FE-108). */
async function onReopen(): Promise<void> {
  if (!ticket.value || reopening.value) return
  reopening.value = true
  try {
    ticket.value = await reopenTicket(ticketId)
    toast.success(t('adminScreens.adminSupportDetail.toast.reopened'))
  } catch (e) {
    if (isStatus(e, 404)) {
      // The spam bin emptied it between the read and the click: there is no
      // ticket to show -- the not-found screen, no toast on top of it.
      ticket.value = null
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

function schedulePoll(): void {
  if (pollTimer || disposed || polls >= POLL_LIMIT) return
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
 *  shown -- the next poll or «Обновить» tries again. */
async function rereadFeeds(): Promise<void> {
  try {
    const page = await getAdminSupportMessages(ticketId)
    messages.value = [...page.messages].reverse()
    const historyId = historyThreadId.value
    if (historyShown.value && historyId) {
      const history = await getAdminSupportMessages(historyId)
      historyMessages.value = [...history.messages].reverse()
    }
  } catch {
    // Silent by design (see above).
  }
}

function markPreparing(messageId: string): void {
  const settle = (list: SupportMessage[]): SupportMessage[] =>
    list.map((m) =>
      m.id === messageId && m.translation
        ? { ...m, translation: { ...m.translation, state: 'preparing', retryable: false } }
        : m,
    )
  messages.value = settle(messages.value)
  historyMessages.value = settle(historyMessages.value)
}

async function onRetry(threadId: string, messageId: string): Promise<void> {
  if (retrying.value.has(messageId)) return
  retrying.value = new Set(retrying.value).add(messageId)
  try {
    await retrySupportTranslation(threadId, messageId)
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

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

async function loadTicket(): Promise<void> {
  const stateData = (history.state as { ticket?: AdminSupportTicket }).ticket
  if (stateData && stateData.id === ticketId) {
    ticket.value = stateData
    ticketError.value = null
    return
  }
  await fetchTicket()
}

/** The ticket by its one read, behind the page loader (no hand-off). */
async function fetchTicket(): Promise<void> {
  loadingTicket.value = true
  ticketError.value = null
  try {
    ticket.value = await getAdminTicket(ticketId)
  } catch (e) {
    if (isStatus(e, 404)) ticket.value = null
    else
      ticketError.value = extractApiError(e, t('adminScreens.adminSupportDetail.ticketLoadError'))
  } finally {
    loadingTicket.value = false
  }
}

/** Read the ticket again in place -- after a 409 or a claim -- without
 *  hiding the page: a failure toasts and keeps what is shown. */
async function refreshTicket(): Promise<void> {
  try {
    ticket.value = await getAdminTicket(ticketId)
  } catch (e) {
    if (isStatus(e, 404)) ticket.value = null
    else toast.error(extractApiError(e, t('adminScreens.adminSupportDetail.ticketLoadError')))
  }
}

async function loadMessages(): Promise<void> {
  loadingMessages.value = true
  messagesError.value = null
  try {
    const page = await getAdminSupportMessages(ticketId)
    messages.value = [...page.messages].reverse()
    restartPolling()
  } catch (e) {
    messagesError.value = extractApiError(e, t('adminScreens.adminSupportDetail.tryAgain'))
  } finally {
    loadingMessages.value = false
  }
}

async function loadHistory(): Promise<void> {
  const historyId = ticket.value?.history_thread_id
  if (!historyId || loadingHistory.value) return
  historyShown.value = true
  loadingHistory.value = true
  historyError.value = null
  try {
    const page = await getAdminSupportMessages(historyId)
    historyMessages.value = [...page.messages].reverse()
    restartPolling()
  } catch (e) {
    historyError.value = extractApiError(e, t('adminScreens.adminSupportDetail.tryAgain'))
  } finally {
    loadingHistory.value = false
  }
}

async function onSetStatus(status: SupportClosingStatus): Promise<void> {
  if (!ticket.value || changingTo.value) return
  changingTo.value = status
  try {
    const changed = await setTicketStatus(ticketId, status)
    // The answer carries no admin-only fields; the status change does not
    // touch them, so they stay as read.
    if (ticket.value) ticket.value = { ...ticket.value, ...changed }
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
    await claimSupportThread(ticketId)
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
    const sent = await sendAdminSupportReply(ticketId, body)
    // Shown at once as written; its translation for the person (BE-166) is
    // known only to the feed -- read it again, and poll if it is on its way.
    messages.value = [...messages.value, { ...sent, original: sent.body, translation: null }]
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

onMounted(async () => {
  await loadTicket()
  if (ticket.value) await loadMessages()
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
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  font-size: var(--text-xs);
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
  font-size: var(--text-sm);
  padding: var(--space-4) 0;
}

.support-detail__refresh {
  align-self: center;
  margin-top: var(--space-2);
  background: none;
  border: none;
  color: var(--velo-primary);
  font-size: var(--text-xs);
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
  font-size: var(--text-xs);
  color: var(--velo-text-muted);
  text-transform: uppercase;
  letter-spacing: var(--velo-letter-spacing-05);
}

.support-detail__processed {
  text-align: center;
  font-size: var(--text-sm);
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
