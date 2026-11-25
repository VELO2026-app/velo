// =============================================================================
// VELO Frontend -- api/admin.ts: each wrapper calls the endpoint the backend
// serves (backend/app/modules/admin/**/router.py, support/router.py)
// =============================================================================
//
// The console's screens mock @/api/admin whole, so a wrong path, method or
// query name here would pass every screen test. This table pins the request
// each wrapper sends: method, URL with its query, body. admin.test.ts covers
// the conditional bodies of the verdicts (promote / master_only).
// =============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as admin from '@/api/admin'
import { api } from '@/api/client'

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>()
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  }
})

type Call = () => unknown
type Sent = [method: 'get' | 'post' | 'patch', url: string, body?: unknown]

const CASES: Array<[name: string, call: Call, sent: Sent]> = [
  ['stats', () => admin.getAdminStats(), ['get', '/api/v1/admin/stats']],
  [
    'overview of a past month',
    () => admin.getAdminStatsOverview('month', -1),
    ['get', '/api/v1/admin/stats/overview?period=month&offset=-1'],
  ],
  [
    'masters, all, first page',
    () => admin.getMastersList(),
    ['get', '/api/v1/admin/masters/list?limit=100&offset=0'],
  ],
  [
    'masters under review',
    () => admin.getMastersList('pending', 20, 40),
    ['get', '/api/v1/admin/masters/list?limit=20&offset=40&status=pending'],
  ],
  [
    'active users of a role',
    () => admin.getUsersList('user', 20, 0, true),
    ['get', '/api/v1/admin/users?limit=20&offset=0&role=user&is_active=true'],
  ],
  [
    'make a user master',
    () => admin.makeMaster('u1'),
    ['post', '/api/v1/admin/users/u1/make-master', {}],
  ],
  ['a master', () => admin.getMasterById('m1'), ['get', '/api/v1/admin/masters/m1']],
  [
    'reject an application',
    () => admin.rejectMaster('m1', 'no documents'),
    ['post', '/api/v1/admin/masters/m1/reject', { reason: 'no documents' }],
  ],
  [
    'revoke preview',
    () => admin.getRevokePreview('m1'),
    ['get', '/api/v1/admin/masters/m1/revoke-preview'],
  ],
  ['invite a master', () => admin.inviteMaster(), ['post', '/api/v1/admin/masters/invite', {}]],
  [
    'method change requests',
    () => admin.getMethodChangeRequests(),
    ['get', '/api/v1/admin/masters/method-change-requests?limit=20&offset=0'],
  ],
  [
    'pending complaints about masters',
    () => admin.getReports('pending', 'master', 20, 20),
    ['get', '/api/v1/admin/reports?status=pending&target_type=master&limit=20&offset=20'],
  ],
  ['a complaint', () => admin.getReportById('r1'), ['get', '/api/v1/admin/reports/r1']],
  [
    'resolve a complaint',
    () => admin.resolveReport('r1', 'warned'),
    ['post', '/api/v1/admin/reports/r1/resolve', { resolution_note: 'warned' }],
  ],
  [
    'dismiss a complaint without a note',
    () => admin.dismissReport('r1'),
    ['post', '/api/v1/admin/reports/r1/dismiss', { resolution_note: null }],
  ],
  [
    'pending payouts',
    () => admin.getAdminWithdrawals('pending'),
    ['get', '/api/v1/admin/withdrawals?limit=20&offset=0&status=pending'],
  ],
  [
    'approve a payout without a note',
    () => admin.approveWithdrawal('w1'),
    ['post', '/api/v1/admin/withdrawals/w1/approve', { note: null }],
  ],
  [
    'reject a payout',
    () => admin.rejectWithdrawal('w1', 'wrong IBAN'),
    ['post', '/api/v1/admin/withdrawals/w1/reject', { note: 'wrong IBAN' }],
  ],
  [
    'check-in rate of the current week',
    () => admin.getCheckinMetric(),
    ['get', '/api/v1/admin/metrics/check-in?period=week&offset=0'],
  ],
  [
    'feedback rate of last month',
    () => admin.getFeedbackMetric('month', -1),
    ['get', '/api/v1/admin/metrics/feedback?period=month&offset=-1'],
  ],
  [
    'return rate of the current week',
    () => admin.getReturnMetric(),
    ['get', '/api/v1/admin/metrics/return?period=week&offset=0'],
  ],
  [
    'every practice, first page',
    () => admin.getAdminPractices(),
    ['get', '/api/v1/admin/practices?scope=all&limit=20&offset=0'],
  ],
  ['a practice', () => admin.getAdminPracticeDetail('p1'), ['get', '/api/v1/admin/practices/p1']],
  [
    'its Zoom attendance',
    () => admin.getAdminZoomAttendance('p1'),
    ['get', '/api/v1/admin/practices/p1/zoom-attendance'],
  ],
  [
    'inactive company promos',
    () => admin.getAdminPromos('company', false),
    ['get', '/api/v1/admin/promos?type=company&is_active=false&limit=20&offset=0'],
  ],
  [
    'deactivate a promo',
    () => admin.deactivateAdminPromo('pr1'),
    ['patch', '/api/v1/admin/promos/pr1/deactivate'],
  ],
]

beforeEach(() => {
  vi.mocked(api.get).mockReset().mockResolvedValue({})
  vi.mocked(api.post).mockReset().mockResolvedValue({})
  vi.mocked(api.patch).mockReset().mockResolvedValue({})
})

describe('api/admin.ts requests', () => {
  it.each(CASES)('%s', async (_name, call, [method, url, body]) => {
    await call()

    const args = vi.mocked(api[method]).mock.calls[0] ?? []
    expect(args[0]).toBe(url)
    if (body !== undefined) expect(args[1]).toEqual(body)
  })

  it('sends a company promo and an announcement as given', async () => {
    const promo = { code: 'WINTER', discount_percent: 25 } as Parameters<
      typeof admin.createCompanyPromo
    >[0]
    const note = { title: 'T', body: 'B', audience: 'masters' } as Parameters<
      typeof admin.sendAnnouncement
    >[0]

    await admin.createCompanyPromo(promo)
    await admin.sendAnnouncement(note)

    expect(vi.mocked(api.post).mock.calls).toEqual([
      ['/api/v1/admin/promos', promo],
      ['/api/v1/admin/announcements', note],
    ])
  })
})
