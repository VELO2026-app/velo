// =============================================================================
// VELO Frontend -- Master Store (Phase F6; FE-166 step 5)
// =============================================================================
//
// Client state of the master zone only. The server data that used to live
// here -- the master profile and the master's own practices -- is Colada
// queries since FE-166 step 5 (composables/queries/master.ts).
// =============================================================================

import { defineStore } from 'pinia'
import { ref } from 'vue'
import { MASTER_APPLIED_KEY } from '@/utils/constants'

/** Master-zone client state: the onboarding flag of this session. */
export const useMasterStore = defineStore('master', () => {
  // Per-session suppression for the post-approval onboarding carousel
  // (MasterOnboardingView, Phase D). Set true on done/skip so the overlay does
  // not re-trigger within a session; the persisted server flag
  // (master_onboarding_completed, Zod E15) governs across sessions. Cleared on
  // $reset/logout so a different account in the same tab starts fresh.
  const onboardingShownThisSession = ref(false)

  // Reset on logout (W-1, the account scope: platform/session.ts).
  function $reset(): void {
    onboardingShownThisSession.value = false
    // Drop the applicant marker so a logged-out tab can't reach master-pending.
    sessionStorage.removeItem(MASTER_APPLIED_KEY)
  }

  return { onboardingShownThisSession, $reset }
})
