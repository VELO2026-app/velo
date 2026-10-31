// =============================================================================
// VELO Frontend -- support topic, category and status tables (FE-104, FE-100)
// =============================================================================
//
// THE ONE TABLE "topic code -> label" on the front: the catalog section
// `supportTopics.<code>` (owner ruling FE-104: one label per code, the same on
// both forms and in the admin list). The backend stores and returns codes
// only (models.TOPICS); its own labels serve the admin Telegram signal alone.
//
// THE ONE TABLE "category -> icon" (FE-100): six categories, five glyphs --
// both complaints share one (owner ruling 25.10). Colours are existing tokens
// sampled from the owner's mockup (25.10).
//
// TEMPORARY (owner ruling 25.10, FE-100 delivery B): the practices glyph is
// IconMeditation standing in for the designer's yoga-mat icon (no source SVG
// yet), and both complaints use IconProfile. Replace when the designer's
// sources arrive -- only SUPPORT_CATEGORY_ICONS below changes.
//
// THE FILTER GROUPS (FE-100): five chips over the six categories -- the
// «Жалобы» chip is both complaint categories (sent as a repeatable
// `category`, BE-162 fix 2).
// =============================================================================

import type { Component } from 'vue'
import { t } from '@/locales'
import type { SupportCategory, SupportTicketStatus, SupportTopicCode } from '@/api/support'
import {
  IconFinance,
  IconMeditation,
  IconProfile,
  IconQuestion,
  IconWarning,
} from '@/components/icons'

export function supportTopicLabel(code: SupportTopicCode): string {
  return t(`supportTopics.${code}`)
}

export function supportStatusLabel(status: SupportTicketStatus): string {
  return t(`adminScreens.adminSupport.statuses.${status}`)
}

/** The badge colour of a status -- one map for the admin list and the card. */
export type SupportStatusBadge = 'warning' | 'success' | 'muted' | 'info' | 'error'

const STATUS_BADGES: Record<SupportTicketStatus, SupportStatusBadge> = {
  open: 'warning',
  resolved: 'success',
  rejected: 'muted',
  duplicate: 'info',
  spam: 'error',
}

export function supportStatusBadge(status: SupportTicketStatus): SupportStatusBadge {
  return STATUS_BADGES[status]
}

/** A category's glyph and its colour token (`--velo-*`, applied as `color`). */
export interface SupportCategoryIcon {
  icon: Component
  color: string
}

const SUPPORT_CATEGORY_ICONS: Record<SupportCategory, SupportCategoryIcon> = {
  tech: { icon: IconWarning, color: 'var(--velo-pink-300)' },
  payments: { icon: IconFinance, color: 'var(--velo-analytics-neutral)' },
  // TEMPORARY: the designer's yoga mat replaces this (see the header).
  practices: { icon: IconMeditation, color: 'var(--velo-analytics-good)' },
  complaint_master: { icon: IconProfile, color: 'var(--velo-peach-300)' },
  complaint_user: { icon: IconProfile, color: 'var(--velo-peach-300)' },
  other: { icon: IconQuestion, color: 'var(--velo-blue-200)' },
}

export function supportCategoryIcon(category: SupportCategory): SupportCategoryIcon {
  return SUPPORT_CATEGORY_ICONS[category]
}

/** A filter chip: its key (also the catalog key) and the categories it sends. */
export interface SupportCategoryGroup {
  key: 'payments' | 'practices' | 'tech' | 'complaints' | 'other'
  categories: readonly SupportCategory[]
}

export const SUPPORT_CATEGORY_GROUPS: readonly SupportCategoryGroup[] = [
  { key: 'payments', categories: ['payments'] },
  { key: 'practices', categories: ['practices'] },
  { key: 'tech', categories: ['tech'] },
  { key: 'complaints', categories: ['complaint_master', 'complaint_user'] },
  { key: 'other', categories: ['other'] },
]

export function supportCategoryGroupLabel(key: SupportCategoryGroup['key']): string {
  return t(`adminScreens.adminSupport.categories.${key}`)
}

/** The SIX categories by their own code (FE-107: the statistics rows name
 *  each category separately -- complaint_master and complaint_user apart,
 *  where the filter's chips merge them into «Жалобы»). */
export function supportCategoryLabel(category: SupportCategory): string {
  return t(`adminScreens.adminSupport.categoryNames.${category}`)
}
