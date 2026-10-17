// =============================================================================
// VELO Frontend -- Backend error code -> phrase (B8)
// =============================================================================
//
// Owner ruling 2026-08-16: PLAIN RUSSIAN, nothing else. No key system, no
// locale files, no i18n library, no t() wrapper -- full multi-language is its
// own future task and gets solved there, once, with everything in view. This
// table is not a first step toward that; building it "i18n-ready" is the
// failure mode this ruling explicitly rejects.
//
// Every code the backend can raise (VeloError.code, backend/app/core/
// exceptions.py + one code="..." per module raise site) maps to ONE Russian
// sentence here. useApiError.ts's extractApiError()/errorMessage() consult
// this table before ever falling back -- e.detail (backend's raw English
// message) is never read, let alone shown on screen.
//
// RECONCILED (PROMPT №747): 24 distinct codes are genuinely raised today
// (`grep -rnHE '\bcode(:\s*str)?\s*=\s*"[a-z_]+"' backend/app --include=*.py`,
// comment lines excluded, word-boundary on `code` so "..._passcode = ..."
// stub literals elsewhere in zoom_client.py don't false-positive in). 22 of
// those 24 are here, phrase-shaped. 2 are deliberately NOT here --
// zoom_meeting_not_failed and practice_full -- neither is a "show this
// phrase" case: one is a silently-recovered race (shows an info toast, not
// an error), the other drives a full-screen sold-out state with no error
// text at all. Forcing either through a code->phrase table would be the
// wrong shape; their call sites are untouched. ONE further entry,
// practice_not_found, is NOT among the 24 -- it is raised nowhere, only
// named in exceptions.py's own usage-example comment (`№745`'s original "25
// distinct codes" figure counted that comment line; corrected here). Kept
// anyway, at zero cost, so a future raise site is covered without anyone
// needing to remember this table. ONE MORE, validation_error, is not a
// VeloError.code at all -- see its own comment below.
//
// RE-MEASURED (GT-15). The paragraph above is a snapshot of the №747
// reconciliation and has drifted twice since -- GT-14 added nine curator
// codes and GT-15 adds a tenth, neither round updating the totals. Today,
// re-running that same command at GT-15: 34 codes raised as a literal, 30
// of them here, 4 deliberately absent (practice_full and
// zoom_meeting_not_failed for the reasons above, plus invalid_cursor and
// too_many_requests, which no screen shows a phrase for). Total table size
// then: 34.
//
// RE-MEASURED AGAIN (BE-92), same command, with BE-92's three check-in
// codes in: 47 codes raised as a literal, 34 of them here, 13 absent -- the
// 4 above plus 9 that arrived after GT-15 without a phrase (audio_invalid,
// audio_too_large, curator_cannot_cancel_series, delivery_window_empty,
// recipient_override_not_allowed, speech_not_recognized,
// transcription_failed, transcription_not_configured,
// transcription_unavailable -- recorded in the BE-92 report, not added
// here). Total table size: 38 (34 + the 2 constant-raised codes below +
// practice_not_found + validation_error).
//
// AND THAT COMMAND HAS A BLIND SPOT worth naming rather than repeating: it
// matches a STRING LITERAL after `code=`, so a code raised through a
// constant is invisible to it. Two are: curator_group_name_taken
// (_NAME_TAKEN_CODE) and group_creation_not_allowed (_NO_CREATE_RIGHT_CODE),
// both in curator_groups/service.py. Counting raise sites rather than
// literals put the real number at 36 at GT-15, and puts it at 49 at BE-92.
//
// SEEDED from the 7 call sites that already carried a hand-written Russian
// phrase for a specific code (verbatim, not re-worded -- those were written
// with a real screen in view): bot_url_not_configured, direction_not_confirmed,
// style_not_confirmed, zoom_meeting_not_active, group_in_use, invite_invalid,
// insufficient_balance. The other 15 genuinely-raised codes plus
// practice_not_found are new, written from each raise site's own message.
//
// tz-i18n 1.2 (the owner's "own future task" has started): the table itself
// moved to locales/ru.json under the `errors` namespace -- keys
// errors.<code>, the phrases VERBATIM what the table above used to carry.
// errorMessage()/extractApiError() look the key up and fall back to
// errors.generic for a code the catalog does not know. ERROR_CODES below is
// the machine-readable list of what the catalog must contain; the CI key
// audit (tz-i18n §4.4) checks catalog <-> list.
// =============================================================================

import i18n from '@/locales'

export const ERROR_CODES = [
  'bot_url_not_configured',
  'direction_not_confirmed',
  'style_not_confirmed',
  'group_in_use',
  'invite_invalid',
  'insufficient_balance',
  'zoom_sdk_not_configured',
  'zoom_entry_not_joinable',
  'zoom_unavailable',
  'zoom_host_token_unavailable',
  'already_master',
  'master_offer_not_found',
  'blocked_by_master',
  'master_profile_not_found',
  'master_profile_not_verified',
  'method_change_pending',
  'not_a_student',
  'not_in_audience',
  'practice_completed',
  'practice_not_found',
  'role_not_allowed',
  'no_active_booking',
  'checkin_window_closed',
  'checkin_window_not_open',
  'curator_group_name_taken',
  'group_creation_not_allowed',
  'curator_cannot_leave',
  'own_group',
  'master_required',
  'blocked_by_curator',
  'blocked_in_group',
  'cannot_block_curator',
  'master_id_requires_school',
  'master_not_in_school',
  'curator_only',
  'curator_cannot_add_occurrence',
  'curator_group_not_usable',
  'transfer_pending',
  'invite_not_found',
  'transfer_not_found',
  'transfer_target_not_member',
  'reflection_not_available',
  'reflection_already_submitted',
  'mcp_token_limit_reached',
  'mcp_token_not_found',
  'mcp_token_name_taken',
  'unauthorized',
  'not_found',
  'forbidden',
  'conflict',
  'bad_request',
  'internal_error',
  'validation_error',
] as const

/** Whether the catalog carries a phrase for this backend code. */
export function hasErrorMessage(code: string): boolean {
  const key = `errors.${code}`
  // The seed catalog (ru) is the complete one: check it first, then the
  // active locale (an instance overlay may cover a code the seed does not).
  return i18n.global.te(key, 'ru') || i18n.global.te(key)
}

/**
 * Look up a known backend error code's phrase directly, with no caught
 * exception and no caller-supplied fallback.
 *
 * PROMPT №747: replaces the `ERROR_MESSAGES.some_code!` non-null-assertion
 * pattern the 7 migrated point-branches used -- that assertion SILENCED
 * `noUncheckedIndexedAccess` instead of answering it. This function answers
 * it: a code with a catalog entry returns its phrase; anything else (a typo,
 * a future code the catalog hasn't caught up with yet) returns
 * errors.generic, never `undefined`, so the type is `string` everywhere
 * without an assertion at any call site.
 */
export function errorMessage(code: string): string {
  const key = `errors.${code}`
  return hasErrorMessage(code) ? i18n.global.t(key) : i18n.global.t('errors.generic')
}
