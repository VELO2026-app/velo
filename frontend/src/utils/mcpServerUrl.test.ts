// =============================================================================
// mcpServerUrl / bearerHeaderValue (BE-150)
// =============================================================================

import { describe, it, expect } from 'vitest'
import { bearerHeaderValue, mcpServerUrl } from '@/utils/mcpServerUrl'

describe('mcpServerUrl', () => {
  it.each([
    ['https://api.velo.test', 'https://api.velo.test/mcp'],
    ['https://api.velo.test/', 'https://api.velo.test/mcp'],
    ['https://api.velo.test///', 'https://api.velo.test/mcp'],
    ['  https://api.velo.test  ', 'https://api.velo.test/mcp'],
  ])('%j -> %j: one /mcp, never //mcp', (base, expected) => {
    expect(mcpServerUrl(base)).toBe(expected)
  })

  it.each([[''], ['   '], [undefined], [null]])(
    'no base (%j) -> null: never a guessed address (fails closed)',
    (base) => {
      expect(mcpServerUrl(base)).toBeNull()
    },
  )
})

describe('bearerHeaderValue', () => {
  it('puts exactly one "Bearer " in front of the token', () => {
    const token = 'velo_pat_0123456789abcdef_' + 'S'.repeat(43)
    const value = bearerHeaderValue(token)
    expect(value).toBe(`Bearer ${token}`)
    expect(value.match(/Bearer/g)).toHaveLength(1)
    expect(value.startsWith('Bearer velo_pat_')).toBe(true)
  })
})
