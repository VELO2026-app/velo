// =============================================================================
// VELO Frontend -- web console routes (/console, ConsoleShell; FE-262)
// =============================================================================
//
// The desktop web version of the instance admin. It lives next to the mobile
// /admin zone until it is tested; then /admin moves here and the mobile
// screens go. One route per module (utils/console/modules.ts) plus the
// screens inside a module. The records of an instance option carry
// meta.option, as in routes/user.ts.
//
// A record's component comes from views/console/consoleScreens.ts through
// one lazy import, so the start-up chunk does not grow with each screen
// (the bundle budget); the router still waits for the screen itself.
// =============================================================================

import type { Component } from 'vue'
import type { RouteRecordRaw } from 'vue-router'
import { CONSOLE_MODULES, consoleRouteName, type ConsoleRouteName } from '@/utils/console/modules'

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

/** The /console zone: ConsoleShell and one screen per module. */
export function consoleRoutes(): RouteRecordRaw[] {
  return [
    {
      path: '/console',
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
        {
          path: '',
          redirect: { name: consoleRouteName('dashboard') },
        },
      ],
    },
  ]
}
