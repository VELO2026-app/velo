// =============================================================================
// VELO Frontend -- useAuth: parseStartParam Tests (P4, PROMPT №593)
// =============================================================================
//
// parseStartParam is a pure function (no platform/network dependency) --
// exported specifically for this direct coverage rather than only exercised
// indirectly through initAuth()/pendingDeepLink (see router/guards.test.ts,
// which tests roleRedirect CONSUMING an already-set pendingDeepLink, not the
// parsing itself).
//
// Covers all three deep-link formats the function currently recognizes:
// open_practice__{uuid} (pre-existing), master_onboarding__{token}
// (pre-existing, Batch-INVITE №258), group_invite__{token} (new, P4).
// =============================================================================

import { describe, it, expect } from 'vitest'
import { parseStartParam } from '@/composables/useAuth'

describe('parseStartParam', () => {
  it('returns null for an absent param', () => {
    expect(parseStartParam(null)).toBeNull()
  })

  it('returns null for an unrecognized format', () => {
    expect(parseStartParam('garbage')).toBeNull()
    expect(parseStartParam('')).toBeNull()
  })

  it('parses open_practice__{uuid}', () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000'
    expect(parseStartParam(`open_practice__${uuid}`)).toEqual({
      name: 'practice-detail',
      params: { id: uuid },
    })
  })

  it('parses master_onboarding__{token}', () => {
    const token = 'a'.repeat(32)
    expect(parseStartParam(`master_onboarding__${token}`)).toEqual({
      name: 'master-invite',
      params: { token },
    })
  })

  it('parses group_invite__{token} (P4, PROMPT №593)', () => {
    const token = 'b'.repeat(43) // typical secrets.token_urlsafe(32) length
    expect(parseStartParam(`group_invite__${token}`)).toEqual({
      name: 'group-join',
      params: { token },
    })
  })

  it('rejects a group_invite token outside the 16..128 charset/length bound', () => {
    expect(parseStartParam('group_invite__tooshort')).toBeNull()
    expect(parseStartParam(`group_invite__${'c'.repeat(129)}`)).toBeNull()
    expect(parseStartParam('group_invite__has spaces not url-safe')).toBeNull()
  })
  // ===========================================================================
  // T-35: zoom__<22> -- the public practice code as a deep link.
  //
  // THREE AXES OF GARBAGE, matched against the backend's decode_practice_code
  // (zoom/service.py). The two copies exist because this route takes a UUID
  // path parameter, so the decode must happen here before a route exists --
  // a language boundary, not a duplication anyone forgot to remove. They must
  // therefore agree on REJECTION, not just on valid input: what the server
  // answers 404 to, this must answer "not a route" to.
  //
  // The fourth axis -- a well-formed code naming a practice that does not
  // exist -- is deliberately NOT here and cannot be: there is no database on
  // this side. That link routes normally and the resolve call on the target
  // screen 404s (see PracticeLiveView.test.ts).
  // ===========================================================================
  describe('T-35: zoom__{code}', () => {
    it('decodes a real code back into the practice uuid and routes to practice-live', () => {
      // Built the same way the backend builds it, so the fixture cannot drift
      // from the algorithm: bytes -> base64url -> strip padding.
      const uuid = '11111111-2222-3333-4444-555555555555'
      const bytes = Uint8Array.from(
        (uuid.replace(/-/g, '').match(/../g) ?? []).map((h) => parseInt(h, 16)),
      )
      const code = btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')

      expect(code).toHaveLength(22)
      expect(parseStartParam(`zoom__${code}`)).toEqual({
        name: 'practice-live',
        params: { practiceId: uuid },
      })
    })

    it('AXIS 1 -- wrong length: neither 21 nor 23 characters is a route', () => {
      expect(parseStartParam(`zoom__${'A'.repeat(21)}`)).toBeNull()
      expect(parseStartParam(`zoom__${'A'.repeat(23)}`)).toBeNull()
    })

    it('AXIS 2 -- wrong charset: 22 characters outside [A-Za-z0-9_-] is not a route', () => {
      expect(parseStartParam(`zoom__${'A'.repeat(20)}!!`)).toBeNull()
      expect(parseStartParam(`zoom__${'A'.repeat(20)}==`)).toBeNull()
      expect(parseStartParam(`zoom__${'тест'.repeat(5)}аб`)).toBeNull()
    })

    it('AXIS 3 -- empty: the prefix alone is not a route', () => {
      expect(parseStartParam('zoom__')).toBeNull()
      expect(parseStartParam('zoom')).toBeNull()
    })

    it('does NOT disturb open_practice__{uuid} -- both formats live, they are two different actions', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000'
      expect(parseStartParam(`open_practice__${uuid}`)).toEqual({
        name: 'practice-detail',
        params: { id: uuid },
      })
    })
  })
})
