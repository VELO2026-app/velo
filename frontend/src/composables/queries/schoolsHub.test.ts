// =============================================================================
// VELO Frontend -- the schools hub on Colada (FE-88, tz-curator.md §1.2; FE-166 step 5)
// =============================================================================
//
// The hub is the one server truth the shells filter the conditional Schools
// tab (i18n:tabs.schools) with -- stores/schoolsHub.ts until FE-166 step 5,
// now two queries (composables/queries/schools.ts). Real Pinia and Colada,
// mocked API seam.
//
// What is under test, and why:
//   1. The tab condition follows MEMBERSHIP (owner 2026-09-22): every account
//      is probed through GET /schools/mine; only master-mode, master-capable
//      accounts additionally probe the master surface for the founding right
//      (can_create_schools, BE-18).
//   2. Fail-closed: a failed probe keeps the tab hidden and is retried on the
//      next shell mount; a failed MASTER probe must not poison the membership
//      answer.
//   3. A join made in this app refreshes the hub (INVALIDATES.joinSchool); the
//      end of a session empties it (the account scope, queries/setup.ts).
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyInstanceConfig } from '@/platform/instance'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { PiniaColada, useQueryCache } from '@pinia/colada'
import { coladaOptions, useQueryScopeStore } from '@/composables/queries/setup'
import {
  cachedHasSchools,
  ensureSchoolsHub,
  hasSchoolsFor,
  useSchoolsHub,
} from '@/composables/queries/schools'
import { invalidateAfter } from '@/composables/queries/invalidation'
import { useAuthStore } from '@/stores/auth'
import * as cgApi from '@/api/schools'
import type { SchoolMineItem } from '@/api/types'

vi.mock('@/api/schools')

function mineItem(overrides: Partial<SchoolMineItem> = {}): SchoolMineItem {
  return {
    id: 'g1',
    name: 'Тихая школа',
    description: null,
    curator: { id: 'c1', name: 'Мария' },
    masters_count: 1,
    students_count: 3,
    relation: 'student',
    ...overrides,
  } as SchoolMineItem
}

let pinia: Pinia
let app: App | null = null
let hub: ReturnType<typeof useSchoolsHub>

function seedRoles(roles: string[], activeRole?: 'user' | 'master'): void {
  useAuthStore().user = {
    id: 'u1',
    // FE-93: capability (allowed_roles) and the ACTIVE role are separate --
    // a master switched to user mode keeps ['user', 'master'] but reads as
    // role='user'.
    role: activeRole ?? (roles.includes('master') ? 'master' : 'user'),
    role_switch: { allowed_roles: roles },
  } as never
}

/** A shell: holds the hub, as UserShell / MasterShell do. */
function mountShell(): void {
  const Shell = defineComponent({
    setup() {
      hub = useSchoolsHub()
      return () => h('div')
    },
  })
  app = createApp(Shell).use(pinia)
  app.mount(document.createElement('div'))
}

function unmountShell(): void {
  app?.unmount()
  app = null
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  pinia = createPinia()
  createApp({}).use(pinia).use(PiniaColada, coladaOptions)
  setActivePinia(pinia)
  vi.mocked(cgApi.getMySchools).mockReset()
  vi.mocked(cgApi.getSchools).mockReset()
})

afterEach(() => {
  unmountShell()
  applyInstanceConfig(null)
  vi.useRealTimers()
})

