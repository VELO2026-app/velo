// =============================================================================
// VELO Frontend -- plural.ts Unit Tests
// =============================================================================
//
// SW14: three views each hand-rolled an equivalent Russian plural-forms
// implementation (MasterPublicView.vue, AdminDashboardView.vue,
// MasterPracticesView.vue) -- all three agreed at every boundary case when
// audited, but with no shared source a future tweak to one would silently
// drift from the others. This is the ONE canonical implementation; all three
// views now import it instead of reimplementing it locally.
// =============================================================================

import { describe, it, expect } from 'vitest'
import { plural } from '@/utils/plural'

describe('plural', () => {
  const forms = ['год', 'года', 'лет'] as const

  it('n=1 -> one (last digit 1, not in 11-14)', () => {
    expect(plural(1, ...forms)).toBe('год')
  })

  it('n=2 -> few (last digit 2-4, not in 11-14)', () => {
    expect(plural(2, ...forms)).toBe('года')
  })

  it('n=5 -> many (last digit 5-9 or 0)', () => {
    expect(plural(5, ...forms)).toBe('лет')
  })

  it('n=0 -> many', () => {
    expect(plural(0, ...forms)).toBe('лет')
  })

  it('n=11 -> many (the 11-14 exception overrides last-digit-1)', () => {
    expect(plural(11, ...forms)).toBe('лет')
  })

  it('n=12,13,14 -> many (the full 11-14 exception range)', () => {
    expect(plural(12, ...forms)).toBe('лет')
    expect(plural(13, ...forms)).toBe('лет')
    expect(plural(14, ...forms)).toBe('лет')
  })

  it('n=21 -> one (last digit 1 again, past the 11-14 exception window)', () => {
    expect(plural(21, ...forms)).toBe('год')
  })

  it('n=22 -> few', () => {
    expect(plural(22, ...forms)).toBe('года')
  })

  it('n=25 -> many', () => {
    expect(plural(25, ...forms)).toBe('лет')
  })

  it('n=111 -> many (the 11-14 exception applies again at the next hundred)', () => {
    expect(plural(111, ...forms)).toBe('лет')
  })

  it('n=101 -> one', () => {
    expect(plural(101, ...forms)).toBe('год')
  })
})
