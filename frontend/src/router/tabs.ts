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
}

export const USER_TABS: TabItem[] = [
  { icon: IconHome, label: 'Дашборд', to: '/user/dashboard' },
  { icon: IconCalendar, label: 'Календарь', to: '/user/calendar' },
  { icon: IconDiary, label: 'Дневник', to: '/user/diary' },
  { icon: IconProfile, label: 'Я', to: '/user/profile' },
]

export const MASTER_TABS: TabItem[] = [
  { icon: IconHome, label: 'Дашборд', to: '/master/dashboard' },
  { icon: IconCalendar, label: 'Практики', to: '/master/practices' },
  { icon: IconAnalytics, label: 'Аналитика', to: '/master/analytics' },
  { icon: IconProfile, label: 'Я', to: '/master/profile' },
]

export const ADMIN_TABS: TabItem[] = [
  { icon: IconHome, label: 'Дашборд', to: '/admin/dashboard' },
  { icon: IconGroup, label: 'Мастера', to: '/admin/masters' },
  { icon: IconWarning, label: 'Модерация', to: '/admin/reports' },
]
