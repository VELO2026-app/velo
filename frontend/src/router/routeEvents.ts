// =============================================================================
// VELO Frontend -- route-change notifications (FE-238)
// =============================================================================
//
// The cycle-free seam for "a navigation just finished". Router consumers
// outside router/ (composables mounted by views, the views being route
// targets) must not import ./index: index builds the route table out of the
// view modules, so composable -> index -> views -> composable is an import
// cycle. This module has no dependency on the router instance; index.ts
// installs ONE afterEach hook that fans the event out, consumers subscribe
// with onRouteChange() and get an unsubscribe function back.
// =============================================================================

import type { Router } from 'vue-router'

/** Handler notified after every finished navigation. */
type RouteChangeHandler = () => void

const handlers = new Set<RouteChangeHandler>()

/**
 * Subscribe to "a navigation just finished" (the same moment router.afterEach
 * fires). Returns the unsubscribe function; call it on teardown.
 */
export function onRouteChange(handler: RouteChangeHandler): () => void {
  handlers.add(handler)
  return () => {
    handlers.delete(handler)
  }
}

/**
 * Router-side half of the seam: notify every subscriber after each finished
 * navigation. Call it last in router/index.ts, after the other install* hooks.
 */
export function installRouteEvents(router: Router): void {
  router.afterEach(() => {
    for (const handler of handlers) handler()
  })
}
