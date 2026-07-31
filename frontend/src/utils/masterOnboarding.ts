// =============================================================================
// VELO Frontend -- Master onboarding gate (Phase D, slice-1)
// =============================================================================
//
// Pure helpers for the post-approval master onboarding carousel
// (MasterOnboardingView), shown ONCE to a freshly-verified master as a
// full-screen overlay on first master-dashboard entry. Kept framework-free so
// the gate is unit-testable.
//
// E15 SHIPPED (PROMPT №256/257): `master_onboarding_completed` is persisted by
// the backend and typed on UserResponse. The reader below stays null-tolerant
// (absent / undefined / null -> false) so it accepts a not-yet-loaded user.
// =============================================================================

import type { UserRole } from '@/api/types'

/**
 * Null-tolerant read of the `master_onboarding_completed` flag (E15).
 *
 * The field is now on the typed UserResponse; the loose parameter keeps the
 * helper usable with a still-null auth user and framework-free in unit tests.
 */
export function isMasterOnboardingCompleted(user: unknown): boolean {
  return (
    (user as { master_onboarding_completed?: boolean } | null | undefined)
      ?.master_onboarding_completed ?? false
  )
}

export interface MasterOnboardingGateInput {
  /** Current account role (null while auth is still resolving). */
  role: UserRole | null
  /** Master profile verification status ('verified' once the admin approves). */
  profileStatus: string | null | undefined
  /** Persisted server-flag read (isMasterOnboardingCompleted, E15). */
  completed: boolean
  /** Per-session suppression (set on done/skip; cleared on logout). */
  shownThisSession: boolean
}

/**
 * Show the post-approval carousel exactly once: only to a VERIFIED master who
 * has neither completed it (the persisted E15 server flag) nor dismissed it
 * this session. No forced replays — the tester scaffolding was stripped in
 * №260; the natural prod trigger is the only trigger.
 */
export function shouldShowMasterOnboarding(input: MasterOnboardingGateInput): boolean {
  return (
    input.role === 'master' &&
    input.profileStatus === 'verified' &&
    !input.completed &&
    !input.shownThisSession
  )
}
