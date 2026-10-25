/**
 * Filter state of the «Обращения» list (FE-100) and its translation into the
 * list query. Lives in a .ts module, not in the .vue sheet: types exported
 * from SFCs are invisible to type-aware eslint (same reason as
 * shared/moderationFilter.ts).
 *
 * ONE VALUE PER GROUP: the backend takes one `status` and one set of
 * categories per request, so every chip group is single-select with «Все».
 * The «Жалобы» chip is both complaint categories (repeatable `category`).
 *
 * THE DAY is the admin's own: [00:00, 00:00 of the next day) in their
 * `users.timezone`, sent as ISO with the offset (the backend refuses a time
 * without a zone; `created_from` inclusive, `created_to` exclusive).
 */
import { DateTime } from 'luxon'
import type { AdminTicketQuery, SupportTicketStatus } from '@/api/support'
import { SUPPORT_CATEGORY_GROUPS, type SupportCategoryGroup } from '@/utils/supportTopics'

/** Statuses the filter offers -- spam is its own tab, not a chip. */
export type SupportFilterStatus = Exclude<SupportTicketStatus, 'spam'>

export const SUPPORT_FILTER_STATUSES: readonly SupportFilterStatus[] = [
  'open',
  'resolved',
  'rejected',
  'duplicate',
]

export interface SupportTicketsFilter {
  group: SupportCategoryGroup['key'] | null
  status: SupportFilterStatus | null
  /** 'YYYY-MM-DD' (DatePickerSheet's value) or '' for any day. */
  date: string
}

export type SupportTicketsTab = 'all' | 'spam'

export const EMPTY_SUPPORT_FILTER: SupportTicketsFilter = { group: null, status: null, date: '' }

/** The list query for a tab + filter. In «Спам» the status is spam and the
 *  status chips do not apply; category and day still do. */
export function supportTicketQuery(
  tab: SupportTicketsTab,
  filter: SupportTicketsFilter,
  timezone: string | undefined,
): AdminTicketQuery {
  const query: AdminTicketQuery = {}
  const group = SUPPORT_CATEGORY_GROUPS.find((g) => g.key === filter.group)
  if (group) query.categories = group.categories
  if (tab === 'spam') query.status = 'spam'
  else if (filter.status) query.status = filter.status
  if (filter.date) {
    const start = DateTime.fromISO(filter.date, { zone: timezone }).startOf('day')
    query.createdFrom = start.toISO() ?? undefined
    query.createdTo = start.plus({ days: 1 }).toISO() ?? undefined
  }
  return query
}
