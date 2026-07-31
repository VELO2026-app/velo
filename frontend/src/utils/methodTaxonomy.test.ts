// =============================================================================
// VELO Frontend -- methodTaxonomy.ts Unit Tests
// =============================================================================
// R3/R4 regression (PROMPT №391): parseMethods used to DROP any string that
// didn't match the taxonomy (Q3=В); it now SURFACES it as the custom variant
// (Q3=А) so a master's «Свой вариант» entry (e.g. "терапия") shows up in the
// picker instead of silently vanishing after submit / after admin approval.
// =============================================================================

import { describe, it, expect, vi } from 'vitest'
import {
  flattenMethods,
  parseMethods,
  directionLabel,
  primeMethodTaxonomyCatalog,
  applyTaxonomyCatalog,
} from '@/utils/methodTaxonomy'
import { getActiveTaxonomy } from '@/api/taxonomy'
import type { PracticeDirection } from '@/api/types'

vi.mock('@/api/taxonomy')

describe('parseMethods', () => {
  it('matches a bare direction label', () => {
    const parsed = parseMethods(['Йога'])
    expect(parsed.directions).toEqual(['yoga'])
    expect(parsed.styles).toEqual({})
    expect(parsed.customEnabled).toBe(false)
    expect(parsed.customText).toBe('')
  })

  it('matches a «Направление — Вид» pair', () => {
    const parsed = parseMethods(['Йога — Хатха-йога'])
    expect(parsed.directions).toEqual(['yoga'])
    expect(parsed.styles).toEqual({ yoga: ['hatha'] })
  })

  it('surfaces a single unmatched string as the custom variant (R3/R4)', () => {
    const parsed = parseMethods(['терапия'])
    expect(parsed.directions).toEqual([])
    expect(parsed.customEnabled).toBe(true)
    expect(parsed.customText).toBe('терапия')
  })

  it('surfaces a custom variant ALONGSIDE matched directions', () => {
    const parsed = parseMethods(['Йога', 'терапия'])
    expect(parsed.directions).toEqual(['yoga'])
    expect(parsed.customEnabled).toBe(true)
    expect(parsed.customText).toBe('терапия')
  })

  it('surfaces an unmatched «Направление — Вид»-shaped string verbatim (not silently dropped)', () => {
    const parsed = parseMethods(['Йога — Несуществующий вид'])
    expect(parsed.directions).toEqual([])
    expect(parsed.customEnabled).toBe(true)
    expect(parsed.customText).toBe('Йога — Несуществующий вид')
  })

  it('joins multiple unmatched strings rather than dropping all but one', () => {
    const parsed = parseMethods(['терапия', 'пилатес'])
    expect(parsed.customEnabled).toBe(true)
    expect(parsed.customText).toBe('терапия, пилатес')
  })

  it('ignores blank entries', () => {
    const parsed = parseMethods(['Йога', '', '   '])
    expect(parsed.directions).toEqual(['yoga'])
    expect(parsed.customEnabled).toBe(false)
  })
})

describe('parseMethods -> flattenMethods round-trip', () => {
  it('is lossless for a matched direction+style', () => {
    const original = ['Йога — Хатха-йога']
    expect(flattenMethods(parseMethods(original))).toEqual(original)
  })

  it('is lossless for a single custom string (R3/R4 the common case)', () => {
    const original = ['терапия']
    expect(flattenMethods(parseMethods(original))).toEqual(original)
  })

  it('is lossless for a mix of matched + custom', () => {
    const original = ['Йога', 'терапия']
    expect(flattenMethods(parseMethods(original))).toEqual(original)
  })

  it('is stable (idempotent) on a second round-trip after the multi-unmatched join', () => {
    const first = flattenMethods(parseMethods(['терапия', 'пилатес']))
    expect(first).toEqual(['терапия, пилатес'])
    // Second round-trip must reproduce the exact same result (no further drift).
    const second = flattenMethods(parseMethods(first))
    expect(second).toEqual(first)
  })
})

// =============================================================================
// Bug 2 (PROMPT №405): a value auto-promoted into the DB catalog (admin
// approves a master's «Свой вариант» with "добавить в каталог") must resolve
// as a MATCHED direction, not stay "unmatched -> custom" forever.
//
// primeMethodTaxonomyCatalog() mutates MODULE-LEVEL state (the whole point --
// a lazy, session-lifetime cache, same lifecycle as production). Tests below
// are ORDER-DEPENDENT by design: the fetch-failure/fallback case must run
// BEFORE any successful prime, or it would just be observing an
// already-warm cache from an earlier test rather than a genuinely cold one.
// Declaration order = execution order (no shuffle configured) -- do not
// reorder these two describe blocks relative to each other.
// =============================================================================
describe('primeMethodTaxonomyCatalog (cold-cache fallback, must run before any successful prime)', () => {
  it('on fetch failure, parseMethods still only matches the hardcoded map', async () => {
    vi.mocked(getActiveTaxonomy).mockRejectedValueOnce(new Error('network error'))

    await primeMethodTaxonomyCatalog()

    const parsed = parseMethods(['Терапия'])
    expect(parsed.directions).toEqual([])
    expect(parsed.customEnabled).toBe(true)
    expect(parsed.customText).toBe('Терапия')
  })
})

