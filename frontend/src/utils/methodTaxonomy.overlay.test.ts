// =============================================================================
// VELO Frontend -- stored method strings vs re-worded direction labels (FE-261)
// =============================================================================
// A stored `methods` string is the ru storage canon (the seed label of the
// direction), whatever language the screen shows. The labels parseMethods can
// read from the active locale change: a texts package re-words them (Goodo
// says "sessions" for "practices"), a non-ru UI shows its own words. With the
// taxonomy catalog cold -- a chip screen never loads it -- the ru seed is the
// only vocabulary that still knows the stored string. This file never primes
// the catalog, and its overlay lives for the whole file: keep the cases
// independent of order.
// =============================================================================

import { afterEach, describe, expect, it } from 'vitest'
import { applyInstanceOverrides, setLocale } from '@/locales'
import { directionLabel, parseMethods } from '@/utils/methodTaxonomy'

describe('a texts package re-words a direction', () => {
  it('the stored string still resolves, shown under the package wording', () => {
    applyInstanceOverrides({ ru: { display: { direction: { breathwork: 'Дыхательные сессии' } } } })

    const parsed = parseMethods(['Дыхательные практики', 'терапия'])

    expect(parsed.directions).toEqual(['breathwork'])
    expect(parsed.custom).toEqual(['терапия'])
    expect(directionLabel('breathwork')).toBe('Дыхательные сессии')
  })
})

describe('a non-ru UI with a cold catalog', () => {
  afterEach(async () => {
    await setLocale('ru')
  })

  it.each([
    ['en', 'Breathwork'],
    ['uk', 'Дихальні практики'],
  ])('%s: a stored ru string resolves to the direction and style', async (locale, dirLabel) => {
    await setLocale(locale)

    const parsed = parseMethods(['Дыхательные практики', 'Йога — Хатха-йога'])

    expect(parsed.directions).toEqual(['breathwork', 'yoga'])
    expect(parsed.styles).toEqual({ yoga: ['hatha'] })
    expect(parsed.customEnabled).toBe(false)
    expect(directionLabel('breathwork')).toBe(dirLabel)
  })
})
