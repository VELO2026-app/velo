// =============================================================================
// VELO Frontend -- the web console's modules (FE-262)
// =============================================================================
//
// The console (/console) is the web version of the instance admin. A module
// is one menu item and the unit of access: a module the instance does not
// have (an instance option is off) is not in the menu at all. Role
// permissions join the same filter later (one predicate per module); until
// the backend has roles, the admin role sees every module.
//
// Another instance (a skin) changes only the look through tokens; a
// different set of items comes from instance options, never from the skin
// name.
//
// Plain data on purpose: the router reads it, so it must not pull the menu
// icons into the app chunk (they live in nav.ts, loaded with the shell).
// =============================================================================

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

/** A menu group: a run of modules under one caption. */
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
  /** Instance option the module needs; off -- the module is not there. */
  readonly option?: OptionName
  /** Live counter shown next to the item. */
  readonly badge?: ConsoleBadgeSource
}

/** Every console module, in menu order. */
export const CONSOLE_MODULES: readonly ConsoleModule[] = [
  { key: 'dashboard', group: 'overview' },
  { key: 'masters', group: 'people', badge: 'pendingVerifications' },
  { key: 'users', group: 'people' },
  { key: 'schools', group: 'people', option: 'schools' },
  { key: 'practices', group: 'content' },
  { key: 'catalog', group: 'content' },
  { key: 'moderation', group: 'requests', badge: 'pendingModeration' },
  { key: 'support', group: 'requests' },
  { key: 'finance', group: 'money' },
  { key: 'analytics', group: 'growth' },
  { key: 'mail', group: 'growth' },
  { key: 'settings', group: 'system' },
]

/** A console route name: a module's screen or a screen inside a module. */
export type ConsoleRouteName =
  `console-${ConsoleModuleKey}` | 'console-masters-detail' | 'console-practices-detail'

/** The route name of a module's main screen. */
export function consoleRouteName<K extends ConsoleModuleKey>(key: K): `console-${K}` {
  return `console-${key}`
}

/** Whether a group shows its caption (i18n:console.groups.<key>); the
 *  overview group (the dashboard alone) has none. */
export function groupHasCaption(key: ConsoleGroupKey): boolean {
  return key !== 'overview'
}

/**
 * The module a console route belongs to: `console-<module>` or a nested
 * screen named `console-<module>-<screen>` (a master's card, a practice).
 */
export function consoleModuleOf(routeName: unknown): ConsoleModuleKey | null {
  if (typeof routeName !== 'string' || !routeName.startsWith('console-')) return null
  const rest = routeName.slice('console-'.length)
  const found = CONSOLE_MODULES.find((m) => rest === m.key || rest.startsWith(`${m.key}-`))
  return found?.key ?? null
}
