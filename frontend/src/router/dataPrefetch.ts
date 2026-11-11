// =============================================================================
// VELO Frontend -- idle prefetch of the tab screens' DATA
// =============================================================================
//
// router/prefetch.ts warms the tab screens' code; this warms what they show.
// Once the first screen of a zone is up and the app is idle, every OTHER
// tab's data is loaded through the very same cache the screen reads (the
// Colada entry, the store), so a tap on the dock renders from memory --
// no skeleton, no jump; the screen's own mount then only revalidates.
//
// Rules: once per zone and session, right after the first paint
// (DATA_PREFETCH_DELAY_MS, then an idle slot capped at IDLE_TIMEOUT_MS --
// iOS WebKit has no requestIdleCallback, so the cap is what runs); never on a
// constrained link (Data Saver, 2G); one tab after another, not a burst;
// a failure is silent (the screen loads on its own as before); only with a
// session (a token or a user) -- without one the API answers 401, so the
// prefetch waits until a session appears. A finger
// down on a dock tab also warms that tab's data (warmTabData, throttled):
// the ~100 ms before the tap lands are often enough. Stores and
// API modules are imported lazily -- the router must not pull them in.
// Today the user zone is covered (the zone of the Telegram app's users);
// another zone simply has no warmers yet.
// =============================================================================

import { watch } from 'vue'
import type { Router } from 'vue-router'
import type { QueryCache } from '@pinia/colada'
import { USER_TABS, type TabItem } from '@/router/tabs'
import { isConstrainedNetwork, whenIdle } from '@/platform/dom'

/** After the first screen of a zone, before the data prefetch may start
 * (about one frame of the first paint plus its mount work). */
export const DATA_PREFETCH_DELAY_MS = 300
const IDLE_TIMEOUT_MS = 300
/** A finger-down warm of the same tab is skipped within this window. */
const INTENT_THROTTLE_MS = 15_000

type Warmer = () => Promise<unknown>

/**
 * Load one Colada query into the cache its screen reads, unless it is fresh.
 * Rejects when the request fails (warmTabsData swallows it).
 */
async function warmQuery(load: (cache: QueryCache) => Promise<unknown>): Promise<void> {
  const { useQueryCache } = await import('@pinia/colada')
  await load(useQueryCache())
}

async function warmUpcoming(): Promise<void> {
  // Fresh within UPCOMING_STALE_MS (the query's staleTime): not asked again.
  const { upcomingBookingsQuery } = await import('@/composables/queries/bookings')
  await warmQuery((cache) => cache.refresh(cache.ensure(upcomingBookingsQuery())))
}

async function warmStats(): Promise<void> {
  const { myStatsQuery } = await import('@/composables/queries/stats')
  await warmQuery((cache) => cache.refresh(cache.ensure(myStatsQuery())))
}

/** Per tab path: load that screen's data into the cache it reads. */
export const TAB_DATA_WARMERS: Readonly<Record<string, Warmer>> = {
  '/user/dashboard': async () => {
    const { useNotificationsStore } = await import('@/stores/notifications')
    await Promise.all([
      warmUpcoming(),
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
    const [{ useSchoolsHubStore }, { useAuthStore }, { userSchoolsQuery }] = await Promise.all([
      import('@/stores/schoolsHub'),
      import('@/stores/auth'),
      import('@/composables/queries/schools'),
    ])
    if (!useSchoolsHubStore().hasSchools) return // no tab, nothing to warm
    const role = useAuthStore().role ?? ''
    if (!role) return // a token without its user yet: the screen loads for itself
    await warmQuery((cache) => cache.refresh(cache.ensure(userSchoolsQuery(role))))
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

/** The auth store is imported lazily: the router must not pull it in. */
async function sessionStore() {
  const { useAuthStore } = await import('@/stores/auth')
  return useAuthStore()
}

/** Whether there is a session to ask the API with (a token or a user). */
async function hasSession(): Promise<boolean> {
  const auth = await sessionStore()
  return !!(auth.token || auth.user)
}

const lastIntent = new Map<string, number>()

/** Warm one tab's data now (dock finger-down). Throttled per tab; silent. */
export function warmTabData(path: string): void {
  const warm = TAB_DATA_WARMERS[path]
  if (!warm || isConstrainedNetwork()) return
  const last = lastIntent.get(path)
  if (last !== undefined && Date.now() - last < INTENT_THROTTLE_MS) return
  lastIntent.set(path, Date.now()) // synchronous: a second touch while the auth chunk loads is throttled
  void hasSession()
    .then((signedIn) => {
      // No session: the API would answer 401; nothing to warm, nothing to throttle.
      if (!signedIn) {
        lastIntent.delete(path)
        return
      }
      return warm()
    })
    .catch(() => undefined)
}

/** Warm the current zone's tab data once, idle after the first screen of the
 * zone. Without a session nothing is asked of the API; the zone is warmed
 * once a session appears. */
export function installDataPrefetch(router: Router): void {
  const started = new Set<readonly TabItem[]>()
  const waiting = new Set<readonly TabItem[]>()

  function run(tabs: readonly TabItem[]): void {
    setTimeout(() => {
      whenIdle(() => {
        if (isConstrainedNetwork()) return
        void hasSession()
          .then((signedIn) => {
            if (!signedIn) return waitForSession(tabs)
            // The session may belong to another zone (a master after login).
            if (zoneOf(router.currentRoute.value.path) !== tabs) return
            // The screen that is open when the slot comes loads its own data.
            return warmTabsData(tabs, router.currentRoute.value.path)
          })
          .catch(() => undefined)
      }, IDLE_TIMEOUT_MS)
    }, DATA_PREFETCH_DELAY_MS)
  }

  async function waitForSession(tabs: readonly TabItem[]): Promise<void> {
    if (waiting.has(tabs)) return
    waiting.add(tabs)
    const auth = await sessionStore()
    const stop = watch(
      () => !!(auth.token || auth.user),
      (signedIn) => {
        if (!signedIn) return
        stop()
        waiting.delete(tabs)
        run(tabs)
      },
      { immediate: true }, // a session that landed while the store was loading
    )
  }

  router.afterEach((to, _from, failure) => {
    if (failure) return
    const tabs = zoneOf(to.path)
    if (!tabs || started.has(tabs)) return
    started.add(tabs)
    run(tabs)
  })
}
