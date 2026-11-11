// =============================================================================
// VELO Frontend -- Router (Phase F2.2, updated F9, TD-FE-ROLE-SWITCH, WARNING-3)
// =============================================================================
//
// Assembles the route table from the zone modules (router/routes/*.ts) and
// installs the router-wide hooks in their order.
// =============================================================================

import { createRouter, createWebHistory } from 'vue-router'
import { installViewTransitions } from '@/router/viewTransition'
import { installTabPrefetch } from '@/router/prefetch'
import { installDataPrefetch } from '@/router/dataPrefetch'
import { installRouteCatalogs } from '@/router/catalogs'
import { installAccessGuard } from '@/router/guards'
import { ROOT_ROUTE, PUBLIC_ROUTES } from '@/router/routes/public'
import { AI_USER_ROUTES, userRoutes } from '@/router/routes/user'
import { masterRoutes } from '@/router/routes/master'
import { adminRoutes } from '@/router/routes/admin'

// -- Module route groups (tz-whitelabel §4, F3) --
// Registration is gated by the BUILD-TIME feature literals (vite `define`,
// resolved from PRIMER_EDITION through editions.json; VITE_FEATURES is the
// local-dev channel -- FE-130) -- never by a runtime helper: a literal
// `false` folds `__VELO_FEATURE_X__ ? ROUTES : []` to an empty array, the
// group const becomes unreferenced, and Rollup tree-shakes it with its
// dynamic imports -- the module's chunks are physically absent from dist/.
// The gates stay in THIS file (scripts/brand-grep.mjs allows the literals
// nowhere else); the zone modules declare the groups and take them back as
// arguments. A deep link into a disabled module misses these records and
// lands on the catch-all's /404 (NotFoundView), per §4.
//
// Instance options (FE-151: payments, schools, mcp) are not gated here: the
// flag arrives at container start, so their records are always registered
// with meta.option, and the access guard's optionGuard sends a navigation
// into a switched-off option to the same /404.
const router = createRouter({
  history: createWebHistory(),
  routes: [
    ROOT_ROUTE,
    ...userRoutes({ ai: __VELO_FEATURE_AI__ ? AI_USER_ROUTES : [] }),
    ...masterRoutes(),
    ...adminRoutes(),
    ...PUBLIC_ROUTES,
  ],
})

// Installed BEFORE the access guard: guards run in registration order, so a
// deep link into a zone starts its catalog fetch during the auth wait.
installRouteCatalogs(router)
// Auth readiness, role freshness, the P-1 redirect and every record's
// meta.requires -- one guard (router/guards.ts).
installAccessGuard(router)
installViewTransitions(router)
installTabPrefetch(router)
installDataPrefetch(router)

export default router
