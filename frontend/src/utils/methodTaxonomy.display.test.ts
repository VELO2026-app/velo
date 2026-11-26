// =============================================================================
// VELO Frontend -- methodTaxonomy.ts: stored methods and catalog rows in the
// live locale (FE-275, the console on uk)
// =============================================================================
// The DB catalog and the stored "Direction — Style" strings carry the ru
// storage canon. A non-ru UI must show them in its own words: the known
// directions and styles through their keys, and a promoted direction (random
// `custom_<8 hex>` slug) through the seed key its ru label names
// (i18n:display.direction.therapy). A string the taxonomy does not know stays
// verbatim. Display only: nothing here re-writes a stored string.
// =============================================================================

import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { setLocale } from '@/locales'
import { applyTaxonomyCatalog, directionLabel, methodDisplayLabel } from '@/utils/methodTaxonomy'

/** A promoted direction and an own one no seed key names, next to a seeded one. */
beforeAll(() => {
  applyTaxonomyCatalog({
    directions: [
      {
        id: 'd1',
        value: 'custom_n8xq7g2q',
        label: 'Терапия',
        display_order: 10,
        is_active: true,
        source: 'custom',
        styles: [],
      },
      {
        id: 'd2',
        value: 'custom_k3m9p1xz',
        label: 'Исцеление',
        display_order: 11,
        is_active: true,
        source: 'custom',
        styles: [],
      },
    ],
  })
})

afterEach(async () => {
  await setLocale('ru')
})

describe('directionLabel', () => {
  it('shows a promoted direction in the live locale when its ru label is a seed one', async () => {
    await setLocale('uk')
    expect(directionLabel('custom_n8xq7g2q')).toBe('Терапія')
    await setLocale('en')
    expect(directionLabel('custom_n8xq7g2q')).toBe('Therapy')
  })

  it('keeps the catalog label of a promoted direction no seed key names', async () => {
    await setLocale('uk')
    expect(directionLabel('custom_k3m9p1xz')).toBe('Исцеление')
  })
})

describe('methodDisplayLabel', () => {
  it.each([
    ['uk', 'Медитация — Звуковая медитация', 'Медитація — Звукова медитація'],
    ['en', 'Йога — Хатха-йога', 'Yoga — Hatha yoga'],
    ['uk', 'Дыхательные практики', 'Дихальні практики'],
    ['uk', 'Терапия', 'Терапія'],
  ])('%s: the stored "%s" reads "%s"', async (locale, stored, shown) => {
    await setLocale(locale)
    expect(methodDisplayLabel(stored)).toBe(shown)
  })

  it('leaves a string the taxonomy does not know verbatim', async () => {
    await setLocale('uk')
    expect(methodDisplayLabel('Мой уникальный метод')).toBe('Мой уникальный метод')
    expect(methodDisplayLabel('Йога — Несуществующий вид')).toBe('Йога — Несуществующий вид')
  })
})
