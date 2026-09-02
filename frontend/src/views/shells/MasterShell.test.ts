// =============================================================================
// VELO Frontend -- MasterShell Tests (guard-adjacent, NOT the screen ladder)
// =============================================================================
//
// WHY THIS FILE EXISTS, AND ITS SHAPE (probekit-screen-test audit, rank 3, see
// AdminShell.test.ts's banner for the full rationale shared by all three
// shells): no fetched record, so this tests only what MasterShell computes --
// which tab lights up, fill mode, fog-route membership, and hideTabBar's TWO
// independent inputs (route.meta AND the live keyboard signal).
//
// PATTERN: a fresh REAL vue-router (memory history) per mount, route NAMES
// and `meta.hideTabBar` copied VERBATIM from router/index.ts (checked:
// master-dashboard has no hideTabBar meta; master-chat/-support/-finance/
// -practice-detail/-students all carry `meta: { hideTabBar: true }`) so the
// fixture is faithful to the real app, not just internally consistent.
// @/composables/useKeyboardOpen is mocked wholesale (repo convention: mock at
// the composable boundary the screen imports) with a plain writable ref
// standing in for the readonly one useViewportGeometry.ts normally exports --
// this ALSO sidesteps that module's own eager `import router from '@/router'`
// (loading the whole app router + its guards), which this file has no need
// for and DiaryFeedView.test.ts's banner already flags as a heavy transitive
// import worth avoiding when nothing requires it.
//
// TRAPS ABSENT:
//  - fogTuning's per-route PIXEL tuning (ctaSafeFog/compactBottomFog/formFog,
//    .vue:117-215) is deliberately OUT of this
//    file's scope -- checked that Vitest here never loads component <style>
//    (no `test.css` in vitest.config.ts), so getComputedStyle always reads
//    empty custom properties and every fog-tuning function silently takes its
//    hardcoded JS fallback -- provable, but it is visual polish, not the
//    role/status branching the audit asked this batch of tests to cover.
//    isFogRoute (the boolean gate) IS covered; the pixel math it feeds is not.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, ref, type App, type Ref } from 'vue'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import MasterShell from '@/views/shells/MasterShell.vue'

const keyboardOpenRef: Ref<boolean> = ref(false)
vi.mock('@/composables/useKeyboardOpen', () => ({
  useKeyboardOpen: () => ({ keyboardOpen: keyboardOpenRef }),
}))

const StubChild = { template: '<div class="stub-child" />' }
function buildRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/master/dashboard', name: 'master-dashboard', component: StubChild },
      { path: '/master/practices', name: 'master-practices', component: StubChild },
      {
        path: '/master/messages/:id',
        name: 'master-chat',
        meta: { hideTabBar: true },
        component: StubChild,
      },
      {
        path: '/master/support',
        name: 'master-support',
        meta: { hideTabBar: true },
        component: StubChild,
      },
      // [FE-45] the group-create form: fog + form-grade tuning in the SFC.
      {
        path: '/master/groups/new',
        name: 'master-group-create',
        meta: { hideTabBar: true },
        component: StubChild,
      },
      { path: '/master/profile', name: 'master-profile', component: StubChild },
      // Absent from every FOG_ROUTES / hideTabBar list in the SFC -- the
      // default-branch baseline.
      { path: '/master/somewhere-unlisted', name: 'master-unlisted', component: StubChild },
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
  app = createApp(MasterShell)
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

describe('MasterShell', () => {
  describe('activeTab', () => {
    it('lights up the tab whose `to` prefixes the current path', async () => {
      await mount('master-practices')
      await flush()

      expect(activeTabLabel()).toBe('Практики')
    })

    it('defaults to the first tab when the path matches none', async () => {
      await mount('master-unlisted')
      await flush()

      expect(activeTabLabel()).toBe('Дашборд')
    })
  })

  describe('isFillRoute -- master-chat only', () => {
    it('master-chat mounts in fill mode', async () => {
      await mount('master-chat', { id: 't1' })
      await flush()

      expect(wrapperEl().classList.contains('mobile-layout--fill')).toBe(true)
      expect(mainEl().classList.contains('mobile-layout__main--fill')).toBe(true)
    })

    it('every other route stays non-fill', async () => {
      await mount('master-dashboard')
      await flush()

      expect(wrapperEl().classList.contains('mobile-layout--fill')).toBe(false)
      expect(mainEl().classList.contains('mobile-layout__main--fill')).toBe(false)
    })
  })

  describe('isFogRoute', () => {
    it('a FOG_ROUTES member (master-dashboard) gets the fog mask', async () => {
      await mount('master-dashboard')
      await flush()

      expect(mainEl().classList.contains('mobile-layout__main--fog')).toBe(true)
    })

    it('an unlisted route does not', async () => {
      await mount('master-unlisted')
      await flush()

      expect(mainEl().classList.contains('mobile-layout__main--fog')).toBe(false)
    })

    it('master-chat renders with no fog mask (fill mode owns its own fog per the SFC comment)', async () => {
      await mount('master-chat', { id: 't1' })
      await flush()

      expect(mainEl().classList.contains('mobile-layout__main--fog')).toBe(false)
    })

    it('[FE-45] master-group-create gets the fog mask (keyboard-safe header-overlap fix; pixel tuning via FORM_FOG_ROUTES)', async () => {
      await mount('master-group-create')
      await flush()

      expect(mainEl().classList.contains('mobile-layout__main--fog')).toBe(true)
    })
  })

  describe('hideTabBar -- two independent inputs', () => {
    it('route.meta.hideTabBar hides the tab bar even with the keyboard closed', async () => {
      await mount('master-support')
      await flush()

      expect(host?.querySelector('.v-tabbar')).toBeNull()
    })

    it('a route with no hideTabBar meta shows the tab bar', async () => {
      await mount('master-dashboard')
      await flush()

      expect(host?.querySelector('.v-tabbar')).not.toBeNull()
    })

    it('the live keyboard signal ALSO hides it, independent of meta', async () => {
      await mount('master-dashboard') // meta.hideTabBar is NOT set on this route
      await flush()
      expect(host?.querySelector('.v-tabbar')).not.toBeNull()

      keyboardOpenRef.value = true
      await flush()

      expect(host?.querySelector('.v-tabbar')).toBeNull()
    })

    it('the keyboard closing again restores the tab bar', async () => {
      keyboardOpenRef.value = true
      await mount('master-dashboard')
      await flush()
      expect(host?.querySelector('.v-tabbar')).toBeNull()

      keyboardOpenRef.value = false
      await flush()

      expect(host?.querySelector('.v-tabbar')).not.toBeNull()
    })
  })
})

// =============================================================================
// NOT COVERED, deliberately
// =============================================================================
// - fogTuning's pixel math -- see the banner.
// - What each master ROUTE renders: out of this shell's own surface.
// =============================================================================
