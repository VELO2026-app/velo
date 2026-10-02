// =============================================================================
// VELO Frontend -- Schools Hub Store Tests (FE-88, tz-curator.md §1.2)
// =============================================================================
//
// The hub is the one server truth the shells filter the conditional «Школы»
// tab with. Real Pinia, mocked API seam (velo-idiom §4/§5) -- the store is
// the unit under test, so only the network boundary is faked.
//
// What is under test, and why:
//   1. The tab condition follows MEMBERSHIP (owner 2026-09-22): every
//      account is probed through GET /curator-groups/mine; only
//      master-capable accounts additionally probe the master surface for the
//      founding right (can_create_groups, BE-18).
//   2. Fail-closed per zone: a failed probe stays unsettled, keeps the tab
//      hidden, and RETRIES on the next ensure; a settled probe never
//      re-fetches. A failed MASTER probe must not poison the membership
//      answer.
//   3. refreshCurator forces a fresh read (the join flow's contract: the
//      account may have just gained its first school); $reset drops
//      everything so an account switch never inherits schools (W-1).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSchoolsHubStore } from '@/stores/schoolsHub'
import { useAuthStore } from '@/stores/auth'
import * as cgApi from '@/api/curatorGroups'
import type { CuratorGroupMineItem } from '@/api/types'

vi.mock('@/api/curatorGroups')

function mineItem(overrides: Partial<CuratorGroupMineItem> = {}): CuratorGroupMineItem {
  return {
    id: 'g1',
    name: 'Тихая школа',
    description: null,
    curator: { id: 'c1', name: 'Мария' },
    masters_count: 1,
    students_count: 3,
    relation: 'student',
    ...overrides,
  } as CuratorGroupMineItem
}

function seedRoles(roles: string[]): void {
  useAuthStore().user = {
    id: 'u1',
    role: roles.includes('master') ? 'master' : 'user',
    role_switch: { allowed_roles: roles },
  } as never
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(cgApi.getMyCuratorGroups).mockReset()
  vi.mocked(cgApi.getCuratorGroups).mockReset()
})

