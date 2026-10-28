import { describe, expect, it } from 'vitest'
import { FEATURE_NAMES, featureEnabled, featureFlags } from '@/platform/features'

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
    expect(featureEnabled('ai')).toBe(true)
    expect(featureEnabled('payments')).toBe(true)
  })
})
