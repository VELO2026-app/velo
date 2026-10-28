// =============================================================================
// VELO Frontend -- useAuth Composable (Phase F1.3, fixed 10.4, BUG-role-redirect, TD-F01)
// =============================================================================
//
// FIX 10.4: isReady and the other flags are reactive refs inside composable scope,
// but shared via module-level refs (Vue pattern for singleton composables).
// Testable: reset by calling initAuth() in test setup.
//
// BUG-role-redirect: Vue Router is created and begins its first navigation
// before App.vue mounts and calls initAuth(). This means roleRedirect fires
// while auth.role is still null, and every user is sent to /user/dashboard.
// Fix: export waitUntilReady() so roleRedirect can await auth completion
// before reading auth.role.
//
// WARNING-3: waitUntilReady() now returns { ok, timedOut } so callers can
// distinguish a clean ready from a timeout and act accordingly (e.g. redirect
// to /auth-error instead of reading a null role).
//
// TD-F01: Deep link handling.
// After auth, read platform.getStartParam() and parse open_practice__{uuid}.
// Store the RAW start parameter in pendingStartParam; roleRedirect parses it
// once auth knows the role (Links: a notification button carries no viewer)
// and clears it after first use to prevent stale redirects.
//
// Standalone phase 3 -- outside Telegram the person signs in with "Log In
// With Telegram". The sign-in always ENDS on a fresh page load: Telegram
// sends the browser back to RETURN_PATH, and initAuth() completes it here,
// before isReady -- so the router's first navigation and the App.vue stage
// already see the signed-in user. A failed or refused return leaves a
// LoginNotice for the login screen to word.
// =============================================================================

import { ref, computed, watch } from 'vue'
import { platform } from '@/platform'
import { takeLoginMark, takeLoginReturn } from '@/platform/browser-login'
import { useAuthStore } from '@/stores/auth'
import { ApiNetworkError, ApiResponseError, ApiTimeoutError } from '@/api/client'
import { featureEnabled } from '@/platform/features'
import type { UserRole } from '@/api/types'

/** Whether auth initialization has completed. */
const isReady = ref(false)

/**
 * Why the login screen is up (outside Telegram), worded by TelegramLoginView:
 *   cancelled       -- the person declined on Telegram's page;
 *   foreign         -- the return came to a browser that did not start this
 *                      sign-in (no mark, or a mark for another state);
 *   expired         -- the backend no longer holds the state (taken, late);
 *   telegram_failed -- Telegram did not prove a user;
 *   not_configured  -- browser sign-in is not set up on this server;
 *   deactivated     -- the account is switched off;
 *   rate_limited    -- too many attempts;
 *   unavailable     -- the server answered that it cannot right now;
 *   network         -- no answer at all.
 */
export type LoginNotice =
  | 'cancelled'
  | 'foreign'
  | 'expired'
  | 'telegram_failed'
  | 'not_configured'
  | 'deactivated'
  | 'rate_limited'
  | 'unavailable'
  | 'network'

/** The notice for the login screen, or null. */
export const loginNotice = ref<LoginNotice | null>(null)

/**
 * The sign-in that just finished did NOT give the bot the right to write to
 * the person. Shown once after this sign-in (BotAccessHint) and kept nowhere
 * else -- the next launch does not show it again.
 */
export const botAccessHint = ref(false)

/**
 * The saved session could not be checked (no answer from the server). The
 * token is still saved; App.vue shows the "try again" screen instead of the
 * login screen.
 */
export const restoreUnreachable = ref(false)

/** Word an error of the browser sign-in endpoints as a LoginNotice. */
export function loginNoticeFor(error: unknown): LoginNotice {
  if (error instanceof ApiNetworkError || error instanceof ApiTimeoutError) return 'network'
  if (!(error instanceof ApiResponseError)) return 'telegram_failed'
  switch (error.status) {
    case 404:
      return 'not_configured'
    case 403:
      return 'deactivated'
    case 429:
      return 'rate_limited'
    case 400:
      if (error.code === 'login_expired') return 'expired'
      if (error.code === 'login_foreign') return 'foreign'
      return 'telegram_failed'
    case 422:
      return 'telegram_failed'
    default:
      return 'unavailable'
  }
}

