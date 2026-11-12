// =============================================================================
// VELO Frontend -- Bookings Store: client state only (FE-166 step 3)
// =============================================================================
//
// The user's bookings are server state and live in Pinia Colada since FE-166
// step 3 (composables/queries/bookings.ts): the list (`useMyBookings`), the
// dashboard's upcoming slice (`upcomingBookingsQuery`), and the mutations
// (cancel, purchase, waitlist confirmation, join, skip check-in). What stays
// here is what the server does not hold (ADR, convention 7).
// =============================================================================

import { defineStore } from 'pinia'
import { ref } from 'vue'

/** Client state around the user's bookings: the check-ins skipped this session. */
export const useBookingsStore = defineStore('bookings', () => {
  // Practices whose check-in the user SKIPPED this session -- hides the
  // dashboard check-in banner (i18n:user.screens.userDashboard.checkinBanner.title)
  // at once, before the persisted `checkin_skipped` flag (B2, useSkipCheckin)
  // comes back with the next upcoming answer.
  const dismissedCheckins = ref<string[]>([])

  /** Hide the check-in banner of this practice for the rest of the session. */
  function dismissCheckin(practiceId: string): void {
    if (!dismissedCheckins.value.includes(practiceId)) {
      dismissedCheckins.value.push(practiceId)
    }
  }

  /** A different account in the same tab starts fresh (platform/session.ts, account scope). */
  function $reset(): void {
    dismissedCheckins.value = []
  }

  return { dismissedCheckins, dismissCheckin, $reset }
})
