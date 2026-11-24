<!--
  VELO Frontend -- TicketDetail (FE-262, slice 2)

  One support ticket open in the console: the conversation in a card at the
  centre (title, the take / close actions, the feed with translations, the
  reply field) and the person's panel at the right (TicketAside). All logic is
  useTicketSession; this file is the markup and the dialogs. Mount it with
  `:key="ticketId"` so another ticket starts from a clean session.

  The claim is write access: the reply field is for the taker alone, everybody
  else reads a notice (and the take button while nobody holds the ticket).
  Closing a ticket asks for one of the four closing statuses in a dialog; a
  closed ticket offers to bring it back to work, a recent spam one -- "not
  spam".
-->

<template>
  <div class="ticket-detail" data-testid="ticket-detail">
    <ConsoleCard class="ticket-detail__thread">
      <div v-if="loadingTicket" class="ticket-detail__center">
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

      <VEmptyState
        v-else-if="!ticket"
        icon="notfound"
        :title="t('adminScreens.adminSupportDetail.notFoundTitle')"
        :description="t('adminScreens.adminSupportDetail.backToList')"
      />

      <template v-else>
        <header class="ticket-detail__head">
          <div class="ticket-detail__heading">
            <h2 class="ticket-detail__title">{{ supportTopicLabel(ticket.topic) }}</h2>
            <p class="ticket-detail__sub">
              {{
                t('console.support.ticketMeta', {
                  id: ticket.id.slice(0, 8),
                  date: formatDate(ticket.created_at, viewerTz),
                })
              }}
            </p>
          </div>
          <div class="ticket-detail__actions">
            <VButton
              v-if="!ticket.claimed_by"
              variant="secondary"
              size="sm"
              :loading="claiming"
              @click="claim"
            >
              {{ t('console.support.take') }}
            </VButton>
            <VButton variant="secondary" size="sm" @click="openAssign">
              {{ t('adminScreens.adminSupportDetail.menu.assign') }}
            </VButton>
            <VButton
              v-if="ticket.claimed_by"
              variant="secondary"
              size="sm"
              :loading="releasing"
              @click="release"
            >
              {{ t('adminScreens.adminSupportDetail.menu.release') }}
            </VButton>
            <VButton
              v-if="ticket.status === 'open'"
              size="sm"
              :loading="changingTo !== null"
              @click="statusOpen = true"
            >
              {{ t('console.support.close') }}
            </VButton>
            <VButton v-if="reopenLabel" size="sm" :loading="reopening" @click="reopen">
              {{ reopenLabel }}
            </VButton>
          </div>
        </header>

        <!-- Claim notice: shown whenever the caller is NOT the taker, so "why
             can't I type" is answered before it is asked. -->
        <p v-if="!canReply" class="ticket-detail__notice" data-testid="claim-notice">
          {{
            ticket.claimed_by
              ? t('adminScreens.adminSupportDetail.claimedByOtherHint')
              : t('adminScreens.adminSupportDetail.unclaimedHint')
          }}
        </p>

        <div ref="feedEl" class="ticket-detail__feed" data-testid="ticket-feed">
          <div v-if="loadingMessages" class="ticket-detail__center">
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
            <p v-if="messages.length === 0" class="ticket-detail__empty">
              {{ t('adminScreens.adminSupportDetail.noMessages') }}
            </p>
            <SupportMessageBubble
              v-for="m in messages"
              :key="m.id"
              :message="m"
              :from-person="isPerson(m)"
              :mine="m.sender === myId"
              :show-original="originalShown.has(m.id)"
              :retrying="retrying.has(m.id)"
              :time="formatMessageTime(m.created_at)"
              @toggle="toggleOriginal(m.id)"
              @retry="retryTranslation(ticket.id, m.id)"
            />
            <button type="button" class="ticket-detail__link" @click="loadMessages">
              {{ t('adminScreens.adminSupportDetail.refresh') }}
            </button>

            <!-- The person's conversation before tickets: read-only, on demand. -->
            <template v-if="ticket.history_thread_id">
              <VButton v-if="!historyShown" variant="secondary" size="sm" @click="loadHistory">
                {{ t('adminScreens.adminSupportDetail.history.show') }}
              </VButton>
              <section v-else class="ticket-detail__history">
                <h3 class="ticket-detail__history-title">
                  {{ t('adminScreens.adminSupportDetail.history.title') }}
                </h3>
                <div v-if="loadingHistory" class="ticket-detail__center">
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
                <template v-else>
                  <p v-if="historyMessages.length === 0" class="ticket-detail__empty">
                    {{ t('adminScreens.adminSupportDetail.noMessages') }}
                  </p>
                  <SupportMessageBubble
                    v-for="m in historyMessages"
                    :key="m.id"
                    :message="m"
                    :from-person="isPerson(m)"
                    :mine="m.sender === myId"
                    :show-original="originalShown.has(m.id)"
                    :retrying="retrying.has(m.id)"
                    :time="formatMessageTime(m.created_at)"
                    @toggle="toggleOriginal(m.id)"
                    @retry="retryTranslation(historyThreadId, m.id)"
                  />
                </template>
              </section>
            </template>
          </template>
        </div>

        <div v-if="canReply" class="ticket-detail__composer">
          <div class="ticket-detail__input">
            <VTextarea
              v-model="draft"
              :placeholder="t('console.support.replyPlaceholder')"
              :label="t('adminScreens.adminSupportDetail.reply')"
              hide-label
              :rows="1"
              autogrow
              maxlength="4000"
              :disabled="sending"
            />
          </div>
          <VButton
            size="sm"
            data-testid="ticket-send"
            :disabled="sending || !draft.trim()"
            :loading="sending"
            @click="send"
          >
            {{ t('common.submitSend') }}
          </VButton>
        </div>
      </template>
    </ConsoleCard>

    <ConsoleCard class="ticket-detail__aside">
      <TicketAside :ticket="ticket" :my-id="myId" />
    </ConsoleCard>

    <!-- Close: the four closing statuses of an open ticket. -->
    <VModal :open="statusOpen" @close="statusOpen = false">
      <div class="ticket-detail__dialog">
        <h2 class="ticket-detail__dialog-title">{{ t('console.support.closeTitle') }}</h2>
        <div class="ticket-detail__rows">
          <VMenuRow
            v-for="status in SUPPORT_CLOSING_STATUSES"
            :key="status"
            :label="supportStatusLabel(status)"
            :show-arrow="false"
            :data-testid="`close-${status}`"
            @click="onPickStatus(status)"
          />
        </div>
      </div>
    </VModal>

    <!-- Hand over: the roster of the other admins, read each time it opens. -->
    <VModal :open="assignOpen" @close="assignOpen = false">
      <div class="ticket-detail__dialog">
        <h2 class="ticket-detail__dialog-title">
          {{ t('adminScreens.adminSupportDetail.menu.assignTitle') }}
        </h2>
        <div v-if="loadingAdmins" class="ticket-detail__center">
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
        <p v-else-if="admins.length === 0" class="ticket-detail__empty">
          {{ t('adminScreens.adminSupportDetail.menu.assignEmpty') }}
        </p>
        <div v-else class="ticket-detail__rows">
          <VMenuRow
            v-for="admin in admins"
            :key="admin.id"
            :label="admin.name"
            :show-arrow="false"
            @click="assignTo(admin)"
          />
        </div>
      </div>
    </VModal>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed, nextTick, ref, watch } from 'vue'
