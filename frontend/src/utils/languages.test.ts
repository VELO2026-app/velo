import { describe, expect, it } from 'vitest'
import { LANGUAGES } from './languages'

describe('LANGUAGES', () => {
  it('lists the two practice languages from the seed as endonyms', () => {
    expect(LANGUAGES).toHaveLength(2)
    expect(LANGUAGES.every((name) => name.length > 0)).toBe(true)
  })
})
