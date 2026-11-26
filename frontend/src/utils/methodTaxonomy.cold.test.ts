// =============================================================================
// VELO Frontend -- methodTaxonomy.ts: a stored method on a COLD catalog
// (FE-275 review, the console on uk)
// =============================================================================
// The catalog is not loaded yet, failed to load, or does not list the
// direction (a hidden one): "Therapy" -- a master's own method an admin once
// promoted (i18n:display.direction.therapy) -- is not matched by parseMethods
// and surfaces as the custom variant. Its live wording is still known by the
// label, so the display paths take it from the ru seed. Any other own text
// stays verbatim. This file never applies a catalog: module state stays cold.
// =============================================================================

import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '@/locales'
import { methodChipFor } from '@/utils/methodChips'
import { customMethodLabel, methodDisplayLabel } from '@/utils/methodTaxonomy'

afterEach(async () => {
  await setLocale('ru')
})

describe('a bare direction label the seed names, with no catalog', () => {
  it('reads in the live locale on every display path', async () => {
    await setLocale('uk')
    expect(customMethodLabel('Терапия')).toBe('Терапія')
    expect(methodDisplayLabel('Терапия')).toBe('Терапія')
    expect(methodChipFor('Терапия').label).toBe('Терапія')
    await setLocale('en')
    expect(methodDisplayLabel('Терапия')).toBe('Therapy')
  })

  it("leaves the master's own text verbatim", async () => {
    await setLocale('uk')
    expect(customMethodLabel('Мой уникальный метод')).toBe('Мой уникальный метод')
    expect(methodDisplayLabel('Терапия — Заземление')).toBe('Терапия — Заземление')
  })
})
