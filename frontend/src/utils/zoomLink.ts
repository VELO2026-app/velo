// =============================================================================
// VELO Frontend -- Zoom link ladder (T21-1, ПРОМТ №541, owner decision D3;
// A4 V2, ПРОМТ №572)
// =============================================================================
//
// One place for the rule every Zoom entry point (user dashboard, practice-
// live, master dashboard) must follow, in this exact order:
//   1. the person's OWN registrant join_url (the ?tk= personal link) --
//      the only link Zoom will ever associate with them for attendance.
//   2. the manual Practice.zoom_link fallback -- ONLY if 1 is absent, and
//      the caller MUST mark it visibly distinct (attendance is not counted
//      for this state -- D1).
//   3. neither exists yet, and the meeting is PERMANENTLY failed
//      (ZoomMeetingStatus.create_failed) -- an honest "did not work" state,
//      distinct from state 4. Before A4 V2, this and state 4 were the SAME
//      "pending" state: a master or participant had no way to tell "still
//      being created" apart from "will never exist unless someone acts" --
//      commit 1317525 (series children created in the background) made
//      create_failed a routine, not rare, occurrence, and the admin was the
//      ONLY role who could already see it (admin/practices zoom_meeting_
//      status), never the two people who actually needed to know.
//   4. neither exists yet, meeting still pending_creation (or no
//      ZoomMeeting row at all) -- an honest "being prepared" state.
//
// A SILENT FALL-THROUGH TO STATE 2 IS FORBIDDEN: the whole defect being
// fixed is a user joining by a shared link with nothing telling them their
// attendance won't be recorded. `kind` exists so callers cannot skip that.
// =============================================================================

export type ZoomLinkKind = 'personal' | 'manual' | 'pending' | 'failed'

export interface ZoomLinkResolution {
  kind: ZoomLinkKind
  url: string | null
}

function isValidHttpsUrl(value: string | null | undefined): value is string {
  return !!value && value.startsWith('https://')
}

/** Resolve which link (if any) a Zoom entry point should offer right now.
 *
 * meetingStatus (A4 V2, ПРОМТ №572): PracticeResponse/PracticeSummary's
 * zoom_meeting_status verbatim -- 'create_failed' is the only value that
 * changes the outcome (-> kind 'failed' when neither link is available).
 * Every other value (including undefined/null, e.g. a caller that has not
 * been updated yet, or a genuinely pre-E21 practice) falls through to the
 * existing 'pending' state -- backward compatible by construction, not by
 * special-casing every other status string. */
export function resolveZoomLink(
  personalJoinUrl: string | null | undefined,
  manualZoomLink: string | null | undefined,
  meetingStatus?: string | null,
): ZoomLinkResolution {
  if (isValidHttpsUrl(personalJoinUrl)) {
    return { kind: 'personal', url: personalJoinUrl }
  }
  if (isValidHttpsUrl(manualZoomLink)) {
    return { kind: 'manual', url: manualZoomLink }
  }
  if (meetingStatus === 'create_failed') {
    return { kind: 'failed', url: null }
  }
  return { kind: 'pending', url: null }
}
