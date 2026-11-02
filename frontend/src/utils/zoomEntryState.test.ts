// =============================================================================
// VELO Frontend -- zoomEntryState.ts Unit Tests
// =============================================================================
//
// Standalone F4: this was zoomLink.test.ts. Its cases checked a personal URL
// (https only, never javascript:, empty string = none). The URL is gone from
// the API -- a row carries a ready flag -- so the URL-shape cases have no
// input left to guard; their purpose (a list button never opens a bad link)
// is now structural: the button opens no link at all, it routes to the
// practice screen. The state cases are kept one for one.
//
// The real decision -- personal / guest / host / pending / failed / cancelled
// -- lives on the server (resolve_zoom_entry) and is proved by its own
// doubles there, plus PracticeLiveView.test.ts on the rendering side.
// =============================================================================

import { describe, it, expect } from 'vitest'
import { zoomEntryState } from '@/utils/zoomEntryState'

describe('zoomEntryState', () => {
  it('is ready when the row says it can be entered', () => {
    expect(zoomEntryState(true)).toBe('ready')
  })

  it('reports pending when the row cannot be entered yet', () => {
    expect(zoomEntryState(false)).toBe('pending')
  })

  it('reports pending when the field is absent entirely (fixture without it)', () => {
    expect(zoomEntryState(undefined)).toBe('pending')
    expect(zoomEntryState(null)).toBe('pending')
  })

  // A4 V2 (PROMPT №572): create_failed became routine once series children
  // started being created in the background, and before this distinction both
  // it and pending_creation rendered the identical «готовится» spinner --
  // forever, for a meeting that would never appear on its own.
  it('reports failed (not pending) when not ready and the meeting permanently failed', () => {
    expect(zoomEntryState(false, 'create_failed')).toBe('failed')
    expect(zoomEntryState(undefined, 'create_failed')).toBe('failed')
  })

  it('ready wins over create_failed -- the entry itself is the fact', () => {
    expect(zoomEntryState(true, 'create_failed')).toBe('ready')
  })

  it('every other meeting status (including unknown/absent) falls through to pending', () => {
    for (const status of ['active', 'pending_creation', 'deleted', undefined, null]) {
      expect(zoomEntryState(false, status)).toBe('pending')
    }
  })

  // FE-91: the row the backend marks "this registrant's personal link will
  // NOT come" must stop reading as «готовится» -- nothing is preparing, and
  // the meeting itself exists (not 'failed' either).
  it('reports unavailable when the row says the personal link will not come', () => {
    expect(zoomEntryState(false, 'active', true)).toBe('unavailable')
    expect(zoomEntryState(undefined, undefined, true)).toBe('unavailable')
  })

  it('linkUnavailable false/absent changes nothing -- pending as before (fixtures, master rows)', () => {
    for (const flag of [false, undefined, null]) {
      expect(zoomEntryState(false, 'active', flag)).toBe('pending')
      expect(zoomEntryState(undefined, undefined, flag)).toBe('pending')
    }
  })

  it('ready wins over linkUnavailable -- the entry itself is the fact', () => {
    // The server never sends both (the flag requires "no entry token"), but
    // the helper names what it is shown: a row that CAN be entered is ready.
    expect(zoomEntryState(true, 'active', true)).toBe('ready')
  })

  it('unavailable wins over create_failed in contradictory data (a real row is never both)', () => {
    // The backend's flag query joins on an ACTIVE meeting, so a real
    // create_failed row carries no flag. If stale or hand-built data ever
    // carries both, the per-person fact ("no link for YOU, ever") is the one
    // that cannot be fixed by the master retrying the meeting.
    expect(zoomEntryState(false, 'create_failed', true)).toBe('unavailable')
  })
})