/**
 * Whether a logout is in progress (Telegram only).
 *
 * Set the instant logout() starts clearing the session and kept true until
 * the Mini App actually closes. The App.vue gate shows LoadingView while this
 * is true, so the brief window between _clearSession() (isAuthenticated -> false)
 * and platform.close() never falls through to TelegramStubView. Without it,
 * a reactive tick could flash the "Open via Telegram" stub before the app closes.
 */
const isLoggingOut = ref(false)

/** Begin the logout transition: gate shows LoadingView, not the stub. */
export function beginLogout(): void {
  isLoggingOut.value = true
}

/**
 * Pending deep link route from startapp parameter (TD-F01).
 * Consumed once by roleRedirect, then cleared.
 * Format: { name: string, params?: Record<string, string> }
 */
export const pendingStartParam = ref<string | null>(null)

/** Timeout for waitUntilReady() in milliseconds (P-3). */
const READY_TIMEOUT_MS = 10_000

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
 * (route resolution) and isSchoolInviteStartParam (FE-81 entry-gate deferral),
 * so a startapp that counts as an invite for one counts for the other -- a
 * malformed token degrades to the plain new-user flow, never opens the app
 * around the gate.
 */
const SCHOOL_INVITE_PARAM = /^school__([A-Za-z0-9_-]{16,128})$/

/**
 * Parse the Telegram startapp parameter into a router location.
 * Returns null if the parameter is absent or unrecognized.
 *
 * Supported formats:
 *   open_practice__{uuid}       -> practice-detail (master: master-practice-detail)
 *   zoom__{code}                -> { name: 'practice-live', params: { practiceId } } (T-35)
 *   master_onboarding__{token}  -> { name: 'master-invite', params: { token } }
 *   group_invite__{token}       -> { name: 'group-join', params: { token } } (P4, PROMPT №593)
 *   school__{token}             -> { name: 'curator-group-join', params: { token } } (FE-18, Links)
 *   open_thread__{uuid}         -> { name: 'user-chat' | 'master-chat', params: { id } }
 *                                  (FE-103: Telegram twin of the bell's msg.* buttons)
 *   open_support_rating__{uuid} -> the same chat route + ?rate=1: the rating
 *                                  sheet on THAT resolved ticket (FE-107 /
 *                                  BE-162 delivery 3; the chat resolves the
 *                                  ticket id to the person's one support row)
 *   open_admin_support__{uuid}  -> { name: 'admin-support-detail', params: { id } }, admin only
 *                                  (FE-103/BE-172: the comms THREAD id -- owner
 *                                  ruling in the BE-172 fix)
 *   <action>[__{uuid}]          -> the bell's screen for that notification verb (Links);
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
): { name: string; params?: Record<string, string>; query?: Record<string, string> } | null {
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
  // "Открыть VELO" button carries it straight through as startapp=zoom__<22>
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

  // Curator-group (school) invite (FE-18): a school's reusable link. ONE kind
  // for BOTH flavours -- master and student links differ only in the token's
  // row, and which one this is comes from the SERVER's preview
  // (GET /curator-groups/invites/{token}), never from anything parseable
  // here. Links (3 October): the kind is `school__` (owner) -- 8 + 43 = 51
  // characters; the former curator_group_invite__ made 65 against
  // Telegram's 64 and the link did not open.
  const curatorInviteMatch = startParam.match(SCHOOL_INVITE_PARAM)
  if (curatorInviteMatch?.[1]) {
    return { name: 'curator-group-join', params: { token: curatorInviteMatch[1] } }
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
      if (asMaster) return { name: 'master-finance' }
      // tz-whitelabel §4: an edition without the payments module has no
      // wallet route -- the tap degrades to no navigation, not the 404.
      return featureEnabled('payments') ? { name: 'user-topup' } : null
    case 'confirm_waitlist':
      return id ? { name: 'waitlist-confirm', params: { id } } : null
    case 'open_curator_group':
      return id
        ? { name: asMaster ? 'master-curator-group' : 'user-curator-group', params: { id } }
        : null
    case 'open_master_offer':
      return id ? { name: 'curator-group-master-offer', params: { id } } : null
    case 'open_master_application': // bare (BE-104) or __<group_id> (BE-59)
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
      // FE-107 / BE-162 delivery 3: «Как мы помогли?» -- the notification's
      // button opens the rating sheet on THAT ticket. The same chat route
      // open_thread uses resolves the ticket id to the person's one support
      // row; ?rate=1 is what asks the sheet to open on the ticket the link
      // named (the route's own id).
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
 * FE-81: did the app open via a school invite deep link (`school__<token>`)?
 *
 * The entry gate (App.vue) defers the new-user Welcome for exactly this one
 * startapp kind: the router has already resolved the link to the standalone
 * invitation screen, so the gate opens the RouterView around it, and the join
 * view runs the onboarding carousel after a successful join (FE-83).
 *
 * Reads the platform live instead of pendingStartParam: roleRedirect may
 * already have consumed and cleared the pending copy by the time the gate
 * decides its initial stage -- both run right after initAuth() resolves.
 */
