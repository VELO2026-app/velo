import { describe, it, expect } from 'vitest'
import router from '@/router'

// =============================================================================
// VELO Frontend -- Route Table Tests (navigation contracts pinned by name)
// =============================================================================
//
// Screen tests mock vue-router, so a pushed { name, params } shape is only
// checked for CALL SHAPE there -- a renamed route param (or a dropped route)
// passes every mocked-router screen test and still fails to navigate in the
// real app: "Missing required param" rejects under `void router.push` and the
// tap silently does nothing. These tests resolve the REAL route table, so
// name/param drift fails here. (Born from exactly that failure: the school
// page pushed user-calendar-school with :id while the route wanted its
// school param.)
// =============================================================================

describe('route table: stacked calendars resolve by name + params', () => {
  it('user-calendar-master resolves with :masterId', () => {
    const r = router.resolve({ name: 'user-calendar-master', params: { masterId: 'm1' } })
    expect(r.href).toBe('/user/calendar/master/m1')
  })
})

describe('route table: the school analytics screen (§6 MVP) resolves by name + params', () => {
  // FE-93: the user-zone twin is gone -- the analytics screen mounts in the
  // master zone only.
  it('master-school-analytics resolves with :id', () => {
    const r = router.resolve({ name: 'master-school-analytics', params: { id: 'g1' } })
    expect(r.name).toBe('master-school-analytics')
  })
})

describe('route table: module gates resolve in the golden build (tz-whitelabel §4)', () => {
  // The suite builds with no VITE_FEATURES -- every module on. A gate that
  // dropped routes by default fails here; the «chunks absent» side of the
  // contract is proven by the build matrix (F5), not by unit tests.
  it('ai routes resolve', () => {
    expect(router.resolve({ name: 'user-ai-summary' }).href).toBe('/user/ai-summary')
    expect(router.resolve({ name: 'user-ai-connections' }).href).toBe(
      '/user/profile/ai-connections',
    )
  })

  it('payments routes resolve in every zone', () => {
    expect(router.resolve({ name: 'user-topup' }).href).toBe('/user/topup')
    expect(router.resolve({ name: 'user-topup-success' }).href).toBe('/user/topup/success')
    expect(router.resolve({ name: 'user-topup-cancel' }).href).toBe('/user/topup/cancel')
    // FE-112, FE-151: the master's finance screen and the console's finance
    // module (FE-272: at /admin) are the payments option's surfaces -- always registered (variant
    // A); the option's off side is meta.option (the table below).
    expect(router.resolve({ name: 'master-finance' }).href).toBe('/master/finance')
    expect(router.resolve({ name: 'console-finance' }).href).toBe('/admin/finance')
  })
})

describe('route table: instance options (FE-151, meta.option)', () => {
  // Every record of an option's section, pinned: a new screen of a section
  // that forgets meta.option stays reachable on an instance where the
  // backend has closed its API -- add it here deliberately.
  it('the option records are exactly these', () => {
    const tagged = Object.fromEntries(
      router
        .getRoutes()
        .filter((r) => r.meta.option !== undefined && r.name !== undefined)
        .map((r) => [String(r.name), r.meta.option]),
    )
    expect(tagged).toEqual({
      'user-topup': 'payments',
      'user-topup-success': 'payments',
      'user-topup-cancel': 'payments',
      'master-finance': 'payments',
      'master-promocodes': 'payments',
      'master-promocode-new': 'payments',
      'console-finance': 'payments',
      'user-calendar-school': 'schools',
      'user-my-schools': 'schools',
      'user-schools': 'schools',
      'user-school': 'schools',
      'master-schools': 'schools',
      'master-school-create': 'schools',
      'master-school': 'schools',
      'master-school-members': 'schools',
      'master-school-analytics': 'schools',
      'master-school-student': 'schools',
      'console-schools': 'schools',
      'school-join': 'schools',
      'school-master-offer': 'schools',
      'user-ai-connections': 'mcp',
    })
  })
})

describe('route table: school pages by name + the param keys their builders push', () => {
  // Step 3 of the school rename: the user-zone school pages and both school
  // params moved off the word «group». Each row is the exact { name, params }
  // shape a screen builds (SchoolPageView, SchoolMembersView, UserProfileView,
  // practice-analytics) -- a param key that drifts from the route table makes
  // resolve() throw here instead of a silent no-op tap in the app.
  it.each([
    ['user-my-schools', {}, '/user/my-schools'],
    ['user-school', { id: 'g1' }, '/user/schools/g1'],
    ['user-calendar-school', { schoolId: 'g1' }, '/user/calendar/school/g1'],
    ['master-school-student', { schoolId: 'g1', userId: 'u1' }, '/master/schools/g1/students/u1'],
  ] as const)('%s -> %s', (name, params, href) => {
    expect(router.resolve({ name, params }).href).toBe(href)
  })
})

