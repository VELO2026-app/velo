// =============================================================================
// VELO Frontend -- api/schools.ts Unit Tests (FE-22)
// =============================================================================
//
// Same pattern as api/admin.test.ts: mocks @/api/client (the HTTP seam),
// calls the REAL wrappers, and asserts the exact URL + body each one sends.
// The risk this file closes is the one the component tests cannot see (they
// mock @/api/schools entirely) and the backend tests never reach (they
// hit HTTP directly): a wrong URL segment, a swapped body key, or -- the one
// genuinely subtle contract here -- updateSchool's three-state
// description (absent key vs null vs string), which is the difference between
// "leave the column alone" and "wipe it" on the server.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  getSchools,
  createSchool,
  updateSchool,
  deleteSchool,
  getSchoolMembers,
  removeSchoolMember,
  offerSchoolMaster,
  cancelSchoolMasterOffer,
  createSchoolInvite,
  revokeSchoolInvite,
  offerSchoolTransfer,
  cancelSchoolTransfer,
  getSchoolDeletePreview,
  getSchoolRemovePreview,
  getMySchools,
  getSchoolInvitePreview,
  joinSchool,
  getSchoolPage,
  getSchoolMasters,
  getSchoolCheckins,
  getSchoolReviews,
  getSchoolPractices,
  getSchoolStudentProfile,
  getSchoolLeavePreview,
  leaveSchool,
  acceptSchoolTransfer,
  declineSchoolTransfer,
  getSchoolJournal,
  getAdminSchools,
} from '@/api/schools'
import { api } from '@/api/client'

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>()
  return {
    ...actual,
    api: {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    },
  }
})

const G = '/api/v1/masters/me/schools'
const M = '/api/v1/schools'

beforeEach(() => {
  vi.mocked(api.get).mockReset().mockResolvedValue({})
  vi.mocked(api.post).mockReset().mockResolvedValue({})
  vi.mocked(api.patch).mockReset().mockResolvedValue({})
  vi.mocked(api.delete).mockReset().mockResolvedValue(undefined)
})

// -- URL/method table: every no-argument-or-path-only wrapper ------------------

describe.each([
  [
    'cancelSchoolMasterOffer',
    () => cancelSchoolMasterOffer('g1', 'u2'),
    'delete',
    `${G}/g1/master-offers/u2`,
  ],
  ['getSchools', getSchools, 'get', `${G}`],
  ['deleteSchool', () => deleteSchool('g1'), 'delete', `${G}/g1`],
  ['removeSchoolMember', () => removeSchoolMember('g1', 'u2'), 'delete', `${G}/g1/members/u2`],
  [
    // GT-27: two rows here used to prove the two link kinds hit two
    // different paths. One link, one path, one row.
    'revokeSchoolInvite',
    () => revokeSchoolInvite('g1'),
    'delete',
    `${G}/g1/invites`,
  ],
  ['cancelSchoolTransfer', () => cancelSchoolTransfer('g1'), 'delete', `${G}/g1/transfer`],
  ['getSchoolDeletePreview', () => getSchoolDeletePreview('g1'), 'get', `${G}/g1/delete-preview`],
  [
    'getSchoolRemovePreview',
    () => getSchoolRemovePreview('g1', 'u2'),
    'get',
    `${G}/g1/members/u2/remove-preview`,
  ],
  ['getMySchools', getMySchools, 'get', `${M}/mine`],
  [
    'getSchoolInvitePreview',
    () => getSchoolInvitePreview('tok_abc'),
    'get',
    `${M}/invites/tok_abc`,
  ],
  ['getSchoolPage', () => getSchoolPage('g1'), 'get', `${M}/g1`],
  ['getSchoolLeavePreview', () => getSchoolLeavePreview('g1'), 'get', `${M}/g1/leave-preview`],
  ['leaveSchool', () => leaveSchool('g1'), 'delete', `${M}/g1/membership`],
  ['acceptSchoolTransfer', () => acceptSchoolTransfer('g1'), 'post', `${M}/g1/transfer/accept`],
  ['declineSchoolTransfer', () => declineSchoolTransfer('g1'), 'post', `${M}/g1/transfer/decline`],
] as const)('%s hits %s %s', (_name, call, method, url) => {
  it('sends exactly one request to the right path', async () => {
    await call()

    const mock = vi.mocked(api[method])
    expect(mock).toHaveBeenCalledTimes(1)
    expect(mock.mock.calls[0]![0]).toBe(url)
  })
})

