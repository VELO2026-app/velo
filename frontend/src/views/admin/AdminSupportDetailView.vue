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

  DELIBERATELY NOT BUILT (scope trim, stated not silent): polling like
  ChatThreadScreen has -- a manual «Обновить» covers it; mark-read for admins.
  Delivery B (out of FE-100's minimum): translation marks, «Показать оригинал»,
  «Повторить», the ⋯ menu, «вернуть в работу», «назначить».
-->

<template>
  <div class="support-detail">
    <VHeader :title="headerTitle" show-back @back="router.back()" />

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

        <!-- Status: the four closing statuses while the ticket is open. -->
        <div v-if="ticket.status === 'open'" class="support-detail__section">
          <div class="support-detail__section-title">
            {{ t('adminScreens.adminSupportDetail.statusSection') }}
          </div>
          <div class="support-detail__actions">
            <VButton
              v-for="status in SUPPORT_CLOSING_STATUSES"
              :key="status"
              :variant="status === 'resolved' ? 'primary' : 'outline'"
              block
              :loading="changingTo === status"
              :disabled="changingTo !== null"
              @click="onSetStatus(status)"
            >
              {{ supportStatusLabel(status) }}
            </VButton>
          </div>
        </div>
        <VCard v-else class="support-detail__processed">
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
            <div
              v-for="m in messages"
              :key="m.id"
              class="support-detail__row"
              :class="{ 'support-detail__row--mine': m.sender === myId }"
            >
              <div
                class="support-detail__bubble"
                :class="{ 'support-detail__bubble--mine': m.sender === myId }"
              >
                <div class="support-detail__body">{{ m.body }}</div>
                <div class="support-detail__time">{{ formatTime(m.created_at) }}</div>
              </div>
            </div>
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
              <div
                v-for="m in historyMessages"
                :key="m.id"
                class="support-detail__row"
                :class="{ 'support-detail__row--mine': m.sender === myId }"
              >
                <div
                  class="support-detail__bubble"
                  :class="{ 'support-detail__bubble--mine': m.sender === myId }"
                >
                  <div class="support-detail__body">{{ m.body }}</div>
                  <div class="support-detail__time">{{ formatTime(m.created_at) }}</div>
                </div>
              </div>
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
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import { VBadge, VButton, VCard, VTextarea, VEmptyState, VLoader } from '@/components/ui'
import { useToast } from '@/composables/useToast'
import { useAuthStore } from '@/stores/auth'
import { ApiResponseError } from '@/api/client'
import {
  SUPPORT_CLOSING_STATUSES,
  claimSupportThread,
  getAdminSupportMessages,
  getAdminTicket,
  sendAdminSupportReply,
  setTicketStatus,
  type AdminSupportTicket,
  type SupportClosingStatus,
  type SupportMessage,
} from '@/api/support'
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
    messages.value = [...messages.value, sent]
    draft.value = ''
  } catch (e) {
    toast.error(extractApiError(e, t('adminScreens.adminSupportDetail.toast.replyFailed')))
  } finally {
    sending.value = false
  }
}

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

.support-detail__row {
  display: flex;
  justify-content: flex-start;
}
.support-detail__row--mine {
  justify-content: flex-end;
}

.support-detail__bubble {
  max-width: 78%;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--velo-bg-card-solid);
  color: var(--velo-text-primary);
  word-break: break-word;
}
.support-detail__bubble--mine {
  background: var(--velo-primary);
  color: var(--velo-white);
}

.support-detail__body {
  white-space: pre-wrap;
  font-size: var(--text-sm);
}

.support-detail__time {
  margin-top: var(--space-1);
  font-size: var(--text-xs);
  opacity: 0.6;
  text-align: right;
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

.support-detail__actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.support-detail__processed {
  text-align: center;
  font-size: var(--text-sm);
  color: var(--velo-text-muted);
}
</style>
