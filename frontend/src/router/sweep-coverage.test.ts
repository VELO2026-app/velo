import { describe, expect, it } from 'vitest'
import router from '@/router'
import { SWEEP } from '../../e2e/sweep/routes'

// =============================================================================
// VELO Frontend -- the e2e sweep covers every route (FE-161)
// =============================================================================
//
// The sweep (frontend/e2e/sweep/) opens every named route of the router under
// the roles its table lists. This test is what keeps the table whole: a new
// screen without a row fails here, in the fast gate, long before anyone runs
// the sweep. A row either visits the route or skips it WITH a reason.
// =============================================================================

const named = router
  .getRoutes()
  .filter((r) => typeof r.name === 'string')
  .map((r) => ({ name: r.name as string, path: r.path }))

describe('e2e sweep table (e2e/sweep/routes.ts)', () => {
  it('has a row for every named route', () => {
    const missing = named.filter((r) => !(r.name in SWEEP)).map((r) => `${r.name} ${r.path}`)
    expect(missing, 'add these routes to e2e/sweep/routes.ts (visit or skip)').toEqual([])
  })

  it('has no row for a route that is gone', () => {
    const names = new Set(named.map((r) => r.name))
    expect(Object.keys(SWEEP).filter((n) => !names.has(n))).toEqual([])
  })

  it.each(named)('$name: the row path is the router path', ({ name, path }) => {
    expect(SWEEP[name]?.path).toBe(path)
  })

  it.each(Object.entries(SWEEP))(
    '%s: a skip has a reason, a visit has roles and every parameter',
    (name, row) => {
      if ('skip' in row) {
        expect(row.skip.trim().length, `${name}: skip without a reason`).toBeGreaterThan(10)
        return
      }
      expect(row.roles.length).toBeGreaterThan(0)
      const declared = [...row.path.matchAll(/:(\w+)/g)].map((m) => m[1])
      expect(Object.keys(row.params ?? {}).sort()).toEqual(declared.sort())
    },
  )
})
