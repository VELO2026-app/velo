// =============================================================================
// VELO Frontend -- web console routes (/console, ConsoleShell; FE-262)
// =============================================================================
//
// The desktop web version of the instance admin. It lives next to the mobile
// /admin zone until it is tested; then /admin moves here and the mobile
// screens go. One route per module (utils/console/modules.ts); a module
// that has not moved yet shows ConsolePlaceholderView with a way to its
// mobile screen. The records of an instance option carry meta.option, as in
// routes/user.ts.
// =============================================================================

import type { Component } from 'vue'
import type { RouteRecordRaw } from 'vue-router'
import { CONSOLE_MODULES, consoleRouteName, type ConsoleModuleKey } from '@/utils/console/modules'

declare module 'vue-router' {
  interface RouteMeta {
    /** A full-width web screen: AppFrame drops its 402px phone column. */
    web?: boolean
  }
}

const placeholder = () => import('@/views/console/ConsolePlaceholderView.vue')

/** The modules that have their own web screen; the rest show the placeholder. Lazy: a screen is its own chunk. */
const SCREENS: Partial<Record<ConsoleModuleKey, () => Promise<Component>>> = {
  finance: () => import('@/views/console/ConsoleFinanceView.vue'),
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
          component: SCREENS[module.key] ?? placeholder,
        })),
        {
          path: '',
          redirect: { name: consoleRouteName('dashboard') },
        },
      ],
    },
  ]
}