export function isSchoolInviteStartParam(): boolean {
  return SCHOOL_INVITE_PARAM.test(platform.getStartParam() ?? '')
}

/**
 * Reset auth state (for testing).
 */
export function resetAuthState(): void {
  isReady.value = false
  isLoggingOut.value = false
  pendingStartParam.value = null
  loginNotice.value = null
  botAccessHint.value = false
  restoreUnreachable.value = false
}

/**
 * TEST-ONLY. Force `isReady` without running the real initAuth() bootstrap
 * (network/platform.init()/auth store calls). Router-guard tests need to
 * control waitUntilReady()'s resolution synchronously; this is the only
 * seam for that. Never call from production code -- there is no legitimate
 * production reason to set readiness without actually being ready.
 */
export function __setReadyForTest(ready: boolean): void {
  isReady.value = ready
}

/** Result returned by waitUntilReady(). */
export interface ReadyResult {
  /** True if auth completed normally before the timeout. */
  ok: boolean
  /** True if the 10s timeout fired before initAuth() finished. */
  timedOut: boolean
}

/**
 * Returns a Promise that resolves once isReady becomes true.
 * If isReady is already true, resolves immediately with { ok: true, timedOut: false }.
 *
 * WARNING-3: races against a 10s timeout and now returns { ok, timedOut }
 * so callers can distinguish a clean ready from a network-stall timeout.
 * On timeout, auth.role may still be null -- callers must handle that case
 * (e.g. redirect to /auth-error) instead of falling through to role-based
 * routing with a null role.
 *
 * Used by roleRedirect guard, applyGuard, and router beforeEach.
 * Safe to call multiple times -- each call gets its own Promise.
 */
export function waitUntilReady(): Promise<ReadyResult> {
  if (isReady.value) return Promise.resolve({ ok: true, timedOut: false })

  const waitPromise = new Promise<ReadyResult>((resolve) => {
    const stop = watch(isReady, (ready) => {
      if (ready) {
        stop()
        resolve({ ok: true, timedOut: false })
      }
    })
  })

  const timeoutPromise = new Promise<ReadyResult>((resolve) => {
    setTimeout(() => {
      resolve({ ok: false, timedOut: true })
    }, READY_TIMEOUT_MS)
  })

  return Promise.race([waitPromise, timeoutPromise])
}

/**
 * Run the full auth initialization flow.
 * Should be called once from App.vue on mount.
 */
