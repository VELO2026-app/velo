// =============================================================================
// VELO Frontend -- Tab Bar Config (Phase F2.2; admin -> 3 tabs, DS rebuild 2026-06-14)
// =============================================================================
//
// Tab items per role. Used by shell components (UserShell, MasterShell,
// AdminShell) to configure their tab bars (VTabBar for user/master,
// VAdminTabBar for admin).
//
// Admin DS rebuild (2026-06-14, operator): admin has 3 tabs -- Дашборд / Мастера /
// Модерация. The former 4th tab «Я» (/admin/profile) is removed: the operator
// confirmed admin needs no own profile. Badge counts are injected live by
// AdminShell (masters awaiting verification + reports awaiting moderation).
// =============================================================================

import type { Component } from 'vue'
import {
  IconHome,
  IconCalendar,
  IconDiary,
  IconProfile,
  IconAnalytics,
  IconGroup,
  IconSchool,
  IconWarning,
} from '@/components/icons'

/** One tab of the role tab bar. Lives HERE, not in VTabBar.vue: types exported
 * from .vue SFCs are invisible to tooling without the vue language plugin
 * (type-aware eslint resolves them as any). */
export interface TabItem {
  icon: string | Component
  label: string
  to: string
  /** Count badge -- rendered by VAdminTabBar only (admin counts); the
   *  user/master VTabBar itself paints no badges. */
  badge?: number | string
  /** Conditional tab (tz-curator.md §1.2): the SHELL drops the tab unless
   *  the named server-side condition holds; VTabBar stays dumb. Omit for the
   *  unconditional default. 'schools' = the account is a curator
   *  (stores/schoolsHub: can_create_groups or curates >= 1 school). */
  requires?: 'schools'
}

export const USER_TABS: TabItem[] = [
  { icon: IconHome, label: 'Дашборд', to: '/user/dashboard' },
  { icon: IconCalendar, label: 'Календарь', to: '/user/calendar' },
  { icon: IconDiary, label: 'Дневник', to: '/user/diary' },
  // tz-curator.md §1.2 (owner, mockup 2026-09-19): «Школы» sits between
  // «Дневник» and «Я». Visible only to curators (the shell filters by the
  // schoolsHub store); the plain-user branch (member of a school) comes with
  // the user flow later.
  { icon: IconSchool, label: 'Школы', to: '/user/schools', requires: 'schools' },
  { icon: IconProfile, label: 'Я', to: '/user/profile' },
]

export const MASTER_TABS: TabItem[] = [
  { icon: IconHome, label: 'Дашборд', to: '/master/dashboard' },
  { icon: IconCalendar, label: 'Практики', to: '/master/practices' },
  { icon: IconAnalytics, label: 'Аналитика', to: '/master/analytics' },
  // tz-curator.md §1.2 (owner: «у куратора — всегда»), порядок владельца
  // 2026-09-19: четвёртым, перед «Я» — зеркально юзер-зоне. Same schoolsHub
  // condition as the user zone's; target is the master zone's own sectioned
  // schools list.
  { icon: IconSchool, label: 'Школы', to: '/master/curator-groups', requires: 'schools' },
  { icon: IconProfile, label: 'Я', to: '/master/profile' },
]

export const ADMIN_TABS: TabItem[] = [
  { icon: IconHome, label: 'Дашборд', to: '/admin/dashboard' },
  { icon: IconGroup, label: 'Мастера', to: '/admin/masters' },
  { icon: IconWarning, label: 'Модерация', to: '/admin/reports' },
]
