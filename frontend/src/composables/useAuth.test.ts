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
import { decodePracticeCode, parseStartParam } from '@/composables/useAuth'

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
      [`open_curator_group__${id}`, 'user', { name: 'user-curator-group', params: { id } }],
      [`open_curator_group__${id}`, 'master', { name: 'master-curator-group', params: { id } }],
      ['open_support', 'master', { name: 'master-support' }],
      ['open_master_practices', 'master', { name: 'master-practices' }],
      [`open_practice__${id}`, 'master', { name: 'master-practice-detail', params: { id } }],
    ] as const)('%s as %s', (param, role, route) => {
      expect(parseStartParam(param, role)).toEqual(route)
    })

    it.each(['open_notifications', 'open_admin_masters', 'open_admin_support', 'open_thread__x'])(
      '%s -> no route (no admin bell; msg.* has no Telegram)',
      (param) => {
        expect(parseStartParam(param, 'user')).toBeNull()
      },
    )

    it('a verb that needs its id without one is no route', () => {
      expect(parseStartParam('confirm_waitlist', 'user')).toBeNull()
      expect(parseStartParam('open_curator_group', 'user')).toBeNull()
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
      name: 'curator-group-join',
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
  // curator_group.master_offered. The former curator_group_master_offer__
  // was built by nothing and is no route any more (no legacy).
  it('parses open_master_offer__{uuid}; the former kind is gone', () => {
    const groupId = '123e4567-e89b-12d3-a456-426614174000'
    expect(parseStartParam(`open_master_offer__${groupId}`)).toEqual({
      name: 'curator-group-master-offer',
      params: { id: groupId },
    })
    expect(parseStartParam(`curator_group_master_offer__${groupId}`)).toBeNull()
    expect(parseStartParam('open_master_offer__not-a-uuid')).toBeNull()
    expect(parseStartParam('open_master_offer')).toBeNull()
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

// ===========================================================================
// T-44: THE SHARED VECTOR.
//
// The block between the two sentinel comments below is duplicated VERBATIM in
// backend/tests/test_zoom_public_link.py. Two copies, because no single build
// context can see both trees (the backend image copies app/ tests/ scripts/
// migrations/ + .env.example; this image is built from frontend/ alone), so a
// shared file would be unreachable to one of them.
//
// TWO MECHANISMS, catching two different mistakes:
//   1. THIS FILE runs the real decodePracticeCode against its own copy --
//      catches "I changed the codec and forgot the table".
//   2. `velo test` / `velo update` run a container that mounts the whole
//      checkout and diffs the two copies against each other -- catches "I
//      changed one side's codec AND its table", which neither side's own
//      suite can possibly see, because each is internally consistent.
//
// EDITING RULE: change the JSON here and the JSON there in the same commit.
// The comparison is on PARSED JSON, not bytes, so TypeScript's backticks and
// Python's triple quotes are free to differ -- the data must not.
//
// NOTE on the "not_16_bytes" axis, which carries no example. There is none to
// carry: 22 characters of base64url plus "==" always decode to exactly 16
// bytes. That is group arithmetic, not luck -- confirmed over 200000 random
// codes. Any input that would decode to a different length has to break the
// length or charset axis first, and is rejected there. Both sides keep their
// byte-count guard regardless, as the thing that would catch a future change
// to the code length; documenting why the axis is empty is honest, inventing
// a case that "covers" it would not be.
//
// NOTE on "+" and "/". Python's urlsafe_b64decode translates "-" into "+" and
// "_" into "/" and then calls the STANDARD decoder, which accepts either
// spelling -- so before T-44 the backend decoded "AAAAAAAAAAAAAAAAAAAA++" to a
// real practice id while this file's regex rejected it. Python accepted a
// strict superset of this side. That is the drift this vector exists to
// catch, and it is now closed by an explicit charset gate on the backend.
//
// --- T-44 CODEC VECTOR START (identical JSON on both sides) ---
const CODEC_VECTOR_JSON = `
{
  "axes": {
    "valid": "a real code decodes to its practice id",
    "length": "not 22 characters is not a code",
    "charset": "22 characters outside base64url is not a code",
    "empty": "the empty string is not a code",
    "repeat": "same input twice, same answer (asserted separately)",
    "not_16_bytes": "no example exists -- see the NOTE above, it is arithmetic"
  },
  "cases": [
    {
      "input": "ERERESIiMzNERFVVVVVVVQ",
      "expect": "11111111-2222-3333-4444-555555555555",
      "why": "canonical valid code"
    },
    {
      "input": "-__7__v_-__7__v_-__7_w",
      "expect": "fbfffbff-fbff-fbff-fbff-fbfffbfffbff",
      "why": "valid; exercises - and _, which ARE base64url"
    },
    {
      "input": "+//7//v/+//7//v/+//7/w",
      "expect": null,
      "why": "same bytes spelled with + and / -- the T-44 divergence"
    },
    {
      "input": "AAAAAAAAAAAAAAAAAAAA++",
      "expect": null,
      "why": "the divergence, minimal form"
    },
    {
      "input": "AAAAAAAAAAAAAAAAAAAA//",
      "expect": null,
      "why": "the divergence, other standard-alphabet character"
    },
    {
      "input": "AAAAAAAAAAAAAAAAAAAAA",
      "expect": null,
      "why": "21 characters -- too short"
    },
    {
      "input": "AAAAAAAAAAAAAAAAAAAAAAA",
      "expect": null,
      "why": "23 characters -- too long"
    },
    {
      "input": "",
      "expect": null,
      "why": "empty"
    },
    {
      "input": "AAAAAAAAAAAAAAAAAAAA!!",
      "expect": null,
      "why": "right length, impossible alphabet"
    },
    {
      "input": "AAAAAAAAAAAAAAAAAAAA==",
      "expect": null,
      "why": "padding is not part of a code -- it is stored stripped"
    },
    {
      "input": "AAAAAAAAAAAAAAAAAAAA  ",
      "expect": null,
      "why": "trailing whitespace -- caught by the charset gate"
    },
    {
      "input": "жжжжжжжжжжжжжжжжжжжжжж",
      "expect": null,
      "why": "22 non-ASCII characters -- length alone would pass"
    }
  ]
}
`
// --- T-44 CODEC VECTOR END ---

describe('T-44: shared codec vector', () => {
  const vector = JSON.parse(CODEC_VECTOR_JSON) as {
    axes: Record<string, string>
    cases: { input: string; expect: string | null; why: string }[]
  }

  it('MECHANISM 1 -- the real decoder agrees with this side of the vector', () => {
    for (const c of vector.cases) {
      expect(decodePracticeCode(c.input), `vector case "${c.input}" (${c.why})`).toBe(c.expect)
    }
  })

  it('REPEAT axis -- the decoder is pure, the same input twice gives the same answer', () => {
    for (const c of vector.cases) {
      expect(decodePracticeCode(c.input)).toBe(decodePracticeCode(c.input))
    }
  })
})
