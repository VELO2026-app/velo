// =============================================================================
// VELO Frontend -- AdminShell Tests (guard-adjacent, NOT the screen ladder)
// =============================================================================
//
// WHY THIS FILE EXISTS, AND WHY IT IS SHAPED DIFFERENTLY (probekit-screen-test
// audit, rank 3, all three shells grouped together): the audit's own table
// says explicitly NOT to force the shells into the normal loading/error/
// empty/content ladder -- "router-outlet shells with role/status branching
// logic... worth scoping as guard-adjacent tests (do they gate correctly, not
// 'does it render')". There is no fetched record here (RouterView owns that),
// so this file tests exactly the four things AdminShell computes: which tab
// lights up, which routes get the live badge counts, which routes get the fog
// mask, and which routes hide the tab bar -- plus the one real side effect,
// the dashboard-stats fetch + its error toast.
//
// PATTERN: real Pinia + real useAdminStore (the badges are its own computed
// properties, pendingVerifications/pendingModeration -- real derivation, only
// @/api/admin mocked underneath). A FRESH real vue-router (memory history) per
// mount, NOT mocked -- <RouterView/> needs an actually-installed router to
// resolve at all, and useRoute()/useRouter() inside the shell read from
// whatever this test's own tiny router is currently on. Route NAMES below are
// synthetic (chosen to match FOG_ROUTES/DETAIL_ROUTES, .vue:58-66/71-90,
// verbatim) -- the shell's arrays are hardcoded string lists independent of
// the app's real router/index.ts, so a standalone test router matching the
// SAME NAMES exercises the exact same branches without loading the real app
// router (which would also load router/index.ts's guards -- unrelated to what
// this file is proving, per DiaryFeedView.test.ts's own note on the same
// transitive-import shape).
//
// Every child component actually mounts (SC-12: nothing stubbed) --
// AdminLayout, VAdminTabBar, and whatever the route resolves (a trivial stub
// component here, since the CHILD ROUTE's own content is not this shell's
// concern -- proven by the audit's own framing).
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import AdminShell from '@/views/shells/AdminShell.vue'
import { useAdminStore } from '@/stores/admin'
import * as adminApi from '@/api/admin'
import { ApiResponseError } from '@/api/client'
import type { AdminStatsResponse, PaginatedReportsResponse } from '@/api/types'

vi.mock('@/api/admin')

const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: vi.fn(), info: vi.fn() }),
}))

// Route NAMES chosen to match AdminShell.vue's own FOG_ROUTES/DETAIL_ROUTES
// arrays verbatim (see banner). 'admin-users' is in NEITHER list -- the
// baseline case.
const StubChild = { template: '<div class="stub-child" />' }
function buildRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/admin/dashboard', name: 'admin-dashboard', component: StubChild },
      { path: '/admin/masters', name: 'admin-masters', component: StubChild },
      { path: '/admin/reports', name: 'admin-reports', component: StubChild },
      { path: '/admin/promos', name: 'admin-promos', component: StubChild },
      { path: '/admin/catalog', name: 'admin-catalog', component: StubChild },
      { path: '/admin/users', name: 'admin-users', component: StubChild },
    ],
  })
}

function stats(overrides: Partial<AdminStatsResponse> = {}): AdminStatsResponse {
  return {
    users_count: 100,
    masters_count: 10,
    practices_count: 50,
    pending_verifications: 0,
    pending_method_changes: 0,
    ...overrides,
  }
}

function reports(total = 0): PaginatedReportsResponse {
  return { items: [], total, limit: 1, offset: 0 }
}

let app: App | null = null
let host: HTMLElement | null = null
let pinia: Pinia
let router: Router

async function mount(routeName: string): Promise<HTMLElement> {
  router = buildRouter()
  await router.push({ name: routeName })
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(AdminShell)
  app.use(pinia)
  app.use(router)
  app.mount(host)
  return host
}

// fetchDashboard: await Promise.all(...) (1) -> onMounted's own .then()
// continuation is chained onto that promise, one more microtask hop (1) ->
// possible toast + re-render (1). 5 leaves margin.
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await nextTick()
}

function mainEl(): HTMLElement {
  const el = host?.querySelector<HTMLElement>('.admin-layout__main')
  if (!el) throw new Error('.admin-layout__main did not render')
  return el
}

function tabButton(label: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-admin-tabbar__item') ?? []).find(
    (b) => b.getAttribute('aria-label') === label,
  )
}

function activeTabLabel(): string | undefined {
  return tabButtons()
    .find((b) => b.getAttribute('aria-current') === 'page')
    ?.getAttribute('aria-label') as string | undefined
}

function tabButtons(): HTMLButtonElement[] {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-admin-tabbar__item') ?? [])
}

