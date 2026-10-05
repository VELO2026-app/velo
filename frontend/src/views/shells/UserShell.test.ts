// =============================================================================
// VELO Frontend -- UserShell Tests (guard-adjacent, NOT the screen ladder)
// =============================================================================
//
// WHY THIS FILE EXISTS, AND ITS SHAPE (probekit-screen-test audit, rank 3 --
// see AdminShell.test.ts's banner for the rationale shared by all three
// shells). UserShell is the richest of the three: 7 computed()s, and unlike
// MasterShell's activeTab (pure path-prefix match), this one has a real
// TWO-INPUT branch worth proving on its own -- `meta.activeTab` OVERRIDES the
// path match (.vue:40-46), for the one screen with no tab of its own
// (post-booking lighting up Calendar). Route names/paths/meta below are
// copied VERBATIM from router/index.ts where they exist (booking-confirmed's
// `meta: { activeTab: '/user/calendar' }` at :139-143; the diary/chat/form
// route names at :78-162) so the fixture matches the shipped app, not just
// itself.
//
// PATTERN: fresh REAL vue-router (memory history) per mount, @/composables/
// useKeyboardOpen mocked wholesale with a plain writable ref -- same reasons
// as MasterShell.test.ts's banner (avoids useViewportGeometry.ts's eager
// `import router from '@/router'`, which this file has no need for).
//
// TRAPS ABSENT:
//  - fogTuning's practice-detail pixel tuning (.vue:118-139) is OUT of scope
//    for the same reason as MasterShell.test.ts: Vitest here never loads
//    component <style> (no `test.css`), so it always resolves to hardcoded
//    JS fallbacks -- provable, but visual polish, not role/status branching.
//    isFogRoute itself (the boolean gate) IS covered.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, ref, type App, type Ref } from 'vue'
import { createPinia, type Pinia } from 'pinia'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import UserShell from '@/views/shells/UserShell.vue'
import { useAuthStore } from '@/stores/auth'

// The schools tab probe (tz-curator.md §1.2) is the one network seam the
// shell touches; both branches below drive it through this mock.
const curatorGroupsMock = vi.hoisted(() => ({
  getCuratorGroups: vi.fn(),
  getMyCuratorGroups: vi.fn(),
}))
vi.mock('@/api/curatorGroups', () => curatorGroupsMock)

const keyboardOpenRef: Ref<boolean> = ref(false)
vi.mock('@/composables/useKeyboardOpen', () => ({
  useKeyboardOpen: () => ({ keyboardOpen: keyboardOpenRef }),
}))

const StubChild = { template: '<div class="stub-child" />' }
function buildRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      // Mirrors router/index.ts: user-dashboard's headerless meta is RETIRED
      // (the VHeader «Главная» + bell floats again, 2026-09-08), so the route
      // carries no meta -- and StubChild teleports nothing into the island,
      // which is exactly the pre-measurement frame the headered contract
      // below pins (HEADER_FALLBACK + gap).
      {
        path: '/user/dashboard',
        name: 'user-dashboard',
        component: StubChild,
      },
      // [FE-3] profile hub: same contract (retires its margin-top hack);
      // topup screens are headerless too (fixture route mirrors router meta).
      {
        path: '/user/profile',
        name: 'user-profile',
        meta: { headerless: true },
        component: StubChild,
      },
      { path: '/user/calendar', name: 'user-calendar', component: StubChild },
      {
        // The «Предстоящие практики» target on the school page (owner
        // 2026-10-01): the school-scoped week grid. Owner 2026-10-05: a
        // DETAIL screen -- dock hidden (DETAIL_ROUTES) + fogged (FOG_ROUTES).
        path: '/user/calendar/school/:groupId',
        name: 'user-calendar-school',
        component: StubChild,
      },
      { path: '/user/schools', name: 'user-schools', component: StubChild },
      {
        path: '/user/booking-confirmed/:practiceId',
        name: 'user-booking-confirmed',
        // Same meta as router/index.ts: headerless is declared on the ROUTE.
        meta: { activeTab: '/user/calendar', headerless: true },
        component: StubChild,
      },
      { path: '/user/diary', name: 'user-diary', component: StubChild },
      { path: '/user/diary/entry/:id', name: 'user-diary-entry', component: StubChild },
      {
        path: '/user/diary/:type(checkin|feedback)/:id',
        name: 'user-diary-detail',
        component: StubChild,
      },
      { path: '/user/profile/messages/:id', name: 'user-chat', component: StubChild },
      // FE-11: the bell feed -- reached from the dashboard header's bell
      // (UserDashboardView.onBell); hides the dock (INBOX_ROUTES).
      { path: '/user/notifications', name: 'user-inbox', component: StubChild },
      { path: '/user/checkin/:practiceId', name: 'user-checkin', component: StubChild },
      { path: '/user/practice/:id', name: 'practice-detail', component: StubChild },
      // FE-93 (owner 2026-10-03): the participants / analytics / student
      // profile screens exist ONLY in the master zone -- their user-zone
      // routes and stubs are gone from here and from router/index.ts.
      {
        path: '/user/masters/:id',
        name: 'user-master-public',
        component: StubChild,
      },
      // Absent from every FOG_ROUTES / DIARY_ROUTES / FORM_ROUTES list --
      // the default-branch baseline.
      { path: '/user/somewhere-unlisted', name: 'user-unlisted', component: StubChild },
    ],
  })
}

