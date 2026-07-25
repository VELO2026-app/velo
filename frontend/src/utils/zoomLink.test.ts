// =============================================================================
// VELO Frontend -- zoomLink.ts Unit Tests
// =============================================================================

import { describe, it, expect } from 'vitest'
import { resolveZoomLink } from '@/utils/zoomLink'

describe('resolveZoomLink', () => {
  it('prefers the personal link when present and https', () => {
    expect(resolveZoomLink('https://zoom.us/w/personal?tk=abc', 'https://zoom.us/j/manual')).toEqual({
      kind: 'personal',
      url: 'https://zoom.us/w/personal?tk=abc',
    })
  })

  it('falls back to the manual link, marked distinctly, when there is no personal link', () => {
    expect(resolveZoomLink(null, 'https://zoom.us/j/manual')).toEqual({
      kind: 'manual',
      url: 'https://zoom.us/j/manual',
    })
  })

  it('falls back to manual when the personal link is undefined (fixture without the field)', () => {
    expect(resolveZoomLink(undefined, 'https://zoom.us/j/manual')).toEqual({
      kind: 'manual',
      url: 'https://zoom.us/j/manual',
    })
  })

  it('reports pending when neither link exists', () => {
    expect(resolveZoomLink(null, null)).toEqual({ kind: 'pending', url: null })
  })

  it('reports pending when both links are empty strings', () => {
    expect(resolveZoomLink('', '')).toEqual({ kind: 'pending', url: null })
  })

  it('never returns a non-https personal link -- falls through to manual instead', () => {
    expect(resolveZoomLink('http://zoom.us/insecure', 'https://zoom.us/j/manual')).toEqual({
      kind: 'manual',
      url: 'https://zoom.us/j/manual',
    })
  })

  it('never returns a non-https manual link -- reports pending instead', () => {
    expect(resolveZoomLink(null, 'http://zoom.us/insecure')).toEqual({
      kind: 'pending',
      url: null,
    })
  })

  it('never silently reports personal when only manual is valid', () => {
    const result = resolveZoomLink(null, 'https://zoom.us/j/manual')
    expect(result.kind).not.toBe('personal')
  })

  // A4 V2 (ПРОМТ №572): pending_creation and create_failed used to render
  // the identical 'pending' state -- the whole defect being fixed.
  describe('meetingStatus (create_failed vs pending_creation)', () => {
    it('reports failed when the meeting permanently failed and neither link exists', () => {
      expect(resolveZoomLink(null, null, 'create_failed')).toEqual({
        kind: 'failed',
        url: null,
      })
    })

    it('reports pending (not failed) when the meeting is still pending_creation', () => {
      expect(resolveZoomLink(null, null, 'pending_creation')).toEqual({
        kind: 'pending',
        url: null,
      })
    })

    it('reports pending (not failed) when meetingStatus is omitted -- backward compatible', () => {
      // The two-arg call every pre-existing call site still makes until it
      // is updated to pass the third argument.
      expect(resolveZoomLink(null, null)).toEqual({ kind: 'pending', url: null })
    })

    it('reports pending (not failed) when meetingStatus is null (no ZoomMeeting row at all)', () => {
      expect(resolveZoomLink(null, null, null)).toEqual({ kind: 'pending', url: null })
    })

    it('a REAL link always wins over create_failed -- a stale status must never hide a working link', () => {
      // Defensive: if the meeting later recovers (a manual link was added,
      // or -- in practice impossible, but the resolver must not assume --
      // a personal link exists) the link itself is the source of truth,
      // not the status string.
      expect(resolveZoomLink(null, 'https://zoom.us/j/manual', 'create_failed')).toEqual({
        kind: 'manual',
        url: 'https://zoom.us/j/manual',
      })
    })
  })
})
