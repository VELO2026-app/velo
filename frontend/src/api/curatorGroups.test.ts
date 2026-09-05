// =============================================================================
// VELO Frontend -- api/curatorGroups.ts Unit Tests (FE-22)
// =============================================================================
//
// Same pattern as api/admin.test.ts: mocks @/api/client (the HTTP seam),
// calls the REAL wrappers, and asserts the exact URL + body each one sends.
// The risk this file closes is the one the component tests cannot see (they
// mock @/api/curatorGroups entirely) and the backend tests never reach (they
// hit HTTP directly): a wrong URL segment, a swapped body key, or -- the one
// genuinely subtle contract here -- updateCuratorGroup's three-state
// description (absent key vs null vs string), which is the difference between
// "leave the column alone" and "wipe it" on the server.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  getCuratorGroups,
  createCuratorGroup,
  updateCuratorGroup,
  deleteCuratorGroup,
  getCuratorGroupMembers,
  removeCuratorGroupMember,
  createCuratorGroupInvite,
  revokeCuratorGroupInvite,
  offerCuratorGroupTransfer,
  cancelCuratorGroupTransfer,
  getCuratorGroupDeletePreview,
  getCuratorGroupRemovePreview,
  getMyCuratorGroups,
  getCuratorGroupInvitePreview,
  joinCuratorGroup,
  getCuratorGroupPage,
  getCuratorGroupMasters,
  getCuratorGroupPractices,
  getCuratorGroupLeavePreview,
  leaveCuratorGroup,
  acceptCuratorGroupTransfer,
  declineCuratorGroupTransfer,
  getCuratorGroupJournal,
  getAdminCuratorGroups,
} from '@/api/curatorGroups'
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

const G = '/api/v1/masters/me/curator-groups'
const M = '/api/v1/curator-groups'

beforeEach(() => {
  vi.mocked(api.get).mockReset().mockResolvedValue({})
  vi.mocked(api.post).mockReset().mockResolvedValue({})
  vi.mocked(api.patch).mockReset().mockResolvedValue({})
  vi.mocked(api.delete).mockReset().mockResolvedValue(undefined)
})

// -- URL/method table: every no-argument-or-path-only wrapper ------------------

describe.each([
  ['getCuratorGroups', getCuratorGroups, 'get', `${G}`],
  ['deleteCuratorGroup', () => deleteCuratorGroup('g1'), 'delete', `${G}/g1`],
  [
    'removeCuratorGroupMember',
    () => removeCuratorGroupMember('g1', 'u2'),
    'delete',
    `${G}/g1/members/u2`,
  ],
  [
    'revokeCuratorGroupInvite (master kind)',
    () => revokeCuratorGroupInvite('g1', 'master'),
    'delete',
    `${G}/g1/invites/master`,
  ],
  [
    'revokeCuratorGroupInvite (student kind)',
    () => revokeCuratorGroupInvite('g1', 'student'),
    'delete',
    `${G}/g1/invites/student`,
  ],
  [
    'cancelCuratorGroupTransfer',
    () => cancelCuratorGroupTransfer('g1'),
    'delete',
    `${G}/g1/transfer`,
  ],
  [
    'getCuratorGroupDeletePreview',
    () => getCuratorGroupDeletePreview('g1'),
    'get',
    `${G}/g1/delete-preview`,
  ],
  [
    'getCuratorGroupRemovePreview',
    () => getCuratorGroupRemovePreview('g1', 'u2'),
    'get',
    `${G}/g1/members/u2/remove-preview`,
  ],
  ['getMyCuratorGroups', getMyCuratorGroups, 'get', `${M}/mine`],
  [
    'getCuratorGroupInvitePreview',
    () => getCuratorGroupInvitePreview('tok_abc'),
    'get',
    `${M}/invites/tok_abc`,
  ],
  ['getCuratorGroupPage', () => getCuratorGroupPage('g1'), 'get', `${M}/g1`],
  [
    'getCuratorGroupLeavePreview',
    () => getCuratorGroupLeavePreview('g1'),
    'get',
    `${M}/g1/leave-preview`,
  ],
  ['leaveCuratorGroup', () => leaveCuratorGroup('g1'), 'delete', `${M}/g1/membership`],
  [
    'acceptCuratorGroupTransfer',
    () => acceptCuratorGroupTransfer('g1'),
    'post',
    `${M}/g1/transfer/accept`,
  ],
  [
    'declineCuratorGroupTransfer',
    () => declineCuratorGroupTransfer('g1'),
    'post',
    `${M}/g1/transfer/decline`,
  ],
] as const)('%s hits %s %s', (_name, call, method, url) => {
  it('sends exactly one request to the right path', async () => {
    await call()

    const mock = vi.mocked(api[method])
    expect(mock).toHaveBeenCalledTimes(1)
    expect(mock.mock.calls[0]![0]).toBe(url)
  })
})

// -- Body construction ---------------------------------------------------------

describe('createCuratorGroup body', () => {
  it('omits the description key entirely when not provided', async () => {
    await createCuratorGroup('Школа')

    expect(api.post).toHaveBeenCalledWith(`${G}`, { name: 'Школа' })
  })

  it('omits the description key when blank (backend would null it anyway)', async () => {
    await createCuratorGroup('Школа', '')

    expect(api.post).toHaveBeenCalledWith(`${G}`, { name: 'Школа' })
  })

  it('carries description when provided', async () => {
    await createCuratorGroup('Школа', 'Тихие практики')

    expect(api.post).toHaveBeenCalledWith(`${G}`, {
      name: 'Школа',
      description: 'Тихие практики',
    })
  })
})

