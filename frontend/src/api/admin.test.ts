// =============================================================================
// VELO Frontend -- api/admin.ts Unit Tests: the promote/master_only seam
// =============================================================================
//
// B13 (Батч B, PROMPT №579): the promote (add-to-catalog) seam had thorough
// coverage on BOTH ends -- AdminMasterReviewView.test.ts / AdminMethodRequestsView.
// test.ts assert the COMPONENT calls verifyMaster/approveMethodChange with the
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
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { verifyMaster, approveMethodChange, setMasterGroupRight } from '@/api/admin'
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
  vi.mocked(api.patch).mockReset().mockResolvedValue({ user_id: 'm_1', can_create_groups: true })
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

    const [, body] = vi.mocked(api.post).mock.calls[0]!
    expect(body).toEqual({ promote: ['Новое направление'] })
    expect(Object.keys(body as object)).not.toContain('master_only')
  })

  it('master_only only: body carries ONLY master_only, promote key absent', async () => {
    await fn('m_1', undefined, ['Личный вариант'])

    const [, body] = vi.mocked(api.post).mock.calls[0]!
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

  it('resolves with the backend response', async () => {
    const response = { user_id: 'm_1', status: 'ok' as const }
    vi.mocked(api.post).mockResolvedValue(response)

    await expect(fn('m_1', ['X'])).resolves.toEqual(response)
  })
})

// -- BE-18: the school-founding right seam ------------------------------

describe('verifyMaster -- can_create_groups body construction (BE-18)', () => {
  it('absent/false: the key is NOT sent (backend default no -- nothing written)', async () => {
    await verifyMaster('m_1')
    await verifyMaster('m_1', undefined, undefined, false)

    for (const call of vi.mocked(api.post).mock.calls) {
      expect(Object.keys(call[1] as object)).not.toContain('can_create_groups')
    }
  })

  it('true: sent as can_create_groups alongside the promote keys', async () => {
    await verifyMaster('m_1', ['Новое направление'], undefined, true)

    expect(api.post).toHaveBeenCalledWith('/api/v1/admin/masters/m_1/verify', {
      promote: ['Новое направление'],
      can_create_groups: true,
    })
  })

  it('true alone: a bare { can_create_groups: true } body', async () => {
    await verifyMaster('m_1', undefined, undefined, true)

    expect(api.post).toHaveBeenCalledWith('/api/v1/admin/masters/m_1/verify', {
      can_create_groups: true,
    })
  })
})

describe('setMasterGroupRight (BE-18) -- PATCH /admin/masters/{id}/can-create-groups', () => {
  it('PATCHes the boolean as { can_create_groups } and resolves the right, after', async () => {
    const response = { user_id: 'm_1', can_create_groups: false }
    vi.mocked(api.patch).mockResolvedValue(response)

    await expect(setMasterGroupRight('m_1', false)).resolves.toEqual(response)
    expect(api.patch).toHaveBeenCalledWith('/api/v1/admin/masters/m_1/can-create-groups', {
      can_create_groups: false,
    })
  })

  it('the grant direction is the same one write', async () => {
    await setMasterGroupRight('m_1', true)

    expect(api.patch).toHaveBeenCalledWith('/api/v1/admin/masters/m_1/can-create-groups', {
      can_create_groups: true,
    })
  })
})