describe('route table: access requirements (meta.requires, router/guards.ts)', () => {
  // The declared records: getRoutes() would also list a shell's '' redirect
  // child under the shell's own path.
  const record = (path: string) => router.options.routes.find((r) => r.path === path)

  it('the zone shells require their role', () => {
    expect(record('/master')?.meta?.requires).toBe('master-role')
    expect(record('/admin')?.meta?.requires).toBe('admin-role')
  })

  // Every MasterShell child is classified here on purpose: a new master
  // screen fails this table until someone decides whether a pending master
  // may open it. These were the 21 `beforeEnter: masterStatusGuard` routes
  // and the dashboard's masterNoProfileGuard before FE-157.
  it('every master shell child declares its requirement, or deliberately none', () => {
    const children = record('/master')?.children ?? []
    const table = Object.fromEntries(
      children
        .filter((child) => child.name)
        .map((child) => [child.name, child.meta?.requires ?? null]),
    )
    const verified = [
      'master-practices',
      'master-practice-new',
      'master-practice-edit',
      'master-practice-live',
      'master-attendance',
      'master-practice-detail',
      'master-attendance-roster',
      'master-practice-reviews',
      'master-finance',
      'master-students',
      'master-student-profile',
      'master-groups',
      'master-group-create',
      'master-group-detail',
      'master-schools',
      'master-school-create',
      'master-school',
      'master-school-members',
      'master-school-analytics',
      'master-school-student',
      'master-summary',
    ]
    const open = [
      'master-inbox',
      'master-analytics',
      'master-profile',
      'master-edit-profile',
      'master-notifications',
      'master-timezone',
      'master-support',
      'master-messages',
      'master-chat',
      'master-promocodes',
      'master-promocode-new',
    ]
    expect(verified).toHaveLength(21)
    expect(table).toEqual({
      'master-dashboard': 'master-application',
      ...Object.fromEntries(verified.map((name) => [name, 'verified-master'])),
      ...Object.fromEntries(open.map((name) => [name, null])),
    })
  })

  it('no record outside the master, admin and console shells declares a requirement', () => {
    const outside = router
      .getRoutes()
      .filter((r) => r.meta.requires && !/^\/(master|admin|console)(\/|$)/.test(r.path))
      .map((r) => r.path)
    expect(outside).toEqual([])
    // The standalone master landings keep their own beforeEnter policies.
    for (const path of ['/master/apply', '/master/invite/:token', '/master/pending']) {
      expect(record(path)?.meta?.requires, path).toBeUndefined()
      expect(record(path)?.beforeEnter, path).toBeTypeOf('function')
    }
  })
})

describe('route table: the console at /admin answers the old addresses (FE-272)', () => {
  // Bot deep links, bookmarks and old notifications name the mobile admin's
  // addresses and the console's first one (/console); each lands on the
  // console screen that does the same job.
  it.each([
    ['/admin/support/t1', 'console-support', { ticket: 't1' }],
    ['/admin/support/stats', 'console-support', { tab: 'stats' }],
    ['/admin/reports', 'console-support', {}],
    ['/admin/reports?tab=complaints', 'console-moderation', { tab: 'complaints' }],
    ['/admin/reports/r1', 'console-moderation', { tab: 'complaints', id: 'r1' }],
    ['/admin/method-requests', 'console-moderation', { tab: 'methods' }],
    ['/admin/withdrawals', 'console-finance', { tab: 'withdrawals' }],
    ['/admin/withdrawals/w1', 'console-finance', { tab: 'withdrawals' }],
    ['/admin/promos', 'console-finance', { tab: 'promos' }],
    ['/admin/revenue', 'console-finance', {}],
    ['/admin/metrics/check-in', 'console-analytics', { metric: 'checkin' }],
    ['/admin/participants', 'console-users', { tab: 'user' }],
    ['/admin/masters/invite', 'console-masters', {}],
    ['/admin/profile', 'console-dashboard', {}],
    ['/admin', 'console-dashboard', {}],
  ])('%s -> %s', async (from, name, query) => {
    const landed = await resolveRedirects(from)

    expect(landed.name).toBe(name)
    expect(landed.query).toEqual(query)
  })

  it('/console/* goes to the same screen under /admin, with its query', async () => {
    const landed = await resolveRedirects('/console/masters/m1?x=1')

    expect(landed.fullPath).toBe('/admin/masters/m1?x=1')
    expect(landed.name).toBe('console-masters-detail')
  })
})

/** Follow a location's record redirects the way the router does, without navigating. */
async function resolveRedirects(path: string): Promise<ReturnType<typeof router.resolve>> {
  let current = router.resolve(path)
  for (let hops = 0; hops < 5; hops++) {
    const record = current.matched.at(-1)
    if (!record?.redirect) return current
    const next =
      typeof record.redirect === 'function'
        ? record.redirect(current as never, current as never)
        : record.redirect
    current = router.resolve(next as Parameters<typeof router.resolve>[0])
  }
  return current
}