// -- Body construction ---------------------------------------------------------

describe('createSchool body', () => {
  it('omits the description key entirely when not provided', async () => {
    await createSchool('Школа')

    expect(api.post).toHaveBeenCalledWith(`${G}`, { name: 'Школа' })
  })

  it('omits the description key when blank (backend would null it anyway)', async () => {
    await createSchool('Школа', '')

    expect(api.post).toHaveBeenCalledWith(`${G}`, { name: 'Школа' })
  })

  it('carries description when provided', async () => {
    await createSchool('Школа', 'Тихие практики')

    expect(api.post).toHaveBeenCalledWith(`${G}`, {
      name: 'Школа',
      description: 'Тихие практики',
    })
  })
})

describe('updateSchool body -- the three-state description', () => {
  it('undefined: key ABSENT (rename only, description column untouched)', async () => {
    await updateSchool('g1', 'Новое имя')

    const [, body] = vi.mocked(api.patch).mock.calls[0]!
    expect(body).toEqual({ name: 'Новое имя' })
    // The distinction that matters: not `description: undefined`, but NO key.
    expect(Object.keys(body as object)).not.toContain('description')
  })

  it('null: key present as null (clear the description column)', async () => {
    await updateSchool('g1', 'Новое имя', null)

    const [, body] = vi.mocked(api.patch).mock.calls[0]!
    expect(body).toEqual({ name: 'Новое имя', description: null })
  })

  it('string: key present with the value', async () => {
    await updateSchool('g1', 'Новое имя', 'Новое описание')

    const [, body] = vi.mocked(api.patch).mock.calls[0]!
    expect(body).toEqual({ name: 'Новое имя', description: 'Новое описание' })
  })
})

// avatar_url (BE-20) is a second three-state partial alongside description --
// and the one whose ABSENT state is load-bearing: an edit sheet that always
// sent the key would wipe the picture on every plain rename.
describe('updateSchool -- avatar_url three-state (BE-20)', () => {
  it('undefined: key ABSENT (a plain rename leaves the picture alone)', async () => {
    await updateSchool('g1', 'Новое имя', 'Новое описание')

    const [, body] = vi.mocked(api.patch).mock.calls[0]!
    expect(body).toEqual({ name: 'Новое имя', description: 'Новое описание' })
    expect(Object.keys(body as object)).not.toContain('avatar_url')
  })

  it('null: key present as null (remove the avatar)', async () => {
    await updateSchool('g1', 'Новое имя', null, null)

    const [, body] = vi.mocked(api.patch).mock.calls[0]!
    expect(body).toEqual({ name: 'Новое имя', description: null, avatar_url: null })
  })

  it('string: key present with the value', async () => {
    await updateSchool('g1', 'Новое имя', undefined, 'https://cdn.example.com/a.png')

    const [, body] = vi.mocked(api.patch).mock.calls[0]!
    expect(body).toEqual({ name: 'Новое имя', avatar_url: 'https://cdn.example.com/a.png' })
    expect(Object.keys(body as object)).not.toContain('description')
  })
})

describe('invite + transfer + join bodies', () => {
  it('createSchoolInvite posts an empty body under the school path', async () => {
    // It used to post { kind } and the assertion named the kind. GT-27 left
    // one link per school, so the body carries nothing -- asserted as {},
    // not skipped: a body that quietly regrew a field would pass a looser
    // check.
    await createSchoolInvite('g1')

    expect(api.post).toHaveBeenCalledWith(`${G}/g1/invites`, {})
  })

  it('offerSchoolTransfer posts snake_case to_user_id', async () => {
    await offerSchoolTransfer('g1', 'u2')

    expect(api.post).toHaveBeenCalledWith(`${G}/g1/transfer`, { to_user_id: 'u2' })
  })

  it('offerSchoolMaster posts snake_case to_user_id (GT-27, 204)', async () => {
    await offerSchoolMaster('g1', 'u3')

    expect(api.post).toHaveBeenCalledWith(`${G}/g1/master-offers`, { to_user_id: 'u3' })
  })

  it('joinSchool posts {token} to the shared join path', async () => {
    await joinSchool('tok_abc')

    expect(api.post).toHaveBeenCalledWith(`${M}/join`, { token: 'tok_abc' })
  })
})

