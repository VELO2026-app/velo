// =============================================================================
// VELO Frontend -- practiceOptions.ts Unit Tests (catalog-first, T2 stage 2)
// =============================================================================
//
// The backend accepts a direction/style from the DB catalog OR the hardcoded
// lists (T2 stage 1, union). catalogDirectionOptions/catalogStylesForDirection
// are the frontend's other half: build the OPTIONS a picker offers,
// catalog-first, falling back to the hardcoded consts when the catalog is
// cold (null, e.g. offline/error) -- never an empty picker.
//
// Pure functions -- no fetching, no module-level state, no mocking needed.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest'
import {
  catalogDirectionOptions,
  catalogStylesForDirection,
  directionDisplayLabel,
  styleDisplayLabel,
  DIRECTION_OPTIONS,
  stylesForDirection,
} from '@/utils/practiceOptions'
import { setLocale } from '@/locales'
import type { TaxonomyListResponse } from '@/api/taxonomy'

const CATALOG_WITH_CUSTOM_DIRECTION: TaxonomyListResponse = {
  directions: [
    {
      id: 'd1',
      value: 'yoga',
      label: 'Йога',
      display_order: 0,
      is_active: true,
      source: 'seed',
      styles: [
        {
          id: 's1',
          direction_id: 'd1',
          value: 'hatha',
          label: 'Хатха-йога',
          display_order: 0,
          is_active: true,
          source: 'seed',
        },
      ],
    },
    {
      id: 'd2',
      value: 'therapy',
      label: 'Терапия',
      display_order: 1,
      is_active: true,
      source: 'custom',
      styles: [
        {
          id: 's2',
          direction_id: 'd2',
          value: 'grounding',
          label: 'Заземление',
          display_order: 0,
          is_active: true,
          source: 'custom',
        },
      ],
    },
  ],
}

describe('catalogDirectionOptions', () => {
  it('falls back to the hardcoded DIRECTION_OPTIONS when the catalog is cold (null)', () => {
    expect(catalogDirectionOptions(null)).toEqual(DIRECTION_OPTIONS)
  })

  it('offers a catalog-only direction not in the hardcoded list', () => {
    const options = catalogDirectionOptions(CATALOG_WITH_CUSTOM_DIRECTION)
    expect(options).toContainEqual({ value: 'therapy', label: 'Терапия' })
  })

  it('still offers the seeded (config-mirroring) directions from the catalog', () => {
    const options = catalogDirectionOptions(CATALOG_WITH_CUSTOM_DIRECTION)
    expect(options).toContainEqual({ value: 'yoga', label: 'Йога' })
  })
})

describe('catalogStylesForDirection', () => {
  it('returns [] when no direction is selected', () => {
    expect(catalogStylesForDirection(CATALOG_WITH_CUSTOM_DIRECTION, undefined)).toEqual([])
    expect(catalogStylesForDirection(CATALOG_WITH_CUSTOM_DIRECTION, null)).toEqual([])
    expect(catalogStylesForDirection(CATALOG_WITH_CUSTOM_DIRECTION, '')).toEqual([])
  })

  it('falls back to the hardcoded stylesForDirection() when the catalog is cold (null)', () => {
    expect(catalogStylesForDirection(null, 'yoga')).toEqual(stylesForDirection('yoga'))
  })

  it('offers a catalog-only style under its catalog-only direction', () => {
    const styles = catalogStylesForDirection(CATALOG_WITH_CUSTOM_DIRECTION, 'therapy')
    expect(styles).toEqual([{ value: 'grounding', label: 'Заземление' }])
  })

  it('offers catalog styles for a seeded direction (matches its hardcoded styles today)', () => {
    const styles = catalogStylesForDirection(CATALOG_WITH_CUSTOM_DIRECTION, 'yoga')
    expect(styles).toEqual([{ value: 'hatha', label: 'Хатха-йога' }])
  })

  it('returns [] for a direction warm-catalog does not contain, rather than falling back', () => {
    // Catalog is warm (not null) but this direction isn't in it -- should not
    // happen in practice (catalog is a superset), but must degrade to [] --
    // never to the hardcoded fallback list for an unrelated direction.
    expect(catalogStylesForDirection(CATALOG_WITH_CUSTOM_DIRECTION, 'meditation')).toEqual([])
  })
})

// tz-i18n + BE-165 patch: the DB catalog serves ONE label per row (the ru
// storage canon). The display mapping renders KNOWN values through the
// live-locale seed label and keeps the server label only for catalog-only
// additions -- so the method picker/filter/form options follow the interface
// language without forking the stored vocabulary.
describe('catalog label display mapping (directionDisplayLabel/styleDisplayLabel)', () => {
  afterEach(async () => {
    await setLocale('ru')
  })

  it('a known direction renders the ACTIVE locale label, not the server one', async () => {
    await setLocale('en')
    // Server sends its ru canon label; the seed key wins for display.
    expect(directionDisplayLabel('yoga', 'Йога')).toBe('Yoga')
    // A catalog-only addition has no seed key -- the server label stands.
    expect(directionDisplayLabel('therapy', 'Терапия')).toBe('Терапия')
  })

  it('a known style renders the ACTIVE locale label, not the server one', async () => {
    await setLocale('en')
    expect(styleDisplayLabel('hatha', 'Хатха-йога')).toBe('Hatha yoga')
    expect(styleDisplayLabel('grounding', 'Заземление')).toBe('Заземление')
  })

  it('the option builders resolve labels through the same mapping', async () => {
    await setLocale('en')
    const directions = catalogDirectionOptions(CATALOG_WITH_CUSTOM_DIRECTION)
    expect(directions).toContainEqual({ value: 'yoga', label: 'Yoga' })
    expect(directions).toContainEqual({ value: 'therapy', label: 'Терапия' })
    const styles = catalogStylesForDirection(CATALOG_WITH_CUSTOM_DIRECTION, 'yoga')
    expect(styles).toEqual([{ value: 'hatha', label: 'Hatha yoga' }])
    // ...and back to ru the same builders render the canon labels again.
    await setLocale('ru')
    expect(catalogDirectionOptions(CATALOG_WITH_CUSTOM_DIRECTION)).toContainEqual({
      value: 'yoga',
      label: 'Йога',
    })
  })
})
