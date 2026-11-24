// =============================================================================
// VELO Frontend -- useTicketSession (FE-262, slice 2: support in the console)
// =============================================================================
//
// Everything one open support ticket does on the web console, in one place so
// the card layout stays markup: the ticket row, its message feed and the
// person's earlier conversation, the claim, the handover, the statuses, the
// reply and the translation of messages. It is the logic of the mobile
// AdminSupportDetailView, moved here without changes of behaviour; the mobile
// screen stays as it is until /admin moves to the console.
//
// THE TICKET comes from the list's row (`handed`, written into an empty cache
// entry so the card paints at once) or, for a deep link, from one read of the
// ticket. 404 is the not-found state. A 409 on a write means the ticket moved
// on: a toast and a fresh read.
//
// CLAIM IS WRITE-AUTHZ. comms lets only the thread's client or its assignee
// post, so the composer is for the admin in `claimed_by` alone; the screen
// shows a notice and the take button to everybody else.
//
// POLLING is bounded and only while a message is on its way through
// translation: every POLL_MS, at most POLL_LIMIT reads per cycle, until
// nothing is in flight or the card is left. The refresh button covers the rest.
//
// One session per ticket: the screen mounts it with `:key="ticketId"`, so the
// draft, the polling and the shown originals reset when another ticket opens.
// =============================================================================

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { useQuery, useQueryCache } from '@pinia/colada'
import { t } from '@/locales'
import { ApiResponseError } from '@/api/client'
import { createAttemptKeys } from '@/api/attemptKeys'
import {
  assignTicket,
  claimSupportThread,
  releaseTicket,
  reopenTicket,
  retrySupportTranslation,
  sendAdminSupportReply,
  setTicketStatus,
  type AdminSupportTicket,
  type SupportClosingStatus,
  type SupportMessage,
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
import { useToast } from '@/composables/useToast'
import { useAuthStore } from '@/stores/auth'

/** Milliseconds between two reads of a feed with a translation on its way. */
export const TICKET_POLL_MS = 5000
/** Reads per polling cycle (a cycle restarts on a load, a history open, a retry). */
export const TICKET_POLL_LIMIT = 24

/** An admin a ticket can be handed to. */
export interface TicketAdminOption {
  id: string
  name: string
}

interface FeedQuery {
  data: Readonly<Ref<SupportMessage[] | undefined>>
  error: Readonly<Ref<unknown>>
  asyncStatus: Readonly<Ref<'idle' | 'loading'>>
}

function isStatus(error: unknown, status: number): boolean {
  return error instanceof ApiResponseError && error.status === status
}

/** A message still on its way through translation (comms `preparing`, or `not_requested` before the job is taken). */
function inFlight(list: readonly SupportMessage[]): boolean {
  return list.some(
    (m) => m.translation?.state === 'preparing' || m.translation?.state === 'not_requested',
  )
}

function adminName(user: UserResponse): string {
  return (
    [user.first_name, user.last_name].filter(Boolean).join(' ') ||
    t('adminScreens.adminSupportDetail.menu.adminFallback')
  )
}

/**
 * Open a ticket's session (call it in a component's setup).
 *
 * @param ticketId - the ticket's comms thread id
 * @param handed - the list's row of this ticket, when the card opens from a list
 */
export function useTicketSession(ticketId: string, handed: AdminSupportTicket | null) {
  const toast = useToast()
  const authStore = useAuthStore()
  const queryCache = useQueryCache()
  const myId = computed(() => authStore.user?.id ?? '')

  // -- The ticket ----------------------------------------------------------------
  // Written only into an empty entry: a held one may be newer than the list's
  // row (a decision made a moment ago, the list's refetch still on its way).
  if (handed && handed.id === ticketId && !hasSupportTicket(queryCache, ticketId))
    setSupportTicket(queryCache, handed)
  const ticketQuery = useQuery(() => adminSupportTicketQuery(ticketId))
  /** A reopen answered 404: the spam bin emptied the ticket. */
  const gone = ref(false)
  const ticketSettledError = computed(() =>
    ticketQuery.asyncStatus.value === 'idle' ? ticketQuery.error.value : null,
  )
  /** The ticket is not there: the not-found state shows and the feed stops polling. */
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

  // -- The feeds: the ticket's thread and, on demand, the person's history -------
  // With nothing shown yet a read shows the loader and, failed, the error. Over
  // a shown feed only a read the card asks for itself (refresh, retry) is
  // "loud" and takes the feed's place; every other read keeps the feed and the
  // composer (and its draft) on screen. The polling's reads are quiet: a failed
  // one waits for the next poll.
  function feedState(query: FeedQuery, shown: () => boolean) {
    const loud = ref(false)
    const loudFailed = ref(false)
    let quiet = false
    onFailedRequest(query, (e) => {
      // Runs before the reads' own continuations: a loud read is its state's,
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
      async readQuietly(read: () => Promise<unknown>): Promise<void> {
        quiet = true
        try {
          await read()
        } finally {
          quiet = false
        }
      },
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

  const historyShown = ref(false)
  const historyThreadId = computed(() => ticket.value?.history_thread_id ?? '')
  const historyQuery = useQuery(() =>
    adminSupportMessagesQuery({
      threadId: historyThreadId.value,
      enabled: historyShown.value && historyThreadId.value !== '',
    }),
  )
  const historyMessages = computed<SupportMessage[]>(() =>
    historyShown.value ? (historyQuery.data.value ?? []) : [],
  )
  const historyFeed = feedState(historyQuery, () => historyShown.value)

  // -- Who may do what -----------------------------------------------------------
  /** Only the taker posts: comms refuses everybody else. */
  const canReply = computed(() => !!myId.value && ticket.value?.claimed_by?.user_id === myId.value)
  /** A message of the person the ticket is about (not of support). */
  function isPerson(m: SupportMessage): boolean {
    return !!ticket.value?.opener && m.sender === ticket.value.opener.user_id
  }

  // -- The writes (ADMIN_INVALIDATES): the answer is written into the ticket, then
  // the lists and the stats refetch. ---------------------------------------------
  const draft = ref('')
  const sending = ref(false)
  const claiming = ref(false)
  const changingTo = ref<SupportClosingStatus | null>(null)
  const releasing = ref(false)
  const reopening = ref(false)
  const originalShown = ref<ReadonlySet<string>>(new Set())
  const retrying = ref<ReadonlySet<string>>(new Set())

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
      // The answer carries no admin-only fields; the status change does not
      // touch them, so they stay as read.
      write: (changed) => {
        if (ticket.value) setSupportTicket(queryCache, { ...ticket.value, ...changed })
      },
      waitForRefetch: false,
    },
  )
  // The take answers no ticket: the card reads it again (refreshTicket).
  const claim = useAdminMutation('changeTicketTaker', () => claimSupportThread(ticketId), {
    waitForRefetch: false,
  })
  // One key per send attempt (FE-232): a retry of the same text is the same
  // reply. A landed reply and a refusal free the key, any other failure keeps it.
  const replyKeys = createAttemptKeys()
  const reply = useAdminMutation(
    'replySupport',
    (body: string) => sendAdminSupportReply(ticketId, body, replyKeys.keyFor(ticketId, body)),
    { waitForRefetch: false },
  )
  const retryTranslation = useAdminMutation(
    'retryTranslation',
    ({ threadId, messageId }: { threadId: string; messageId: string }) =>
      retrySupportTranslation(threadId, messageId),
  )

  // -- The handover: the roster of admins ----------------------------------------
  const assignOpen = ref(false)
  const assigning = ref(false)
  // Read each time the roster opens (staleTime 0); a held roster shows meanwhile.
  const adminsQuery = useQuery(() => adminAdminsQuery(assignOpen.value))
  /** The admins a ticket can be handed to: not the caller, who takes it with the take button. */
  const admins = computed<readonly TicketAdminOption[]>(() =>
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
  // A failed read over a roster already shown is told; the roster stays for a pick.
  onFailedRequest(adminsQuery, (e) => {
    if (adminsQuery.data.value !== undefined)
      toast.error(extractApiError(e, t('adminScreens.adminSupportDetail.menu.assignLoadFailed')))
  })

  async function loadAdmins(): Promise<void> {
    if (adminsQuery.asyncStatus.value === 'loading') return
    await adminsQuery.refetch()
  }

  /** Open the roster: turning the query on reads it. */
  function openAssign(): void {
    assignOpen.value = true
  }

  // -- Translation polling -------------------------------------------------------
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let polls = 0
  let disposed = false

  function stopPolling(): void {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = null
  }

  function schedulePoll(): void {
    if (pollTimer || disposed || ticketMissing.value || polls >= TICKET_POLL_LIMIT) return
    if (!inFlight(messages.value) && !inFlight(historyMessages.value)) return
    pollTimer = setTimeout(() => {
      pollTimer = null
      polls += 1
      void rereadFeeds().then(schedulePoll)
    }, TICKET_POLL_MS)
  }

  function restartPolling(): void {
    polls = 0
    schedulePoll()
  }

  /** Read the feeds again in place, silently: a failed read keeps what is shown. */
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

  function toggleOriginal(id: string): void {
    const next = new Set(originalShown.value)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    originalShown.value = next
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

  // -- Reads the card asks for ---------------------------------------------------
  /** The ticket again, behind the loader (the error state's retry). */
  async function fetchTicket(): Promise<void> {
    await ticketQuery.refetch()
  }

  /** Read the ticket again in place -- after a 409 or a claim -- without hiding the card. */
  async function refreshTicket(): Promise<void> {
    const state = await ticketQuery.refetch()
    if (state.error && !isStatus(state.error, 404))
      toast.error(
        extractApiError(state.error, t('adminScreens.adminSupportDetail.ticketLoadError')),
      )
  }

  /** The feed again, loudly (the refresh button, the error state's retry). */
  async function loadMessages(): Promise<void> {
    if (await messagesFeed.readLoudly(() => messagesQuery.refetch())) restartPolling()
  }

  /** Show the person's history (the button), or read it again (its retry). */
  async function loadHistory(): Promise<void> {
    if (!historyThreadId.value || historyFeed.loading.value) return
    historyShown.value = true
    // The query turns on with historyShown; refresh joins the read it starts,
    // and reads again after a failure.
    await nextTick()
    if (await historyFeed.readLoudly(() => historyQuery.refresh())) restartPolling()
  }

  // -- The actions ---------------------------------------------------------------
  async function onAssign(target: TicketAdminOption): Promise<void> {
    if (assigning.value) return
    assigning.value = true
    try {
      await assign.mutateAsync(target.id)
      assignOpen.value = false
      toast.success(t('adminScreens.adminSupportDetail.toast.assigned', { name: target.name }))
    } catch (e) {
      if (isStatus(e, 409)) {
        // Handed over (or freed) meanwhile: the fresh read is now the card, and
        // the roster names the past -- close it.
        assignOpen.value = false
        toast.error(t('adminScreens.adminSupportDetail.toast.handoverConflict'))
        await refreshTicket()
      } else if (isStatus(e, 422)) {
        // The chosen admin stopped being one: the roster re-reads for another pick.
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

  /** Reopen and not-spam: one route. */
  async function onReopen(): Promise<void> {
    if (!ticket.value || reopening.value) return
    reopening.value = true
    try {
      await reopen.mutateAsync()
      toast.success(t('adminScreens.adminSupportDetail.toast.reopened'))
    } catch (e) {
      if (isStatus(e, 404)) {
        // The spam bin emptied it between the read and the click: there is no
        // ticket to show -- the not-found state, no toast on top of it.
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

  async function onSetStatus(status: SupportClosingStatus): Promise<void> {
    if (!ticket.value || changingTo.value) return
    changingTo.value = status
    try {
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
      replyKeys.settle()
      // Shown at once as written; its translation for the person is known only
      // to the feed -- read it again, and poll if it is on its way.
      updateSupportFeed(queryCache, ticketId, (list) => [
        ...list,
        { ...sent, original: sent.body, translation: null },
      ])
      draft.value = ''
      void rereadFeeds().then(restartPolling)
    } catch (e) {
      replyKeys.settle(e)
      toast.error(extractApiError(e, t('adminScreens.adminSupportDetail.toast.replyFailed')))
    } finally {
      sending.value = false
    }
  }

  onBeforeUnmount(() => {
    disposed = true
    stopPolling()
  })

  // The ticket and its feed load together (their queries start at once): the
  // feed is keyed by the same id, so it does not wait for the ticket row. If
  // the ticket turns out missing the not-found state wins over whatever the
  // feed answered. The polling starts once the feed answered.
  onMounted(async () => {
    const state = await messagesQuery.refresh()
    if (state.status === 'success') restartPolling()
  })

  watch(ticketMissing, (missing) => {
    if (missing) stopPolling()
  })

  // A 404 is for good: Colada asks an entry in error again (a return to the
  // app), and the not-found state must not flicker back to a loader.
  watch(ticketSettledError, (e) => {
    if (isStatus(e, 404)) gone.value = true
  })

  return {
    myId,
    ticket,
    loadingTicket,
    ticketError,
    ticketMissing,
    fetchTicket,
    messages,
    loadingMessages: messagesFeed.loading,
    messagesError: messagesFeed.error,
    loadMessages,
    historyShown,
    historyThreadId,
    historyMessages,
    loadingHistory: historyFeed.loading,
    historyError: historyFeed.error,
    loadHistory,
    isPerson,
    originalShown,
    toggleOriginal,
    retrying,
    retryTranslation: onRetry,
    canReply,
    draft,
    sending,
    send: onSend,
    claiming,
    claim: onClaim,
    changingTo,
    setStatus: onSetStatus,
    releasing,
    release: onRelease,
    reopening,
    reopen: onReopen,
    assignOpen,
    assigning,
    admins,
    loadingAdmins,
    adminsError,
    openAssign,
    loadAdmins,
    assignTo: onAssign,
  }
}

/** What `useTicketSession` returns. */
export type TicketSession = ReturnType<typeof useTicketSession>