describe('updateCuratorGroup body -- the three-state description', () => {
  it('undefined: key ABSENT (rename only, description column untouched)', async () => {
    await updateCuratorGroup('g1', 'Новое имя')

    const [, body] = vi.mocked(api.patch).mock.calls[0]!
    expect(body).toEqual({ name: 'Новое имя' })
    // The distinction that matters: not `description: undefined`, but NO key.
    expect(Object.keys(body as object)).not.toContain('description')
  })

  it('null: key present as null (clear the description column)', async () => {
    await updateCuratorGroup('g1', 'Новое имя', null)

    const [, body] = vi.mocked(api.patch).mock.calls[0]!
    expect(body).toEqual({ name: 'Новое имя', description: null })
  })

  it('string: key present with the value', async () => {
    await updateCuratorGroup('g1', 'Новое имя', 'Новое описание')

    const [, body] = vi.mocked(api.patch).mock.calls[0]!
    expect(body).toEqual({ name: 'Новое имя', description: 'Новое описание' })
  })
})

// avatar_url (BE-20) is a second three-state partial alongside description --
// and the one whose ABSENT state is load-bearing: an edit sheet that always
// sent the key would wipe the picture on every plain rename.
describe('updateCuratorGroup -- avatar_url three-state (BE-20)', () => {
  it('undefined: key ABSENT (a plain rename leaves the picture alone)', async () => {
    await updateCuratorGroup('g1', 'Новое имя', 'Новое описание')

    const [, body] = vi.mocked(api.patch).mock.calls[0]!
    expect(body).toEqual({ name: 'Новое имя', description: 'Новое описание' })
    expect(Object.keys(body as object)).not.toContain('avatar_url')
  })

  it('null: key present as null (remove the avatar)', async () => {
    await updateCuratorGroup('g1', 'Новое имя', null, null)

    const [, body] = vi.mocked(api.patch).mock.calls[0]!
    expect(body).toEqual({ name: 'Новое имя', description: null, avatar_url: null })
  })

  it('string: key present with the value', async () => {
    await updateCuratorGroup('g1', 'Новое имя', undefined, 'https://cdn.example.com/a.png')

    const [, body] = vi.mocked(api.patch).mock.calls[0]!
    expect(body).toEqual({ name: 'Новое имя', avatar_url: 'https://cdn.example.com/a.png' })
    expect(Object.keys(body as object)).not.toContain('description')
  })
})

describe('invite + transfer + join bodies', () => {
  it('createCuratorGroupInvite posts {kind} under the group path', async () => {
    await createCuratorGroupInvite('g1', 'master')

    expect(api.post).toHaveBeenCalledWith(`${G}/g1/invites`, { kind: 'master' })
  })

  it('offerCuratorGroupTransfer posts snake_case to_user_id', async () => {
    await offerCuratorGroupTransfer('g1', 'u2')

    expect(api.post).toHaveBeenCalledWith(`${G}/g1/transfer`, { to_user_id: 'u2' })
  })

  it('joinCuratorGroup posts {token} to the shared join path', async () => {
    await joinCuratorGroup('tok_abc')

    expect(api.post).toHaveBeenCalledWith(`${M}/join`, { token: 'tok_abc' })
  })
})

// -- Query construction --------------------------------------------------------

describe('getCuratorGroupMembers query', () => {
  it('empty query: no query string at all', async () => {
    await getCuratorGroupMembers('g1')

    expect(api.get).toHaveBeenCalledWith(`${G}/g1/members`)
  })

  it('full query: kind, search, limit, offset all present in order', async () => {
    await getCuratorGroupMembers('g1', {
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
    await getCuratorGroupMembers('g1', { kind: 'master' })

    expect(api.get).toHaveBeenCalledWith(`${G}/g1/members?kind=master`)
  })
})

describe('paginated listings default to limit=20&offset=0', () => {
  it('getCuratorGroupMasters', async () => {
    await getCuratorGroupMasters('g1')

    expect(api.get).toHaveBeenCalledWith(`${M}/g1/masters?limit=20&offset=0`)
  })

  it('getCuratorGroupPractices', async () => {
    await getCuratorGroupPractices('g1')

    expect(api.get).toHaveBeenCalledWith(`${M}/g1/practices?limit=20&offset=0`)
  })

  it('getAdminCuratorGroups', async () => {
    await getAdminCuratorGroups()

    expect(api.get).toHaveBeenCalledWith(`/api/v1/admin/curator-groups?limit=20&offset=0`)
  })

  it('getCuratorGroupJournal rides the CURATOR prefix (BE-19, curator-only feed)', async () => {
    await getCuratorGroupJournal('g1')

    expect(api.get).toHaveBeenCalledWith(`${G}/g1/journal?limit=20&offset=0`)
  })

  it('explicit pagination is forwarded', async () => {
    await getCuratorGroupMasters('g1', 5, 20)
    await getCuratorGroupPractices('g1', 5, 20)
    await getAdminCuratorGroups(5, 20)
    await getCuratorGroupJournal('g1', 5, 20)

    expect(api.get).toHaveBeenNthCalledWith(1, `${M}/g1/masters?limit=5&offset=20`)
    expect(api.get).toHaveBeenNthCalledWith(2, `${M}/g1/practices?limit=5&offset=20`)
    expect(api.get).toHaveBeenNthCalledWith(3, `/api/v1/admin/curator-groups?limit=5&offset=20`)
    expect(api.get).toHaveBeenNthCalledWith(4, `${G}/g1/journal?limit=5&offset=20`)
  })
})
