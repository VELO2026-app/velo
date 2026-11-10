// =============================================================================
// VELO Frontend -- zone catalogs load before their routes resolve (FE-157)
// =============================================================================
//
// The master and admin catalogs (locales/index.ts ZONE_CATALOGS) are not in
// the main bundle. A route whose screens read them says so in
// meta.catalogs -- on the zone's parent record (children inherit through
// `to.matched`) or on a standalone screen of the zone. The fetch starts as
// soon as the navigation passes the auth wait (beforeEach), in parallel
// with the route guards and the screen chunks, and the navigation confirms
// only once the catalogs are merged (beforeResolve). So a zone screen never
// paints a raw key path, and the first-screen gate (router/firstScreen.ts)
// -- which waits for router.isReady() -- keeps the splash up until a
// master's or an admin's first screen has its text.
// =============================================================================

import type { RouteLocationNormalized, Router } from 'vue-router'
import { ensureCatalogs, type ZoneCatalog } from '@/locales'

type MatchedRoute = Pick<RouteLocationNormalized, 'matched'>

declare module 'vue-router' {
  interface RouteMeta {
    /** Zone catalogs this route's screens read; merged before it resolves.
     * Read from every matched record, so a parent's list covers its children. */
    catalogs?: readonly ZoneCatalog[]
  }
}

/** Zone catalogs every matched record of `to` asks for, without repeats. */
export function routeCatalogs(to: MatchedRoute): ZoneCatalog[] {
  return [...new Set(to.matched.flatMap((record) => record.meta.catalogs ?? []))]
}

/** Start the fetch early, hold the navigation until the catalogs are in. */
export function installRouteCatalogs(router: Router): void {
  router.beforeEach((to) => {
    const zones = routeCatalogs(to)
    // A failure surfaces in beforeResolve below, on the awaited call.
    if (zones.length > 0) ensureCatalogs(zones).catch(() => undefined)
  })
  router.beforeResolve(async (to) => {
    const zones = routeCatalogs(to)
    if (zones.length > 0) await ensureCatalogs(zones)
  })
}
