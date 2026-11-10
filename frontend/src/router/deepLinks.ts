// =============================================================================
// VELO Frontend -- deep links: the Telegram startapp parameter as a route
// =============================================================================
//
// TD-F01 / Links (3 October): initAuth() (composables/useAuth.ts) keeps the
// RAW startapp value in pendingStartParam; roleRedirect (router/guards.ts)
// parses it here once auth knows the session role -- a notification button
// carries no viewer, and some verbs land in different zones for a user and a
// master -- and clears it after first use.
//
// Pure: no platform, network or store access, so every verb is testable as
// a plain call (router/deepLinks.test.ts). The one platform read --
// isSchoolInviteStartParam() for the App.vue entry gate -- stays in
// composables/useAuth.ts and shares SCHOOL_INVITE_PARAM through
// isSchoolInviteParam().
//
// The T-44 codec vector for decodePracticeCode stays in
// composables/useAuth.test.ts: `velo test` (scripts/velo-manage.sh) and the
// backend's twin (backend/tests/test_zoom_public_link.py) read it from that
// path.
// =============================================================================

import { featureEnabled } from '@/platform/features'
import type { UserRole } from '@/api/types'

/** A router location a deep link resolves to: a named route, its params and query. */
export interface DeepLinkTarget {
  name: string
  params?: Record<string, string>
  query?: Record<string, string>
}

/** T-35: the 22-character public practice code, back into a UUID.
 *
 * SECOND COPY, BY DESIGN. The authoritative implementation is
 * decode_practice_code in backend/app/modules/zoom/service.py. Two copies
 * exist because the deep-link route takes a UUID path parameter, so the code
 * must be decoded HERE, before a route can be built -- the split follows the
 * language boundary, not forgetfulness. Sending the code to an endpoint just
 * to have it decoded would not remove the copy; it would add a network round
 * trip to a pure function.
 *
 * BOTH SIDES MUST AGREE ON GARBAGE, not merely on valid input: wrong length,
 * wrong charset and empty all mean "not a route" on both. What this side
 * CANNOT know is whether a well-formed code names a practice that still
 * exists -- there is no database here. Such a link routes normally and the
 * resolve call on the target screen answers 404, which PracticeLiveView
 * renders as an honest error.
 *
 * T-44: that agreement is no longer held by discipline alone. A shared
 * vector -- the same JSON table of inputs and expected outcomes -- is
 * duplicated VERBATIM in both test files:
 *   frontend/src/composables/useAuth.test.ts
 *   backend/tests/test_zoom_public_link.py
 * Each side runs its own decoder against its own copy (catching "I changed
 * the codec and not the table"), and `velo test` / `velo update` additionally
 * diff the two copies against each other in a container that can see both
 * trees (catching "I changed one side's codec AND its table, leaving the
 * other side behind" -- which no single-sided test can see).
 * CHANGE THIS DECODER ONLY IN PAIRS: this function, decode_practice_code in
 * backend/app/modules/zoom/service.py, and BOTH copies of the vector. T-44
 * was opened because the comments were the only thing holding them together,
 * and the two had already drifted: Python accepted "+" and "/" (its decoder
 * translates - and _ into them and then accepts either spelling) where the
 * regex below rejects them. The backend now gates the alphabet explicitly.
 *
 * Exported for the vector test, which must exercise the CODEC rather than
 * the codec wrapped in parseStartParam's own route-shaped regex.
 */
