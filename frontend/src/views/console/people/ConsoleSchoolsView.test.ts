// =============================================================================
// VELO Frontend -- ConsoleSchoolsView tests (FE-262, slice 1)
// =============================================================================
//
// The schools table lists every school, frozen ones included (is_active is a
// badge, not a filter), pages by number, and a row opens the curator's card --
// the lever on a school is its curator's verification. Real Pinia + Colada and
// a real router; @/api/schools is the mocked boundary.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { PiniaColada, useQueryCache } from '@pinia/colada'
import { adminKeys } from '@/composables/queries/adminKeys'
import { coladaOptions } from '@/composables/queries/setup'
import ConsoleSchoolsView from '@/views/console/people/ConsoleSchoolsView.vue'
import * as schoolsApi from '@/api/schools'
import type { AdminSchoolListItem } from '@/api/types'

vi.mock('@/api/schools')

const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: vi.fn(), info: vi.fn() }),
}))

function school(overrides: Partial<AdminSchoolListItem> = {}): AdminSchoolListItem {
  return {
    id: 's1',
    name: 'Tishina',
    curator: { user_id: 'cur1', display_name: 'Anna Lebedeva' },
    masters_count: 3,
    students_count: 214,
    is_active: true,
    created_at: '2026-03-12T10:00:00Z',
    ...overrides,
  }
}

const ACTIVE = school({
  id: 's1',
  name: 'Tishina',
  curator: { user_id: 'cur1', display_name: 'Anna Lebedeva' },
})
const FROZEN = school({
  id: 's2',
  name: 'Veter',
  curator: { user_id: 'cur2', display_name: 'Timur Garaev' },
  is_active: false,
})

let app: App | null = null
let root: HTMLElement | null = null
let router: Router
let pinia: Pinia

/** Colada asks the stale list again on focus and visibilitychange; the entry is asked the same way here. */
async function askAgain(): Promise<void> {
  await useQueryCache(pinia)
    .invalidateQueries({ key: adminKeys.schools() })
    .catch(() => {})
}

async function mount(url = '/console/schools', expectRows = true): Promise<HTMLElement> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/console/schools', name: 'console-schools', component: ConsoleSchoolsView },
      {
        path: '/console/masters/:id',
        name: 'console-masters-detail',
        component: { render: () => null },
      },
    ],
  })
  await router.push(url)
  pinia = createPinia()
  setActivePinia(pinia)
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp({ template: '<RouterView />' })
    .use(createTestI18n())
    .use(pinia)
    .use(PiniaColada, coladaOptions)
    .use(router)
  app.mount(root)
  if (expectRows) await vi.waitFor(() => expect(rows().length).toBeGreaterThan(0))
  return root
}

function rows(): HTMLElement[] {
  return Array.from(root?.querySelectorAll<HTMLElement>('[data-testid="console-table-row"]') ?? [])
}

beforeEach(() => {
  toastError.mockReset()
  vi.mocked(schoolsApi.getAdminSchools)
    .mockReset()
    .mockResolvedValue({ items: [ACTIVE, FROZEN], total: 2, limit: 20, offset: 0 })
})

afterEach(() => {
  app?.unmount()
  root?.remove()
  app = null
  root = null
})

describe('ConsoleSchoolsView', () => {
  it('lists active and frozen schools with their status', async () => {
    await mount()

    expect(rows()).toHaveLength(2)
    expect(rows()[0]?.textContent).toContain('Tishina')
    expect(rows()[0]?.textContent).toContain('Активна')
    expect(rows()[1]?.textContent).toContain('Veter')
    expect(rows()[1]?.textContent).toContain('Заморожена')
  })

  it('tells a failed load with an error state, and Retry asks again', async () => {
    vi.mocked(schoolsApi.getAdminSchools).mockRejectedValue(new Error('down'))
    await mount('/console/schools', false)
    await vi.waitFor(() =>
      expect(root?.querySelector('[data-testid="screen-error"]')).not.toBeNull(),
    )
    expect(toastError).toHaveBeenCalled()

    vi.mocked(schoolsApi.getAdminSchools).mockResolvedValue({
      items: [ACTIVE],
      total: 1,
      limit: 20,
      offset: 0,
    })
    root?.querySelector<HTMLButtonElement>('[data-testid="screen-error"] button')?.click()

    await vi.waitFor(() => expect(rows().length).toBe(1))
  })

  describe('background refetch', () => {
    it('keeps the table on screen while a refetch runs, then shows what it brings', async () => {
      await mount()
      let release: (page: Awaited<ReturnType<typeof schoolsApi.getAdminSchools>>) => void = () => {}
      vi.mocked(schoolsApi.getAdminSchools).mockReturnValue(
        new Promise((resolve) => {
          release = resolve
        }),
      )

      const refetch = askAgain()
      await vi.waitFor(() => expect(schoolsApi.getAdminSchools).toHaveBeenCalledTimes(2))

      expect(rows()).toHaveLength(2)
      expect(root?.querySelector('[data-testid="people-loading"]')).toBeNull()

      release({ items: [FROZEN], total: 1, limit: 20, offset: 0 })
      await refetch
      await vi.waitFor(() => expect(rows()).toHaveLength(1))
    })

    it('failing again and again is told once, until an answer arrives', async () => {
      await mount()
      const fail = () =>
        vi
          .mocked(schoolsApi.getAdminSchools)
          .mockImplementation(() => Promise.reject(new Error('down')))
      fail()

      await askAgain()
      await askAgain()
      expect(toastError).toHaveBeenCalledTimes(1)
      expect(rows()).toHaveLength(2)

      vi.mocked(schoolsApi.getAdminSchools).mockResolvedValue({
        items: [ACTIVE, FROZEN],
        total: 2,
        limit: 20,
        offset: 0,
      })
      await askAgain()
      fail()
      await askAgain()

      expect(toastError).toHaveBeenCalledTimes(2)
    })
  })

  it('asks for the page named by the URL', async () => {
    await mount('/console/schools?page=3')

    expect(schoolsApi.getAdminSchools).toHaveBeenCalledWith(20, 40)
  })

  it("opens the curator's card from a row", async () => {
    await mount()

    rows()[1]?.click()

    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('console-masters-detail'))
    expect(router.currentRoute.value.params).toEqual({ id: 'cur2' })
  })
})
