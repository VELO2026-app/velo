// =============================================================================
// VELO Frontend -- idle prefetch of the tab screens' DATA
// =============================================================================
//
// router/prefetch.ts warms the tab screens' code; this warms what they show.
// Once the first screen of a zone is up and the app is idle, every OTHER
// tab's data is loaded through the very same cache the screen reads (the
// useQuery entry, the store), so a tap on the dock renders from memory --
// no skeleton, no jump; the screen's own mount then only revalidates.
//
// Rules: once per zone and session, right after the first paint
// (DATA_PREFETCH_DELAY_MS, then an idle slot capped at IDLE_TIMEOUT_MS --
// iOS WebKit has no requestIdleCallback, so the cap is what runs); never on a
// constrained link (Data Saver, 2G); one tab after another, not a burst;
// a failure is silent (the screen loads on its own as before). A finger
// down on a dock tab also warms that tab's data (warmTabData, throttled):
// the ~100 ms before the tap lands are often enough. Stores and
// API modules are imported lazily -- the router must not pull them in.
// Today the user zone is covered (the zone of the Telegram app's users);
// another zone simply has no warmers yet.
// =============================================================================

import type { Router } from 'vue-router'
import { USER_TABS, type TabItem } from '@/router/tabs'
import { isConstrainedNetwork, whenIdle } from '@/platform/dom'

/** After the first screen of a zone, before the data prefetch may start
 * (about one frame of the first paint plus its mount work). */
export const DATA_PREFETCH_DELAY_MS = 300
const IDLE_TIMEOUT_MS = 300
/** A finger-down warm of the same tab is skipped within this window. */
const INTENT_THROTTLE_MS = 15_000

type Warmer = () => Promise<unknown>

/** An upcoming list answered this recently is not asked for again (the
 * first-screen gate, the idle prefetch and the screen's mount share it). */
export const UPCOMING_FRESH_MS = 10_000

async function warmStats(): Promise<void> {
  const [{ queryCache }, { myStatsQuery }] = await Promise.all([
    import('@/composables/useQuery'),
    import('@/composables/queries'),
  ])
  const q = myStatsQuery()
  await queryCache.prefetch(q.key, q.query, q.staleTime, true)
}

/** Per tab path: load that screen's data into the cache it reads. */
export const TAB_DATA_WARMERS: Readonly<Record<string, Warmer>> = {
  '/user/dashboard': async () => {
    const [{ useBookingsStore }, { useNotificationsStore }] = await Promise.all([
      import('@/stores/bookings'),
      import('@/stores/notifications'),
    ])
    await Promise.all([
      useBookingsStore().fetchUpcoming({ maxAgeMs: UPCOMING_FRESH_MS }),
      warmStats(),
      // The header bell's dot: in place at first paint, not a late pop.
      useNotificationsStore().refreshUnread(),
    ])
  },
  '/user/calendar': async () => {
    const { useCalendarStore } = await import('@/stores/calendar')
    await useCalendarStore().init()
  },
  // Memory only: diary text is never persisted (composables/persistedCache).
  '/user/diary': async () => {
    const { useDiaryStore } = await import('@/stores/diary')
    await useDiaryStore().fetchFeed()
  },
  '/user/schools': async () => {
    const [{ useSchoolsHubStore }, { useAuthStore }, { queryCache }, { userSchoolsQuery }] =
      await Promise.all([
        import('@/stores/schoolsHub'),
        import('@/stores/auth'),
        import('@/composables/useQuery'),
        import('@/composables/queries'),
      ])
    if (!useSchoolsHubStore().hasSchools) return // no tab, nothing to warm
    const q = userSchoolsQuery(useAuthStore().role ?? '')
    await queryCache.prefetch(q.key, q.query, q.staleTime, true)
  },
  '/user/profile': warmStats,
}

const ZONES: readonly (readonly TabItem[])[] = [USER_TABS]

function zoneOf(path: string): readonly TabItem[] | undefined {
  const head = path.split('/')[1]
  return ZONES.find((tabs) => tabs.some((tab) => tab.to.split('/')[1] === head))
}

/** Warm every tab of `tabs` except `skip`, one after another. */
export async function warmTabsData(tabs: readonly TabItem[], skip: string): Promise<void> {
  for (const tab of tabs) {
    if (tab.to === skip) continue
    const warm = TAB_DATA_WARMERS[tab.to]
    if (!warm) continue
    try {
      await warm()
    } catch {
      // Silent: the screen loads on its own when opened.
    }
  }
}

const lastIntent = new Map<string, number>()

/** Warm one tab's data now (dock finger-down). Throttled per tab; silent. */
export function warmTabData(path: string): void {
  const warm = TAB_DATA_WARMERS[path]
  if (!warm || isConstrainedNetwork()) return
  const last = lastIntent.get(path)
  if (last !== undefined && Date.now() - last < INTENT_THROTTLE_MS) return
  lastIntent.set(path, Date.now())
  void warm().catch(() => undefined)
}

export function installDataPrefetch(router: Router): void {
  const started = new Set<readonly TabItem[]>()
  router.afterEach((to, _from, failure) => {
    if (failure) return
    const tabs = zoneOf(to.path)
    if (!tabs || started.has(tabs)) return
    started.add(tabs)
    setTimeout(() => {
      whenIdle(() => {
        if (isConstrainedNetwork()) return
        // The screen that is open when the slot comes loads its own data.
        void warmTabsData(tabs, router.currentRoute.value.path)
      }, IDLE_TIMEOUT_MS)
    }, DATA_PREFETCH_DELAY_MS)
  })
}
