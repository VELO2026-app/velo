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
  /** The probe DIED (2026-10-04): still unsettled -- the «Школы» tab stays
   *  hidden and the next ensure retries -- but the curator ANSWER below is
   *  resolved, so a dead network cannot hold the dock's first paint forever. */
  const mineFailed = ref(false)
  const masterFailed = ref(false)

  /** The USER-zone tab condition. Fail-closed: an unsettled (or failed)
   *  mine probe reads as "no schools". */
  const hasSchools = computed(() => mineSettled.value && mine.value.length > 0)

  async function ensureCurator(): Promise<void> {
    const probes: Array<Promise<void>> = []
    if (!mineSettled.value) {
      mineFailed.value = false
      probes.push(
        getMyCuratorGroups()
          .then((res) => {
            mine.value = res.items
            mineSettled.value = true
          })
          .catch(() => {
            // Leave unsettled: the next shell mount retries. The tab stays
            // hidden meanwhile (fail-closed); the hub screen owns visible
            // errors. mineFailed releases the tab bar's first-paint hold
            // (curatorAnswerPending) -- a dead network must not eat the dock.
            mineFailed.value = true
          }),
      )
    }
    // Master surface requires a verified master token; a plain user (or an
    // applicant) can never hold the founding right, so no call, no error
    // round-trip.
    if (!masterSettled.value && authStore.allowedRoles.includes('master')) {
      masterFailed.value = false
      probes.push(
        getCuratorGroups()
          .then((res) => {
            canCreate.value = res.can_create_groups ?? false
            masterSettled.value = true
          })
          .catch(() => {
            // Same retry contract; the master-zone tab then still answers
            // honestly through membership. Releases the dock hold as above.
            masterFailed.value = true
          }),
      )
    }
    await Promise.all(probes)
  }

  // ===========================================================================
  // The personal-diary answer (owner 2026-10-04, restoring 2026-10-01's rule):
  // a CURATOR ACCOUNT gets no personal diary surfaces in the user zone -- no
  // «Дневник» tab, no dashboard quick access. A curator account is a
  // founding-right holder (can_create_groups) OR the curator of >= 1 school
  // (mine relation='curator') -- a transfer hands a school to a master who
  // need not hold the founding right, and both are curators all the same.
  //
  // The 2026-10-02 removal was about the FLASH, not the rule: the old gate
  // let the tab paint, then vanish when the async probe answered. The flash
  // now dies on the SHELL side -- the user zone holds the tab bar's first
  // paint on curatorAnswerPending, so whatever paints is final. While
  // pending, diaryVisible reads false (fail-closed): the unresolved answer
  // never becomes visible, the same contract the «Школы» tab follows.
  // ===========================================================================
  const isCuratorAccount = computed(
    () => canCreate.value || mine.value.some((g) => g.relation === 'curator'),
  )

  /** True while the probes that decide the curator answer are still in
   *  flight. A failed probe is an ANSWER (fail-open for the diary: it shows,
   *  and the next mount may correct it) -- only a live wait holds the dock. */
  const curatorAnswerPending = computed(() => {
    if (!mineSettled.value && !mineFailed.value) return true
    if (authStore.allowedRoles.includes('master') && !masterSettled.value && !masterFailed.value) {
      return true
    }
    return false
  })

  /** The user zone's diary-surface gate: resolved AND not a curator. */
  const diaryVisible = computed(() => !curatorAnswerPending.value && !isCuratorAccount.value)

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
    mineFailed.value = false
    masterFailed.value = false
  }

  return {
    canCreate,
    mine,
    /** Probe outcomes -- the «Школы»/diary answers are only as fresh as
     *  these; exposed so membership-adjacent screens can tell a settled
     *  "no" from an in-flight one (the diary gates read them too). */
    mineSettled,
    masterSettled,
    hasSchools,
    isCuratorAccount,
    curatorAnswerPending,
    diaryVisible,
    ensureCurator,
    refreshCurator,
    $reset,
  }
})
