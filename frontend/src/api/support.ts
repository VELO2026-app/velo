// =============================================================================
// VELO Frontend -- Support API (B34; tickets since FE-104 / BE-162)
// =============================================================================
//
// Typed wrappers over the support proxy (backend app/modules/support/router.py).
//
// EVERY APPEAL THROUGH A FORM IS A TICKET (owner ruling BE-162): its own comms
// thread, a topic CODE (models.TOPICS), our own status. One call creates it
// with its first message; the client's Idempotency-Key names the appeal, so a
// repeat under the same key is the same ticket, not a second one.
//
// The person never reads support through this module: their tickets are one
// row in «Сообщения» (api/chats.ts, `channel: 'support'`, `thread_ids`).
//
// ADMIN HALF: the ticket list (velo's own table; without a status filter every
// ticket but spam), one ticket by id, the status change (an OPEN ticket only),
// the handover -- assign / release / reopen (BE-162 delivery 2) -- and --
// unchanged routes, keyed by the ticket id -- the feed, the reply and the
// claim. Claiming is what grants the right to reply: comms admits only
// the client or the assignee, so a reply on an unclaimed ticket is comms' own
// 403, forwarded (backend/app/core/comms.py forward_403).
//
// The request bodies' closed sets come from generated.ts (TicketIn, StatusIn)
// so a backend change of the sets shows up here at type-check time. The
// responses are hand-written: the routes return untyped dicts, generated.ts
// has no schema for them.
// =============================================================================

import { api } from '@/api/client'
import { newIdempotencyKey } from '@/api/chats'
import type { StatusIn, TicketIn } from '@/api/generated'

/** A topic code of the support forms (backend models.TOPICS). The label is
 *  the front's, in the reader's language -- utils/supportTopics.ts. */
export type SupportTopicCode = TicketIn['topic']

/** Where an admin may move an OPEN ticket. */
export type SupportClosingStatus = StatusIn['status']

/** A ticket's status. Back to `open` only a person's message moves it. */
export type SupportTicketStatus = 'open' | SupportClosingStatus

/** Every status an admin may set, in the order the card offers them. */
export const SUPPORT_CLOSING_STATUSES: readonly SupportClosingStatus[] = [
  'resolved',
  'rejected',
  'duplicate',
  'spam',
]

export type SupportCategory =
  'tech' | 'practices' | 'payments' | 'complaint_master' | 'complaint_user' | 'other'

/** A person as velo knows them (P-1, same shape as ChatPeer in api/chats.ts).
 *  `name` is null when the account has no name. */
export interface SupportPerson {
  user_id: string
  name: string | null
  avatar_url: string | null
}

/** A ticket as the backend describes it -- codes, never labels. `id` is the
 *  ticket's comms thread id: the key of every admin route and of the
 *  `open_admin_support__<id>` deep link. */
export interface SupportTicket {
  id: string
  topic: SupportTopicCode
  category: SupportCategory
  status: SupportTicketStatus
  created_at: string
  status_changed_at: string
}

/** A ticket as the admin list and the one-ticket read return it. `opener`
 *  is null when the person's row is gone; `history_thread_id` names the
 *  person's pre-ticket support conversation (read-only), when they have one. */
export interface AdminSupportTicket extends SupportTicket {
  opener: SupportPerson | null
  claimed_by: SupportPerson | null
  history_thread_id: string | null
}

export interface AdminSupportTicketList {
  tickets: AdminSupportTicket[]
  next_cursor: string | null
}

/** A translation's state (comms VariantState, a closed set of five):
 *  `ready` -- translated; `not_needed` -- already in the target language;
 *  `preparing` / `not_requested` -- on its way; `impossible` -- failed, or
 *  declined by the model (comms keeps a declined variant as `impossible`). */
export type SupportTranslationState =
  'ready' | 'not_needed' | 'preparing' | 'not_requested' | 'impossible'

/** BE-166: a message's translation as the admin feed describes it.
 *  On a person's message `locale` is the support language and `body` is the
 *  translation when `ready`, the original otherwise. On a reply to a person
 *  of another language `locale` is theirs and `variant_body` is what they
 *  read (when `ready`). `retryable` -- the job failed in transport, and
 *  POST .../translation/retry may ask again. */
