// =============================================================================
// VELO Frontend -- api/admin.ts Unit Tests: the promote/master_only seam
// =============================================================================
//
// B13 (Batch B, PROMPT №579): the promote (add-to-catalog) seam had thorough
// coverage on BOTH ends -- ConsoleMasterDetailView.test.ts / ConsoleModerationView.test.ts
// assert the COMPONENT calls verifyMaster/approveMethodChange with the
// right (promote, masterOnly) args (but mock @/api/admin entirely, so the
// actual body-construction logic below is never exercised); backend's
// test_admin_masters.py / test_master_method_change.py hit the real HTTP
// endpoint with a hand-written `json={"promote": [...]}` body and assert the
// catalog row lands (but never go through this file at all). The api CLIENT
// FUNCTIONS themselves -- verifyMaster/approveMethodChange's own
// `if (x && x.length) body.x = x` conditional-omission logic, the thing that
// turns component args into the JSON body the backend actually receives --
// had ZERO direct test coverage. A bug here (wrong key name, always-sent
// empty array instead of omitted, swapped promote/master_only) would have
// sailed through the entire existing suite undetected on both sides.
//
// This file closes that specific gap: mocks @/api/client (the actual HTTP
// seam, same pattern as api/bookings.test.ts), calls the REAL verifyMaster/
// approveMethodChange, and asserts the exact body shape sent -- the missing
// middle link between the component tests' asserted args and the backend
// tests' asserted JSON body.
//
// THE REQUEST TABLE (FE-272): the console's screens mock @/api/admin whole,
// so a wrong path, method or query name in a wrapper would pass every screen
// test. The table pins the request each wrapper sends -- method, URL with its
// query, body -- against the backend's routers
// (backend/app/modules/admin/**/router.py).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as admin from '@/api/admin'
import { verifyMaster, approveMethodChange, setMasterSchoolRight } from '@/api/admin'
import type { AnnouncementRequest } from '@/api/admin'
import type { CreateCompanyPromoRequest } from '@/api/generated'
import { api } from '@/api/client'

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>()
  return {
    ...actual,
    api: {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
  }
})

beforeEach(() => {
  vi.mocked(api.post).mockReset().mockResolvedValue({ user_id: 'm_1', status: 'ok' })
  vi.mocked(api.patch).mockReset().mockResolvedValue({ user_id: 'm_1', can_create_schools: true })
})

describe.each([
  ['verifyMaster', verifyMaster, '/api/v1/admin/masters/m_1/verify'],
  [
    'approveMethodChange',
    approveMethodChange,
    '/api/v1/admin/masters/m_1/method-change-request/approve',
  ],
] as const)('%s -- promote/master_only body construction', (_name, fn, url) => {
  it('neither arg provided: POSTs an empty body -- no promote, no master_only key at all', async () => {
    await fn('m_1')

    expect(api.post).toHaveBeenCalledWith(url, {})
  })

  it('promote only: body carries ONLY promote, master_only key absent (not undefined-valued, ABSENT)', async () => {
    await fn('m_1', ['Новое направление'])

    const [, body] = vi.mocked(api.post).mock.calls[0] ?? []
    expect(body).toEqual({ promote: ['Новое направление'] })
    expect(Object.keys(body as object)).not.toContain('master_only')
  })

  it('master_only only: body carries ONLY master_only, promote key absent', async () => {
    await fn('m_1', undefined, ['Личный вариант'])

    const [, body] = vi.mocked(api.post).mock.calls[0] ?? []
    expect(body).toEqual({ master_only: ['Личный вариант'] })
    expect(Object.keys(body as object)).not.toContain('promote')
  })

  it('both provided together: body carries BOTH, independently -- the two branches do not clobber each other', async () => {
    await fn('m_1', ['Глобальный вариант'], ['Личный вариант'])

    expect(api.post).toHaveBeenCalledWith(url, {
      promote: ['Глобальный вариант'],
      master_only: ['Личный вариант'],
    })
  })

  it('an EMPTY array for either arg is treated as absent (omitted from the body), not sent as []', async () => {
    await fn('m_1', [], [])

    expect(api.post).toHaveBeenCalledWith(url, {})
  })
})

// -- BE-18: the school-founding right seam ------------------------------

describe('verifyMaster -- can_create_schools body construction (BE-18)', () => {
  it('absent/false: the key is NOT sent (backend default no -- nothing written)', async () => {
    await verifyMaster('m_1')
    await verifyMaster('m_1', undefined, undefined, false)

    for (const call of vi.mocked(api.post).mock.calls) {
      expect(Object.keys(call[1] as object)).not.toContain('can_create_schools')
    }
  })

  it('true: sent as can_create_schools alongside the promote keys', async () => {
    await verifyMaster('m_1', ['Новое направление'], undefined, true)

    expect(api.post).toHaveBeenCalledWith('/api/v1/admin/masters/m_1/verify', {
      promote: ['Новое направление'],
      can_create_schools: true,
    })
  })

  it('true alone: a bare { can_create_schools: true } body', async () => {
    await verifyMaster('m_1', undefined, undefined, true)

    expect(api.post).toHaveBeenCalledWith('/api/v1/admin/masters/m_1/verify', {
      can_create_schools: true,
    })
  })
})

describe('setMasterSchoolRight (BE-18) -- PATCH /admin/masters/{id}/can-create-schools', () => {
  it('PATCHes the boolean as { can_create_schools } and resolves the right, after', async () => {
    await setMasterSchoolRight('m_1', false)
    expect(api.patch).toHaveBeenCalledWith('/api/v1/admin/masters/m_1/can-create-schools', {
      can_create_schools: false,
    })
  })

  it('the grant direction is the same one write', async () => {
    await setMasterSchoolRight('m_1', true)

    expect(api.patch).toHaveBeenCalledWith('/api/v1/admin/masters/m_1/can-create-schools', {
      can_create_schools: true,
    })
  })
})

type Call = () => unknown
type Sent = [method: 'get' | 'post' | 'patch', url: string, ...body: unknown[]]

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

describe('api/admin.ts requests', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset().mockResolvedValue({})
  })

  it.each(CASES)('%s', async (_name, call, [method, url, ...body]) => {
    await call()

    expect(api[method]).toHaveBeenCalledWith(url, ...body)
  })

  it('sends a company promo and an announcement as given', async () => {
    const promo: CreateCompanyPromoRequest = { code: 'WINTER', discount_percent: 25 }
    const note: AnnouncementRequest = { title: 'T', body: 'B', audience: 'masters' }

    await admin.createCompanyPromo(promo)
    await admin.sendAnnouncement(note)

    expect(vi.mocked(api.post).mock.calls).toEqual([
      ['/api/v1/admin/promos', promo],
      ['/api/v1/admin/announcements', note],
    ])
  })
})