describe('primeMethodTaxonomyCatalog (warm cache)', () => {
  it('after a successful prime, a promoted catalog direction is matched -- not custom', async () => {
    vi.mocked(getActiveTaxonomy).mockResolvedValueOnce({
      directions: [
        {
          id: 'd1',
          value: 'custom_abc123',
          label: 'Терапия',
          display_order: 0,
          is_active: true,
          source: 'custom',
          styles: [],
        },
      ],
    })

    await primeMethodTaxonomyCatalog()
    const parsed = parseMethods(['Терапия'])

    expect(parsed.directions).toEqual(['custom_abc123'])
    expect(parsed.styles).toEqual({})
    expect(parsed.customEnabled).toBe(false)
    expect(parsed.customText).toBe('')
  })

  it('directionLabel resolves a catalog-only value back to its label (chip rendering)', () => {
    // Cache is warm from the previous test (module-level, session-lifetime).
    expect(directionLabel('custom_abc123')).toBe('Терапия')
  })

  it('flattenMethods round-trips a catalog-matched direction back to the original stored string', () => {
    const original = ['Терапия']
    expect(flattenMethods(parseMethods(original))).toEqual(original)
  })

  it('a catalog direction WITH a style is matched as a direction+style pair', async () => {
    vi.mocked(getActiveTaxonomy).mockResolvedValueOnce({
      directions: [
        {
          id: 'd2',
          value: 'yoga',
          label: 'Йога',
          display_order: 0,
          is_active: true,
          source: 'seed',
          styles: [
            {
              id: 's1',
              direction_id: 'd2',
              value: 'restorative',
              label: 'Восстановительная',
              display_order: 0,
              is_active: true,
              source: 'custom',
            },
          ],
        },
      ],
    })

    await primeMethodTaxonomyCatalog()
    const parsed = parseMethods(['Йога — Восстановительная'])

    expect(parsed.directions).toEqual(['yoga'])
    expect(parsed.styles).toEqual({ yoga: ['restorative'] })
    expect(parsed.customEnabled).toBe(false)
  })
})

// =============================================================================
// Bug 5 leak 2 (PROMPT №408): flattenMethods against a catalog-only style.
//
// The bug 2 fix (PROMPT №405) above taught directionLabel/parseMethods about
// the catalog, but flattenMethods' style branch (`STYLE_LABEL[st] ?? st`) was
// never made catalog-aware in any screen -- a catalog-created style
// flattened straight to its raw slug (e.g. "Йога тест — custom_l40lb6fj")
// because there was no value->label reverse map for styles, only the
// label->value forward map parseMethods needs. applyTaxonomyCatalog() (pulled
// out of primeMethodTaxonomyCatalog so MethodTaxonomyPicker can feed the SAME
// fetch into this cache -- see MethodTaxonomyPicker.vue's onMounted) now
// builds that reverse map too. Uses applyTaxonomyCatalog directly (no network
// mock needed) since these tests only care about the cache-consuming side.
// =============================================================================
describe('flattenMethods against a catalog-only style (bug 5 leak 2)', () => {
  it('a catalog-created direction (no styles) flattens to its label, not its slug', () => {
    applyTaxonomyCatalog({
      directions: [
        {
          id: 'd3',
          value: 'custom_vwxosjci',
          label: 'Гвоздестояние',
          display_order: 0,
          is_active: true,
          source: 'custom',
          styles: [],
        },
      ],
    })

    const flattened = flattenMethods({
      directions: ['custom_vwxosjci' as PracticeDirection],
      styles: {},
      customEnabled: false,
      customText: '',
    })

    expect(flattened).toEqual(['Гвоздестояние'])
  })

  it('a catalog-created style flattens to its label, not its slug', () => {
    applyTaxonomyCatalog({
      directions: [
        {
          id: 'd4',
          value: 'custom_abcxyz01',
          label: 'Йога тест',
          display_order: 0,
          is_active: true,
          source: 'custom',
          styles: [
            {
              id: 's2',
              direction_id: 'd4',
              value: 'custom_l40lb6fj',
              label: 'Продвинутый',
              display_order: 0,
              is_active: true,
              source: 'custom',
            },
          ],
        },
      ],
    })

    const flattened = flattenMethods({
      directions: ['custom_abcxyz01' as PracticeDirection],
      styles: { custom_abcxyz01: ['custom_l40lb6fj'] },
      customEnabled: false,
      customText: '',
    })

    expect(flattened).toEqual(['Йога тест — Продвинутый'])
  })

  it('the hardcoded/seeded path is unchanged (yoga + hatha still flattens via STYLE_LABEL)', () => {
    const flattened = flattenMethods({
      directions: ['yoga'],
      styles: { yoga: ['hatha'] },
      customEnabled: false,
      customText: '',
    })

    expect(flattened).toEqual(['Йога — Хатха-йога'])
  })

  it('a style matching neither the hardcoded map nor a catalog entry for its direction falls back to the raw value, not a throw', () => {
    const flattened = flattenMethods({
      directions: ['yoga'],
      styles: { yoga: ['totally_unknown_style'] },
      customEnabled: false,
      customText: '',
    })

    expect(flattened).toEqual(['Йога — totally_unknown_style'])
  })
})
