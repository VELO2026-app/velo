// =============================================================================
// VELO Frontend -- useAuth: parseStartParam Tests (P4, ПРОМТ №593)
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

  it('parses group_invite__{token} (P4, ПРОМТ №593)', () => {
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
})