export function decodePracticeCode(code: string): string | null {
  if (code.length !== 22) return null
  if (!/^[A-Za-z0-9_-]{22}$/.test(code)) return null
  try {
    const binary = atob(code.replace(/-/g, '+').replace(/_/g, '/') + '==')
    if (binary.length !== 16) return null
    const hex = Array.from(binary, (ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    return (
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
      `${hex.slice(16, 20)}-${hex.slice(20)}`
    )
  } catch {
    return null
  }
}

/**
 * The school invite token pattern (FE-18): ONE copy shared by parseStartParam
 * (route resolution) and isSchoolInviteParam (the FE-81 entry-gate deferral,
 * composables/useAuth.ts isSchoolInviteStartParam),
 * so a startapp that counts as an invite for one counts for the other -- a
 * malformed token degrades to the plain new-user flow, never opens the app
 * around the gate.
 */
const SCHOOL_INVITE_PARAM = /^school__([A-Za-z0-9_-]{16,128})$/

/**
 * Parse the Telegram startapp parameter into a router location.
 *
 * @returns Null if the parameter is absent or unrecognized.
 *
 * Supported formats:
 *   `open_practice__{uuid}       -> practice-detail (master: master-practice-detail)`
 *   `zoom__{code}                -> { name: 'practice-live', params: { practiceId } }` (T-35)
 *   `master_onboarding__{token}  -> { name: 'master-invite', params: { token } }`
 *   `group_invite__{token}       -> { name: 'group-join', params: { token } }` (P4, PROMPT №593)
 *   `school__{token}             -> { name: 'school-join', params: { token } }` (FE-18, Links)
 *   `open_thread__{uuid}         -> { name: 'user-chat' | 'master-chat', params: { id } }`
 *                                  (FE-103: Telegram twin of the bell's msg.* buttons)
 *   `open_support_rating__{uuid} -> the same chat route + ?rate=1`: the rating
 *                                  sheet on THAT resolved ticket (FE-107 /
 *                                  BE-162 delivery 3; the chat resolves the
 *                                  ticket id to the person's one support row)
 *   `open_admin_support__{uuid}  -> { name: 'admin-support-detail', params: { id } }, admin only`
 *                                  (FE-103/BE-172: the comms THREAD id -- owner
 *                                  ruling in the BE-172 fix)
 *   `<action>[__{uuid}]          -> the bell's screen for that notification verb (Links)`;
 *                                  the session `role` picks the zone where bells differ
 *
 * T-35: zoom__ is ADDED, open_practice__ is NOT replaced. They are two
 * different actions, not two formats for one: open_practice__ means "show me
 * the practice card" and is the live contract of seven notification emitters
 * (core/events/reminders.py, bookings/service.py, cancel_service.py,
 * practices/service.py, waitlist/service.py), while zoom__ means "let me into
 * the Zoom meeting" and lands on the screen that can do that. Removing
 * open_practice__ would break the button in every notification already sent.
 */
export function parseStartParam(
  startParam: string | null,
  role: UserRole | null = null,
): DeepLinkTarget | null {
  if (!startParam) return null
  // Links (3 October): a notification button carries no notification TYPE
  // and no viewer -- so roleRedirect parses it AFTER auth, with the session's
  // role, and the same verb lands where the matching bell would send it.
  const asMaster = role === 'master'
  const asAdmin = role === 'admin'

  const practiceMatch = startParam.match(/^open_practice__([0-9a-f-]{36})$/)
  if (practiceMatch?.[1]) {
    return asMaster
      ? { name: 'master-practice-detail', params: { id: practiceMatch[1] } }
      : { name: 'practice-detail', params: { id: practiceMatch[1] } }
  }

  // T-35: the public practice code, the same 22 characters that appear in
  // {PUBLIC_LINK_BASE}/z/{code}. One code, two places -- the landing page's
  // open-app button carries it straight through as startapp=zoom__<22>
  // (28 characters against Telegram's 64 limit), so a person who clicked a
  // channel link arrives here already pointed at the right practice.
  const zoomMatch = startParam.match(/^zoom__([A-Za-z0-9_-]{22})$/)
  if (zoomMatch?.[1]) {
    const practiceId = decodePracticeCode(zoomMatch[1])
    // A code of the right shape that does not decode is not a route.
    if (practiceId) {
      return { name: 'practice-live', params: { practiceId } }
    }
    return null
  }

  // Batch-INVITE (№258): one-time master invite link issued by an admin.
  // Token charset = secrets.token_urlsafe (url-safe base64); length-bounded
  // to match the backend's ClaimMasterInviteRequest (16..128).
  const inviteMatch = startParam.match(/^master_onboarding__([A-Za-z0-9_-]{16,128})$/)
  if (inviteMatch?.[1]) {
    return { name: 'master-invite', params: { token: inviteMatch[1] } }
  }

  // Group invite (P4, №593): a master's reusable group link. Same token
  // charset/length bound as above -- both are secrets.token_urlsafe(32)
  // outputs, matching JoinGroupRequest.token (groups_schemas.py: 16..128).
  const groupInviteMatch = startParam.match(/^group_invite__([A-Za-z0-9_-]{16,128})$/)
  if (groupInviteMatch?.[1]) {
    return { name: 'group-join', params: { token: groupInviteMatch[1] } }
  }

  // School invite (FE-18): a school's reusable link. ONE kind
  // for BOTH flavours -- master and student links differ only in the token's
  // row, and which one this is comes from the SERVER's preview
  // (GET /schools/invites/{token}), never from anything parseable
  // here. Links (3 October): the kind is `school__` (owner) -- 8 + 43 = 51
  // characters; the former, longer kind made 65 against
  // Telegram's 64 and the link did not open.
  const schoolInviteMatch = startParam.match(SCHOOL_INVITE_PARAM)
  if (schoolInviteMatch?.[1]) {
    return { name: 'school-join', params: { token: schoolInviteMatch[1] } }
  }

  // Notification buttons (Links, 3 October): comms builds startapp as
  // `<action>` or `<action>__<one param>`. Each verb lands where the bell
  // sends it; where the bells differ by zone, the session role decides.
  const verb = startParam.match(/^([a-z_]+?)(?:__([0-9a-f-]{36}))?$/)
  const action = verb?.[1]
  const id = verb?.[2]
  switch (action) {
    case 'open_feedback':
      return id ? { name: 'user-feedback', params: { practiceId: id } } : null
    case 'open_wallet': // bare (payouts, top-ups) or __<practice_id> (refunds)
      // tz-whitelabel §4: an edition without the payments module has no
      // wallet route in ANY zone -- the master's finance screen and the
      // user's top-up are the same module (FE-112) -- the tap degrades
      // to no navigation, not the 404.
      if (!featureEnabled('payments')) return null
      return asMaster ? { name: 'master-finance' } : { name: 'user-topup' }
    case 'confirm_waitlist':
      return id ? { name: 'waitlist-confirm', params: { id } } : null
    case 'open_school':
      return id ? { name: asMaster ? 'master-school' : 'user-school', params: { id } } : null
    case 'open_master_offer':
      return id ? { name: 'school-master-offer', params: { id } } : null
    case 'open_master_application': // bare (BE-104) or __<school_id> (BE-59)
      // The Telegram button does not know the type, so a rejection lands on
      // the apply wizard (its guard decides) -- the reason is in the text.
      return { name: 'master-apply' }
    case 'open_master_zone':
      // Its role guard sends a role='user' account to /user/dashboard; the
      // switch-offer screen is the bell's route (master-pending).
      return id ? null : { name: 'master-dashboard' }
    case 'open_support':
      return id ? null : { name: asMaster ? 'master-support' : 'user-support' }
    case 'open_master_practices':
      return id ? null : { name: 'master-practices' }
    case 'open_thread':
      // FE-103: the Telegram twin of the bell's msg.* buttons -- the support
      // notification and the "translation unavailable" notice carry
      // `open_thread__<thread_id>`, and the SAME routes open it (the thread
      // screen learns it is support from the row's `channel`).
      return id ? { name: asMaster ? 'master-chat' : 'user-chat', params: { id } } : null
    case 'open_support_rating':
      // FE-107 / BE-162 delivery 3: the rating notification's title
      // (i18n:chat.rating.title) -- its button opens the rating sheet on
      // THAT ticket. The same chat route open_thread uses resolves the
      // ticket id to the person's one support row; ?rate=1 is what asks the
      // sheet to open on the ticket the link named (the route's own id).
      return id
        ? {
            name: asMaster ? 'master-chat' : 'user-chat',
            params: { id },
            query: { rate: '1' },
          }
        : null
    case 'open_admin_support':
      // FE-103 / BE-172: the per-admin Telegram signal about a support
      // message deep-links the admin detail screen by the comms THREAD id
      // (owner ruling in the BE-172 fix -- the opener's user_id would leave
      // the front to find the thread through the list). Bare (no id) has no
      // destination of its own.
      return id && asAdmin ? { name: 'admin-support-detail', params: { id } } : null
    default:
      // open_notifications / open_admin_masters: there is no admin bell --
      // the app opens as usual. Anything else is not a route.
      return null
  }
}

/**
 * Whether a startapp value is a school invite link (`school__<token>`, FE-18).
 *
 * @remarks The same pattern parseStartParam resolves to `school-join`, so the
 * App.vue entry gate (FE-81) and the router never disagree about one link.
 */
export function isSchoolInviteParam(startParam: string | null): boolean {
  return SCHOOL_INVITE_PARAM.test(startParam ?? '')
}