export interface SupportTranslation {
  locale: string
  state: SupportTranslationState
  source_locale: string | null
  retryable: boolean
  variant_body?: string | null
}

/** A message of the admin feed. `original` is the author's text (admins
 *  only); `translation` is null on a reply to a person of the support
 *  language. */
export interface SupportMessage {
  id: string
  thread_id: string
  sender: string
  body: string
  original: string
  translation: SupportTranslation | null
  created_at: string
}

/** A reply as the send answers it -- comms' message, without the admin
 *  feed's `original` / `translation` (those come with the next feed read). */
export type SupportSentMessage = Omit<SupportMessage, 'original' | 'translation'>

export interface SupportRetryResult {
  message_id: string
  locale: string
  attempt: number
  state: 'preparing'
}

export interface SupportMessageList {
  messages: SupportMessage[]
  next_cursor: string | null
}

export interface SupportTicketCreated {
  ticket: SupportTicket
  message: SupportMessage
}

/** An appeal through a support form: a NEW ticket and its first message.
 *  `idempotencyKey` names the appeal -- the caller keeps it across retries of
 *  the same (topic, body) and replaces it when either changes. 422 -- unknown
 *  code, empty or over-long body. */
export function createTicket(
  topic: SupportTopicCode,
  body: string,
  idempotencyKey: string,
): Promise<SupportTicketCreated> {
  return api.post<SupportTicketCreated>(
    '/api/v1/support/tickets',
    { topic, body },
    { 'Idempotency-Key': idempotencyKey },
  )
}

/** ONE APPEAL, ONE KEY (owner ruling FE-104): a keeper that returns the
 *  Idempotency-Key for a (topic, body) -- the same key while neither changes,
 *  so a retry after a failed send is the same ticket; a fresh key once either
 *  changes, so an edited appeal is never answered with the old one (the
 *  backend would return the ticket and the message the key already names).
 *  One keeper per form instance. */
export function createAppealKeys(
  mint: () => string = newIdempotencyKey,
): (topic: SupportTopicCode, body: string) => string {
  let key: string | null = null
  let appeal = ''
  return (topic, body) => {
    const next = JSON.stringify([topic, body])
    if (key === null || next !== appeal) {
      key = mint()
      appeal = next
    }
    return key
  }
}

// -- Admin --------------------------------------------------------------------

/** The filters of the admin ticket list. `categories` is "any of these"
 *  (repeatable `category`, BE-162 fix 2); without `status` the backend
 *  returns every ticket but spam. `createdFrom` inclusive, `createdTo`
 *  exclusive -- ISO with an offset (the backend refuses one without). */
export interface AdminTicketQuery {
  categories?: readonly SupportCategory[]
  status?: SupportTicketStatus
  createdFrom?: string
  createdTo?: string
  cursor?: string
  limit?: number
}

/** Tickets, newest appeal first. */
export function listAdminTickets(query: AdminTicketQuery = {}): Promise<AdminSupportTicketList> {
  const qs = new URLSearchParams({ limit: String(query.limit ?? 20) })
  for (const c of query.categories ?? []) qs.append('category', c)
  if (query.status) qs.set('status', query.status)
  if (query.createdFrom) qs.set('created_from', query.createdFrom)
  if (query.createdTo) qs.set('created_to', query.createdTo)
  if (query.cursor) qs.set('cursor', query.cursor)
  return api.get<AdminSupportTicketList>(`/api/v1/support/tickets?${qs}`)
}

/** One ticket by its id -- the same row as in the list, spam included. 404 --
 *  no such ticket (a person's history thread included). */
export function getAdminTicket(ticketId: string): Promise<AdminSupportTicket> {
  return api.get<AdminSupportTicket>(`/api/v1/support/tickets/${ticketId}`)
}

/** Move an OPEN ticket to a closing status. Returns the ticket without the
 *  admin-only fields (opener, claimed_by, history_thread_id). 409 -- the
 *  ticket is no longer open or changed meanwhile: read it again. */
export function setTicketStatus(
  ticketId: string,
  status: SupportClosingStatus,
): Promise<SupportTicket> {
  return api.post<SupportTicket>(`/api/v1/support/tickets/${ticketId}/status`, { status })
}

