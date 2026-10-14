// =============================================================================
// VELO Frontend -- Zoom entry state of a list row (T21-1, PROMPT №541;
// A4 V2, PROMPT №572; T-35; Standalone F4)
// =============================================================================
//
// WHAT THIS USED TO BE. utils/zoomLink.ts chose between Zoom URLs (T21-1),
// then -- after T-35 removed the manual rung -- named the state of the ONE
// personal link a list row carried. Standalone F4 removed the link itself:
// nobody is sent to a Zoom URL any more. The person enters on the practice
// screen through the Meeting SDK, and a list row only needs to know WHETHER
// he can, to enable its «Zoom» button. Hence the new name: there is no link
// here to name.
//
// THE REAL DECISION LIVES ON THE SERVER: GET /practices/{id}/zoom/resolve
// (zoom/service.py's resolve_zoom_entry) is what the practice screen asks,
// and POST .../zoom/sdk-join is what actually lets a person in. This helper
// never lets anybody in; it only keeps a list button honest.
//
// States:
//   1. ready   -- the row can be entered: a student's own registrant has an
//      entry token (BookingWithPracticeResponse.zoom_registrant_ready); for
//      the master's own practice, the meeting is ACTIVE.
//   2. failed  -- not ready and the meeting is PERMANENTLY failed
//      (ZoomMeetingStatus.create_failed): waiting is pointless until the
//      master retries. Kept distinct from 3 by A4 V2 -- create_failed is
//      routine (series children are created in the background), and before
//      that both rendered the same «готовится» spinner forever.
//   3. pending -- not ready yet, meeting still pending_creation (or no
//      ZoomMeeting row at all): an honest "being prepared".
// =============================================================================

export type ZoomEntryStateKind = 'ready' | 'pending' | 'failed'

/** Name the Zoom entry state of one list row.
 *
 * ready: whether the row can be entered (see the header for what that means
 * per role). Anything but `true` -- false, undefined (a fixture without the
 * field), null -- is not ready.
 *
 * meetingStatus: PracticeResponse/PracticeSummary's zoom_meeting_status
 * verbatim -- 'create_failed' is the only value that changes the outcome of
 * a not-ready row (-> 'failed'). Every other value, including
 * undefined/null, falls through to 'pending'.
 */
export function zoomEntryState(
  ready: boolean | null | undefined,
  meetingStatus?: string | null,
): ZoomEntryStateKind {
  if (ready === true) return 'ready'
  if (meetingStatus === 'create_failed') return 'failed'
  return 'pending'
}
