// =============================================================================
// VELO Frontend -- the T-44 codec vector for decodePracticeCode
// =============================================================================
//
// The decoder lives in router/deepLinks.ts (with the rest of the startapp
// parsing, tested in router/deepLinks.test.ts). This file keeps ONLY the
// shared vector, at the path its two other readers name:
// scripts/velo-manage.sh (run_codec_vector_diff) and
// backend/tests/test_zoom_public_link.py. Moving it means changing both.
// =============================================================================

import { describe, it, expect } from 'vitest'
import { decodePracticeCode } from '@/router/deepLinks'

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