// -- The handover (BE-162 delivery 2) -----------------------------------------
//
// All three answer the ticket's FULL row -- the same as GET /tickets/{id},
// admin fields included -- so the card takes the answer as its new truth
// without a second read (unlike setTicketStatus, whose answer is thin).

/** Hand the ticket to another admin. `assignee` is the admin's user id.
 *  422 -- the assignee is not an admin; 409 -- the ticket changed hands
 *  meanwhile or is a history thread; 404 -- not a ticket. */
export function assignTicket(ticketId: string, assignee: string): Promise<AdminSupportTicket> {
  return api.post<AdminSupportTicket>(`/api/v1/support/tickets/${ticketId}/assign`, { assignee })
}

/** Return the ticket to the pool (nobody holds it; every admin may reply
 *  again). 409 -- changed hands meanwhile or a history thread; 404 -- not a
 *  ticket. */
export function releaseTicket(ticketId: string): Promise<AdminSupportTicket> {
  return api.post<AdminSupportTicket>(`/api/v1/support/tickets/${ticketId}/release`)
}

/** Back to OPEN: «вернуть в работу» from resolved / rejected / duplicate,
 *  «не спам» from spam within the retention -- one route for both. 409 --
 *  open already, spam past the retention, or changed meanwhile; 404 -- gone
 *  (the spam bin emptied it). */
export function reopenTicket(ticketId: string): Promise<AdminSupportTicket> {
  return api.post<AdminSupportTicket>(`/api/v1/support/tickets/${ticketId}/reopen`)
}

/** How long a spam verdict keeps the ticket recoverable (owner ruling: 30
 *  days; backend settings.support_spam_retention_days). Past it the bin
 *  deletes the ticket with its conversation. */
export const SUPPORT_SPAM_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** May this spam ticket still come back («Не спам»)? True while the verdict
 *  is STRICTLY younger than the retention -- the backend refuses a verdict
 *  exactly at the cutoff (`status_changed_at <= cutoff` is a 409), so the
 *  offer disappears on the same edge. */
export function spamWithinRetention(statusChangedAt: string, now: number = Date.now()): boolean {
  const changed = Date.parse(statusChangedAt)
  return Number.isFinite(changed) && changed > now - SUPPORT_SPAM_RETENTION_MS
}

/** A support thread's feed, newest-first: a ticket, or a person's history.
 *  Read access is universal for admins -- no claim required. 404s if
 *  `threadId` does not name a known support thread. */
export function getAdminSupportMessages(
  threadId: string,
  limit = 50,
  cursor?: string,
): Promise<SupportMessageList> {
  const qs = new URLSearchParams({ limit: String(limit) })
  if (cursor) qs.set('cursor', cursor)
  return api.get<SupportMessageList>(`/api/v1/support/threads/${threadId}/messages?${qs}`)
}

/** Reply as this admin, in a ticket. Throws ApiResponseError(403) -- via
 *  useApiError -- when the caller has not claimed it; comms' own refusal. */
export function sendAdminSupportReply(threadId: string, body: string): Promise<SupportSentMessage> {
  return api.post<SupportSentMessage>(`/api/v1/support/threads/${threadId}/messages`, { body })
}

/** Take a ticket -- the act that grants the right to reply. A repeat of your
 *  own claim is 200 again; held by another admin -> 409. The answer (comms'
 *  thread) is not read: the card reads the ticket again (getAdminTicket), so
 *  who holds it is always velo's `claimed_by`. */
export function claimSupportThread(threadId: string): Promise<unknown> {
  return api.post<unknown>(`/api/v1/support/threads/${threadId}/claim`, {})
}

/** Ask again for a message whose translation job failed in transport
 *  (`translation.retryable`). 409 -- nothing to retry (in progress, done,
 *  declined); 404 -- the message is not in the pages the backend searches. */
export function retrySupportTranslation(
  threadId: string,
  messageId: string,
): Promise<SupportRetryResult> {
  return api.post<SupportRetryResult>(
    `/api/v1/support/threads/${threadId}/messages/${messageId}/translation/retry`,
    {},
  )
}
