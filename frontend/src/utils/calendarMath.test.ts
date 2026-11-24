import { describe, expect, it } from 'vitest'
import { daysInMonth } from './calendarMath'

describe('daysInMonth', () => {
  it('counts the days of a real month, leap February included', () => {
    expect(daysInMonth(2025, 2)).toBe(28)
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(daysInMonth(2025, 12)).toBe(31)
  })

  it('is NaN for a month that does not exist', () => {
    expect(daysInMonth(2025, 13)).toBeNaN()
  })
})
