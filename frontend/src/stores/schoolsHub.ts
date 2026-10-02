// =============================================================================
// VELO Frontend -- Schools Hub Store (tz-curator.md §1.2)
// =============================================================================
//
// One small piece of server truth the SHELLS need before any school screen
// mounts: does this account see the conditional «Школы» tab at all?
//
// THE TAB FOLLOWS MEMBERSHIP (owner 2026-09-22, FE-88), not curatorship:
//   - USER zone: >= 1 school of ANY relation (curator / master / student).
//     /curator-groups/mine is a user surface, so EVERY authenticated account
//     is probed -- the plain student of one school is the branch this store
//     used to defer as a "later slice".
//   - MASTER zone: the same membership, OR the admin-issued right to found a
//     school (can_create_groups, BE-18). A right holder with zero schools
//     keeps their entrance -- the empty hub with «Создать школу» is exactly
//     their screen (owner 2026-09-19); a master without the right gains the
//     tab when they belong to somebody else's school.
//
// The facts ride TWO calls: GET /curator-groups/mine (memberships; everyone)
// and GET /masters/me/curator-groups (the founding right; only accounts with
// master capability in role_switch.allowed_roles may call the master surface
// at all -- for everyone else that probe is skipped, no network round-trip).
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
   *  mine probe reads as "no schools". */
  const hasSchools = computed(() => mineSettled.value && mine.value.length > 0)

  /** Owner 2026-10-01: whoever holds the admin-issued founding right
   *  (can_create_groups) IS a curator account -- the user zone hides the
   *  personal-diary surfaces (the «Дневник» tab, the dashboard quick
   *  actions) for them. Fail-closed for POSSIBLE holders: a master-capable
   *  account whose master probe has not settled yet reads as curator until
   *  the probe answers, so a diary tab never flashes for a right holder.
   *  A plain user (or an applicant) can never hold the right -- the same
   *  gate ensureCurator probes the master surface through -- so they are
   *  known-non-curator with zero network round-trips and nothing flickers.
   *
   *  COLD-LOAD SMOOTHING (owner 2026-10-01: «косяки» -- the tab popped in
   *  late for verified masters on every fresh load): while the probe is in
   *  flight the PREVIOUS session's settled answer is reused from
   *  sessionStorage, so repeat visits render the tab instantly and correctly.
   *  Only an account never probed before falls back to fail-closed. */
  const MASTER_INVITE_CURATOR_ANSWER_KEY = 'schoolsHub.curatorAnswer'

  const isCuratorAccount = computed(() => {
    if (canCreate.value) return true
    if (!authStore.allowedRoles.includes('master')) return false
    if (masterSettled.value) return false
    return sessionStorage.getItem(MASTER_INVITE_CURATOR_ANSWER_KEY) !== '0'
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
    // Master surface requires a verified master token; a plain user (or an
    // applicant) can never hold the founding right, so no call, no error
    // round-trip.
    if (!masterSettled.value && authStore.allowedRoles.includes('master')) {
      probes.push(
        getCuratorGroups()
          .then((res) => {
            canCreate.value = res.can_create_groups ?? false
            masterSettled.value = true
            // Cold-load smoothing (see isCuratorAccount): remember the
            // settled answer so the NEXT session renders instantly.
            sessionStorage.setItem(MASTER_INVITE_CURATOR_ANSWER_KEY, canCreate.value ? '1' : '0')
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
    // A different account must not inherit the previous one's cached
    // curator answer (same W-1 reasoning as the schools reset).
    sessionStorage.removeItem(MASTER_INVITE_CURATOR_ANSWER_KEY)
  }

  return {
    canCreate,
    mine,
    hasSchools,
    isCuratorAccount,
    ensureCurator,
    refreshCurator,
    $reset,
  }
})
