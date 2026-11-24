// =============================================================================
// VELO Frontend -- the web console's modules and their menu (FE-262)
// =============================================================================
//
// The console (/console) is the desktop web version of the instance admin.
// A module is one menu item and the unit of access: a module the instance
// does not have (an instance option is off) is not in the menu at all.
// Role permissions join the same filter later (one predicate per module);
// until the backend has roles, the admin role sees every module.
//
// Another instance (a skin) changes only the look through tokens; a
// different set of items comes from instance options, never from the skin
// name.
// =============================================================================

import type { Component } from 'vue'
import {
  IconAnalytics,
  IconBroadcast,
  IconCalendar,
  IconFinance,
  IconGroup,
  IconHome,
  IconList,
  IconLock,
  IconSchool,
  IconSupport,
  IconUsers,
  IconWarning,
} from '@/components/icons'
import type { OptionName } from '@/platform/instance'

/** A console module key: the menu item and the access unit. */
export type ConsoleModuleKey =
  | 'dashboard'
  | 'masters'
  | 'users'
  | 'schools'
  | 'practices'
  | 'catalog'
  | 'moderation'
  | 'support'
  | 'finance'
  | 'analytics'
  | 'mail'
  | 'settings'

/** A menu group: a caption over a run of modules (null -- no caption). */
export type ConsoleGroupKey =
  'overview' | 'people' | 'content' | 'requests' | 'money' | 'growth' | 'system'

/** A live counter a menu item can show (from the admin stats query). */
export type ConsoleBadgeSource = 'pendingVerifications' | 'pendingModeration'

/** One console module as the menu and the router see it. */
export interface ConsoleModule {
  /** Module key; the route name is `console-<key>`. */
  readonly key: ConsoleModuleKey
  /** Menu group the item sits in. */
  readonly group: ConsoleGroupKey
  /** Menu icon. */
  readonly icon: Component
  /** Instance option the module needs; off -- the module is not there. */
  readonly option?: OptionName
  /** Live counter shown next to the item. */
  readonly badge?: ConsoleBadgeSource
}

/** Every console module, in menu order. */
export const CONSOLE_MODULES: readonly ConsoleModule[] = [
  { key: 'dashboard', group: 'overview', icon: IconHome },
  { key: 'masters', group: 'people', icon: IconGroup, badge: 'pendingVerifications' },
  { key: 'users', group: 'people', icon: IconUsers },
  { key: 'schools', group: 'people', icon: IconSchool, option: 'schools' },
  { key: 'practices', group: 'content', icon: IconCalendar },
  { key: 'catalog', group: 'content', icon: IconList },
  { key: 'moderation', group: 'requests', icon: IconWarning, badge: 'pendingModeration' },
  { key: 'support', group: 'requests', icon: IconSupport },
  { key: 'finance', group: 'money', icon: IconFinance },
  { key: 'analytics', group: 'growth', icon: IconAnalytics },
  { key: 'mail', group: 'growth', icon: IconBroadcast },
  { key: 'settings', group: 'system', icon: IconLock },
]

/** The route name of a module's main screen. */
export function consoleRouteName(key: ConsoleModuleKey): string {
  return `console-${key}`
}

/** A run of visible modules under one group caption. */
export interface ConsoleNavGroup {
  /** Group key (its caption is i18n:console.groups.<key>; overview has none). */
  readonly key: ConsoleGroupKey
  /** The group's visible modules, in menu order. */
  readonly modules: readonly ConsoleModule[]
}

/**
 * The menu: visible modules grouped in order, empty groups dropped.
 *
 * @param optionEnabled - whether an instance option is on (the instance
 *   config in the app, a stub in tests)
 */
export function consoleNavGroups(
  optionEnabled: (option: OptionName) => boolean,
): ConsoleNavGroup[] {
  const groups: ConsoleNavGroup[] = []
  for (const module of CONSOLE_MODULES) {
    if (module.option !== undefined && !optionEnabled(module.option)) continue
    const last = groups.at(-1)
    if (last?.key === module.group)
      groups[groups.length - 1] = { ...last, modules: [...last.modules, module] }
    else groups.push({ key: module.group, modules: [module] })
  }
  return groups
}

/** The module a console route belongs to (its route name prefix), if any. */
export function consoleModuleOf(routeName: unknown): ConsoleModuleKey | null {
  if (typeof routeName !== 'string' || !routeName.startsWith('console-')) return null
  const rest = routeName.slice('console-'.length)
  const found = CONSOLE_MODULES.find((m) => rest === m.key || rest.startsWith(`${m.key}-`))
  return found?.key ?? null
}
