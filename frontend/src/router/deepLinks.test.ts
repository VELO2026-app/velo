// =============================================================================
// VELO Frontend -- router/deepLinks.ts: the startapp parameter as a route
// =============================================================================
//
// parseStartParam is pure (no platform/network dependency), so every format
// is covered as a direct call here; router/guards.test.ts covers roleRedirect
// CONSUMING the pending parameter, not the parsing itself. The last block
// resolves every target against the REAL route table, so a renamed route or
// param fails here instead of as a silent no-op deep link.
//
// The T-44 codec vector for decodePracticeCode lives in
// composables/useAuth.test.ts -- `velo test` reads it from that path.
// =============================================================================

import { describe, it, expect, vi } from 'vitest'
import router from '@/router'
import { isSchoolInviteParam, parseStartParam, type DeepLinkTarget } from '@/router/deepLinks'

describe('parseStartParam', () => {
  // Links: the BE-59 parameterised form used to stay unmapped -- right while
  // only bare verbs were parsed; it now lands on the same wizard.
  it('BE-104 verbs, and the BE-59 parameterised form, map', () => {
    expect(parseStartParam('open_master_application')).toEqual({ name: 'master-apply' })
    expect(parseStartParam('open_master_zone')).toEqual({ name: 'master-dashboard' })
    expect(parseStartParam('open_support')).toEqual({ name: 'user-support' })
    expect(
      parseStartParam('open_master_application__00000000-0000-4000-8000-000000000001'),
    ).toEqual({ name: 'master-apply' })
    expect(parseStartParam('open_master_zone__x')).toBeNull()
    expect(parseStartParam('xopen_support')).toBeNull()
  })

  // Links (3 October): every notification verb lands where the bell sends it;
  // the session role picks the zone where the two bells differ.
  describe('notification verbs (Links)', () => {
    const id = '00000000-0000-4000-8000-0000000000b2'
    it.each([
      [`open_feedback__${id}`, 'user', { name: 'user-feedback', params: { practiceId: id } }],
      ['open_wallet', 'user', { name: 'user-topup' }],
      ['open_wallet', 'master', { name: 'master-finance' }],
      [`open_wallet__${id}`, 'user', { name: 'user-topup' }],
      [`confirm_waitlist__${id}`, 'user', { name: 'waitlist-confirm', params: { id } }],
      [`open_school__${id}`, 'user', { name: 'user-school', params: { id } }],
      [`open_school__${id}`, 'master', { name: 'master-school', params: { id } }],
      ['open_support', 'master', { name: 'master-support' }],
      ['open_master_practices', 'master', { name: 'master-practices' }],
      [`open_practice__${id}`, 'master', { name: 'master-practice-detail', params: { id } }],
      // FE-103: the Telegram twin of the bell's msg.* buttons -- support
      // notification and the "translation unavailable" notice land on the
      // same chat routes the bell uses; the role picks the zone.
      [`open_thread__${id}`, 'user', { name: 'user-chat', params: { id } }],
      [`open_thread__${id}`, 'master', { name: 'master-chat', params: { id } }],
      // FE-103/BE-172: the admin signal carries the OPENER's user_id; only
      // an admin gets the destination.
      [`open_admin_support__${id}`, 'admin', { name: 'admin-support-detail', params: { id } }],
      // FE-107 / BE-162 delivery 3: the rating notification's title
      // (i18n:chat.rating.title) -- the same chat route open_thread uses,
      // plus ?rate=1 asking the rating sheet to open on the ticket the link
      // named; the role picks the zone.
      [
        `open_support_rating__${id}`,
        'user',
        { name: 'user-chat', params: { id }, query: { rate: '1' } },
      ],
      [
        `open_support_rating__${id}`,
        'master',
        { name: 'master-chat', params: { id }, query: { rate: '1' } },
      ],
    ] as const)('%s as %s', (param, role, route) => {
      expect(parseStartParam(param, role)).toEqual(route)
    })

    // tz-whitelabel §4 (FE-112): an edition without payments has no wallet
    // route in ANY zone -- the user's top-up and the master's finance
    // screen are the same module; both taps degrade to no navigation.
    it('open_wallet without the payments module -> no route in either zone', () => {
      vi.stubEnv('VITE_FEATURES', 'ai')
      try {
        expect(parseStartParam('open_wallet', 'user')).toBeNull()
        expect(parseStartParam('open_wallet', 'master')).toBeNull()
      } finally {
        vi.unstubAllEnvs()
      }
    })

    it.each(['open_support_rating', 'open_support_rating__x'])(
      '%s -> no route (no ticket named; malformed id)',
      (param) => {
        expect(parseStartParam(param, 'user')).toBeNull()
      },
    )

    it.each(['open_notifications', 'open_admin_masters', 'open_thread__x'])(
      '%s -> no route (no admin bell; malformed thread id)',
      (param) => {
        expect(parseStartParam(param, 'user')).toBeNull()
      },
    )

    it.each(['open_admin_support', `open_admin_support__${id}`])(
      '%s without the admin role -> no route',
      (param) => {
        expect(parseStartParam(param, 'user')).toBeNull()
        expect(parseStartParam(param, 'master')).toBeNull()
      },
    )

    it('open_thread / open_admin_support without an id are no route', () => {
      expect(parseStartParam('open_thread', 'user')).toBeNull()
      expect(parseStartParam('open_admin_support', 'admin')).toBeNull()
    })

    it('a verb that needs its id without one is no route', () => {
      expect(parseStartParam('confirm_waitlist', 'user')).toBeNull()
      expect(parseStartParam('open_school', 'user')).toBeNull()
      expect(parseStartParam('open_feedback', 'user')).toBeNull()
    })
  })

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

  // Links (3 October): the school kind is `school__` (owner). These pinned
  // curator_group_invite__, right until it proved 65 characters against
  // Telegram's 64 -- the old kind is now no route at all (no legacy).
  it('parses school__{token} -- ONE kind for both link flavours, 51 characters', () => {
    const token = 'z'.repeat(43)
    expect(`school__${token}`).toHaveLength(51)
    expect(parseStartParam(`curator_group_invite__${token}`)).toBeNull()
    expect(parseStartParam(`school__${token}`)).toEqual({
      name: 'school-join',
      params: { token },
    })
  })

  it('rejects a school token outside the 16..128 charset/length bound', () => {
    expect(parseStartParam('school__tooshort')).toBeNull()
    expect(parseStartParam(`school__${'c'.repeat(129)}`)).toBeNull()
    expect(parseStartParam('school__has spaces not url-safe')).toBeNull()
  })

  it('does not disturb group_invite__{token} -- the two invite prefixes stay separate routes', () => {
    const token = 'a'.repeat(43)
    expect(parseStartParam(`group_invite__${token}`)).toEqual({
      name: 'group-join',
      params: { token },
    })
    expect(parseStartParam('school__')).toBeNull()
    expect(parseStartParam('school')).toBeNull()
  })

  // Links (3 October): the master-offer consent screen has its own verb,
  // open_master_offer__<group_id> (55 characters), sent by the backend for
  // school.master_offered. The former curator_group_master_offer__
  // was built by nothing and is no route any more (no legacy).
  it('parses open_master_offer__{uuid}; the former kind is gone', () => {
    const schoolId = '123e4567-e89b-12d3-a456-426614174000'
    expect(parseStartParam(`open_master_offer__${schoolId}`)).toEqual({
      name: 'school-master-offer',
      params: { id: schoolId },
    })
    expect(parseStartParam(`curator_group_master_offer__${schoolId}`)).toBeNull()
    expect(parseStartParam('open_master_offer__not-a-uuid')).toBeNull()
    expect(parseStartParam('open_master_offer')).toBeNull()
  })

  // FE-127 (owner: no alias): a Telegram button sent before the rename carries
  // the former school verb -- it is no route any more, and the guard opens the
  // role's dashboard instead. The new verb needs its uuid.
  it('open_school needs a uuid; the former school verb is no route', () => {
    const id = '00000000-0000-4000-8000-0000000000b2'
    expect(parseStartParam(`open_curator_group__${id}`, 'user')).toBeNull()
    expect(parseStartParam(`open_curator_group__${id}`, 'master')).toBeNull()
    expect(parseStartParam('open_school', 'user')).toBeNull()
    expect(parseStartParam('open_school__not-a-uuid', 'master')).toBeNull()
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

describe('isSchoolInviteParam (FE-81 entry gate)', () => {
  const token = 'S'.repeat(43)

  it('agrees with parseStartParam on what a school invite is', () => {
    for (const param of [
      `school__${token}`,
      'school__tooshort',
      `school__${'c'.repeat(129)}`,
      `curator_group_invite__${token}`,
      `group_invite__${token}`,
      'school__',
      '',
    ]) {
      const routed = parseStartParam(param)?.name === 'school-join'
      expect(isSchoolInviteParam(param), param).toBe(routed)
    }
  })

  it('no parameter is no invite', () => {
    expect(isSchoolInviteParam(null)).toBe(false)
  })
})

describe('every deep link target resolves in the real route table', () => {
  const id = '00000000-0000-4000-8000-0000000000c3'
  const token = 'T'.repeat(43)
  const practiceCode = 'ERERESIiMzNERFVVVVVVVQ'
  const params = [
    `open_practice__${id}`,
    `zoom__${practiceCode}`,
    `master_onboarding__${token}`,
    `group_invite__${token}`,
    `school__${token}`,
    `open_feedback__${id}`,
    'open_wallet',
    `confirm_waitlist__${id}`,
    `open_school__${id}`,
    `open_master_offer__${id}`,
    'open_master_application',
    'open_master_zone',
    'open_support',
    'open_master_practices',
    `open_thread__${id}`,
    `open_support_rating__${id}`,
    `open_admin_support__${id}`,
  ]

  it.each(['user', 'master', 'admin'] as const)('as %s', (role) => {
    const targets = params
      .map((param) => parseStartParam(param, role))
      .filter((target): target is DeepLinkTarget => target !== null)
    // Every verb above but the admin-only one routes for a user and a master.
    expect(targets.length).toBeGreaterThanOrEqual(params.length - 1)
    for (const target of targets) {
      const resolved = router.resolve(target)
      expect(resolved.name, JSON.stringify(target)).toBe(target.name)
      expect(resolved.matched.at(-1)?.path).not.toBe('/:pathMatch(.*)*')
    }
  })

  it('the zoom fixture decodes, so the practice-live row above is exercised', () => {
    expect(parseStartParam(`zoom__${practiceCode}`)).toEqual({
      name: 'practice-live',
      params: { practiceId: '11111111-2222-3333-4444-555555555555' },
    })
  })
})
