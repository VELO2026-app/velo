// =============================================================================
// VELO Frontend -- api/support.ts Unit Tests (FE-104 / FE-100)
// =============================================================================
//
// Same pattern as api/curatorGroups.test.ts: mocks @/api/client (the HTTP
// seam), calls the REAL wrappers, and asserts the exact URL, body and headers
// each one sends. The screen tests mock @/api/support entirely, so the wire
// shape of the ticket routes (BE-162 section 7) is closed here: the
// Idempotency-Key header of the form's call, the absence of a status filter
// on the admin list, the one-ticket read and the status change.
//
// createAppealKeys -- "one appeal, one key" (owner ruling FE-104) -- is pure
// and tested directly with an injected key source.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  SUPPORT_CLOSING_STATUSES,
  SUPPORT_SPAM_RETENTION_MS,
  assignTicket,
  claimSupportThread,
  createAppealKeys,
  createTicket,
  getAdminSupportMessages,
  getAdminTicket,
  listAdminTickets,
  releaseTicket,
  reopenTicket,
  retrySupportTranslation,
  sendAdminSupportReply,
  setTicketStatus,
  spamWithinRetention,
} from '@/api/support'
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

const S = '/api/v1/support'

beforeEach(() => {
  vi.mocked(api.get).mockReset().mockResolvedValue({})
  vi.mocked(api.post).mockReset().mockResolvedValue({})
})

describe('createTicket -- the form appeal', () => {
  it('POSTs {topic, body} to /support/tickets with the appeal Idempotency-Key', async () => {
    await createTicket('complaint_user', 'Текст', 'key-abc')

    expect(api.post).toHaveBeenCalledTimes(1)
    expect(api.post).toHaveBeenCalledWith(
      `${S}/tickets`,
      { topic: 'complaint_user', body: 'Текст' },
      { 'Idempotency-Key': 'key-abc' },
    )
  })

  it('the body carries exactly topic and body -- the backend forbids extra fields (422)', async () => {
    await createTicket('other', 'Текст', 'k')

    const body = vi.mocked(api.post).mock.calls[0]?.[1]
    expect(Object.keys(body as object).sort()).toEqual(['body', 'topic'])
  })
})

describe('createAppealKeys -- one appeal, one key', () => {
  function keeper() {
    let n = 0
    const mint = vi.fn(() => `k${++n}`)
    return { keyFor: createAppealKeys(mint), mint }
  }

  it('the same (topic, body) asked again gets the SAME key -- a retry is one appeal', () => {
    const { keyFor, mint } = keeper()

    expect(keyFor('payment', 'Текст')).toBe('k1')
    expect(keyFor('payment', 'Текст')).toBe('k1')
    expect(mint).toHaveBeenCalledTimes(1)
  })

  it('a changed body gets a NEW key', () => {
    const { keyFor } = keeper()

    keyFor('payment', 'Текст')
    expect(keyFor('payment', 'Текст, исправленный')).toBe('k2')
  })

  it('a changed topic gets a NEW key', () => {
    const { keyFor } = keeper()

    keyFor('payment', 'Текст')
    expect(keyFor('technical', 'Текст')).toBe('k2')
  })

  it('going back to an earlier appeal is a new key too -- only the LAST appeal is kept', () => {
    const { keyFor } = keeper()

    keyFor('payment', 'А')
    keyFor('payment', 'Б')
    expect(keyFor('payment', 'А')).toBe('k3')
  })

  it('two keepers (two form instances) never share a key', () => {
    let n = 0
    const mint = () => `k${++n}`
    const a = createAppealKeys(mint)
    const b = createAppealKeys(mint)

    expect(a('payment', 'Текст')).not.toBe(b('payment', 'Текст'))
  })

  it('the default key source yields a non-empty key', () => {
    const keyFor = createAppealKeys()

    const key = keyFor('payment', 'Текст')
    expect(typeof key).toBe('string')
    expect(key.length).toBeGreaterThan(0)
    expect(keyFor('payment', 'Текст')).toBe(key)
  })
})

describe('admin -- the ticket routes', () => {
  it('listAdminTickets sends limit only -- no status, so spam stays out by default', async () => {
    await listAdminTickets()

    expect(api.get).toHaveBeenCalledWith(`${S}/tickets?limit=20`)
  })

  it('listAdminTickets passes the cursor through', async () => {
    await listAdminTickets({ cursor: 'c2' })

    expect(api.get).toHaveBeenCalledWith(`${S}/tickets?limit=20&cursor=c2`)
  })

  it('categories go as a REPEATED `category` -- "any of these" (BE-162 fix 2)', async () => {
    await listAdminTickets({ categories: ['complaint_master', 'complaint_user'] })

    expect(api.get).toHaveBeenCalledWith(
      `${S}/tickets?limit=20&category=complaint_master&category=complaint_user`,
    )
  })

  it('an empty category list sends no `category` at all', async () => {
    await listAdminTickets({ categories: [] })

    expect(api.get).toHaveBeenCalledWith(`${S}/tickets?limit=20`)
  })

  it('status, the day bounds (URL-encoded offsets), cursor and limit all reach the URL', async () => {
    await listAdminTickets({
      categories: ['tech'],
      status: 'spam',
      createdFrom: '2026-10-20T00:00:00.000+02:00',
      createdTo: '2026-10-21T00:00:00.000+02:00',
      cursor: 'c9',
      limit: 5,
    })

    const url = vi.mocked(api.get).mock.calls[0]?.[0] ?? ''
    const qs = new URLSearchParams(url.split('?')[1])
    expect(url.startsWith(`${S}/tickets?`)).toBe(true)
    expect(qs.get('limit')).toBe('5')
    expect(qs.getAll('category')).toEqual(['tech'])
    expect(qs.get('status')).toBe('spam')
    expect(qs.get('created_from')).toBe('2026-10-20T00:00:00.000+02:00')
    expect(qs.get('created_to')).toBe('2026-10-21T00:00:00.000+02:00')
    expect(qs.get('cursor')).toBe('c9')
    // The `+` of the offset must survive the wire: raw it would read as a space.
    expect(url).toContain('created_from=2026-10-20T00%3A00%3A00.000%2B02%3A00')
  })

  it('getAdminTicket reads ONE ticket by its id', async () => {
    await getAdminTicket('t_9')

    expect(api.get).toHaveBeenCalledWith(`${S}/tickets/t_9`)
  })

  it('setTicketStatus POSTs {status} to the ticket status route', async () => {
    await setTicketStatus('t_9', 'duplicate')

    expect(api.post).toHaveBeenCalledWith(`${S}/tickets/t_9/status`, { status: 'duplicate' })
  })

  it('the closing statuses are the four the backend accepts, in the card order', () => {
    expect(SUPPORT_CLOSING_STATUSES).toEqual(['resolved', 'rejected', 'duplicate', 'spam'])
  })
})