describe('schoolsHub store', () => {
  it('a plain user with a school settles the tab through /mine alone', async () => {
    seedRoles(['user'])
    vi.mocked(cgApi.getMyCuratorGroups).mockResolvedValue({ items: [mineItem()] })

    const hub = useSchoolsHubStore()
    await hub.ensureCurator()

    expect(hub.hasSchools).toBe(true)
    expect(cgApi.getMyCuratorGroups).toHaveBeenCalledTimes(1)
    // The master surface would 403 for this token -- the store must not even
    // ask (no error round-trip).
    expect(cgApi.getCuratorGroups).not.toHaveBeenCalled()
  })

  it('a plain user without schools keeps the tab hidden', async () => {
    seedRoles(['user'])
    vi.mocked(cgApi.getMyCuratorGroups).mockResolvedValue({ items: [] })

    const hub = useSchoolsHubStore()
    await hub.ensureCurator()

    expect(hub.hasSchools).toBe(false)
  })

  it('a master-capable account is probed on both surfaces; the right rides the master one', async () => {
    seedRoles(['user', 'master'])
    vi.mocked(cgApi.getMyCuratorGroups).mockResolvedValue({ items: [] })
    vi.mocked(cgApi.getCuratorGroups).mockResolvedValue({
      items: [],
      can_create_groups: true,
    })

    const hub = useSchoolsHubStore()
    await hub.ensureCurator()

    expect(hub.hasSchools).toBe(false)
    expect(hub.canCreate).toBe(true)
  })

  it('a settled probe never re-fetches', async () => {
    seedRoles(['user', 'master'])
    vi.mocked(cgApi.getMyCuratorGroups).mockResolvedValue({ items: [mineItem()] })
    vi.mocked(cgApi.getCuratorGroups).mockResolvedValue({ items: [], can_create_groups: false })

    const hub = useSchoolsHubStore()
    await hub.ensureCurator()
    await hub.ensureCurator()

    expect(cgApi.getMyCuratorGroups).toHaveBeenCalledTimes(1)
    expect(cgApi.getCuratorGroups).toHaveBeenCalledTimes(1)
  })

  it('a FAILED probe stays hidden and retries on the next ensure', async () => {
    seedRoles(['user'])
    vi.mocked(cgApi.getMyCuratorGroups)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ items: [mineItem()] })

    const hub = useSchoolsHubStore()
    await hub.ensureCurator()
    expect(hub.hasSchools).toBe(false)

    await hub.ensureCurator()
    expect(hub.hasSchools).toBe(true)
    expect(cgApi.getMyCuratorGroups).toHaveBeenCalledTimes(2)
  })

  it('a failed MASTER probe does not poison the membership answer', async () => {
    seedRoles(['user', 'master'])
    vi.mocked(cgApi.getMyCuratorGroups).mockResolvedValue({
      items: [mineItem({ relation: 'master' })],
    })
    vi.mocked(cgApi.getCuratorGroups).mockRejectedValue(new Error('offline'))

    const hub = useSchoolsHubStore()
    await hub.ensureCurator()

    expect(hub.hasSchools).toBe(true)
    expect(hub.canCreate).toBe(false)
  })

  it('refreshCurator forces a fresh read: a school gained outside the shell is picked up', async () => {
    seedRoles(['user'])
    vi.mocked(cgApi.getMyCuratorGroups)
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [mineItem()] })

    const hub = useSchoolsHubStore()
    await hub.ensureCurator()
    expect(hub.hasSchools).toBe(false)

    // The join flow's contract (FE-88): the account just joined its first
    // school through a standalone deeplink -- the fresh read must see it.
    await hub.refreshCurator()
    expect(hub.hasSchools).toBe(true)
    expect(cgApi.getMyCuratorGroups).toHaveBeenCalledTimes(2)
  })

  it('$reset drops everything (an account switch must not inherit schools)', async () => {
    seedRoles(['user'])
    vi.mocked(cgApi.getMyCuratorGroups).mockResolvedValue({ items: [mineItem()] })

    const hub = useSchoolsHubStore()
    await hub.ensureCurator()
    expect(hub.hasSchools).toBe(true)

    hub.$reset()
    expect(hub.hasSchools).toBe(false)
    expect(hub.mine).toEqual([])

    // The reset re-opens both probes: the next ensure fetches again.
    await hub.ensureCurator()
    expect(cgApi.getMyCuratorGroups).toHaveBeenCalledTimes(2)
  })

  // -- isCuratorAccount (owner 2026-10-01: the founding right IS curatorship;
  //    the user zone hides the personal-diary surfaces for a holder) --
  describe('isCuratorAccount', () => {
    it('a settled right holder reads as curator', async () => {
      seedRoles(['user', 'master'])
      vi.mocked(cgApi.getMyCuratorGroups).mockResolvedValue({ items: [] })
      vi.mocked(cgApi.getCuratorGroups).mockResolvedValue({
        items: [],
        can_create_groups: true,
      })

      const hub = useSchoolsHubStore()
      await hub.ensureCurator()

      expect(hub.isCuratorAccount).toBe(true)
    })

    it('a master-capable account with an unsettled probe reads as curator (fail-closed)', async () => {
      // Both probes hang, like a stalled network: until the master probe
      // answers, the account COULD hold the right -- the diary surfaces must
      // not flash for a possible holder.
      seedRoles(['user', 'master'])
      vi.mocked(cgApi.getMyCuratorGroups).mockReturnValue(new Promise(() => {}))
      vi.mocked(cgApi.getCuratorGroups).mockReturnValue(new Promise(() => {}))

      const hub = useSchoolsHubStore()
      void hub.ensureCurator()

      expect(hub.isCuratorAccount).toBe(true)
    })

    // -- Cold-load smoothing (owner 2026-10-01): the PREVIOUS session's
    //    settled answer is reused while the probe is in flight, so the diary
    //    surfaces neither flash in (plain masters) nor flash out (right
    //    holders) on a fresh page load. --
    it('cold load, cached answer "0": a master-capable account renders the diary surfaces immediately', () => {
      seedRoles(['user', 'master'])
      sessionStorage.setItem('schoolsHub.curatorAnswer', '0')
      vi.mocked(cgApi.getMyCuratorGroups).mockReturnValue(new Promise(() => {}))
      vi.mocked(cgApi.getCuratorGroups).mockReturnValue(new Promise(() => {}))

      const hub = useSchoolsHubStore()
      void hub.ensureCurator()

      expect(hub.isCuratorAccount).toBe(false)
    })

    it('cold load, cached answer "1": the surfaces stay hidden while pending (no flash for a right holder)', () => {
      seedRoles(['user', 'master'])
      sessionStorage.setItem('schoolsHub.curatorAnswer', '1')
      vi.mocked(cgApi.getMyCuratorGroups).mockReturnValue(new Promise(() => {}))
      vi.mocked(cgApi.getCuratorGroups).mockReturnValue(new Promise(() => {}))

      const hub = useSchoolsHubStore()
      void hub.ensureCurator()

      expect(hub.isCuratorAccount).toBe(true)
    })

    it('cold load with NO cached answer stays fail-closed for a master-capable account', () => {
      seedRoles(['user', 'master'])
      sessionStorage.removeItem('schoolsHub.curatorAnswer')
      vi.mocked(cgApi.getMyCuratorGroups).mockReturnValue(new Promise(() => {}))
      vi.mocked(cgApi.getCuratorGroups).mockReturnValue(new Promise(() => {}))

      const hub = useSchoolsHubStore()
      void hub.ensureCurator()

      expect(hub.isCuratorAccount).toBe(true)
    })

    it('a plain user is known-non-curator without any network round-trip (no flicker)', () => {
      // No master capability -> the right is unreachable for this token (the
      // same gate that keeps ensureCurator off the master surface), so the
      // answer is available from the auth store alone.
      seedRoles(['user'])

      const hub = useSchoolsHubStore()

      expect(hub.isCuratorAccount).toBe(false)
    })

    it('a master-capable account whose probe settled without the right is not a curator', async () => {
      seedRoles(['user', 'master'])
      vi.mocked(cgApi.getMyCuratorGroups).mockResolvedValue({ items: [] })
      vi.mocked(cgApi.getCuratorGroups).mockResolvedValue({
        items: [],
        can_create_groups: false,
      })

      const hub = useSchoolsHubStore()
      await hub.ensureCurator()

      expect(hub.canCreate).toBe(false)
      expect(hub.isCuratorAccount).toBe(false)
    })

    it('$reset returns a right holder to the fail-closed unknown (no leak to the next account)', async () => {
      seedRoles(['user', 'master'])
      vi.mocked(cgApi.getMyCuratorGroups).mockResolvedValue({ items: [] })
      vi.mocked(cgApi.getCuratorGroups).mockResolvedValue({
        items: [],
        can_create_groups: true,
      })

      const hub = useSchoolsHubStore()
      await hub.ensureCurator()
      expect(hub.isCuratorAccount).toBe(true)

      hub.$reset()
      // Settled state is gone, the account may or may not hold the right
      // again -> back to the fail-closed answer, not to a stale "not a
      // curator".
      expect(hub.isCuratorAccount).toBe(true)
    })
  })
})