function badgeOn(label: string): string | null {
  return tabButton(label)?.querySelector('.v-admin-tabbar__badge')?.textContent?.trim() ?? null
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  vi.mocked(adminApi.getAdminStats).mockReset().mockResolvedValue(stats())
  vi.mocked(adminApi.getReports).mockReset().mockResolvedValue(reports())
  toastError.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('AdminShell', () => {
  describe('activeTab', () => {
    it('lights up the tab whose `to` prefixes the current path', async () => {
      await mount('admin-masters')
      await flush()

      expect(activeTabLabel()).toBe('Мастера')
    })

    it('defaults to the first tab when the path matches none', async () => {
      await mount('admin-users')
      await flush()

      expect(activeTabLabel()).toBe('Дашборд')
    })
  })

  describe('live badge counts (tabItems)', () => {
    it('injects pendingVerifications onto Мастера and pendingModeration onto Модерация', async () => {
      vi.mocked(adminApi.getAdminStats).mockResolvedValue(stats({ pending_verifications: 3 }))
      vi.mocked(adminApi.getReports).mockResolvedValue(reports(7))
      await mount('admin-dashboard')
      await flush()

      expect(badgeOn('Мастера')).toBe('3')
      expect(badgeOn('Модерация')).toBe('7')
      expect(badgeOn('Дашборд')).toBeNull() // never carries a badge
    })

    it('zero counts render NO badge at all on either tab', async () => {
      await mount('admin-dashboard')
      await flush()

      expect(badgeOn('Мастера')).toBeNull()
      expect(badgeOn('Модерация')).toBeNull()
    })
  })

  describe('fog routes (FOG_ROUTES membership)', () => {
    it('a listed route (admin-dashboard) gets the fog mask', async () => {
      await mount('admin-dashboard')
      await flush()

      expect(mainEl().classList.contains('admin-layout__main--fog')).toBe(true)
    })

    it('an unlisted route (admin-users) does NOT', async () => {
      await mount('admin-users')
      await flush()

      expect(mainEl().classList.contains('admin-layout__main--fog')).toBe(false)
    })

    it('a DETAIL route (admin-promos) does NOT get fog either -- the two lists are independent', async () => {
      await mount('admin-promos')
      await flush()

      expect(mainEl().classList.contains('admin-layout__main--fog')).toBe(false)
    })
  })

  describe('detail routes (DETAIL_ROUTES membership -> tab bar hidden)', () => {
    it('a listed route (admin-promos) hides the tab bar entirely', async () => {
      await mount('admin-promos')
      await flush()

      expect(host?.querySelector('.v-admin-tabbar')).toBeNull()
      expect(mainEl().classList.contains('admin-layout__main--no-tabbar')).toBe(true)
    })

    it('admin-catalog (the PROMPT №503 late addition, .vue:84-89) is ALSO a detail route', async () => {
      await mount('admin-catalog')
      await flush()

      expect(host?.querySelector('.v-admin-tabbar')).toBeNull()
    })

    it('an unlisted route (admin-users) keeps the tab bar visible', async () => {
      await mount('admin-users')
      await flush()

      expect(host?.querySelector('.v-admin-tabbar')).not.toBeNull()
    })
  })

  describe('the dashboard-stats fetch (W14: no more silent failure)', () => {
    it('fetches once on mount through the REAL store action', async () => {
      const adminStore = useAdminStore()
      await mount('admin-dashboard')
      await flush()

      expect(adminApi.getAdminStats).toHaveBeenCalledTimes(1)
      expect(adminStore.loaded).toBe(true)
    })

    it('a successful fetch never toasts', async () => {
      await mount('admin-dashboard')
      await flush()

      expect(toastError).not.toHaveBeenCalled()
    })

    it('a failed fetch toasts the REAL store-derived error message', async () => {
      // extractApiError only pulls a message out of an ApiResponseError
      // (useApiError.ts:31) -- a plain Error falls to the fallback string, so
      // the fixture must be the real error shape the store actually branches
      // on, not a generic Error.
      vi.mocked(adminApi.getAdminStats).mockRejectedValue(
        new ApiResponseError(500, 'Сеть недоступна', 'server_error'),
      )
      const adminStore = useAdminStore()
      await mount('admin-dashboard')
      await flush()

      expect(adminStore.dashboardError).toBe('Сеть недоступна')
      expect(toastError).toHaveBeenCalledWith('Сеть недоступна')
    })
  })
})

// =============================================================================
// NOT COVERED, deliberately
// =============================================================================
// - fogTuning-equivalent pixel math: AdminShell has none (AdminLayout's fog is
//   flat CSS, unlike MobileLayout's measured-island version) -- nothing here.
// - What each admin ROUTE renders: RouterView's own content is out of this
//   shell's surface (the audit's own framing: gate/branch, not render).
// =============================================================================
