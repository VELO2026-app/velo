import { describe, expect, it } from 'vitest'
import { DateTime } from 'luxon'
import {
  filterFromQuery,
  filterToQuery,
  isFiltered,
  ticketQueryOf,
  type TicketFilter,
} from '@/components/console/requests/ticketFilters'

const NONE: TicketFilter = { group: null, ratings: [], period: null }

describe('the ticket filters in the URL', () => {
  it('round-trips every filter through the query', () => {
    const filter: TicketFilter = {
      group: 'complaints',
      ratings: ['4', '5', 'none'],
      period: 'week',
    }

    const query = filterToQuery(filter)

    expect(query).toEqual({ cat: 'complaints', rating: '4,5,none', period: 'week' })
    expect(filterFromQuery(query as Record<string, string>)).toEqual(filter)
  })

  it('leaves an unset filter out of the query, so the router drops it', () => {
    expect(filterToQuery(NONE)).toEqual({ cat: undefined, rating: undefined, period: undefined })
  })

  it('ignores values outside the closed sets and keeps the stars in menu order', () => {
    expect(filterFromQuery({ cat: 'bogus', rating: '9,none,2,x', period: 'year' })).toEqual({
      group: null,
      ratings: ['2', 'none'],
      period: null,
    })
  })

  it('knows when any filter is set', () => {
    expect(isFiltered(NONE)).toBe(false)
    expect(isFiltered({ ...NONE, ratings: ['1'] })).toBe(true)
  })
})

describe('ticketQueryOf', () => {
  const now = DateTime.fromISO('2026-11-24T10:00:00Z')

  it('asks for the status alone when nothing is filtered', () => {
    expect(ticketQueryOf('open', NONE, 'Europe/Berlin', now)).toEqual({ status: 'open' })
  })

  it('sends both complaint categories for the complaints chip and the chosen ratings', () => {
    const query = ticketQueryOf(
      'resolved',
      { group: 'complaints', ratings: ['5'], period: null },
      undefined,
      now,
    )

    expect(query).toEqual({
      status: 'resolved',
      categories: ['complaint_master', 'complaint_user'],
      ratings: ['5'],
    })
  })

  it.each([
    ['today', '2026-11-24T00:00:00.000+01:00'],
    ['week', '2026-11-18T00:00:00.000+01:00'],
    ['month', '2026-10-26T00:00:00.000+01:00'],
  ] as const)(
    'spans the %s from midnight of its first day to midnight after today, in the admin timezone',
    (period, from) => {
      const query = ticketQueryOf('open', { ...NONE, period }, 'Europe/Berlin', now)

      expect(query.createdFrom).toBe(from)
      expect(query.createdTo).toBe('2026-11-25T00:00:00.000+01:00')
    },
  )
})
