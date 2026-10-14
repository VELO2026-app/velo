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
})
