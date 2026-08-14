// =============================================================================
// VELO Frontend -- Zoom link ladder, list-view remnant (T21-1, PROMPT №541;
// A4 V2, PROMPT №572; SHRUNK BY T-35)
// =============================================================================
//
// WHAT THIS USED TO BE, AND WHY IT IS SMALLER NOW.
//
// This file was the CHOICE between two different Zoom URLs -- the person's own
// registrant link, or the manually-entered Practice.zoom_link -- and therefore
// a rule every entry point had to remember to follow. A client-side rule
// cannot be enforced by construction, which was the second defect T-35 set out
// to close (the first being a booked student joining by a shared link and
// being recorded NO_SHOW).
//
// T-35 removed the manual rung entirely, column and all. What remains is not a
// ladder: there is ONE link or there is none, so there is nothing left to
// choose wrongly. This function now only NAMES THE STATE for list views that
// already hold the personal link in their page payload (the user dashboard and
// the master dashboard) -- keeping them free of a per-row round trip.
//
// THE REAL DECISION LIVES ON THE SERVER: GET /practices/{id}/zoom/resolve
// (zoom/service.py's resolve_zoom_entry), which is what a single-practice
// screen asks, and the only thing that can answer "personal, guest, or
// neither" for a specific person.
//
// States:
//   1. personal -- the person's OWN registrant join_url, the only link Zoom
//      will ever associate with them for attendance.
//   2. failed  -- no link and the meeting is PERMANENTLY failed
//      (ZoomMeetingStatus.create_failed): waiting is pointless until the
//      master retries. Kept distinct from 3 by A4 V2 -- commit 1317525 made
//      create_failed routine (series children are created in the background),
//      and before that both rendered the same "готовится" spinner forever.
//   3. pending -- no link yet, meeting still pending_creation (or no
//      ZoomMeeting row at all): an honest "being prepared".
// =============================================================================

export type ZoomLinkKind = 'personal' | 'pending' | 'failed'

export interface ZoomLinkResolution {
  kind: ZoomLinkKind
  url: string | null
}

function isValidHttpsUrl(value: string | null | undefined): value is string {
  return !!value && value.startsWith('https://')
}

/** Name the Zoom state of one list row.
 *
 * meetingStatus: PracticeResponse/PracticeSummary's zoom_meeting_status
 * verbatim -- 'create_failed' is the only value that changes the outcome
 * (-> 'failed' when no link is available). Every other value, including
 * undefined/null, falls through to 'pending'.
 */
export function resolveZoomLink(
  personalJoinUrl: string | null | undefined,
  meetingStatus?: string | null,
): ZoomLinkResolution {
  if (isValidHttpsUrl(personalJoinUrl)) {
    return { kind: 'personal', url: personalJoinUrl }
  }
  if (meetingStatus === 'create_failed') {
    return { kind: 'failed', url: null }
  }
  return { kind: 'pending', url: null }
}
