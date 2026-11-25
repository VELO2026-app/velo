// =============================================================================
// VELO Frontend -- web console routes (/admin, ConsoleShell; FE-262, FE-272)
// =============================================================================
//
// The instance admin: the web console at /admin (FE-272; it lived at
// /console next to the mobile admin until then). One route per module (utils/console/modules.ts) plus the
// screens inside a module. The records of an instance option carry
// meta.option, as in routes/user.ts.
//
// A record's component comes from views/console/consoleScreens.ts through
// one lazy import, so the start-up chunk does not grow with each screen
// (the bundle budget); the router still waits for the screen itself.
// =============================================================================

import type { Component } from 'vue'
import type { RouteRecordRaw } from 'vue-router'
import {
  CONSOLE_BASE,
  CONSOLE_MODULES,
  consoleRouteName,
  type ConsoleRouteName,
} from '@/utils/console/modules'

declare module 'vue-router' {
  interface RouteMeta {
    /** A full-width web screen: AppFrame drops its 402px phone column. */
    web?: boolean
  }
}

/** The route component of a console record: its screen, loaded lazily. */
function screen(name: ConsoleRouteName): () => Promise<{ default: Component }> {
  return () => import('@/views/console/consoleScreens').then((m) => m.loadConsoleScreen(name))
}

/**
 * The addresses of the mobile admin that the console now answers (FE-272):
 * bot deep links, bookmarks and old notifications open the console screen
 * that does the same job. The same paths as a console screen
 * (dashboard, masters, masters/:id, users, schools, catalog, practices,
 * practices/:id) need no record here.
 */
const LEGACY_ADMIN: RouteRecordRaw[] = [
  { path: 'masters/invite', redirect: { name: 'console-masters' } },
  { path: 'method-requests', redirect: { name: 'console-moderation', query: { tab: 'methods' } } },
  {
    // The old moderation screen had the support tickets as its first tab.
    path: 'reports',
    redirect: (to) =>
      to.query.tab === 'complaints'
        ? { name: 'console-moderation', query: { tab: 'complaints' } }
        : { name: 'console-support', query: {} },
  },
  {
    path: 'reports/:id',
    redirect: (to) => ({
      name: 'console-moderation',
      query: { tab: 'complaints', id: String(to.params.id) },
    }),
  },
  { path: 'profile', redirect: { name: 'console-dashboard' } },
  ...(
    [
      ['check-in', 'checkin'],
      ['feedback', 'feedback'],
      ['return', 'return'],
    ] as const
  ).map(([path, metric]) => ({
    path: `metrics/${path}`,
    redirect: { name: 'console-analytics', query: { metric } },
  })),
  { path: 'revenue', redirect: { name: 'console-finance' } },
  { path: 'participants', redirect: { name: 'console-users', query: { tab: 'user' } } },
  // A payout's own address loses the payout: the queue has no open item.
  ...['withdrawals', 'withdrawals/:id'].map((path) => ({
    path,
    redirect: { name: 'console-finance', query: { tab: 'withdrawals' } },
  })),
  { path: 'promos', redirect: { name: 'console-finance', query: { tab: 'promos' } } },
  { path: 'support/stats', redirect: { name: 'console-support', query: { tab: 'stats' } } },
  {
    path: 'support/:id',
    redirect: (to) => ({ name: 'console-support', query: { ticket: String(to.params.id) } }),
  },
]

/** The /admin zone (the web console): ConsoleShell and one screen per module. */
export function consoleRoutes(): RouteRecordRaw[] {
  return [
    {
      path: CONSOLE_BASE,
      component: () => import('@/views/shells/ConsoleShell.vue'),
      meta: { catalogs: ['admin'], requires: 'admin-role', web: true },
      children: [
        ...CONSOLE_MODULES.map((module): RouteRecordRaw => ({
          path: module.key,
          name: consoleRouteName(module.key),
          meta: module.option === undefined ? {} : { option: module.option },
          component: screen(consoleRouteName(module.key)),
        })),
        // A screen inside a module is named console-<module>-<what>, so the
        // menu keeps the module lit (consoleModuleOf).
        {
          path: 'masters/:id',
          name: 'console-masters-detail',
          component: screen('console-masters-detail'),
        },
        {
          path: 'practices/:id',
          name: 'console-practices-detail',
          component: screen('console-practices-detail'),
        },
        ...LEGACY_ADMIN,
        {
          path: '',
          redirect: { name: consoleRouteName('dashboard') },
        },
      ],
    },
    // The console's first address (FE-262, until FE-272): the same screen
    // under /admin, query and hash kept.
    {
      path: '/console/:rest(.*)*',
      redirect: (to) => {
        // A repeatable param: an array, or '' for a bare /console.
        const rest = [to.params.rest ?? []].flat().join('/')
        return { path: `${CONSOLE_BASE}/${rest}`, query: to.query, hash: to.hash }
      },
    },
  ]
}
