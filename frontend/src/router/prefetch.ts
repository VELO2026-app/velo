// =============================================================================
// VELO Frontend -- idle prefetch of the tab screens' chunks
// =============================================================================
//
// Every screen is a lazy route. The first tap on a tab therefore waited for
// its chunk before the View Transition could even start -- a visible "dead"
// beat on a cold Telegram webview. Once the app is idle after the first
// screen, warm the chunks of the CURRENT zone's tabs (user / master / admin),
// so a tab switch only has to render. Once per zone; a failed import is
// harmless (the router retries on the real navigation).
// =============================================================================

import type { Router, RouteRecordNormalized } from 'vue-router'
import { ADMIN_TABS, MASTER_TABS, USER_TABS, type TabItem } from '@/router/tabs'
import { whenIdle } from '@/platform/dom'
import { warmTabData } from '@/router/dataPrefetch'

const ZONES: readonly (readonly TabItem[])[] = [USER_TABS, MASTER_TABS, ADMIN_TABS]

function zoneOf(path: string): readonly TabItem[] | undefined {
  const head = path.split('/')[1]
  return ZONES.find((tabs) => tabs.some((tab) => tab.to.split('/')[1] === head))
}

/** A lazy route component is a zero-arg loader; a compiled SFC is an object. */
function lazyLoaders(record: RouteRecordNormalized): (() => Promise<unknown>)[] {
  return Object.values(record.components ?? {}).filter(
    (c): c is () => Promise<unknown> => typeof c === 'function' && c.length === 0,
  )
}

const warmedPaths = new Set<string>()

/** Load the lazy chunks of the screen at `path` now (idempotent). The tab
 * bar calls this on finger-down: the ~100 ms until the click lands is
 * usually enough for a chunk the idle prefetch has not reached yet. */
export function warmRoute(router: Router, path: string): void {
  // The screen's data too (cache-first: a no-op when it is fresh/in flight).
  warmTabData(path)
  if (warmedPaths.has(path)) return
  warmedPaths.add(path)
  for (const record of router.resolve(path).matched) {
    for (const load of lazyLoaders(record)) void load().catch(() => warmedPaths.delete(path))
  }
}

export function installTabPrefetch(router: Router): void {
  const warmed = new Set<readonly TabItem[]>()
  router.afterEach((to, _from, failure) => {
    if (failure) return
    const tabs = zoneOf(to.path)
    if (!tabs || warmed.has(tabs)) return
    warmed.add(tabs)
    whenIdle(() => {
      for (const tab of tabs) warmRoute(router, tab.to)
    })
  })
}
