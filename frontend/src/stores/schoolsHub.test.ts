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
})
