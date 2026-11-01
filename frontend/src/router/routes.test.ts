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
  it('user-calendar-school resolves with :schoolId', () => {
    const r = router.resolve({ name: 'user-calendar-school', params: { schoolId: 'g1' } })
    expect(r.href).toBe('/user/calendar/school/g1')
    expect(r.name).toBe('user-calendar-school')
  })

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

  it('payments routes resolve', () => {
    expect(router.resolve({ name: 'user-topup' }).href).toBe('/user/topup')
    expect(router.resolve({ name: 'user-topup-success' }).href).toBe('/user/topup/success')
    expect(router.resolve({ name: 'user-topup-cancel' }).href).toBe('/user/topup/cancel')
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

  // Owner (no legacy): a bookmark to a former school address is no route --
  // it falls to the catch-all, which redirects to the 404 screen.
  it.each(['/user/groups', '/user/groups/g1'])(
    'the former address %s lands on the catch-all',
    (path) => {
      const r = router.resolve(path)
      expect(r.matched.at(-1)?.path).toBe('/:pathMatch(.*)*')
    },
  )
})
