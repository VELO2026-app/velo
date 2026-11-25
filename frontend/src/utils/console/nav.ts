// =============================================================================
// VELO Frontend -- the web console's menu (FE-262)
// =============================================================================
//
// The modules of modules.ts with their icons, grouped for the menu and
// filtered for this instance. Loaded with the console shell only.
// =============================================================================

import type { Component } from 'vue'
import {
  IconAnalytics,
  IconCalendar,
  IconFinance,
  IconGroup,
  IconHome,
  IconList,
  IconLock,
  IconMessages,
  IconSchool,
  IconSupport,
  IconUsers,
  IconWarning,
} from '@/components/icons'
import type { OptionName } from '@/platform/instance'
import {
  CONSOLE_MODULES,
  type ConsoleGroupKey,
  type ConsoleModule,
  type ConsoleModuleKey,
} from '@/utils/console/modules'

/** The menu icon of each module. */
export const CONSOLE_ICONS: Record<ConsoleModuleKey, Component> = {
  dashboard: IconHome,
  masters: IconGroup,
  users: IconUsers,
  schools: IconSchool,
  practices: IconCalendar,
  catalog: IconList,
  moderation: IconWarning,
  support: IconSupport,
  finance: IconFinance,
  analytics: IconAnalytics,
  mail: IconMessages,
  settings: IconLock,
}

/** A menu item: a visible module with its icon. */
export interface ConsoleNavItem extends ConsoleModule {
  /** Menu icon. */
  readonly icon: Component
}

/** A run of visible modules under one group caption. */
export interface ConsoleNavGroup {
  /** Group key. */
  readonly key: ConsoleGroupKey
  /** The group's visible modules, in menu order. */
  readonly modules: readonly ConsoleNavItem[]
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
    const item: ConsoleNavItem = { ...module, icon: CONSOLE_ICONS[module.key] }
    const last = groups.at(-1)
    if (last?.key === module.group) {
      groups[groups.length - 1] = { ...last, modules: [...last.modules, item] }
    } else {
      groups.push({ key: module.group, modules: [item] })
    }
  }
  return groups
}
