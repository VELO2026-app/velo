// =============================================================================
// VELO Frontend -- Notification preferences API (Phase 6 / T1)
// =============================================================================
//
// Typed wrappers over the comms proxy (backend
// app/modules/comms_proxy/router.py). The backend authenticates the
// session and stamps recipient_id server-side -- the client never
// names a recipient.
//
// Backend endpoints used:
//   GET /api/v1/notifications/prefs -- E8 facade: category toggles +
//       DELIVERY-window schedule (the proxy already converted the
//       comms quiet-window semantics) + read-only timezone
//   PUT /api/v1/notifications/prefs -- partial write: only the parts
//       sent change; schedule is a full replace when present
//
// Types are hand-written (not generated.ts): the shape is the comms
// prefs facade passed through, owned by the comms 3b contract rather
// than the velo OpenAPI schema.
// =============================================================================

import { api } from '@/api/client'

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
  return api.put<NotificationPrefsResponse>(
    '/api/v1/notifications/prefs',
    body,
  )
}
