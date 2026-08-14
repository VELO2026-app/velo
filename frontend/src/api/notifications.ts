// =============================================================================
// VELO Frontend -- Notifications API (Phase 6 / T1; inbox added T-26 bell)
// =============================================================================
//
// Typed wrappers over the comms proxy (backend
// app/modules/comms_proxy/router.py). The backend authenticates the
// session and stamps recipient_id server-side -- the client never
// names a recipient.
//
// Backend endpoints used:
//   GET  /api/v1/notifications                  -- the bell feed: newest-
//       first page + the unread badge IN THE SAME response (comms
//       app/api/inbox.py:14-30 -- verified at the source, T-26 recon
//       №703). There is deliberately no separate unread-count wrapper
//       here: nothing in this app needs the badge without the list.
//   POST /api/v1/notifications/{id}/read         -- mark one read;
//       idempotent, returns the fresh badge.
//   POST /api/v1/notifications/read-all          -- mark every unread
//       read; returns the fresh badge (always 0).
//   GET  /api/v1/notifications/prefs -- E8 facade: category toggles +
//       DELIVERY-window schedule (the proxy already converted the
//       comms quiet-window semantics) + read-only timezone
//   PUT  /api/v1/notifications/prefs -- partial write: only the parts
//       sent change; schedule is a full replace when present
//
// Types are hand-written (not generated.ts): the shapes are the comms
// contracts passed through, owned by comms rather than the velo
// OpenAPI schema.
// =============================================================================

import { api } from '@/api/client'

/** One bell item (comms app/api/inbox.py `_serialize_item`, frozen). Every
 *  key below is ALWAYS present on the wire; `action_data` and `read_at` are
 *  the two that may be null. `action_data` is the navigational intent --
 *  DELIBERATELY UNUSED here (see MasterInboxView.vue header): no screen in
 *  this app reads it yet, so a tap marks the item read and stops. */
export interface NotificationItem {
  id: string
  type: string
  title: string
  body: string
  action_data: { action: string; params: Record<string, unknown> } | null
  priority: number
  sent_at: string
  read_at: string | null
  created_at: string
}

export interface NotificationList {
  items: NotificationItem[]
  /** Opaque keyset cursor for the next page. UNUSED in v1 -- the bell loads
   *  one page (comms default limit 20) and does not paginate; a "load more"
   *  is future scope, not an oversight. */
  next_cursor: string | null
  unread: number
}

export interface NotificationUnread {
  unread: number
}

export function listNotifications(cursor?: string): Promise<NotificationList> {
  const qs = new URLSearchParams()
  if (cursor) qs.set('cursor', cursor)
  const suffix = qs.toString() ? `?${qs}` : ''
  return api.get<NotificationList>(`/api/v1/notifications${suffix}`)
}

export function markNotificationRead(id: string): Promise<NotificationUnread> {
  return api.post<NotificationUnread>(`/api/v1/notifications/${id}/read`, {})
}

export function markAllNotificationsRead(): Promise<NotificationUnread> {
  return api.post<NotificationUnread>('/api/v1/notifications/read-all', {})
}

/** Category keys the VELO profile declares (comms-profile/types.yaml).
 *  The facade emits one boolean per declared category; unknown future
 *  categories flow through untouched. */
export interface NotificationPrefsResponse {
  categories: Record<string, boolean>
  schedule: { from: string; to: string; days: string[] } | null
  timezone: string | null
}

export interface NotificationPrefsUpdate {
  categories?: Record<string, boolean>
  schedule?: { from: string; to: string; days: string[] } | null
}

export function getNotificationPrefs(): Promise<NotificationPrefsResponse> {
  return api.get<NotificationPrefsResponse>('/api/v1/notifications/prefs')
}

export function updateNotificationPrefs(
  body: NotificationPrefsUpdate,
): Promise<NotificationPrefsResponse> {
  return api.put<NotificationPrefsResponse>('/api/v1/notifications/prefs', body)
}
