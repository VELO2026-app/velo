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
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import UserShell from '@/views/shells/UserShell.vue'

const keyboardOpenRef: Ref<boolean> = ref(false)
vi.mock('@/composables/useKeyboardOpen', () => ({
  useKeyboardOpen: () => ({ keyboardOpen: keyboardOpenRef }),
}))

const StubChild = { template: '<div class="stub-child" />' }
function buildRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/user/dashboard', name: 'user-dashboard', component: StubChild },
      { path: '/user/calendar', name: 'user-calendar', component: StubChild },
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
      { path: '/user/checkin/:practiceId', name: 'user-checkin', component: StubChild },
      { path: '/user/practice/:id', name: 'practice-detail', component: StubChild },
      // Absent from every FOG_ROUTES / DIARY_ROUTES / FORM_ROUTES list --
      // the default-branch baseline.
      { path: '/user/somewhere-unlisted', name: 'user-unlisted', component: StubChild },
    ],
  })
}

let app: App | null = null
let host: HTMLElement | null = null
let router: Router

async function mount(routeName: string, params: Record<string, string> = {}): Promise<HTMLElement> {
  router = buildRouter()
  await router.push({ name: routeName, params })
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(UserShell)
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

    it('the diary (fill mode, owns its own fog) renders with NO shared fog mask', async () => {
      await mount('user-diary')
      await flush()

      expect(mainEl().classList.contains('mobile-layout__main--fog')).toBe(false)
    })
  })

  describe('headerless top clearance ([FE-3])', () => {
    // NOT the <style> pixel polish the banner excludes: this pins the SEMANTIC
    // chain route meta → MobileLayout padding. No component CSS loads in this
    // DOM, so the token read falls back to the JS default (48) -- exactly the
    // number that makes the contract testable. The fixture route above mirrors
    // router/index.ts's meta, so this is the end-to-end wiring, not shell math.
    it('booking-confirmed (meta.headerless) pads main by the token, not the phantom header fallback', async () => {
      await mount('user-booking-confirmed', { practiceId: 'p1' })
      await flush()

      expect(mainEl().style.paddingTop).toBe('48px')
    })

    it('a route without the meta keeps the clearance contract (unmeasured island: 88 + 16)', async () => {
      await mount('user-dashboard')
      await flush()

      expect(mainEl().style.paddingTop).toBe('104px')
    })
  })
})

// =============================================================================
// NOT COVERED, deliberately
// =============================================================================
// - fogTuning's practice-detail pixel math -- see the banner.
// - What each user ROUTE renders: out of this shell's own surface.
// =============================================================================