import { VButton, VEmptyState, VLoader, VMenuRow, VModal, VTextarea } from '@/components/ui'
import ConsoleCard from '@/components/console/ConsoleCard.vue'
import SupportMessageBubble from '@/components/admin/SupportMessageBubble.vue'
import TicketAside from '@/components/console/requests/TicketAside.vue'
import { useTicketSession } from '@/components/console/requests/useTicketSession'
import {
  SUPPORT_CLOSING_STATUSES,
  spamWithinRetention,
  type AdminSupportTicket,
  type SupportClosingStatus,
  type SupportTicketStatus,
} from '@/api/support'
import { useViewerTimezone } from '@/composables/useViewerTimezone'
import { formatDate, formatTime } from '@/utils/format'
import { supportStatusLabel, supportTopicLabel } from '@/utils/supportTopics'

const props = defineProps<{
  /** The ticket's comms thread id. */
  ticketId: string
  /** The list's row of this ticket: paints the card before the read answers. */
  handed?: AdminSupportTicket | null
}>()

const {
  myId,
  ticket,
  loadingTicket,
  ticketError,
  fetchTicket,
  messages,
  loadingMessages,
  messagesError,
  loadMessages,
  historyShown,
  historyThreadId,
  historyMessages,
  loadingHistory,
  historyError,
  loadHistory,
  isPerson,
  originalShown,
  toggleOriginal,
  retrying,
  retryTranslation,
  canReply,
  draft,
  sending,
  send,
  claiming,
  claim,
  changingTo,
  setStatus,
  releasing,
  release,
  reopening,
  reopen,
  assignOpen,
  admins,
  loadingAdmins,
  adminsError,
  openAssign,
  loadAdmins,
  assignTo,
} = useTicketSession(props.ticketId, props.handed ?? null)
const viewerTz = useViewerTimezone()

