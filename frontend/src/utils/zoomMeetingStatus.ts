// =============================================================================
// VELO Frontend -- how a Zoom meeting status reads (FE-262)
// =============================================================================
//
// `zoom_meeting_status` of GET /admin/practices/{id}/zoom-attendance, as the
// web console shows it: a tone per status. The words live in the console's
// catalogs.
//
// `null` -- no ZoomMeeting row was ever made for the practice. A status not
// listed here is shown as it came, in the quiet tone.
// =============================================================================

/**
 * The tone of each Zoom meeting status: active is good, a failed creation is
 * bad, a creation still to come (a series child, made by the retry poller)
 * and a deleted meeting are quiet.
 */
export const ZOOM_MEETING_TONES = {
  active: 'success',
  pending_creation: 'muted',
  create_failed: 'error',
  deleted: 'muted',
} as const

/** A Zoom meeting status the admin screens have a tone and a word for. */
export type ZoomMeetingStatus = keyof typeof ZOOM_MEETING_TONES

/** Whether a status string is one of the known Zoom meeting statuses. */
export function isZoomMeetingStatus(status: string): status is ZoomMeetingStatus {
  return Object.hasOwn(ZOOM_MEETING_TONES, status)
}
