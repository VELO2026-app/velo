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
// Every record renders ConsoleScreen, which picks the screen by route name:
// this table is in the start-up chunk, and a lazy import per screen here
// would put a preload list per screen there (the bundle budget). A new
// screen adds its record here and its loader in ConsoleScreen.vue.
// =============================================================================

import type { RouteRecordRaw } from 'vue-router'
import { CONSOLE_MODULES, consoleRouteName } from '@/utils/console/modules'

declare module 'vue-router' {
  interface RouteMeta {
    /** A full-width web screen: AppFrame drops its 402px phone column. */
    web?: boolean
  }
}

const screen = () => import('@/views/console/ConsoleScreen.vue')

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
          component: screen,
        })),
        // A screen inside a module is named console-<module>-<what>, so the
        // menu keeps the module lit (consoleModuleOf).
        {
          path: 'practices/:id',
          name: 'console-practices-detail',
          component: screen,
        },
        {
          path: '',
          redirect: { name: consoleRouteName('dashboard') },
        },
      ],
    },
  ]
}
