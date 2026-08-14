// =============================================================================
// VELO Frontend -- Support API (B34, PROMPT №712; admin surface PROMPT №713)
// =============================================================================
//
// Typed wrappers over the support proxy (backend app/modules/support/router.py).
// Owner ruling (option B, 2026-08-14): the topic-picker forms stay the entry;
// submitting OPENS the caller's one eternal support thread and delivers the
// topic + message as its first (or next) message. Two calls, same shape as
// the chats module's own open-then-send split (api/chats.ts) -- opening is
// idempotent and cheap to call on every submit, sending is the actual event.
//
// PROMPT №713 adds the ADMIN half: list every support thread (opener identity
// + topic attached server-side), read one thread's feed, reply, and claim.
// Claiming is what grants the right to reply -- comms itself enforces this
// (client or assignee only, no supervisor bypass), so a reply against an
// unclaimed thread 403s (comms' own error, forwarded, not a generic
// "service unavailable" -- see backend/app/core/comms.py's forward_403).
//
// Types are hand-written, same precedent as chats.ts / notifications.ts: the
// shape is the comms 3b contract passed through the proxy, not the velo
// OpenAPI schema (generated.ts does not cover this module).
// =============================================================================

import { api } from '@/api/client'

/** The thread opener's display identity (P-1, same shape as ChatPeer in
 *  api/chats.ts). Attached only on the admin listing -- null when the
 *  client id could not be resolved to a User row (degrade, not break). */
export interface SupportOpener {
  user_id: string
  name: string | null
  avatar_url: string | null
}

export interface SupportThread {
  id: string
  client: string
  operator_kind: string
  operator_value: string
  assignee: string | null
  kind: string
  status: string
  subject_type: string | null
  subject_id: string | null
  /** The topic label, set once at creation (service.py::open_support_thread)
   *  -- the only channel that reaches a LIST view without fetching a feed. */
  title: string | null
  priority: number | null
  last_message_at: string | null
  created_at: string
  /** Admin-listing only. */
  opener?: SupportOpener | null
}

export interface SupportThreadList {
  threads: SupportThread[]
  next_cursor: string | null
}

export interface SupportMessage {
  id: string
  thread_id: string
  sender: string
  body: string
  created_at: string
}

export interface SupportMessageList {
  messages: SupportMessage[]
  next_cursor: string | null
}

export interface SupportClaimResult {
  claimed: boolean
  thread: SupportThread
}

/** Open (or return) the caller's support thread. `topic` is optional and
 *  only enriches the admin-group notification fired on genuine creation --
 *  it is not required and has no effect on a reopen. */
export function openSupportThread(topic?: string): Promise<SupportThread> {
  return api.post<SupportThread>('/api/v1/support/threads', topic ? { topic } : {})
}

/** Deliver one message into the caller's support thread (must already be
 *  open). `topic` is prefixed onto the message text server-side so it is
 *  readable by whichever admin opens the thread. */
export function sendSupportMessage(topic: string | null, body: string): Promise<SupportMessage> {
  return api.post<SupportMessage>('/api/v1/support/threads/messages', { topic, body })
}

// -- Admin (PROMPT №713) ------------------------------------------------------

/** Every support thread, section-scoped, opener identity attached. Admin-only
 *  server-side (get_current_admin) -- `is_supervisor`/`operator` are never
 *  parameters here, there is nothing to forward. */
export function listAdminSupportThreads(limit = 20, cursor?: string): Promise<SupportThreadList> {
  const qs = new URLSearchParams({ limit: String(limit) })
  if (cursor) qs.set('cursor', cursor)
  return api.get<SupportThreadList>(`/api/v1/support/threads?${qs}`)
}

/** A support thread's feed, newest-first. Read access is universal for
 *  admins (owner ruling) -- no claim required. 404s if `threadId` does not
 *  name a known support thread. */
export function getAdminSupportMessages(
  threadId: string,
  limit = 50,
  cursor?: string,
): Promise<SupportMessageList> {
  const qs = new URLSearchParams({ limit: String(limit) })
  if (cursor) qs.set('cursor', cursor)
  return api.get<SupportMessageList>(`/api/v1/support/threads/${threadId}/messages?${qs}`)
}

/** Reply as this admin. Throws ApiResponseError(403) -- via useApiError --
 *  when the caller has not claimed the thread; comms' own refusal, not ours. */
export function sendAdminSupportReply(threadId: string, body: string): Promise<SupportMessage> {
  return api.post<SupportMessage>(`/api/v1/support/threads/${threadId}/messages`, { body })
}

/** Claim an unclaimed thread -- the act that grants the right to reply.
 *  `claimed: false` means someone else won the race, not an error. */
export function claimSupportThread(threadId: string): Promise<SupportClaimResult> {
  return api.post<SupportClaimResult>(`/api/v1/support/threads/${threadId}/claim`, {})
}
