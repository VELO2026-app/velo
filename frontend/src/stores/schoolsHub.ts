// =============================================================================
// VELO Frontend -- Schools Hub Store (tz-curator.md §1.2)
// =============================================================================
//
// One small piece of server truth the USER SHELL needs before any school
// screen mounts: is this account a CURATOR (the «Школы» tab shows for
// curators only -- owner decision 2026-09-19)?
//
// Curator = can_create_groups (the admin-issued right, BE-18) OR curates at
// least one school. Both facts ride the ONE call the master surface already
// serves them on: GET /masters/me/curator-groups. A master whose right was
// revoked keeps their schools (and stays a curator); a master with the right
// but no schools yet is still a curator -- the empty hub with «Создать школу»
// is exactly their screen.
//
// The PLAIN-USER branch (a student who merely belongs to a school) is a later
// slice of the TZ's user flow: the tab stays hidden for them for now.
//
// Only accounts with master capability in role_switch.allowed_roles may call
// the master surface at all -- for everyone else the store settles "not a
// curator" without a network call.
// =============================================================================

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { getCuratorGroups } from '@/api/curatorGroups'
import { useAuthStore } from '@/stores/auth'
import type { CuratorGroupResponse } from '@/api/types'

export const useSchoolsHubStore = defineStore('schoolsHub', () => {
  const authStore = useAuthStore()

  /** Schools I curate (GET /masters/me/curator-groups items). */
  const curated = ref<CuratorGroupResponse[]>([])
  /** The admin-issued right to FOUND a school (BE-18); gates «+»/CTA. */
  const canCreate = ref(false)
  /** Settled = the decision was made from server data (success) or is
   *  final for this account state (no master capability). A FAILED fetch
   *  stays unsettled so the next shell mount retries. */
  const settled = ref(false)

  /** The tab condition (tz-curator.md §1.2, owner): curator = the right
   *  OR at least one school of their own. Fail-closed: not settled -> false. */
  const isCurator = computed(() => canCreate.value || curated.value.length > 0)

  async function ensureCurator(): Promise<void> {
    if (settled.value) return
    // Master surface requires a verified master token; a plain user (or an
    // applicant) can never be a curator, so no call, no error round-trip.
    if (!authStore.allowedRoles.includes('master')) {
      settled.value = true
      return
    }
    try {
      const res = await getCuratorGroups()
      curated.value = res.items
      canCreate.value = res.can_create_groups ?? false
      settled.value = true
    } catch {
      // Leave unsettled: the next UserShell mount retries. The tab stays
      // hidden meanwhile (fail-closed); the hub screen owns visible errors.
    }
  }

  /** Fresh read -- a curator-adjacent action (create/transfer/delete) calls
   *  this so the tab and the «+» follow the server without a full reload. */
  async function refreshCurator(): Promise<void> {
    settled.value = false
    await ensureCurator()
  }

  /** Mirror of masterStore.$reset: a different account in the same tab must
   *  not inherit the previous one's schools (auth.logout, W-1). */
  function $reset(): void {
    curated.value = []
    canCreate.value = false
    settled.value = false
  }

  return {
    curated,
    canCreate,
    settled,
    isCurator,
    ensureCurator,
    refreshCurator,
    $reset,
  }
})