describe('admin -- the handover routes (BE-162 delivery 2, FE-108)', () => {
  it('assignTicket POSTs {assignee} to the assign route', async () => {
    await assignTicket('t_9', 'a_1')

    expect(api.post).toHaveBeenCalledWith(`${S}/tickets/t_9/assign`, { assignee: 'a_1' })
  })

  it('the assign body carries exactly the assignee -- the backend forbids extra fields', async () => {
    await assignTicket('t_9', 'a_1')

    const body = vi.mocked(api.post).mock.calls[0]?.[1]
    expect(Object.keys(body as object)).toEqual(['assignee'])
  })

  it('releaseTicket POSTs to the release route with NO body', async () => {
    await releaseTicket('t_9')

    expect(api.post).toHaveBeenCalledWith(`${S}/tickets/t_9/release`)
  })

  it('reopenTicket POSTs to the reopen route with NO body -- «вернуть в работу» and «не спам» are one route', async () => {
    await reopenTicket('t_9')

    expect(api.post).toHaveBeenCalledWith(`${S}/tickets/t_9/reopen`)
  })
})

describe('spamWithinRetention -- «не спам» is offered while the verdict is young', () => {
  const NOW = Date.parse('2026-10-28T12:00:00Z')
  const DAY_MS = 24 * 60 * 60 * 1000

  it('the retention is the owner-ruled 30 days', () => {
    expect(SUPPORT_SPAM_RETENTION_MS).toBe(30 * DAY_MS)
  })

  it('a fresh verdict is within the retention', () => {
    expect(spamWithinRetention('2026-10-28T11:00:00Z', NOW)).toBe(true)
  })

  it('a verdict exactly 30 days old is NOT offered -- the backend refuses `<= cutoff`', () => {
    expect(spamWithinRetention('2026-09-28T12:00:00Z', NOW)).toBe(false)
  })

  it('a verdict one day past the retention is not offered', () => {
    expect(spamWithinRetention('2026-09-27T12:00:00Z', NOW)).toBe(false)
  })

  it('an unparsable date is not offered', () => {
    expect(spamWithinRetention('not a date', NOW)).toBe(false)
  })
})

describe('admin -- the thread routes keyed by the ticket id (unchanged)', () => {
  it('getAdminSupportMessages reads the feed', async () => {
    await getAdminSupportMessages('t_9')

    expect(api.get).toHaveBeenCalledWith(`${S}/threads/t_9/messages?limit=50`)
  })

  it('sendAdminSupportReply POSTs {body}', async () => {
    await sendAdminSupportReply('t_9', 'Ответ')

    expect(api.post).toHaveBeenCalledWith(`${S}/threads/t_9/messages`, { body: 'Ответ' })
  })

  it('claimSupportThread POSTs the claim', async () => {
    await claimSupportThread('t_9')

    expect(api.post).toHaveBeenCalledWith(`${S}/threads/t_9/claim`, {})
  })

  it('retrySupportTranslation POSTs to the message translation retry route (BE-166)', async () => {
    await retrySupportTranslation('t_9', 'm_3')

    expect(api.post).toHaveBeenCalledWith(`${S}/threads/t_9/messages/m_3/translation/retry`, {})
  })
})

describe('the removed routes are not called by any wrapper', () => {
  it('no wrapper reaches /support/threads without a thread id after it', async () => {
    await createTicket('payment', 'x', 'k')
    await listAdminTickets()
    await getAdminTicket('t')
    await setTicketStatus('t', 'resolved')
    await getAdminSupportMessages('t')
    await sendAdminSupportReply('t', 'x')
    await claimSupportThread('t')
    await retrySupportTranslation('t', 'm')

    const urls = [...vi.mocked(api.get).mock.calls, ...vi.mocked(api.post).mock.calls].map(
      (c) => c[0],
    )
    // "X absent" paired with "Y present and non-empty".
    expect(urls).toHaveLength(8)
    for (const url of urls) {
      expect(url).not.toMatch(/\/support\/threads(\?|\/messages|$)/)
    }
  })
})