describe('getSchoolStudentProfile', () => {
  it('GETs the school-scoped path with no query params (BE-54)', async () => {
    await getSchoolStudentProfile('g1', 'u9')

    expect(api.get).toHaveBeenCalledWith(`${G}/g1/students/u9`)
  })
})

// -- Query construction --------------------------------------------------------

describe('getSchoolMembers query', () => {
  it('empty query: no query string at all', async () => {
    await getSchoolMembers('g1')

    expect(api.get).toHaveBeenCalledWith(`${G}/g1/members`)
  })

  it('full query: kind, search, limit, offset all present in order', async () => {
    await getSchoolMembers('g1', {
      kind: 'student',
      search: 'анна',
      limit: 50,
      offset: 0,
    })

    expect(api.get).toHaveBeenCalledWith(
      `${G}/g1/members?kind=student&search=%D0%B0%D0%BD%D0%BD%D0%B0&limit=50&offset=0`,
    )
  })

  it('partial query: only the keys that were set', async () => {
    await getSchoolMembers('g1', { kind: 'master' })

    expect(api.get).toHaveBeenCalledWith(`${G}/g1/members?kind=master`)
  })
})

describe('paginated listings default to limit=20&offset=0', () => {
  it('getSchoolMasters', async () => {
    await getSchoolMasters('g1')

    expect(api.get).toHaveBeenCalledWith(`${M}/g1/masters?limit=20&offset=0`)
  })

  it('getSchoolPractices', async () => {
    await getSchoolPractices('g1')

    expect(api.get).toHaveBeenCalledWith(`${M}/g1/practices?limit=20&offset=0`)
  })

  it('getAdminSchools', async () => {
    await getAdminSchools()

    expect(api.get).toHaveBeenCalledWith(`/api/v1/admin/schools?limit=20&offset=0`)
  })

  it('getSchoolJournal rides the CURATOR prefix (BE-19, curator-only feed)', async () => {
    await getSchoolJournal('g1')

    expect(api.get).toHaveBeenCalledWith(`${G}/g1/journal?limit=20&offset=0`)
  })

  it('explicit pagination is forwarded', async () => {
    await getSchoolMasters('g1', 5, 20)
    await getSchoolPractices('g1', 5, 20)
    await getAdminSchools(5, 20)
    await getSchoolJournal('g1', 5, 20)

    expect(api.get).toHaveBeenNthCalledWith(1, `${M}/g1/masters?limit=5&offset=20`)
    expect(api.get).toHaveBeenNthCalledWith(2, `${M}/g1/practices?limit=5&offset=20`)
    expect(api.get).toHaveBeenNthCalledWith(3, `/api/v1/admin/schools?limit=5&offset=20`)
    expect(api.get).toHaveBeenNthCalledWith(4, `${G}/g1/journal?limit=5&offset=20`)
  })
})

// -- FE-69: curator feedback feeds --------------------------------------------

describe('curator feedback feeds (FE-69)', () => {
  it('checkins: default paging, no practice filter', async () => {
    await getSchoolCheckins('g1')

    expect(api.get).toHaveBeenCalledWith(`${G}/g1/checkins?limit=20&offset=0`)
  })

  it('checkins: practice_id narrows the feed to one practice', async () => {
    await getSchoolCheckins('g1', { practiceId: 'p7' })

    expect(api.get).toHaveBeenCalledWith(`${G}/g1/checkins?practice_id=p7&limit=20&offset=0`)
  })

  it('checkins: explicit pagination is forwarded', async () => {
    await getSchoolCheckins('g1', { practiceId: 'p7', limit: 5, offset: 20 })

    expect(api.get).toHaveBeenCalledWith(`${G}/g1/checkins?practice_id=p7&limit=5&offset=20`)
  })

  it('reviews: default paging, no practice filter', async () => {
    await getSchoolReviews('g1')

    expect(api.get).toHaveBeenCalledWith(`${G}/g1/reviews?limit=20&offset=0`)
  })

  it('reviews: practice_id narrows the feed to one practice', async () => {
    await getSchoolReviews('g1', { practiceId: 'p7' })

    expect(api.get).toHaveBeenCalledWith(`${G}/g1/reviews?practice_id=p7&limit=20&offset=0`)
  })

  it('reviews: explicit pagination is forwarded', async () => {
    await getSchoolReviews('g1', { practiceId: 'p7', limit: 5, offset: 20 })

    expect(api.get).toHaveBeenCalledWith(`${G}/g1/reviews?practice_id=p7&limit=5&offset=20`)
  })
})
