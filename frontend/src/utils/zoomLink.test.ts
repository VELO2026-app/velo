// =============================================================================
// VELO Frontend -- zoomLink.ts Unit Tests
// =============================================================================
//
// T-35 SHRANK WHAT THIS FILE GUARDS, and the shrink is the point rather than
// lost coverage. This helper used to CHOOSE between the person's own
// registrant link and a manually-entered Practice.zoom_link -- a rule every
// entry point had to follow, which is exactly the kind of correctness that
// cannot be enforced by construction. The manual rung is gone with its column,
// so there is no choice left to get wrong; what remains only NAMES the state
// of a list row that already carries its own link.
//
// The real decision -- personal / guest / host / pending / failed / cancelled
// -- now lives on the server (resolve_zoom_entry) and is proved by its own
// doubles there, plus PracticeLiveView.test.ts on the rendering side.
// =============================================================================

import { describe, it, expect } from 'vitest'
import { resolveZoomLink } from '@/utils/zoomLink'

describe('resolveZoomLink', () => {
  it('returns the personal link when present and https', () => {
    expect(resolveZoomLink('https://zoom.us/w/personal?tk=abc')).toEqual({
      kind: 'personal',
      url: 'https://zoom.us/w/personal?tk=abc',
    })
  })

  it('reports pending when there is no link', () => {
    expect(resolveZoomLink(null)).toEqual({ kind: 'pending', url: null })
  })

  it('reports pending when the field is absent entirely (fixture without it)', () => {
    expect(resolveZoomLink(undefined)).toEqual({ kind: 'pending', url: null })
  })

  it('reports pending on an empty string', () => {
    expect(resolveZoomLink('')).toEqual({ kind: 'pending', url: null })
  })

  it('never returns a non-https link -- reports pending instead', () => {
    expect(resolveZoomLink('http://zoom.us/insecure')).toEqual({
      kind: 'pending',
      url: null,
    })
  })

  it('never returns a javascript: link', () => {
    expect(resolveZoomLink('javascript:alert(1)')).toEqual({
      kind: 'pending',
      url: null,
    })
  })

  // A4 V2 (PROMPT №572): create_failed became routine once series children
  // started being created in the background, and before this distinction both
  // it and pending_creation rendered the identical "готовится" spinner --
  // forever, for a meeting that would never appear on its own.
  it('reports failed (not pending) when there is no link and the meeting permanently failed', () => {
    expect(resolveZoomLink(null, 'create_failed')).toEqual({
      kind: 'failed',
      url: null,
    })
  })

  it('a real personal link wins over create_failed -- the link itself is the fact', () => {
    expect(resolveZoomLink('https://zoom.us/w/personal?tk=abc', 'create_failed')).toEqual({
      kind: 'personal',
      url: 'https://zoom.us/w/personal?tk=abc',
    })
  })

  it('every other meeting status (including unknown/absent) falls through to pending', () => {
    for (const status of ['active', 'pending_creation', 'deleted', undefined, null]) {
      expect(resolveZoomLink(null, status)).toEqual({ kind: 'pending', url: null })
    }
  })
})
