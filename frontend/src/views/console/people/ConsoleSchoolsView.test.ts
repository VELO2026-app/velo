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
import { createPinia, setActivePinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
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

async function mount(url = '/console/schools'): Promise<HTMLElement> {
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
  const pinia = createPinia()
  setActivePinia(pinia)
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp({ template: '<RouterView />' })
    .use(createTestI18n())
    .use(pinia)
    .use(PiniaColada, coladaOptions)
    .use(router)
  app.mount(root)
  await vi.waitFor(() => expect(rows().length).toBeGreaterThan(0))
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
