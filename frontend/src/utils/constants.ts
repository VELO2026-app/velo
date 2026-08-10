// =============================================================================
// VELO Frontend -- Shared Constants (NEW-1, TD-FE-W6)
// =============================================================================
//
// Single source of truth for magic numbers shared across multiple views.
// All values mirror their backend counterparts in config.py -- if a backend
// value changes, update it here too.
// =============================================================================

// ---------------------------------------------------------------------------
// Time window constants (NEW-1)
// Mirror: backend config.py checkin_window_hours / feedback_window_hours.
// If those change, update these too.
// Used by: UserDashboardView, PracticeDetailView
// ---------------------------------------------------------------------------

/**
 * Hours before scheduled_at during which check-in is allowed.
 * Mirrors backend config.py checkin_window_hours (24). Changed 3 -> 24
 * (customer request 2026-06-03).
 */
export const CHECKIN_WINDOW_H = 24

/** Hours after practice ends during which feedback is allowed. */
export const FEEDBACK_WINDOW_H = 72

// ---------------------------------------------------------------------------
// Finance constants (TD-FE-W6)
// Mirror: backend config.py min_withdrawal_cents=5000, withdrawal_fee_cents=200
// Used by: MasterFinanceView
// ---------------------------------------------------------------------------

/** Minimum withdrawal amount in euros (backend: min_withdrawal_cents = 5000). */
export const MIN_WITHDRAWAL_EUROS = 50

/** Platform fee deducted per withdrawal in euros (backend: withdrawal_fee_cents = 200). */
export const WITHDRAWAL_FEE_EUROS = 2

// ---------------------------------------------------------------------------
// Master onboarding (WS-1, item 2)
// Used by: MasterApplyView (set), master store $reset (clear), masterPendingGuard (read)
// ---------------------------------------------------------------------------

/**
 * sessionStorage marker set on a successful master-application submit. The
 * `master-pending` route guard uses it to tell an actual applicant (who stays
 * role='user' until the backend promotes them) apart from a plain user who
 * navigated to the pending URL directly. Cleared on logout via master $reset.
 */
export const MASTER_APPLIED_KEY = 'velo:master-applied'

/**
 * localStorage marker key, PER-USER (W18 fix, PROMPT №408 -- was a flat
 * `MASTER_APPROVED_SEEN_KEY` constant that leaked across accounts on a shared
 * device, same class of bug masterRejectionSeenKey below was built to avoid
 * from the start). Set once the master has actually seen/entered through the
 * "Ваша заявка одобрена!" screen (MasterPendingView.enterMasterMode).
 * RoleSwitchSection reads it to decide whether a role='user'->master
 * self-switch should detour through the approved screen first (not seen yet)
 * or go straight to the dashboard (already seen). Not cleared on logout -- it
 * is a one-time "have they ever seen this celebratory screen" fact about the
 * account/device, not per-session state; self-isolating per user via the key
 * name, so no explicit clear-on-logout is needed either.
 */
export function masterApprovedSeenKey(userId: string): string {
  return `velo:master-approved-seen:${userId}`
}

/**
 * localStorage marker key, PER-USER (bug 1, PROMPT №405 -- operator device
 * testing 2026-07-15): set once a rejected applicant has actually seen the
 * «Отказ» screen (MasterPendingView), read by roleRedirect to decide whether
 * a returning role='user' rejected applicant is routed to /master/pending
 * (not yet seen) or straight to /user/dashboard (already seen -- operator
 * decision: show once, then treat them as an ordinary user; rejection is not
 * captivity). Scoped by userId in the key itself -- W18 (unscoped
 * localStorage) is what made the old flat MASTER_APPROVED_SEEN_KEY a trap
 * that leaked across accounts on a shared device; embedding userId avoids
 * that from the start rather than reproducing it. Not cleared on logout,
 * same lifetime-fact semantics as masterApprovedSeenKey above -- self-
 * isolating per user via the key name, so no explicit clear-on-logout is
 * needed either.
 */
export function masterRejectionSeenKey(userId: string): string {
  return `velo:master-rejection-seen:${userId}`
}

// ---------------------------------------------------------------------------
// Keyboard / visual-viewport (keyboard-aware layout)
// ---------------------------------------------------------------------------

/**
 * Visual-viewport shrink (px) past which we treat the soft keyboard as open.
 * Single source for useKeyboardOpen (tab-bar hide) AND useBackgroundStabilizer
 * (the `html.is-keyboard-open` class that gates the keyboard-aware layout in
 * global.css), so the two detections never drift. iOS / Telegram keyboards
 * shrink the visual viewport well past this.
 */
export const KEYBOARD_VIEWPORT_THRESHOLD = 150
