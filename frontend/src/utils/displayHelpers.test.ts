import { describe, it, expect } from 'vitest'
import { practiceIconFor, recurrenceDaysLabel } from './displayHelpers'
import { IconDirectionDefault, IconYoga } from '@/components/icons'

// FE-216: a direction without its own artwork (a master's own direction
// approved into the taxonomy, an unmapped backend value, or none at all)
// renders the default direction icon; a mapped direction keeps its own.
describe('practiceIconFor', () => {
  it('keeps a mapped direction on its own icon', () => {
    expect(practiceIconFor({ direction: 'yoga' })).toBe(IconYoga)
  })

  it.each([['custom_direction'], [null], [undefined]])(
    'falls back to the default direction icon for %s',
    (direction) => {
      expect(practiceIconFor({ direction })).toBe(IconDirectionDefault)
    },
  )
})

describe('recurrenceDaysLabel', () => {
  it('returns null for empty / missing day lists', () => {
    expect(recurrenceDaysLabel(null)).toBeNull()
    expect(recurrenceDaysLabel(undefined)).toBeNull()
    expect(recurrenceDaysLabel([])).toBeNull()
  })

  it('returns «Ежедневно» when all seven days are present', () => {
    expect(recurrenceDaysLabel([1, 2, 3, 4, 5, 6, 7])).toBe('Ежедневно')
  })

  it('lists a subset of weekdays Mon→Sun', () => {
    expect(recurrenceDaysLabel([1, 3, 5])).toBe('Пн, Ср, Пт')
    expect(recurrenceDaysLabel([6])).toBe('Сб')
    expect(recurrenceDaysLabel([7])).toBe('Вс')
  })

  it('de-duplicates and orders unsorted input', () => {
    expect(recurrenceDaysLabel([5, 1, 1, 3])).toBe('Пн, Ср, Пт')
  })

  it('ignores out-of-range day numbers', () => {
    expect(recurrenceDaysLabel([0, 8])).toBeNull()
    expect(recurrenceDaysLabel([0, 2, 8])).toBe('Вт')
  })
})
