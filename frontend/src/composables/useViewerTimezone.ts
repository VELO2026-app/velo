// =============================================================================
// VELO Frontend -- useViewerTimezone (Batch 5 / F5)
// =============================================================================
//
// Single source of truth for the timezone in which the CURRENT VIEWER sees
// practice times. Per the Batch 5 product decision, practice times are always
// rendered in each viewer's OWN profile timezone -- the profile decides, not
// the practice's own timezone and not the browser.
//
// Strict, no fallback (by decision): we trust that every user has a valid IANA
// timezone set during onboarding. When the profile timezone is absent (e.g. no
// authenticated user yet), this returns undefined and the format helpers in
// utils/format.ts apply their own neutral default -- we do NOT invent a city.
//
// Returns a ComputedRef (not a snapshot) so callers stay reactive if the
// profile timezone changes within the session (e.g. right after onboarding
// persists it via authStore.updateProfile).
// =============================================================================

import { computed, type ComputedRef } from 'vue'
import { useAuthStore } from '@/stores/auth'

/**
 * The current viewer's display timezone (their profile timezone).
 *
 * @returns Undefined when there is no authenticated user / no timezone on
 *   the profile, in which case the format helpers fall back to their own
 *   neutral default. No city fallback is injected here.
 */
export function useViewerTimezone(): ComputedRef<string | undefined> {
  const authStore = useAuthStore()
  return computed(() => authStore.user?.timezone ?? undefined)
}
