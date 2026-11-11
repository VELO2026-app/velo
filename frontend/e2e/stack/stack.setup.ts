/**
 * The sweep's setup project (FE-161), run once before `sweep`:
 *
 * 1. Sessions: one per seeded person, reused from `e2e/.state/tokens.json`
 *    while still valid -- the backend allows 5 logins per id per minute, and
 *    ten sweeps in a row must not hit it.
 * 2. What the seed profile cannot express, created through the API as the
 *    people themselves, idempotently (find by name first): a diary entry, a
 *    chat with the master, a support ticket, a report, cara's waitlist entry,
 *    a custom group, invite tokens.
 * 3. The ids the parameterized routes need -> `e2e/.state/params.json`
 *    (keys: e2e/sweep/routes.ts). Seeded ids are random, so they are read
 *    from the API, never hard-coded.
 */
import { randomUUID } from 'node:crypto'
import { test as setup } from '@playwright/test'
import { login } from './auth'
import { apiAs, sessionAlive } from './client'
import {
  API_URL,
  PEOPLE,
  readTokens,
  writeParams,
  writeTokens,
  type Params,
  type Person,
  type Tokens,
} from './state'

interface Listed<T> {
  items: T[]
}
interface Practice {
  id: string
  title: string
}

const TITLE = (name: string): string => `[E2E] ${name}`

/** The token after `startapp=<prefix>__` in a t.me invite link. */
function tokenFrom(link: string, prefix: string): string {
  const m = new RegExp(`startapp=${prefix}__([^&#]+)`).exec(link)
  if (!m?.[1]) throw new Error(`e2e setup: no ${prefix} token in ${link}`)
  return decodeURIComponent(m[1])
}

