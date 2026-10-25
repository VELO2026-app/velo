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
//   POST /api/v1/chats/students               -- the SAME thread, master-side:
//        open-or-get the DM with one student (T3). 403 unless the caller is
//        a verified master; the pair is directed server-side (student =
//        client, master = operator) no matter who tapped first.
//   GET  /api/v1/chats                        -- my conversations. Every role
//        gets {threads, next_cursor} ordered last-message-first (BE-163);
//        rows carry the P-1 `peer` display block, so no per-row name lookups
//        here, plus `channel` and the row's own `last_message` preview.
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

/** BE-163: `"chat"` is a person-to-person DM, `"support"` the caller's own
 *  support conversation (peer is always null there -- the row shows the
 *  VELO logo and «Поддержка VELO» instead). */
export type ChatChannel = 'chat' | 'support'

/** BE-166 translation state, attached to support-channel messages. `null`
 *  pairs with a string `body`; the two word-states replace a body the caller
 *  must not read in the original language (the backend sends `body: null`
 *  for them). Absent entirely on `chat` feeds -- that shape is unchanged. */
export type ChatTranslation = 'translating' | 'unavailable'

/** The row/feed preview of the newest message. `body` is null exactly when
 *  the translation state speaks instead (own messages and same-language
 *  messages are always plain strings). */
export interface ChatLastMessage {
  id: string
  sender: string
  created_at: string
  body: string | null
  translation: ChatTranslation | null
}

/** One conversation (BE-163 shape, live on `test` since 6a31aa6). Both roles
 *  get the same row now; `chat` rows additionally carry the comms fields
 *  (client / operator_value / operator_kind / assignee / kind / status /
 *  title) -- more of them than the student's list used to have. */
export interface ChatThread {
  id: string
  channel: ChatChannel
  created_at: string
  /** Display time of the row: last_message.created_at, else created_at --
   *  the backend computes it, the view renders it as-is. */
  last_message_at?: string | null
  /** Newest message, or null for a thread that has none yet. */
  last_message: ChatLastMessage | null
  peer?: ChatPeer | null
  /** `support` rows only (BE-162): every support thread of the caller -- a
   *  ticket each, plus the pre-ticket history -- shown as this ONE row. `id`
   *  is the most recently active of them; a push or a notice names a
   *  SPECIFIC one, so a row is found by `id` or by membership here. */
  thread_ids?: string[]
  /** Student's list: the master's user id. */
  operator_value?: string
  /** Master's list (comms shape): the client's user id. */
  client?: string
  kind?: string
  status?: string
  title?: string | null
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
  created_at: string
  /** A support feed may carry body: null for an admin reply in a language
   *  the reader does not speak (BE-166) -- `translation` says which state
   *  replaces the text. Own messages and `chat` feeds are always strings. */
  body: string | null
  /** Absent on `chat` feeds (the legacy shape, no translation column). */
  translation?: ChatTranslation | null
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

/** Master-side twin of openChat (POST /chats/students, T3): open-or-get the
 *  SAME eternal DM with one student. The pair is directed server-side
 *  (student=client, master=operator), so this lands in the thread the
 *  student's own openChat would return -- one conversation per pair, never
 *  two. */
export function openStudentChat(studentId: string): Promise<ChatThread> {
  return api.post<ChatThread>('/api/v1/chats/students', { student_id: studentId })
}

export function listChats(limit = 100): Promise<ChatThreadList> {
  return api.get<ChatThreadList>(`/api/v1/chats?limit=${limit}`)
}

/** The row a thread id opens: the row itself, or -- for a `support` row --
 *  any of the caller's support threads it stands for (`thread_ids`). A push
 *  (`open_thread`) and the "translation unavailable" notice name the thread
 *  the message is in, which need not be the row's newest one. */
export function chatRowFor(threads: ChatThread[], threadId: string): ChatThread | undefined {
  return threads.find((t) => t.id === threadId || t.thread_ids?.includes(threadId))
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

/** RFC4122 v4 uuid for the Idempotency-Key header (BE-163). crypto.randomUUID
 *  exists in every webview VELO targets; the fallback keeps runtimes without
 *  it honest instead of crashy. Exported for senders that retry the SAME
 *  logical message after a failed attempt. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

/** BE-163: the send carries an Idempotency-Key -- the backend dedups on it,
 *  so one logical message can never land twice. Default is a fresh key per
 *  call; a caller RETRYING the same message (send failed, draft kept) must
 *  pass the key of the failed attempt back in. */
export function sendChatMessage(
  threadId: string,
  body: string,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<ChatMessage> {
  return api.post<ChatMessage>(
    `/api/v1/chats/${threadId}/messages`,
    { body },
    { 'Idempotency-Key': idempotencyKey },
  )
}

export function markChatRead(threadId: string): Promise<ChatUnread> {
  return api.post<ChatUnread>(`/api/v1/chats/${threadId}/read`, {})
}

export function getChatUnreadSummary(): Promise<ChatUnreadSummary> {
  return api.get<ChatUnreadSummary>('/api/v1/chats/unread-summary')
}
