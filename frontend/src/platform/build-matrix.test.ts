// =============================================================================
// VELO Frontend -- build-matrix gate tests (tz-whitelabel §6.1/§4, FE-114)
// =============================================================================
// evaluateMatrix() is the acceptance gate pnpm build:matrix runs after its
// builds: dist facts vs every edition's source of record. Pinned here: the
// green matrix stays silent, and every FAIL branch fires with a named
// reason -- a gate that cannot fail is a report.
// =============================================================================

import { describe, expect, it } from 'vitest'

// Plain ESM module (types loosely declared in env.d.ts).
// @ts-expect-error -- *.mjs modules carry no type information
import { evaluateMatrix } from '../../scripts/build-matrix.mjs'

// A green four-edition run: skins carry their own identity, the feature-cut
// edition is the golden build minus the payments chunks.
const GREEN_FACTS = {
  golden: {
    title: 'VELO',
    theme: '#334D6E',
    tokensSha: 'golden',
    assets: 120,
    ai: ['AiSummary-1.js'],
    payments: ['TopupView-1.js'],
  },
  'test-contrast': {
    title: 'ПРАКТИКА 42',
    theme: '#1B2A41',
    tokensSha: 'abc123',
    assets: 120,
    ai: ['AiSummary-1.js'],
    payments: ['TopupView-1.js'],
  },
  nightfall: {
    title: 'НОВА',
    theme: '#1B1530',
    tokensSha: 'def456',
    assets: 120,
    ai: ['AiSummary-1.js'],
    payments: ['TopupView-1.js'],
  },
  'feature-cut': {
    title: 'VELO',
    theme: '#334D6E',
    tokensSha: 'golden',
    assets: 116,
    ai: ['AiSummary-1.js'],
    payments: [],
  },
}
const EXPECTED = {
  golden: { title: 'VELO', theme: '#334D6E' },
  'test-contrast': { title: 'ПРАКТИКА 42', theme: '#1B2A41' },
  nightfall: { title: 'НОВА', theme: '#1B1530' },
  'feature-cut': { title: 'VELO', theme: '#334D6E' },
}

describe('evaluateMatrix (tz-whitelabel §6.1 gate)', () => {
  it('a matrix whose facts match every source of record stays silent', () => {
    expect(evaluateMatrix({ facts: GREEN_FACTS, expected: EXPECTED })).toEqual([])
  })

  it('a title that drifted from its brand.json fails, named', () => {
    const fails = evaluateMatrix({
      facts: { ...GREEN_FACTS, nightfall: { ...GREEN_FACTS.nightfall!, title: ' velo ' } },
      expected: EXPECTED,
    })
    expect(fails).toHaveLength(1)
    expect(fails[0]).toContain('nightfall')
    expect(fails[0]).toContain('title')
  })

  it('a theme-color drift on a skin edition fails', () => {
    const fails = evaluateMatrix({
      facts: {
        ...GREEN_FACTS,
        'test-contrast': { ...GREEN_FACTS['test-contrast']!, theme: '#000000' },
      },
      expected: EXPECTED,
    })
    expect(fails).toHaveLength(1)
    expect(fails[0]).toContain('test-contrast')
    expect(fails[0]).toContain('theme-color')
  })

  it('skin tokens leaking into the golden build fail (b)', () => {
    const fails = evaluateMatrix({
      facts: { ...GREEN_FACTS, golden: { ...GREEN_FACTS.golden!, tokensSha: 'abc123' } },
      expected: EXPECTED,
    })
    expect(fails).toHaveLength(1)
    expect(fails[0]).toContain('golden')
    expect(fails[0]).toContain('tokens')
  })

  it('an asset-count drift across full editions fails (b)', () => {
    const fails = evaluateMatrix({
      facts: { ...GREEN_FACTS, nightfall: { ...GREEN_FACTS.nightfall!, assets: 121 } },
      expected: EXPECTED,
    })
    expect(fails).toHaveLength(1)
    expect(fails[0]).toContain('asset count')
  })

  it('a full edition missing payments chunks fails (c)', () => {
    const fails = evaluateMatrix({
      facts: { ...GREEN_FACTS, golden: { ...GREEN_FACTS.golden!, payments: [] } },
      expected: EXPECTED,
    })
    expect(fails).toHaveLength(1)
    expect(fails[0]).toContain('payments chunks missing from a FULL edition')
  })

  it('a disabled module chunk surviving the cut fails, named (d)', () => {
    const fails = evaluateMatrix({
      facts: {
        ...GREEN_FACTS,
        'feature-cut': { ...GREEN_FACTS['feature-cut']!, payments: ['AdminWithdrawalsView-9f.js'] },
      },
      expected: EXPECTED,
    })
    expect(fails).toHaveLength(1)
    expect(fails[0]).toContain('DISABLED payments module')
    expect(fails[0]).toContain('AdminWithdrawalsView-9f.js')
  })

  it('the cut edition losing the ai module fails (d)', () => {
    const fails = evaluateMatrix({
      facts: { ...GREEN_FACTS, 'feature-cut': { ...GREEN_FACTS['feature-cut']!, ai: [] } },
      expected: EXPECTED,
    })
    expect(fails).toHaveLength(1)
    expect(fails[0]).toContain('feature-cut')
    expect(fails[0]).toContain('ai chunks missing')
  })

  it('a missing edition fact fails instead of passing silently', () => {
    const fails = evaluateMatrix({ facts: { golden: GREEN_FACTS.golden! }, expected: EXPECTED })
    expect(fails.length).toBeGreaterThan(0)
  })
})