setup('sessions and route parameters', async () => {
  setup.setTimeout(60_000)
  const ready = await fetch(`${API_URL}/ready`).catch(() => null)
  if (!ready?.ok) {
    throw new Error(
      `e2e setup: the backend at ${API_URL} is not ready -- bring the stack up first (docs/agents/e2e.md)`,
    )
  }

  // 1. Sessions.
  const cached = readTokens()
  const tokens: Tokens = {}
  for (const person of Object.keys(PEOPLE) as Person[]) {
    const old = cached[person]
    tokens[person] = old && (await sessionAlive(old)) ? old : await login(API_URL, PEOPLE[person])
  }
  writeTokens(tokens)

  // Seeded accounts start before onboarding: the app would show Welcome
  // instead of any route. English copy, like the browser locale of the suite.
  for (const person of Object.keys(PEOPLE) as Person[]) {
    await apiAs(tokens, person)('PATCH', '/api/v1/users/me', {
      body: { onboarding_completed: true, master_onboarding_completed: true, language: 'en' },
    })
  }

  const student = apiAs(tokens, 'student')
  const master = apiAs(tokens, 'master')
  const admin = apiAs(tokens, 'admin')
  const cara = apiAs(tokens, 'cara')
  const p: Params = {}

  // 2-3. People, practices, the school.
  p.masterUserId = (await master<{ id: string }>('GET', '/api/v1/users/me')).id
  p.studentUserId = (await student<{ id: string }>('GET', '/api/v1/users/me')).id

  const practices = (
    await master<Listed<Practice>>('GET', '/api/v1/masters/me/practices?limit=100')
  ).items
  const practice = (name: string): string => {
    const found = practices.find((x) => x.title === TITLE(name))
    if (!found)
      throw new Error(`e2e setup: no seeded practice "${TITLE(name)}" -- run the e2e seed profile`)
    return found.id
  }
  p.practiceUpcomingId = practice('Tomorrow yoga')
  p.practicePastId = practice('Past breathwork')
  const fullId = practice('Full free yoga')

  const schools = (
    await master<Listed<{ id: string; name: string }>>('GET', '/api/v1/masters/me/schools')
  ).items
  const school = schools.find((s) => s.name === 'E2E School')
  if (!school) throw new Error('e2e setup: no seeded "E2E School"')
  p.schoolId = school.id
  p.schoolInviteToken = tokenFrom(
    (
      await master<{ invite_url: string }>(
        'POST',
        `/api/v1/masters/me/schools/${school.id}/invites`,
      )
    ).invite_url,
    'school',
  )

  // The diary: the seeded check-in, and a note (the seed writes none).
  p.checkinId =
    (await student<Listed<{ id: string }>>('GET', '/api/v1/users/me/checkins')).items[0]?.id ?? ''
  const notes = (await student<Listed<{ id: string }>>('GET', '/api/v1/diary')).items
  p.diaryEntryId =
    notes[0]?.id ??
    (await student<{ id: string }>('POST', '/api/v1/diary', { body: { content: 'e2e note' } })).id

  // A chat ada -> mira (create-or-get on the pair) with one message, so it is
  // listed on both sides.
  const thread = await student<{ id: string }>('POST', '/api/v1/chats', {
    body: { master_id: p.masterUserId },
  })
  p.chatThreadId = thread.id
  const listed = await master<{ threads: Array<{ id: string }> }>('GET', '/api/v1/chats?limit=100')
  if (!listed.threads.some((t) => t.id === thread.id)) {
    await student('POST', `/api/v1/chats/${thread.id}/messages`, {
      body: { body: 'e2e hello' },
      headers: { 'Idempotency-Key': randomUUID() },
    })
  }

  // A support ticket and a report, each made once.
  const tickets = await admin<{ tickets: Array<{ id: string }> }>(
    'GET',
    '/api/v1/support/tickets?limit=20',
  )
  p.supportTicketId =
    tickets.tickets[0]?.id ??
    (
      await student<{ ticket: { id: string } }>('POST', '/api/v1/support/tickets', {
        body: { topic: 'technical', body: 'e2e ticket' },
        headers: { 'Idempotency-Key': randomUUID() },
      })
    ).ticket.id
  const reports = await admin<Listed<{ id: string }>>('GET', '/api/v1/admin/reports')
  if (reports.items[0]) {
    p.reportId = reports.items[0].id
  } else {
    const made = await student<{ id?: string; report?: { id: string } }>(
      'POST',
      '/api/v1/reports',
      {
        body: { target_type: 'practice', target_id: p.practicePastId, reason: 'e2e report' },
      },
    )
    p.reportId = made.id ?? made.report?.id ?? ''
  }

  // cara on the waitlist of the full practice.
  const waiting = await cara<Listed<{ id: string; practice_id: string }>>(
    'GET',
    '/api/v1/waitlist/me?limit=100',
  )
  p.waitlistId =
    waiting.items.find((w) => w.practice_id === fullId)?.id ??
    (await cara<{ id: string }>('POST', `/api/v1/practices/${fullId}/waitlist`)).id

  // A custom group of mira's and its invite.
  const groups = await master<Listed<{ id: string; kind: string; name: string }>>(
    'GET',
    '/api/v1/masters/me/groups',
  )
  p.groupId =
    groups.items.find((g) => g.kind === 'custom' && g.name === 'E2E Group')?.id ??
    (
      await master<{ id: string }>('POST', '/api/v1/masters/me/groups', {
        body: { name: 'E2E Group' },
      })
    ).id
  p.groupInviteToken = tokenFrom(
    (await master<{ invite_url: string }>('POST', `/api/v1/masters/me/groups/${p.groupId}/invite`))
      .invite_url,
    'group_invite',
  )

  // A master invite is single-use (the screen claims it): a fresh one per run.
  p.masterInviteToken = tokenFrom(
    (await admin<{ invite_link: string }>('POST', '/api/v1/admin/masters/invite', { body: {} }))
      .invite_link,
    'master_onboarding',
  )

  const empty = Object.entries(p).filter(([, v]) => !v)
  if (empty.length) throw new Error(`e2e setup: no value for ${empty.map(([k]) => k).join(', ')}`)
  writeParams(p)
})
