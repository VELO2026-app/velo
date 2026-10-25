// =============================================================================
// VELO Frontend -- Chats-list row derivations (BE-163 / BE-166)
// =============================================================================
//
// Pure display derivations for one GET /api/v1/chats row, shared by
// UserMessagesView and MasterMessagesView (the row component itself stays
// content-agnostic). Two questions a row answers:
//   chatRowTime    -- the row's clock corner: today -> HH:MM, older -> DD.MM.
//                     Device-local wall clock (a conversation time, not a
//                     practice in its own timezone -- no tz param).
//   chatRowPreview -- the newest-message line. A support feed may carry
//                     body: null (BE-166: the reader must not see an admin's
//                     reply in the original language) -- the translation
//                     state is the wording then. Own/same-language messages
//                     and `chat` feeds are plain strings.
// =============================================================================

import { getLocale, t } from '@/locales'
import type { ChatThread } from '@/api/chats'

export function chatRowTime(thread: ChatThread): string {
  const iso = thread.last_message_at ?? thread.created_at
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (sameDay) return d.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString(getLocale(), { day: '2-digit', month: '2-digit' })
}

export function chatRowPreview(thread: ChatThread): string {
  const last = thread.last_message
  if (!last) return ''
  if (last.body !== null) return last.body
  if (last.translation === 'translating') return t('chat.translating')
  if (last.translation === 'unavailable') return t('chat.translationUnavailable')
  return ''
}
