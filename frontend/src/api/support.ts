// =============================================================================
// VELO Frontend -- Support API (B34, PROMPT №712)
// =============================================================================
//
// Typed wrappers over the support proxy (backend app/modules/support/router.py).
// Owner ruling (option B, 2026-08-14): the topic-picker forms stay the entry;
// submitting OPENS the caller's one eternal support thread and delivers the
// topic + message as its first (or next) message. Two calls, same shape as
// the chats module's own open-then-send split (api/chats.ts) -- opening is
// idempotent and cheap to call on every submit, sending is the actual event.
//
// Types are hand-written, same precedent as chats.ts / notifications.ts: the
// shape is the comms 3b contract passed through the proxy, not the velo
// OpenAPI schema (generated.ts does not cover this module).
// =============================================================================

import { api } from '@/api/client'

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
  title: string | null
  priority: number | null
  last_message_at: string | null
  created_at: string
}

export interface SupportMessage {
  id: string
  thread_id: string
  sender: string
  body: string
  created_at: string
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
