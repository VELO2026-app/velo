// =============================================================================
// VELO Frontend -- Schools Hub Store (tz-curator.md §1.2)
// =============================================================================
//
// One small piece of server truth the SHELLS need before any school screen
// mounts: does this account see the conditional «Школы» tab at all?
//
// THE TAB FOLLOWS MEMBERSHIP (owner 2026-09-22, FE-88), not curatorship:
//   - USER zone: >= 1 JOINED school (FE-93: master / student memberships;
//     the curated rows /mine still answers -- relation is role-independent
//     -- are the master list's «Я куратор» section, so a curator switched
//     to user mode counts their participations only).
//     /curator-groups/mine is a user surface, so EVERY authenticated account
//     is probed -- the plain student of one school is the branch this store
//     used to defer as a "later slice".
//   - MASTER zone: the same membership (any relation), OR the admin-issued
//     right to found a school (can_create_groups, BE-18). A right holder
//     with zero schools keeps their entrance -- the empty hub with
//     «Создать школу» is exactly their screen (owner 2026-09-19); a master
//     without the right gains the tab when they belong to somebody else's
//     school.
//
// The facts ride TWO calls: GET /curator-groups/mine (memberships; everyone)
// and GET /masters/me/curator-groups (the founding right; only IN MASTER
// MODE with master capability -- the surface requires the current role, so
// the probe waits for it instead of burning a 403 per shell mount).
//
// Fail-closed PER ZONE: an unsettled probe never shows its tab. A FAILED
// fetch stays unsettled so the next shell mount retries.
// =============================================================================

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { getCuratorGroups, getMyCuratorGroups } from '@/api/curatorGroups'
import { useAuthStore } from '@/stores/auth'
import type { CuratorGroupMineItem } from '@/api/types'

export const useSchoolsHubStore = defineStore('schoolsHub', () => {
  const authStore = useAuthStore()

  /** The admin-issued right to FOUND a school (BE-18); gates «+»/CTA and
   *  keeps the MASTER-zone tab alive for a right holder with no schools. */
  const canCreate = ref(false)
  /** Schools I belong to (GET /curator-groups/mine items, any relation). */
  const mine = ref<CuratorGroupMineItem[]>([])
  /** Settled = the probe succeeded (the tab decision is server-backed).
   *  Separate per surface: the user-zone tab filters on the mine probe
   *  alone, the master-zone tab on either probe (see the shells). */
  const mineSettled = ref(false)
  const masterSettled = ref(false)

  /** The USER-zone tab condition. Fail-closed: an unsettled (or failed)
   *  mine probe reads as "no schools". FE-93: in user mode only JOINED
   *  schools count -- the curated rows /mine still answers are the master
   *  list's «Я куратор» section, so a curator switched to user mode with no
   *  participations reads as "no schools" until they switch back. The raw
   *  /mine payload does not depend on the role, so recomputing on a role
   *  switch is enough -- no re-probe. */
  const hasSchools = computed(() => {
    if (!mineSettled.value) return false
    if (authStore.role === 'master') return mine.value.length > 0
    return mine.value.some((g) => g.relation !== 'curator')
  })

  async function ensureCurator(): Promise<void> {
    const probes: Array<Promise<void>> = []
    if (!mineSettled.value) {
      probes.push(
        getMyCuratorGroups()
          .then((res) => {
            mine.value = res.items
            mineSettled.value = true
          })
          .catch(() => {
            // Leave unsettled: the next shell mount retries. The tab stays
            // hidden meanwhile (fail-closed); the hub screen owns visible
            // errors.
          }),
      )
    }
    // Master surface requires the CURRENT role master (get_current_master)
    // on top of master capability: a master switched to user mode answers
    // 403 there, and a probe that can never settle would just burn one 403
    // per shell mount. canCreate gates the MASTER zone's tab alone, so the
    // probe waits for that mode.
    if (
      !masterSettled.value &&
      authStore.role === 'master' &&
      authStore.allowedRoles.includes('master')
    ) {
      probes.push(
        getCuratorGroups()
          .then((res) => {
            canCreate.value = res.can_create_groups ?? false
            masterSettled.value = true
          })
          .catch(() => {
            // Same retry contract; the master-zone tab then still answers
            // honestly through membership.
          }),
      )
    }
    await Promise.all(probes)
  }

  /** Fresh read -- a membership-adjacent action (join/transfer/delete) calls
   *  this so the tab follows the server without a full reload. */
  async function refreshCurator(): Promise<void> {
    mineSettled.value = false
    masterSettled.value = false
    await ensureCurator()
  }

  /** Mirror of masterStore.$reset: a different account in the same tab must
   *  not inherit the previous one's schools (auth.logout, W-1). */
  function $reset(): void {
    canCreate.value = false
    mine.value = []
    mineSettled.value = false
    masterSettled.value = false
  }

  return {
    canCreate,
    mine,
    /** Probe outcomes -- the «Школы» answer is only as fresh as these;
     *  exposed so membership-adjacent screens can tell a settled "no" from
     *  an in-flight one. */
    mineSettled,
    masterSettled,
    hasSchools,
    ensureCurator,
    refreshCurator,
    $reset,
  }
})
