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
// page pushed user-calendar-school with :id while the route wanted :groupId.)
// =============================================================================

describe('route table: stacked calendars resolve by name + params', () => {
  it('user-calendar-school resolves with :groupId', () => {
    const r = router.resolve({ name: 'user-calendar-school', params: { groupId: 'g1' } })
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
  it('master-curator-group-analytics resolves with :id', () => {
    const r = router.resolve({ name: 'master-curator-group-analytics', params: { id: 'g1' } })
    expect(r.name).toBe('master-curator-group-analytics')
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
