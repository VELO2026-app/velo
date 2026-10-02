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
   *  the named server-side condition holds; VTabBar stays dumb. Omit for
   *  the unconditional default. 'schools' = the account belongs to >= 1 school
   *  (stores/schoolsHub, any relation); the MASTER zone's shell keeps the
   *  tab also for the admin-issued founding right (can_create_groups). */
  requires?: 'schools'
}

export const USER_TABS: TabItem[] = [
  { icon: IconHome, label: 'Дашборд', to: '/user/dashboard' },
  { icon: IconCalendar, label: 'Календарь', to: '/user/calendar' },
  // Owner 2026-10-02: the diary follows the ACTIVE INTERFACE ROLE only -- a
  // multi-role account (master / founding-right holder) in the user zone
  // keeps the tab unconditionally. The former curator gate keyed on the
  // async can_create_groups probe, which made the tab flash out from under
  // a settled first paint; the master/admin zones have no diary tab at all.
  { icon: IconDiary, label: 'Дневник', to: '/user/diary' },
  // tz-curator.md §1.2 (owner 2026-09-22): «Школы» sits between «Дневник»
  // and «Я», shown to anyone who BELONGS to at least one school (the shell
  // filters by the schoolsHub store) -- curators, masters of, and plain
  // students in somebody's school alike.
  { icon: IconSchool, label: 'Школы', to: '/user/schools', requires: 'schools' },
  { icon: IconProfile, label: 'Я', to: '/user/profile' },
]

export const MASTER_TABS: TabItem[] = [
  { icon: IconHome, label: 'Дашборд', to: '/master/dashboard' },
  { icon: IconCalendar, label: 'Практики', to: '/master/practices' },
  { icon: IconAnalytics, label: 'Аналитика', to: '/master/analytics' },
  // tz-curator.md §1.2 (owner 2026-09-22: «только при наличии хотя бы одной
  // школы», право основания сохраняет вход): четвёртым, перед «Я» —
  // зеркально юзер-зоне. Same membership condition as the user zone's, PLUS
  // the founding right: a can_create_groups holder with zero schools keeps
  // the tab -- the empty hub's «Создать школу» is their only entrance.
  // Target is the master zone's own sectioned schools list.
  { icon: IconSchool, label: 'Школы', to: '/master/curator-groups', requires: 'schools' },
  { icon: IconProfile, label: 'Я', to: '/master/profile' },
]

export const ADMIN_TABS: TabItem[] = [
  { icon: IconHome, label: 'Дашборд', to: '/admin/dashboard' },
  { icon: IconGroup, label: 'Мастера', to: '/admin/masters' },
  { icon: IconWarning, label: 'Модерация', to: '/admin/reports' },
]