let app: App | null = null
let host: HTMLElement | null = null
let router: Router

async function mount(
  routeName: string,
  params: Record<string, string> = {},
  seed?: (pinia: Pinia) => void,
): Promise<HTMLElement> {
  router = buildRouter()
  await router.push({ name: routeName, params })
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(UserShell)
  const pinia = createPinia()
  app.use(pinia)
  // Seed BEFORE mount so onMounted's probe sees the seeded account.
  seed?.(pinia)
  app.use(router)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await nextTick()
}

function wrapperEl(): HTMLElement {
  const el = host?.querySelector<HTMLElement>('.mobile-layout')
  if (!el) throw new Error('.mobile-layout did not render')
  return el
}

function mainEl(): HTMLElement {
  const el = host?.querySelector<HTMLElement>('.mobile-layout__main')
  if (!el) throw new Error('.mobile-layout__main did not render')
  return el
}

function activeTabLabel(): string | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-tabbar__item') ?? [])
    .find((b) => b.getAttribute('aria-current') === 'page')
    ?.getAttribute('aria-label') as string | undefined
}

beforeEach(() => {
  keyboardOpenRef.value = false
  // FE-88: the hub probes /curator-groups/mine for EVERY account; a plain
  // visitor with no schools is the default fixture.
  curatorGroupsMock.getMyCuratorGroups.mockResolvedValue({ items: [] })
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('UserShell', () => {
  describe('activeTab', () => {
    it('lights up the tab whose `to` prefixes the current path', async () => {
      await mount('user-calendar')
      await flush()

      expect(activeTabLabel()).toBe('Календарь')
    })

    it('defaults to the first tab when the path matches none', async () => {
      await mount('user-unlisted')
      await flush()

      expect(activeTabLabel()).toBe('Дашборд')
    })

    it('meta.activeTab OVERRIDES the path match -- booking-confirmed has no tab of its own', async () => {
      await mount('user-booking-confirmed', { practiceId: 'p1' })
      await flush()

      // Path-prefix matching alone would find nothing under /user/booking-
      // confirmed/... and fall back to the first tab; meta.activeTab (:41-42)
      // is checked FIRST and wins.
      expect(activeTabLabel()).toBe('Календарь')
    })
  })

  describe('isFillRoute -- diary + chat', () => {
    it.each(['user-diary', 'user-chat'])('%s mounts in fill mode', async (name) => {
      const params: Record<string, string> = name === 'user-chat' ? { id: 't1' } : {}
      await mount(name, params)
      await flush()

      expect(wrapperEl().classList.contains('mobile-layout--fill')).toBe(true)
    })

    it('a plain tab route stays non-fill', async () => {
      await mount('user-dashboard')
      await flush()

      expect(wrapperEl().classList.contains('mobile-layout--fill')).toBe(false)
    })
  })

  describe('the tab bar hides for diary, chat AND form routes alike', () => {
    it.each([
      ['user-diary', {}],
      ['user-chat', { id: 't1' }],
      ['user-checkin', { practiceId: 'p1' }],
      // Owner 2026-10-05: the stacked school calendar + the practice detail
      // are detail screens (back control / own footer instead of the dock).
      ['user-calendar-school', { groupId: 'g1' }],
      ['practice-detail', { id: 'p1' }],
    ] as const)('%s hides the tab bar', async (name, params) => {
      await mount(name, params as Record<string, string>)
      await flush()

      expect(host?.querySelector('.v-tabbar')).toBeNull()
    })

    it('a plain tab route keeps the tab bar', async () => {
      await mount('user-dashboard')
      await flush()

      expect(host?.querySelector('.v-tabbar')).not.toBeNull()
    })

    it('the live keyboard signal ALSO hides it on an otherwise-plain route', async () => {
      await mount('user-dashboard')
      await flush()
      expect(host?.querySelector('.v-tabbar')).not.toBeNull()

      keyboardOpenRef.value = true
      await flush()

      expect(host?.querySelector('.v-tabbar')).toBeNull()
    })

    // Owner 2026-09-30: the master's page in the CURATOR context (?groupId=)
    // hides the dock -- the hanging «Создать практику» CTA takes its place.
    // Without the marker the visitor keeps the dock.
    it('user-master-public hides the tab bar only in the curator context', async () => {
      await mount('user-master-public', { id: 'm1' })
      await flush()
      expect(host?.querySelector('.v-tabbar')).not.toBeNull()

      await router.push({
        name: 'user-master-public',
        params: { id: 'm1' },
        query: { groupId: 'g1' },
      })
      await flush()

      expect(host?.querySelector('.v-tabbar')).toBeNull()
    })

    it('the dock carries exactly the four unconditional tabs for a plain visitor', async () => {
      // tz-curator.md §1.2: USER_TABS now holds five items, but the
      // conditional «Школы» tab is filtered out unless the account belongs
      // to at least one school. No schools in this fixture -> four.
      await mount('user-dashboard')
      await flush()

      const items = Array.from(host?.querySelectorAll('.v-tabbar__item') ?? [])
      expect(items).toHaveLength(4)
      expect(items.some((b) => b.getAttribute('aria-label') === 'Уведомления')).toBe(false)
    })
  })

  describe('the conditional «Школы» tab (tz-curator.md §1.2, owner 2026-09-22)', () => {
    function seedAccount(roles: string[]): (pinia: Pinia) => void {
      return (pinia) => {
        const auth = useAuthStore(pinia)
        auth.user = {
          id: 'u1',
          role: roles.includes('master') ? 'master' : 'user',
          role_switch: { allowed_roles: roles },
        } as never
      }
    }

    function tabLabels(): Array<string | null> {
      return Array.from(host?.querySelectorAll('.v-tabbar__item') ?? []).map((b) =>
        b.getAttribute('aria-label'),
      )
    }

    it('a member of at least one school (any relation) sees five tabs in the mockup order', async () => {
      curatorGroupsMock.getMyCuratorGroups.mockResolvedValue({
        items: [{ id: 'g1', name: 'Тихая школа', relation: 'student' }],
      })
      await mount('user-dashboard', {}, seedAccount(['user']))
      await flush()
      await flush()

      expect(tabLabels()).toEqual(['Дашборд', 'Календарь', 'Дневник', 'Школы', 'Я'])
    })

    it('a founding-right holder loses «Дневник» in the user zone; with no schools, no «Школы» either', async () => {
      // Owner 2026-10-04 (restores 2026-10-01): a can_create_groups holder IS
      // a curator account -- no personal-diary tab. The dock's first paint is
      // held while the probes run, so the answer lands without a flash.
      curatorGroupsMock.getMyCuratorGroups.mockResolvedValue({ items: [] })
      curatorGroupsMock.getCuratorGroups.mockResolvedValue({
        items: [],
        can_create_groups: true,
      })
      await mount('user-dashboard', {}, seedAccount(['user', 'master']))
      await flush()
      await flush()

      expect(tabLabels()).toEqual(['Дашборд', 'Календарь', 'Я'])
    })

    it('a school CURATOR (relation=curator) never gets «Дневник» (owner 2026-10-04)', async () => {
      // Curatorship also rides the membership: a transfer hands a school to a
      // master who need not hold the founding right -- still a curator.
      curatorGroupsMock.getMyCuratorGroups.mockResolvedValue({
        items: [{ id: 'g1', name: 'Тихая школа', relation: 'curator' }],
      })
      await mount('user-dashboard', {}, seedAccount(['user']))
      await flush()
      await flush()

      expect(tabLabels()).toEqual(['Дашборд', 'Календарь', 'Школы', 'Я'])
    })

    it('the reported repro surface: the school-scoped calendar hides the dock entirely (owner 2026-10-05)', async () => {
      // The exact surface the curator diary report named now carries NO dock
      // at all (DETAIL_ROUTES) -- the account-level answer (a curator keeps
      // no «Дневник») stays pinned by the test above on the dashboard.
      curatorGroupsMock.getMyCuratorGroups.mockResolvedValue({
        items: [{ id: 'g1', name: 'Тихая школа', relation: 'curator' }],
      })
      await mount('user-calendar-school', { groupId: 'g1' }, seedAccount(['user']))
      await flush()
      await flush()

      expect(host?.querySelector('.v-tabbar')).toBeNull()
    })

    it('the dock HOLDS its first paint while the curator answer is in flight', async () => {
      // The 2026-10-02 regression (icon painted, then vanished) is dead the
      // other way now: nothing tab-shaped is visible until the answer is in,
      // so whatever appears is final. The held bar is invisible + inert
      // (v-tabbar--pending); the fail-closed diary never reaches the DOM.
      curatorGroupsMock.getMyCuratorGroups.mockReturnValue(new Promise(() => {}))
      curatorGroupsMock.getCuratorGroups.mockReturnValue(new Promise(() => {}))
      await mount('user-dashboard', {}, seedAccount(['user', 'master']))
      await flush()
      await flush()

      expect(host?.querySelector('.v-tabbar')?.classList.contains('v-tabbar--pending')).toBe(true)
      expect(tabLabels()).toEqual(['Дашборд', 'Календарь', 'Я'])
    })

    it('a plain user waits for the mine probe with the dock held, then gets «Дневник»', async () => {
      // Curatorship can ride the membership (a transferred school), so even
      // an account without master capability holds the dock until /mine
      // answers -- one round-trip, then the complete dock paints at once.
      let resolveMine: (value: { items: unknown[] }) => void = () => {}
      curatorGroupsMock.getMyCuratorGroups.mockReturnValue(
        new Promise((resolve) => {
          resolveMine = resolve
        }),
      )
      await mount('user-dashboard', {}, seedAccount(['user']))
      await flush()
      await flush()

      expect(host?.querySelector('.v-tabbar')?.classList.contains('v-tabbar--pending')).toBe(true)
      expect(tabLabels()).not.toContain('Дневник')

      resolveMine({ items: [] })
      await flush()
      await flush()

      expect(host?.querySelector('.v-tabbar')?.classList.contains('v-tabbar--pending')).toBe(false)
      expect(tabLabels()).toEqual(['Дашборд', 'Календарь', 'Дневник', 'Я'])
    })

    it("a master of somebody else's school (no right) sees the tab too", async () => {
      curatorGroupsMock.getMyCuratorGroups.mockResolvedValue({
        items: [{ id: 'g2', name: 'Чужая школа', relation: 'master' }],
      })
      curatorGroupsMock.getCuratorGroups.mockResolvedValue({
        items: [],
        can_create_groups: false,
      })
      await mount('user-dashboard', {}, seedAccount(['user', 'master']))
      await flush()
      await flush()

      expect(tabLabels()).toContain('Школы')
    })

    it('an account with no schools anywhere does not see it', async () => {
      curatorGroupsMock.getMyCuratorGroups.mockResolvedValue({ items: [] })
      curatorGroupsMock.getCuratorGroups.mockResolvedValue({
        items: [],
        can_create_groups: false,
      })
      await mount('user-dashboard', {}, seedAccount(['user', 'master']))
      await flush()
      await flush()

      expect(tabLabels()).not.toContain('Школы')
    })

    it('a plain user is probed through /mine but never touches the master surface', async () => {
      curatorGroupsMock.getMyCuratorGroups.mockResolvedValue({
        items: [{ id: 'g1', name: 'Тихая школа', relation: 'student' }],
      })
      await mount('user-dashboard', {}, seedAccount(['user']))
      await flush()
      await flush()

      expect(curatorGroupsMock.getCuratorGroups).not.toHaveBeenCalled()
      expect(curatorGroupsMock.getMyCuratorGroups).toHaveBeenCalledTimes(1)
      expect(tabLabels()).toContain('Школы')
    })
  })

  describe('isFogRoute', () => {
    it('a FOG_ROUTES member (user-dashboard) gets the fog mask', async () => {
      await mount('user-dashboard')
      await flush()

      expect(mainEl().classList.contains('mobile-layout__main--fog')).toBe(true)
    })

    it('an unlisted route does not', async () => {
      await mount('user-unlisted')
      await flush()

      expect(mainEl().classList.contains('mobile-layout__main--fog')).toBe(false)
    })

    it('practice-detail is fogged too (its own tuned entry, .vue:95 + :139)', async () => {
      await mount('practice-detail', { id: 'p1' })
      await flush()

      expect(mainEl().classList.contains('mobile-layout__main--fog')).toBe(true)
    })

    it('the school-scoped calendar gets the fog as well (stacked list feed, owner 2026-10-05)', async () => {
      await mount('user-calendar-school', { groupId: 'g1' })
      await flush()

      expect(mainEl().classList.contains('mobile-layout__main--fog')).toBe(true)
    })

    // FE-93: the participants / analytics screens left the user zone -- their
    // fog behavior (if any) belongs to the master shell now.

    it('the diary (fill mode, owns its own fog) renders with NO shared fog mask', async () => {
      await mount('user-diary')
      await flush()

      expect(mainEl().classList.contains('mobile-layout__main--fog')).toBe(false)
    })
  })

  describe('headerless top clearance ([FE-3])', () => {
    // NOT the <style> pixel polish the banner excludes: this pins the SEMANTIC
    // chain route meta → MobileLayout padding. No component CSS loads in this
    // DOM, so the token read falls back to the JS default (34) -- exactly the
    // number that makes the contract testable. The fixture route above mirrors
    // router/index.ts's meta, so this is the end-to-end wiring, not shell math.
    it('booking-confirmed (meta.headerless) pads main by the token, not the phantom header fallback', async () => {
      await mount('user-booking-confirmed', { practiceId: 'p1' })
      await flush()

      expect(mainEl().style.paddingTop).toBe('34px')
    })

    // [2026-09-08] The dashboard's floating header is BACK (VHeader «Главная»
    // + the bell in its action slot), so its headerless meta is dropped per
    // the [FE-3] contract. With StubChild teleporting nothing, this frame is
    // the pre-measurement one: the HEADER_FALLBACK (68) + z1 gap (8)
    // reservation -- same contract as any headered route; the real screen's
    // VHeader then measures in and MobileLayout re-pads to its exact height.
    it('user-dashboard (header back, meta dropped) pads by the unmeasured-island contract', async () => {
      await mount('user-dashboard')
      await flush()

      expect(mainEl().style.paddingTop).toBe('76px')
    })

    // [FE-3] the profile hub's own margin-top compensation is retired; the
    // route meta carries the clearance now -- tab-to-tab tops are identical.
    it('user-profile (margin-hack retired) pads by the token too', async () => {
      await mount('user-profile')
      await flush()

      expect(mainEl().style.paddingTop).toBe('34px')
    })

    it('a route without the meta keeps the clearance contract (unmeasured island: 68 + 8)', async () => {
      await mount('user-unlisted')
      await flush()

      expect(mainEl().style.paddingTop).toBe('76px')
    })
  })
})

// =============================================================================
// NOT COVERED, deliberately
// =============================================================================
// - fogTuning's practice-detail pixel math -- see the banner.
// - What each user ROUTE renders: out of this shell's own surface.
// =============================================================================
