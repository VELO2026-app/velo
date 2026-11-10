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
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { roleFreshnessGuard } from '@/router/guards'
import { waitUntilReady } from '@/composables/useAuth'
import type { ReadyResult } from '@/composables/useAuth'
import { ROOT_ROUTE, PUBLIC_ROUTES } from '@/router/routes/public'
import { AI_USER_ROUTES, PAYMENTS_USER_ROUTES, userRoutes } from '@/router/routes/user'
import { PAYMENTS_MASTER_ROUTES, masterRoutes } from '@/router/routes/master'
import { PAYMENTS_ADMIN_ROUTES, adminRoutes } from '@/router/routes/admin'

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
const router = createRouter({
  history: createWebHistory(),
  routes: [
    ROOT_ROUTE,
    ...userRoutes({
      ai: __VELO_FEATURE_AI__ ? AI_USER_ROUTES : [],
      payments: __VELO_FEATURE_PAYMENTS__ ? PAYMENTS_USER_ROUTES : [],
    }),
    // FE-112: the payments module is ALL of its surfaces -- the user's
    // top-ups, the master's finance screen and the admin's payout queue.
    ...masterRoutes({ payments: __VELO_FEATURE_PAYMENTS__ ? PAYMENTS_MASTER_ROUTES : [] }),
    ...adminRoutes({ payments: __VELO_FEATURE_PAYMENTS__ ? PAYMENTS_ADMIN_ROUTES : [] }),
    ...PUBLIC_ROUTES,
  ],
})

// Installed BEFORE the auth guard below: guards run in registration order,
// so a deep link into a zone starts its catalog fetch during the auth wait.
installRouteCatalogs(router)

// =============================================================================
// Global guard (P-1): redirect master/admin away from /user/dashboard only.
// =============================================================================
let authInitialized = false

router.beforeEach(async (to) => {
  if (!authInitialized) {
    const { timedOut }: ReadyResult = await waitUntilReady()
    authInitialized = true
    if (timedOut) {
      console.warn('[router] auth initialization timed out on first navigation')
    }
  }

  // T21-4/T21-5 (PROMPT №546): keeps role/master-application state fresh
  // across in-app navigation (debounced inside), and catches an unseen
  // rejection verdict on ANY route -- not just a fresh app boot landing on
  // '/', which is all roleRedirect's own rejection branch ever covered.
  // See guards.ts for the full reasoning; kept as a separate exported guard
  // (like every other guard here) so it's directly testable.
  const freshnessResult = roleFreshnessGuard(to)
  if (freshnessResult !== true) return freshnessResult

  const auth = useAuthStore()

  if (to.name !== 'user-dashboard' && to.path !== '/user' && to.path !== '/user/') {
    return true
  }

  if (auth.role === 'master' || auth.role === 'admin') {
    const uiStore = useUiStore()
    if (uiStore.uiMode === 'user') return true

    return auth.role === 'admin' ? { path: '/admin/dashboard' } : { path: '/master/dashboard' }
  }

  return true
})

installViewTransitions(router)
installTabPrefetch(router)
installDataPrefetch(router)

export default router
