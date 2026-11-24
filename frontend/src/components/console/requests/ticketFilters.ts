// =============================================================================
// VELO Frontend -- the filters of the console's ticket list (FE-262, slice 2)
// =============================================================================
//
// Category, rating and period, as the list API takes them (`category`,
// `rating`, `created_from`, `created_to`). The state lives in the URL
// (`?cat=`, `?rating=`, `?period=`), so a reload and the back button keep it;
// a value that is not one of the closed sets is ignored.
//
// THE PERIOD is the admin's own days: from 00:00 of its first day to 00:00 of
// the day after today, in their profile timezone, as ISO with the offset (the
// backend refuses a time without a zone; `created_from` inclusive,
// `created_to` exclusive). Whole days, so the query does not change within a
// day.
// =============================================================================

import { DateTime } from 'luxon'
import type { LocationQuery } from 'vue-router'
import type { AdminTicketQuery, SupportRatingFilter, SupportTicketStatus } from '@/api/support'
import { SUPPORT_CATEGORY_GROUPS, type SupportCategoryGroup } from '@/utils/supportTopics'

/** The periods the list offers: today, the last 7 days, the last 30 days. */
export type TicketPeriod = 'today' | 'week' | 'month'

/** The periods in the order of the menu, with the days each spans. */
export const TICKET_PERIODS: readonly { key: TicketPeriod; days: number }[] = [
  { key: 'today', days: 1 },
  { key: 'week', days: 7 },
  { key: 'month', days: 30 },
]

/** The rating filter values in the order of the menu: stars low to high, then "no rating". */
export const TICKET_RATINGS: readonly SupportRatingFilter[] = ['1', '2', '3', '4', '5', 'none']

/** The query parameters the filters use. */
export const TICKET_FILTER_PARAMS = ['cat', 'rating', 'period'] as const

/** The filters of the ticket list. */
export interface TicketFilter {
  /** The category chip (the complaint chip covers both complaint categories). */
  group: SupportCategoryGroup['key'] | null
  /** "Any of these" ratings; none chosen -- every ticket. */
  ratings: SupportRatingFilter[]
  /** The period of the appeal, null for any time. */
  period: TicketPeriod | null
}

function single(value: LocationQuery[string] | undefined): string | null {
  return typeof value === 'string' && value ? value : null
}

/** Read the filters from the URL's query; unknown values are dropped. */
export function filterFromQuery(query: LocationQuery): TicketFilter {
  const cat = single(query.cat)
  const period = single(query.period)
  const rated = new Set((single(query.rating) ?? '').split(','))
  return {
    group: SUPPORT_CATEGORY_GROUPS.find((g) => g.key === cat)?.key ?? null,
    ratings: TICKET_RATINGS.filter((r) => rated.has(r)),
    period: TICKET_PERIODS.find((p) => p.key === period)?.key ?? null,
  }
}

/** The query parameters of the filters; an unset filter is `undefined` (the router drops it). */
export function filterToQuery(filter: TicketFilter): Record<string, string | undefined> {
  return {
    cat: filter.group ?? undefined,
    rating: filter.ratings.length ? filter.ratings.join(',') : undefined,
    period: filter.period ?? undefined,
  }
}

/** Whether any filter is set. */
export function isFiltered(filter: TicketFilter): boolean {
  return filter.group !== null || filter.ratings.length > 0 || filter.period !== null
}

/**
 * The list query of a status and the filters.
 *
 * @param status - the status the tab lists
 * @param filter - the filters from the URL
 * @param timezone - the admin's profile timezone (the period's days are theirs)
 * @param now - the current moment (a test passes its own)
 */
export function ticketQueryOf(
  status: SupportTicketStatus,
  filter: TicketFilter,
  timezone: string | undefined,
  now: DateTime = DateTime.now(),
): AdminTicketQuery {
  const query: AdminTicketQuery = { status }
  const group = SUPPORT_CATEGORY_GROUPS.find((g) => g.key === filter.group)
  if (group) query.categories = group.categories
  if (filter.ratings.length) query.ratings = filter.ratings
  const days = TICKET_PERIODS.find((p) => p.key === filter.period)?.days
  if (days !== undefined) {
    const today = now.setZone(timezone).startOf('day')
    const createdFrom = today.minus({ days: days - 1 }).toISO()
    const createdTo = today.plus({ days: 1 }).toISO()
    if (createdFrom) query.createdFrom = createdFrom
    if (createdTo) query.createdTo = createdTo
  }
  return query
}
