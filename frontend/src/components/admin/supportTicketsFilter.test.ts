// =============================================================================
// VELO Frontend -- supportTicketsFilter Unit Tests (FE-100)
// =============================================================================
//
// The pure translation "tab + filter -> list query". The DAY is the admin's
// own: [00:00, 00:00 of the next day) in their zone, ISO with the offset --
// asserted across zones and on the day the clocks change (a 25-hour and a
// 23-hour day), where "start + 24 h" would be wrong by an hour.
// =============================================================================

import { describe, it, expect } from 'vitest'
import {
  EMPTY_SUPPORT_FILTER,
  supportTicketQuery,
  type SupportTicketsFilter,
} from '@/components/admin/supportTicketsFilter'

function f(overrides: Partial<SupportTicketsFilter> = {}): SupportTicketsFilter {
  return { ...EMPTY_SUPPORT_FILTER, ...overrides }
}

describe('supportTicketQuery -- tabs and chips', () => {
  it('«Все», no filter -> an empty query (the backend leaves spam out)', () => {
    expect(supportTicketQuery('all', f(), 'Europe/Berlin')).toEqual({})
  })

  it('«Спам» -> status spam, even with a status chip chosen before', () => {
    expect(supportTicketQuery('spam', f({ status: 'resolved' }), 'Europe/Berlin')).toEqual({
      status: 'spam',
    })
  })

  it('a status chip on «Все» -> that status', () => {
    expect(supportTicketQuery('all', f({ status: 'duplicate' }), 'UTC')).toEqual({
      status: 'duplicate',
    })
  })

  it.each([
    ['payments', ['payments']],
    ['practices', ['practices']],
    ['tech', ['tech']],
    ['complaints', ['complaint_master', 'complaint_user']],
    ['other', ['other']],
  ] as const)('the «%s» chip -> categories %j', (group, categories) => {
    expect(supportTicketQuery('all', f({ group }), 'UTC')).toEqual({ categories })
  })

  it('the rating chips go together as `ratings` -- "any of these" (FE-107)', () => {
    expect(supportTicketQuery('all', f({ rating: ['4', '5'] }), 'UTC')).toEqual({
      ratings: ['4', '5'],
    })
  })

  it('«none» rides the same parameter as the stars', () => {
    expect(supportTicketQuery('all', f({ rating: ['none'] }), 'UTC')).toEqual({
      ratings: ['none'],
    })
  })

  it('rating chips combine with a category and a status in ONE query', () => {
    expect(
      supportTicketQuery('all', f({ group: 'tech', status: 'resolved', rating: ['5'] }), 'UTC'),
    ).toEqual({
      categories: ['tech'],
      status: 'resolved',
      ratings: ['5'],
    })
  })

  it('no rating chosen sends no `ratings` at all', () => {
    expect(supportTicketQuery('all', f({ rating: [] }), 'UTC')).toEqual({})
  })
})

describe('supportTicketQuery -- the day is the admin\u2019s', () => {
  it.each([
    [
      'Europe/Berlin',
      '2026-10-20',
      '2026-10-20T00:00:00.000+02:00',
      '2026-10-21T00:00:00.000+02:00',
    ],
    ['Asia/Tokyo', '2026-10-20', '2026-10-20T00:00:00.000+09:00', '2026-10-21T00:00:00.000+09:00'],
    [
      'America/Los_Angeles',
      '2026-10-20',
      '2026-10-20T00:00:00.000-07:00',
      '2026-10-21T00:00:00.000-07:00',
    ],
    ['UTC', '2026-10-20', '2026-10-20T00:00:00.000Z', '2026-10-21T00:00:00.000Z'],
  ])('%s, %s -> [%s, %s)', (zone, date, from, to) => {
    expect(supportTicketQuery('all', f({ date }), zone)).toEqual({
      createdFrom: from,
      createdTo: to,
    })
  })

  it('the autumn clock change (Berlin, 25 Oct 2026): a 25-hour day, the next midnight is +01:00', () => {
    expect(supportTicketQuery('all', f({ date: '2026-10-25' }), 'Europe/Berlin')).toEqual({
      createdFrom: '2026-10-25T00:00:00.000+02:00',
      createdTo: '2026-10-26T00:00:00.000+01:00',
    })
  })

  it('the spring clock change (Berlin, 29 Mar 2026): a 23-hour day', () => {
    expect(supportTicketQuery('all', f({ date: '2026-03-29' }), 'Europe/Berlin')).toEqual({
      createdFrom: '2026-03-29T00:00:00.000+01:00',
      createdTo: '2026-03-30T00:00:00.000+02:00',
    })
  })

  it('no day -> no bounds at all (not empty strings)', () => {
    const q = supportTicketQuery('all', f({ date: '' }), 'Europe/Berlin')
    expect('createdFrom' in q).toBe(false)
    expect('createdTo' in q).toBe(false)
  })

  it('everything at once, in «Спам»: categories, spam, the day', () => {
    expect(
      supportTicketQuery(
        'spam',
        f({ group: 'complaints', status: 'open', date: '2026-10-20' }),
        'Europe/Berlin',
      ),
    ).toEqual({
      categories: ['complaint_master', 'complaint_user'],
      status: 'spam',
      createdFrom: '2026-10-20T00:00:00.000+02:00',
      createdTo: '2026-10-21T00:00:00.000+02:00',
    })
  })
})
