import { describe, expect, it, vi } from 'vitest'
import {
  FEATURE_NAMES,
  editionFlags,
  featureDefineMap,
  featureEnabled,
  featureFlags,
  resolveFeatureFlags,
  type EditionTable,
} from '@/platform/features'

describe('feature registry (tz-whitelabel §4)', () => {
  it('absent/empty/full turns every module on -- the golden build', () => {
    for (const value of [undefined, '', '   ', 'full']) {
      expect(featureFlags(value)).toEqual({ ai: true, payments: true })
    }
  })

  it('a comma list turns on exactly the named known modules', () => {
    expect(featureFlags('payments')).toEqual({ ai: false, payments: true })
    expect(featureFlags(' ai , payments ')).toEqual({ ai: true, payments: true })
  })

  it('unknown names never enable a module', () => {
    expect(featureFlags('schools')).toEqual({ ai: false, payments: false })
    expect(featureFlags('schools,full')).toEqual({ ai: false, payments: false })
  })

  it('the namespace list pins both modules', () => {
    expect(FEATURE_NAMES).toEqual(['ai', 'payments'])
  })

  it('featureEnabled reads the live env (stub-able in tests)', () => {
    // No stub here: the suite env has no VITE_FEATURES -> golden default.
    // vitest.config pins __VELO_FEATURE_FLAGS__ away, so this exercises the
    // fallback branch of the FE-130 accessor.
    expect(featureEnabled('ai')).toBe(true)
    expect(featureEnabled('payments')).toBe(true)
  })
})

// The table as editions.json ships it (schema 1); trimmed here to what the
// registry consumes.
const TABLE: EditionTable = {
  schema: 1,
  editions: {
    core: { modules: [] },
    school: { modules: [] },
    'school-payments': { modules: ['payments'] },
    full: { modules: ['ai', 'payments'] },
  },
}

describe('edition channel (FE-130: PRIMER_EDITION -> editions.json)', () => {
  it('the table answers the module set per edition', () => {
    expect(editionFlags('core', TABLE)).toEqual({ ai: false, payments: false })
    expect(editionFlags('school', TABLE)).toEqual({ ai: false, payments: false })
    expect(editionFlags('school-payments', TABLE)).toEqual({ ai: false, payments: true })
    expect(editionFlags('full', TABLE)).toEqual({ ai: true, payments: true })
  })

  it('module names outside FEATURE_NAMES are ignored (backend superset)', () => {
    const table: EditionTable = {
      schema: 1,
      editions: { school: { modules: ['payments', 'zoom', 'diary'] } },
    }
    expect(editionFlags('school', table)).toEqual({ ai: false, payments: true })
  })

  it('an unknown edition fails LOUDLY (repo/passport desync must be red)', () => {
    expect(() => editionFlags('elite', TABLE)).toThrow(/editions\.json/)
  })

  it('the edition channel wins over the legacy VITE_FEATURES', () => {
    expect(resolveFeatureFlags('core', 'payments', TABLE)).toEqual({
      ai: false,
      payments: false,
    })
  })

  it('no edition -> the legacy VITE_FEATURES parse; neither -> golden', () => {
    expect(resolveFeatureFlags(undefined, 'payments', TABLE)).toEqual({
      ai: false,
      payments: true,
    })
    expect(resolveFeatureFlags(undefined, undefined, TABLE)).toEqual({
      ai: true,
      payments: true,
    })
    expect(resolveFeatureFlags('   ', '', TABLE)).toEqual({ ai: true, payments: true })
  })

  it('the define map carries per-module literals PLUS the flags JSON', () => {
    const map = featureDefineMap(editionFlags('school-payments', TABLE))
    expect(map['__VELO_FEATURE_AI__']).toBe('false')
    expect(map['__VELO_FEATURE_PAYMENTS__']).toBe('true')
    // The map WE built always carries the key; the Record<string, string>
    // index type is `string | undefined` under noUncheckedIndexedAccess.
    // The define value is pasted in as an expression: evaluating it must give
    // the JSON STRING featureEnabled() parses, not an object (an object made
    // JSON.parse throw and blanked every screen calling featureEnabled()).
    const pasted: unknown = JSON.parse(map['__VELO_FEATURE_FLAGS__'] as string)
    expect(typeof pasted).toBe('string')
    expect(JSON.parse(pasted as string)).toEqual({
      ai: false,
      payments: true,
    })
  })

  // Regression guard: vitest.config pins the flags define away, so no other
  // test ever runs featureEnabled() on the value vite really injects. Here
  // every define of the map is evaluated as vite pastes it (an expression),
  // installed as the global, and featureEnabled() must read it back intact.
  // Every value is JSON text, and a JSON text evaluates as a JS expression to
  // exactly what JSON.parse returns -- so `pasted` is what vite injects.
  const pasted = (value: string | undefined): unknown => JSON.parse(value as string)
  it('featureEnabled works on the define map exactly as vite injects it', () => {
    const flagSets = [
      editionFlags('core', TABLE),
      editionFlags('school-payments', TABLE),
      featureFlags(undefined), // golden: every module on
    ]
    for (const flags of flagSets) {
      const map = featureDefineMap(flags)
      // Per-module literals must evaluate to booleans (route gates fold them).
      for (const name of FEATURE_NAMES) {
        const key = `__VELO_FEATURE_${name.toUpperCase()}__`
        expect(typeof pasted(map[key])).toBe('boolean')
      }
      vi.stubGlobal('__VELO_FEATURE_FLAGS__', pasted(map['__VELO_FEATURE_FLAGS__']))
      try {
        for (const name of FEATURE_NAMES) {
          expect(featureEnabled(name)).toBe(flags[name])
        }
      } finally {
        vi.unstubAllGlobals()
      }
    }
  })
})