async function initAuth(): Promise<void> {
  const authStore = useAuthStore()

  // Reset in case of re-initialization.
  resetAuthState()

  await platform.init()

  // TD-F01: read startapp param before auth so it's available regardless
  // of whether we restore a session or do a fresh login.
  const startParam = platform.getStartParam()
  pendingStartParam.value = startParam

  if (platform.name === 'standalone') {
    await initStandalone(authStore)
    isReady.value = true
    return
  }

  // Telegram. Step 1: restore this run's session (a page reload inside the
  // Mini App -- initData older than the backend's 300 s window would be
  // refused, so a reload cannot simply sign in again).
  //
  // The restored session is used ONLY if it belongs to the person who opened
  // the app: its telegram_id must equal the user id in THIS initData.
  // Telegram Web keeps the iframe's sessionStorage across an account switch
  // in the same tab, so without this check account B would open account A.
  // The id is read from the unsigned initData string -- enough, because the
  // check can only DROP a session or keep one this tab already holds; every
  // new session still comes from the server, which verifies the signature.
  const restored = await authStore.restoreSession()
  if (restored === 'restored') {
    const ownerId = authStore.user?.telegram_id ?? null
    if (ownerId !== null && ownerId === initDataUserId(platform.getInitData())) {
      isReady.value = true
      return
    }
    // Someone else's session (or initData naming nobody): revoke it and
    // let initData decide.
    await authStore.discardSession()
  }

  // Step 2: sign in with initData. A failure leaves the session cleared and
  // App.vue shows TelegramStubView.
  const initData = platform.getInitData()
  if (initData) {
    await authStore.loginViaTelegram(initData)
  }
  isReady.value = true
}

/**
 * The Telegram user id in an initData string, or null when there is none:
 * no string, no `user` field, not JSON, or no integer `id`. Unsigned -- see
 * initAuth for why that is enough for the one decision it feeds.
 */
export function initDataUserId(initData: string | null): number | null {
  if (!initData) return null
  const raw = new URLSearchParams(initData).get('user')
  if (!raw) return null
  try {
    const user: unknown = JSON.parse(raw)
    const id = user !== null && typeof user === 'object' ? (user as { id?: unknown }).id : undefined
    return typeof id === 'number' && Number.isSafeInteger(id) ? id : null
  } catch {
    return null
  }
}

/**
 * Outside Telegram: finish a sign-in this page is the return of, else
 * restore the saved session, else leave the login screen to App.vue.
 */
async function initStandalone(authStore: ReturnType<typeof useAuthStore>): Promise<void> {
  if (await completeFromReturn(authStore)) return

  const outcome = await authStore.restoreSession()
  if (outcome === 'restored') {
    // Signed in already: a refused return (someone else's link) has nothing
    // to show on a screen this person will not see.
    loginNotice.value = null
    return
  }
  restoreUnreachable.value = outcome === 'unreachable'
}

/**
 * The return from Telegram, if this page is one. The address is wiped and
 * the mark taken FIRST, whatever happens next: a reload must not replay the
 * same state, and a mark serves one return only.
 *
 * Refused WITHOUT a request: an error from Telegram, a return without code
 * and state, and a return this browser holds no mark for (another browser's
 * link -- platform/browser-login.ts, WHY THE MARK).
 */
async function completeFromReturn(authStore: ReturnType<typeof useAuthStore>): Promise<boolean> {
  const back = takeLoginReturn()
  if (!back) return false
  const started = takeLoginMark()

  if (back.error) {
    loginNotice.value = 'cancelled'
    return false
  }
  if (!back.code || !back.state) {
    loginNotice.value = 'telegram_failed'
    return false
  }
  if (!started || started.state !== back.state) {
    loginNotice.value = 'foreign'
    return false
  }

  try {
    const granted = await authStore.completeBrowserLogin(back.code, back.state, started.mark)
    botAccessHint.value = !granted
    return true
  } catch (error) {
    loginNotice.value = loginNoticeFor(error)
    return false
  }
}

export function useAuth() {
  const authStore = useAuthStore()

  return {
    isReady,
    isAuthenticated: computed(() => authStore.isAuthenticated),
    restoreUnreachable,
    loginNotice,
    botAccessHint,
    isLoggingOut,
    initAuth,
    /** Exposed for testing (10.4). */
    resetAuthState,
  }
}
