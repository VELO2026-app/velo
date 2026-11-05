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
//   2. unavailable -- not ready and the registrant's personal link will NOT
//      come (FE-91, BookingWithPracticeResponse.zoom_registrant_link_
//      unavailable -- backend zoom/service.py's link_unavailable_reason, the
//      same predicate the resolver answers kind:'unavailable' from): the
//      registrant exhausted its retries or Zoom answered without a link, and
//      nothing retries it. The meeting itself EXISTS (the backend only sets
//      the flag for a registrant of an ACTIVE meeting) -- so this is neither
//      'failed' («the meeting was not created») nor 'pending' («the link may
//      still come»). Waiting is pointless; the row says so.
//   3. failed  -- not ready and the meeting is PERMANENTLY failed
//      (ZoomMeetingStatus.create_failed): waiting is pointless until the
//      master retries. Kept distinct from 4 by A4 V2 -- create_failed is
//      routine (series children are created in the background), and before
//      that both rendered the same "still preparing" spinner forever.
//   4. pending -- not ready yet, meeting still pending_creation (or no
//      ZoomMeeting row at all): an honest "being prepared".
// =============================================================================

/**
 * Whether a list row's Zoom entry is ready, still being prepared, permanently
 * failed, or known never to become ready (the personal link will not come).
 */
export type ZoomEntryStateKind = 'ready' | 'pending' | 'failed' | 'unavailable'

/** Name the Zoom entry state of one list row.
 *
 * @param ready - Whether the row can be entered (see the header for what that
 *  means per role). Anything but `true` -- false, undefined (a fixture
 *  without the field), null -- is not ready.
 *
 * @param linkUnavailable - BookingWithPracticeResponse.zoom_registrant_link_
 *  unavailable verbatim -- `true` means this registrant's personal link will
 *  never arrive, which names the row 'unavailable' (FE-91). Only `true`
 *  counts; false/undefined/null (a fixture without the field, or the master's
 *  practice rows, which carry no personal registrant) leave the outcome as it
 *  was.
 *
 * @param meetingStatus - PracticeResponse/PracticeSummary's
 *  zoom_meeting_status verbatim -- 'create_failed' is the only value that
 *  changes the outcome of a not-ready row (`-> 'failed'`). Every other
 *  value, including undefined/null, falls through to 'pending'. The server
 *  never sets the flag on a create_failed meeting (the flag's query joins on
 *  an ACTIVE meeting), so the two branches cannot both fire for one real row.
 */
export function zoomEntryState(
  ready: boolean | null | undefined,
  meetingStatus?: string | null,
  linkUnavailable?: boolean | null,
): ZoomEntryStateKind {
  if (ready === true) return 'ready'
  if (linkUnavailable === true) return 'unavailable'
  if (meetingStatus === 'create_failed') return 'failed'
  return 'pending'
}