describe('the schools hub', () => {
  it('a plain user with a school gets the tab through /mine alone', async () => {
    seedRoles(['user'])
    vi.mocked(cgApi.getMySchools).mockResolvedValue({ items: [mineItem()] })
    mountShell()
    await flush()

    expect(hub.hasSchools.value).toBe(true)
    expect(cgApi.getSchools).not.toHaveBeenCalled()
  })

  it('a plain user without schools keeps the tab hidden', async () => {
    seedRoles(['user'])
    vi.mocked(cgApi.getMySchools).mockResolvedValue({ items: [] })
    mountShell()
    await flush()

    expect(hub.hasSchools.value).toBe(false)
  })

  it('in master mode both surfaces are probed; the right rides the master one', async () => {
    seedRoles(['user', 'master'])
    vi.mocked(cgApi.getMySchools).mockResolvedValue({ items: [] })
    vi.mocked(cgApi.getSchools).mockResolvedValue({ items: [], can_create_schools: true })
    mountShell()
    await flush()

    expect(cgApi.getMySchools).toHaveBeenCalledTimes(1)
    expect(cgApi.getSchools).toHaveBeenCalledTimes(1)
    expect(hub.canCreate.value).toBe(true)
    expect(hub.hasSchools.value).toBe(false)
  })

  it('FE-93: in user mode a curated-only /mine keeps the tab hidden and the master surface undialed', async () => {
    seedRoles(['user', 'master'], 'user')
    vi.mocked(cgApi.getMySchools).mockResolvedValue({ items: [mineItem({ relation: 'curator' })] })
    mountShell()
    await flush()

    expect(hub.hasSchools.value).toBe(false)
    expect(cgApi.getSchools).not.toHaveBeenCalled()
  })

  it('the same /mine counts the curated school in master mode (no re-probe on a role switch)', async () => {
    seedRoles(['user', 'master'], 'user')
    vi.mocked(cgApi.getMySchools).mockResolvedValue({ items: [mineItem({ relation: 'curator' })] })
    vi.mocked(cgApi.getSchools).mockResolvedValue({ items: [], can_create_schools: false })
    mountShell()
    await flush()
    expect(hub.hasSchools.value).toBe(false)

    seedRoles(['user', 'master'], 'master')
    await flush()

    expect(hub.hasSchools.value).toBe(true)
    expect(cgApi.getMySchools).toHaveBeenCalledTimes(1)
  })

  it('FE-93: in user mode a joined school keeps the tab up beside the curated ones', () => {
    expect(hasSchoolsFor([mineItem({ relation: 'curator' }), mineItem({ id: 'g2' })], 'user')).toBe(
      true,
    )
  })

  it('a FAILED probe keeps the tab hidden and is retried by the next shell mount', async () => {
    seedRoles(['user'])
    vi.mocked(cgApi.getMySchools).mockRejectedValueOnce(new Error('offline'))
    mountShell()
    await flush()
    expect(hub.hasSchools.value).toBe(false)
    unmountShell()

    vi.mocked(cgApi.getMySchools).mockResolvedValue({ items: [mineItem()] })
    mountShell()
    await flush()

    expect(cgApi.getMySchools).toHaveBeenCalledTimes(2)
    expect(hub.hasSchools.value).toBe(true)
  })

  it('a failed MASTER probe does not poison the membership answer', async () => {
    seedRoles(['user', 'master'])
    vi.mocked(cgApi.getMySchools).mockResolvedValue({ items: [mineItem()] })
    vi.mocked(cgApi.getSchools).mockRejectedValue(new Error('offline'))
    mountShell()
    await flush()

    expect(hub.hasSchools.value).toBe(true)
    expect(hub.canCreate.value).toBe(false)
  })

  it('a join re-reads the hub before the navigation, with no shell mounted (the join route is outside the shells)', async () => {
    seedRoles(['user'])
    vi.mocked(cgApi.getMySchools).mockResolvedValue({ items: [] })
    mountShell()
    await flush()
    expect(hub.hasSchools.value).toBe(false)
    unmountShell() // the join screen replaced the shell

    vi.mocked(cgApi.getMySchools).mockResolvedValue({ items: [mineItem()] })
    const cache = useQueryCache(pinia)
    await invalidateAfter(cache, 'joinSchool')
    await ensureSchoolsHub(cache)
    expect(cachedHasSchools(cache)).toBe(true)

    // The shell the navigation lands in shows the tab at once.
    mountShell()
    expect(hub.hasSchools.value).toBe(true)
  })

  it('one answer per session: another consumer mounting later asks nothing', async () => {
    vi.useFakeTimers()
    seedRoles(['user', 'master'])
    vi.mocked(cgApi.getMySchools).mockResolvedValue({ items: [mineItem()] })
    vi.mocked(cgApi.getSchools).mockResolvedValue({ items: [], can_create_schools: false })
    mountShell()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(31_000)

    const second = createApp(
      defineComponent({
        setup() {
          useSchoolsHub()
          return () => h('div')
        },
      }),
    ).use(pinia)
    second.mount(document.createElement('div'))
    await vi.advanceTimersByTimeAsync(0)
    second.unmount()

    expect(cgApi.getMySchools).toHaveBeenCalledTimes(1)
    expect(cgApi.getSchools).toHaveBeenCalledTimes(1)
  })

  it('switching to master mode in a mounted shell dials the master surface then', async () => {
    seedRoles(['user', 'master'], 'user')
    vi.mocked(cgApi.getMySchools).mockResolvedValue({ items: [] })
    vi.mocked(cgApi.getSchools).mockResolvedValue({ items: [], can_create_schools: true })
    mountShell()
    await flush()
    expect(cgApi.getSchools).not.toHaveBeenCalled()

    seedRoles(['user', 'master'], 'master')
    await flush()

    expect(cgApi.getSchools).toHaveBeenCalledTimes(1)
    expect(hub.canCreate.value).toBe(true)
  })

  it('master mode without master CAPABILITY never dials the master surface', async () => {
    seedRoles(['user'], 'master')
    vi.mocked(cgApi.getMySchools).mockResolvedValue({ items: [] })
    mountShell()
    await flush()

    expect(cgApi.getSchools).not.toHaveBeenCalled()
  })

  it('FE-151: with the schools option off nothing is asked and no tab shows', async () => {
    applyInstanceConfig({ options: { payments: 'on' } } as never)
    seedRoles(['user', 'master'])
    mountShell()
    await flush()
    await ensureSchoolsHub(useQueryCache(pinia))

    expect(cgApi.getMySchools).not.toHaveBeenCalled()
    expect(cgApi.getSchools).not.toHaveBeenCalled()
    expect(hub.hasSchools.value).toBe(false)
    expect(hub.canCreate.value).toBe(false)
  })

  it('the end of a session drops the schools (an account switch must not inherit them)', async () => {
    seedRoles(['user'])
    vi.mocked(cgApi.getMySchools).mockResolvedValue({ items: [mineItem()] })
    mountShell()
    await flush()
    expect(hub.hasSchools.value).toBe(true)

    vi.mocked(cgApi.getMySchools).mockReturnValue(new Promise(() => {}))
    useQueryScopeStore(pinia).$reset()
    await flush()

    expect(hub.hasSchools.value).toBe(false)
    expect(hub.mine.value).toEqual([])
  })
})

describe('the hub outside a component (first-screen gate, idle prefetch)', () => {
  it('ensureSchoolsHub loads both facts in master mode and never rejects', async () => {
    seedRoles(['user', 'master'])
    vi.mocked(cgApi.getMySchools).mockResolvedValue({ items: [mineItem()] })
    vi.mocked(cgApi.getSchools).mockRejectedValue(new Error('offline'))

    await expect(ensureSchoolsHub(useQueryCache(pinia))).resolves.toBeUndefined()

    expect(cachedHasSchools(useQueryCache(pinia))).toBe(true)
    expect(cgApi.getSchools).toHaveBeenCalledTimes(1)
  })

  it('in user mode it does not dial the master surface', async () => {
    seedRoles(['user', 'master'], 'user')
    vi.mocked(cgApi.getMySchools).mockResolvedValue({ items: [] })

    await ensureSchoolsHub(useQueryCache(pinia))

    expect(cgApi.getSchools).not.toHaveBeenCalled()
    expect(cachedHasSchools(useQueryCache(pinia))).toBe(false)
  })
})
