// =============================================================================
// VELO Frontend -- api/masters.ts Unit Tests
// =============================================================================
//
// Same pattern as api/schools.test.ts: mock @/api/client (the HTTP seam), call
// the REAL wrappers, assert the exact method, URL and body each one sends. The
// screens' tests mock @/api/masters entirely and the backend's tests hit HTTP
// directly, so a wrong path segment, a dropped query key or a swapped body key
// is invisible to both. Two contracts matter beyond the table:
//   - the analytics and income wrappers send the period AS GIVEN (the screen's
//     slider has three values, `quarter` included: the backend takes it on both);
//   - getMasterReviews sends `attention` only when it is true: an absent key is
//     the whole feed, `attention=false` is a different request.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  applyMaster,
  claimMasterInvite,
  createWithdrawal,
  deletePayout,
  getIncome,
  getMasterAnalytics,
  getMasterReviews,
  getMasterStats,
  getMyMasterProfile,
  getMyPractices,
  getMyWithdrawals,
  getPublicMaster,
  getStudent,
  getStudents,
  getTransactions,
  submitMethodChangeRequest,
  updateMasterLanguages,
  updatePayoutDetails,
  withdrawMasterApplication,
} from '@/api/masters'
import { api } from '@/api/client'
import type { MasterApplyRequest, PayoutDetails } from '@/api/types'

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>()
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
  }
})

const B = '/api/v1/masters'

beforeEach(() => {
  vi.mocked(api.get).mockReset().mockResolvedValue({})
  vi.mocked(api.post).mockReset().mockResolvedValue({})
  vi.mocked(api.patch).mockReset().mockResolvedValue({})
  vi.mocked(api.delete).mockReset().mockResolvedValue(undefined)
})

describe.each([
  ['getMyMasterProfile', () => getMyMasterProfile(), 'get', `${B}/me`],
  ['getPublicMaster', () => getPublicMaster('u1'), 'get', `${B}/u1`],
  ['getStudent', () => getStudent('s1'), 'get', `${B}/me/students/s1`],
  ['getStudents', () => getStudents(), 'get', `${B}/me/students?limit=50&offset=0`],
  ['getMyWithdrawals', () => getMyWithdrawals(), 'get', `${B}/me/withdrawals?limit=20&offset=0`],
  ['getTransactions', () => getTransactions(), 'get', `${B}/me/transactions?limit=20&offset=0`],
  [
    'getMyPractices',
    () => getMyPractices('past', 10, 20),
    'get',
    `${B}/me/practices?bucket=past&limit=10&offset=20`,
  ],
  ['getMasterStats', () => getMasterStats('month'), 'get', `${B}/me/stats?period=month`],
  ['withdrawMasterApplication', () => withdrawMasterApplication(), 'delete', `${B}/me/application`],
  ['deletePayout', () => deletePayout(), 'delete', `${B}/me/payout`],
] as const)('%s', (_name, call, method, url) => {
  it(`${method.toUpperCase()}s ${url}`, async () => {
    await call()
    expect(vi.mocked(api[method])).toHaveBeenCalledWith(url)
  })
})

describe('bodies', () => {
  it('applyMaster posts the application as given', async () => {
    const body = { methods: ['yoga'] } as unknown as MasterApplyRequest
    await applyMaster(body)
    expect(api.post).toHaveBeenCalledWith(`${B}/apply`, body)
  })

  it('claimMasterInvite wraps the token', async () => {
    await claimMasterInvite('tok')
    expect(api.post).toHaveBeenCalledWith(`${B}/invite/claim`, { token: 'tok' })
  })

  it('updateMasterLanguages patches the list under `languages`', async () => {
    await updateMasterLanguages(['ru', 'en'])
    expect(api.patch).toHaveBeenCalledWith(`${B}/me/languages`, { languages: ['ru', 'en'] })
  })

  it('updatePayoutDetails patches the details as given', async () => {
    const body = { method: 'iban' } as unknown as PayoutDetails
    await updatePayoutDetails(body)
    expect(api.patch).toHaveBeenCalledWith(`${B}/me/payout`, body)
  })

  it('createWithdrawal posts the amount in cents', async () => {
    await createWithdrawal(1500)
    expect(api.post).toHaveBeenCalledWith(`${B}/me/withdraw`, { amount_cents: 1500 })
  })

  it('submitMethodChangeRequest posts the proposed methods', async () => {
    await submitMethodChangeRequest(['yoga'])
    expect(api.post).toHaveBeenCalledWith(`${B}/me/method-change-request`, {
      proposed_methods: ['yoga'],
    })
  })
})

describe('the period, as given', () => {
  it.each(['week', 'month', 'quarter'] as const)('getMasterAnalytics sends %s', async (period) => {
    await getMasterAnalytics(period)
    expect(api.get).toHaveBeenCalledWith(`${B}/me/analytics?period=${period}`)
  })

  it('getMasterAnalytics asks for the week by default', async () => {
    await getMasterAnalytics()
    expect(api.get).toHaveBeenCalledWith(`${B}/me/analytics?period=week`)
  })

  it.each(['week', 'month', 'quarter'] as const)('getIncome sends %s', async (period) => {
    await getIncome(period)
    expect(api.get).toHaveBeenCalledWith(`${B}/me/income?period=${period}`)
  })

  it('getIncome asks for the week by default', async () => {
    await getIncome()
    expect(api.get).toHaveBeenCalledWith(`${B}/me/income?period=week`)
  })
})

describe('getMasterReviews', () => {
  it('leaves `attention` out unless it is true', async () => {
    await getMasterReviews(20, 0)
    expect(api.get).toHaveBeenCalledWith(`${B}/me/reviews?limit=20&offset=0`)
  })

  it('sends attention=true for the needs-attention feed', async () => {
    await getMasterReviews(20, 0, true)
    expect(api.get).toHaveBeenCalledWith(`${B}/me/reviews?limit=20&offset=0&attention=true`)
  })

  it.each(['week', 'month', 'quarter'] as const)(
    'sends period=%s and leaves the page size to the server (BE-228)',
    async (period) => {
      await getMasterReviews(undefined, 0, true, period)
      expect(api.get).toHaveBeenCalledWith(
        `${B}/me/reviews?offset=0&attention=true&period=${period}`,
      )
    },
  )
})
