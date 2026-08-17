// =============================================================================
// VELO Frontend -- Chats API (Phase 6 / T2, H-T2-UI)
// =============================================================================
//
// Typed wrappers over the chat proxy (backend app/modules/chats/router.py,
// seam ID-9 + ID-11). The backend authenticates the session and stamps
// every actor (client / sender / participant / operator) server-side -- the
// frontend never names one, and a request that tries is rejected with 400.
//
// Backend endpoints used (six of the nine 3b verbs; claim/status/retag wait
// for the support UI):
//   POST /api/v1/chats                        -- open-or-get the eternal DM
//        with one VERIFIED master (comms dedups on the pair; safe to call
//        on every entry). 404 when the target isn't a verified master.
//   GET  /api/v1/chats                        -- my conversations. A student
//        gets local pointers, a master the comms operator list; BOTH carry
//        the P-1 `peer` display block, so no per-row name lookups here.
//   POST /api/v1/chats/{id}/messages          -- send; returns the message.
//   GET  /api/v1/chats/{id}/messages          -- NEWEST-FIRST, keyset-
//        paginated feed {messages, next_cursor}.
//   POST /api/v1/chats/{id}/read              -- advance MY read pointer;
//        returns the fresh {unread} for the same thread.
//   GET  /api/v1/chats/{id}/unread-count      -- cheap badge poll {unread}.
//
// A forged/foreign thread id is 404 on every thread route (never 403 --
// existence must not leak).
//
// Types are hand-written (not generated.ts), same precedent as
// notifications.ts: the shapes are the comms 3b contract passed through
// (comms app/api/messaging.py serializers) plus the proxy's own additions
// (student list rows, `peer`), owned by that contract rather than the velo
// OpenAPI schema.
// =============================================================================

import { api } from '@/api/client'

/** P-1 display block: the counterparty as velo knows them. `name` is
 *  "First Last" from Telegram fields and may be null -- the VIEW owns the
 *  role-appropriate fallback («Мастер» / «Ученик»). null peer = the proxy
 *  could not resolve the user at all (degrade, don't break the row). */
export interface ChatPeer {
  user_id: string
  name: string | null
  avatar_url: string | null
}

/** One conversation. The comms serializer's full shape arrives for a
 *  master; a student's local-pointer rows carry only id / operator_value /
 *  created_at (+ peer) -- hence the optionals. */
export interface ChatThread {
  id: string
  created_at: string
  peer?: ChatPeer | null
  /** Student's list: the master's user id. */
  operator_value?: string
  /** Master's list (comms shape): the client's user id. */
  client?: string
  kind?: string
  status?: string
  last_message_at?: string | null
  /** Unread for the CALLER, attached by the backend list (T-51).
   *
   *  OPTIONAL ON PURPOSE, and the absence carries meaning: the key is
   *  missing on a row the caller takes no part in -- for a master, an
   *  unclaimed support thread sitting in the shared pool. Zero means "your
   *  thread, nothing to read". Do not default it to 0 here; default at the
   *  render site, so the two states stay distinguishable in code that
   *  cares. Also absent for every row when comms is unreachable: no badge
   *  beats a false badge. */
  unread?: number
}

export interface ChatThreadList {
  threads: ChatThread[]
  next_cursor: string | null
}

export interface ChatMessage {
  id: string
  thread_id: string
  sender: string
  body: string
  created_at: string
}

/** Newest-first page of a thread's feed. */
export interface ChatMessageList {
  messages: ChatMessage[]
  next_cursor: string | null
}

export interface ChatUnread {
  unread: number
}

/** Caller's unread state across every conversation (GET /chats/unread-summary).
 *
 *  `unread_messages` powers the master hub badge. The student profile does
 *  NOT use this: its dot rides inline on bookings /me/stats, because B52
 *  rules that screen to exactly one request. See the endpoint docstring. */
export interface ChatUnreadSummary {
  has_unread: boolean
  threads_with_unread: number
  unread_messages: number
}

export function openChat(masterId: string): Promise<ChatThread> {
  return api.post<ChatThread>('/api/v1/chats', { master_id: masterId })
}

export function listChats(limit = 100): Promise<ChatThreadList> {
  return api.get<ChatThreadList>(`/api/v1/chats?limit=${limit}`)
}

export function listChatMessages(
  threadId: string,
  limit = 100,
  cursor?: string,
): Promise<ChatMessageList> {
  const qs = new URLSearchParams({ limit: String(limit) })
  if (cursor) qs.set('cursor', cursor)
  return api.get<ChatMessageList>(`/api/v1/chats/${threadId}/messages?${qs}`)
}

export function sendChatMessage(threadId: string, body: string): Promise<ChatMessage> {
  return api.post<ChatMessage>(`/api/v1/chats/${threadId}/messages`, { body })
}

export function markChatRead(threadId: string): Promise<ChatUnread> {
  return api.post<ChatUnread>(`/api/v1/chats/${threadId}/read`, {})
}

export function getChatUnreadSummary(): Promise<ChatUnreadSummary> {
  return api.get<ChatUnreadSummary>('/api/v1/chats/unread-summary')
}