/** A closed-but-not-spam ticket: "back to work" reopens it. */
const REOPENABLE: readonly SupportTicketStatus[] = ['resolved', 'rejected', 'duplicate']

/** The label of the reopen action the ticket offers now, or '' when none applies. */
const reopenLabel = computed(() => {
  const tk = ticket.value
  if (!tk) return ''
  if (REOPENABLE.includes(tk.status)) return t('adminScreens.adminSupportDetail.menu.reopen')
  // Not-spam is the same route, offered while the verdict is inside the
  // retention (past it the bin deletes the ticket with its conversation).
  if (tk.status === 'spam' && spamWithinRetention(tk.status_changed_at))
    return t('adminScreens.adminSupportDetail.menu.notSpam')
  return ''
})

const statusOpen = ref(false)

function onPickStatus(status: SupportClosingStatus): void {
  statusOpen.value = false
  void setStatus(status)
}

/** Message clock time in the viewer's profile timezone and the active locale. */
function formatMessageTime(iso: string): string {
  if (Number.isNaN(new Date(iso).getTime())) return ''
  return formatTime(iso, viewerTz.value)
}

// The newest message is at the bottom: the feed follows it when one lands.
const feedEl = ref<HTMLElement | null>(null)
function scrollToEnd(): void {
  void nextTick(() => {
    if (feedEl.value) feedEl.value.scrollTop = feedEl.value.scrollHeight
  })
}
watch(() => messages.value.length, scrollToEnd, { flush: 'post' })
</script>

<style scoped>
.ticket-detail {
  display: flex;
  flex: 1 1 0;
  gap: var(--space-4);
  min-height: 0;
}

.ticket-detail__thread {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.ticket-detail__aside {
  flex: 0 0 300px;
  min-height: 0;
  overflow-y: auto;
}

/* Too narrow for the conversation and the person's panel side by side: the
   panel goes under the conversation and the pane scrolls. */
@media (max-width: 1359px) {
  .ticket-detail {
    flex: 0 0 auto;
    flex-direction: column;
  }

  .ticket-detail__thread {
    flex: 0 0 auto;
    height: 70vh;
    min-height: 420px;
  }

  .ticket-detail__aside {
    flex: 0 0 auto;
    overflow-y: visible;
  }
}

.ticket-detail__center {
  display: flex;
  justify-content: center;
  padding: var(--space-6) 0;
}

.ticket-detail__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}

.ticket-detail__heading {
  flex: 1 1 200px;
  min-width: 0;
}

.ticket-detail__title {
  margin: 0;
  font-size: var(--velo-fs-20);
  font-weight: inherit;
  color: var(--velo-text-primary);
  -webkit-text-stroke: var(--velo-text-stroke-strong);
}

.ticket-detail__sub {
  margin: var(--space-1) 0 0;
  font-size: var(--velo-fs-12);
  color: var(--velo-text-secondary);
}

.ticket-detail__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}

.ticket-detail__notice {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  background: var(--velo-warning-bg);
  font-size: var(--velo-fs-14);
  line-height: 1.5;
  color: var(--velo-text-primary);
}

.ticket-detail__feed {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 0;
  overflow-y: auto;
}

/* The card is white like the message bubbles of the person: tint theirs, so
   they stand out of the card (the bubbles are the shared support bubble). */
.ticket-detail__feed :deep(.bubble:not(.bubble--mine)) {
  background: var(--velo-bg-subtle);
}

/* The bubble dims its time and translation marks with opacity, which drops
   them under 4.5:1 on the tinted and on the primary bubble. */
.ticket-detail__feed :deep(.bubble__time),
.ticket-detail__feed :deep(.bubble__mark) {
  opacity: 1;
}

.ticket-detail__empty {
  margin: 0;
  padding: var(--space-4) 0;
  text-align: center;
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
}

.ticket-detail__link {
  align-self: center;
  padding: 0;
  border: none;
  background: none;
  font-size: var(--velo-fs-14);
  color: var(--velo-text-primary);
  text-decoration: underline;
  cursor: pointer;
}

.ticket-detail__history {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.ticket-detail__history-title {
  margin: 0;
  font-size: var(--velo-fs-12);
  font-weight: inherit;
  text-transform: uppercase;
  letter-spacing: var(--velo-letter-spacing-05);
  color: var(--velo-text-secondary);
}

.ticket-detail__composer {
  display: flex;
  align-items: flex-end;
  gap: var(--space-2);
}

.ticket-detail__input {
  flex: 1;
  min-width: 0;
}

.ticket-detail__dialog {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.ticket-detail__dialog-title {
  margin: 0;
  font-size: var(--velo-fs-18);
  font-weight: inherit;
  color: var(--velo-text-primary);
}

.ticket-detail__rows {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
</style>
