// =============================================================================
// VELO Frontend -- methodTaxonomy.ts cache reactivity tests (PROMPT №503 commit 1)
// =============================================================================
// The bug-2/bug-5 fixes (PROMPT №405/№408) taught parseMethods/flattenMethods/
// directionLabel about the DB catalog, but the cache backing them was plain
// module-level `let`s -- invisible to Vue's reactivity system. A computed()
// built on these functions never re-ran just because applyTaxonomyCatalog()
// warmed the cache later; it stayed at whatever it resolved to on its FIRST
// read for the rest of the component's lifetime. This is the mechanism behind
// a value that genuinely exists in the catalog still rendering as
// "custom"/unmatched after the catalog resolves (e.g. AdminMasterReviewView's
// hasParsedMethods / EditProfileView's normalizedCurrent -- both computed()).
//
// Separate file from methodTaxonomy.test.ts (not appended to it) because that
// file's later describe blocks are deliberately order-dependent on a COLD
// module cache running first -- these tests warm the cache with values no
// other test file uses, and Vitest isolates module state per test file, so
// there is no ordering hazard either way.
// =============================================================================

import { describe, it, expect } from 'vitest'
import { computed, nextTick } from 'vue'
import {
  parseMethods,
  directionLabel,
  applyTaxonomyCatalog,
  taxonomyCatalogVersion,
} from '@/utils/methodTaxonomy'

describe('methodTaxonomy cache reactivity (PROMPT №503 commit 1)', () => {
  it('a computed() built on directionLabel re-resolves once the catalog warms, with no manual re-trigger', async () => {
    const label = computed(() => directionLabel('custom_reactivity01'))

    // Cold: nothing has primed this value yet -- falls back to the raw slug.
    expect(label.value).toBe('custom_reactivity01')

    applyTaxonomyCatalog({
      directions: [
        {
          id: 'd1',
          value: 'custom_reactivity01',
          label: 'Реактивность',
          display_order: 0,
          is_active: true,
          source: 'custom',
          styles: [],
        },
      ],
    })
    await nextTick()

    // Nothing re-invoked the computed's getter directly above -- Vue's own
    // dependency tracking on the (now-reactive) cache is what must cause this.
    expect(label.value).toBe('Реактивность')
  })

  it('a computed() built on parseMethods flips a value from unmatched/custom to matched once the catalog warms', async () => {
    const selection = computed(() => parseMethods(['Иглотерапия-реакт']))

    expect(selection.value.customEnabled).toBe(true)
    expect(selection.value.directions).toEqual([])

    applyTaxonomyCatalog({
      directions: [
        {
          id: 'd2',
          value: 'custom_reactivity02',
          label: 'Иглотерапия-реакт',
          display_order: 0,
          is_active: true,
          source: 'custom',
          styles: [],
        },
      ],
    })
    await nextTick()

    expect(selection.value.customEnabled).toBe(false)
    expect(selection.value.directions).toEqual(['custom_reactivity02'])
  })

  it('taxonomyCatalogVersion increments exactly once per applyTaxonomyCatalog() call', () => {
    const before = taxonomyCatalogVersion.value
    applyTaxonomyCatalog({ directions: [] })
    expect(taxonomyCatalogVersion.value).toBe(before + 1)
    applyTaxonomyCatalog({ directions: [] })
    expect(taxonomyCatalogVersion.value).toBe(before + 2)
  })
})
