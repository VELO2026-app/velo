// =============================================================================
// VELO Frontend -- routes outside every zone: the root redirect, the
// sign-in return, the error screens and the catch-all
// =============================================================================

import type { RouteRecordRaw } from 'vue-router'
import { RETURN_PATH } from '@/platform/browser-login'
import { roleRedirect } from '@/router/guards'

/** `/`: never rendered -- roleRedirect sends the session to its zone or deep link. */
export const ROOT_ROUTE: RouteRecordRaw = {
  path: '/',
  name: 'root',
  beforeEnter: roleRedirect,
  component: { template: '' },
}

/** The sign-in return, the error screens and the catch-all (declared last). */
export const PUBLIC_ROUTES: RouteRecordRaw[] = [
  // Return from Telegram's sign-in page (Standalone phase 3). The page is
  // never shown. The address keeps code/state until the first navigation
  // finishes, and that navigation waits for isReady -- so useAuth.ts reads
  // them first, wipes them and finishes the sign-in. The route exists so
  // the first navigation lands on '/' (roleRedirect, the role already
  // known) instead of the catch-all's /404.
  {
    path: RETURN_PATH,
    redirect: '/',
  },

  {
    path: '/auth-error',
    name: 'auth-error',
    component: () => import('@/views/auth/LoadingErrorView.vue'),
  },

  {
    path: '/404',
    name: 'not-found',
    component: () => import('@/views/NotFoundView.vue'),
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/404',
  },
]
