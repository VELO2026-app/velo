// =============================================================================
// VELO Frontend -- MethodTaxonomyPicker Unit Tests
// =============================================================================
//
// Bug 5 leak 1 (PROMPT №408): a catalog-created direction/style leaked into a
// master's stored `methods: string[]` as its raw slug (e.g. "custom_vwxosjci")
// because methodTaxonomy.ts's module-level catalog cache stayed cold --
// MasterApplyView never called primeMethodTaxonomyCatalog() (it wasn't among
// the 4 screens wired for it), so directionLabel()/flattenMethods() fell
// through to the raw value.
//
// The fix has the picker feed its OWN catalog fetch into the shared cache
// (see MethodTaxonomyPicker.vue's onMounted -> applyTaxonomyCatalog), so ANY
// screen that merely renders this picker warms the cache -- no per-screen
// prime call to forget. This test proves exactly that: mount the picker with
// NO explicit primeMethodTaxonomyCatalog() call anywhere in this file, then
// check methodTaxonomy.ts's own directionLabel()/flattenMethods() resolve a
// catalog-only value correctly. Dependency-free SFC mount (createApp +
// happy-dom), matching VPaginationDots.test.ts -- the repo has no
// @vue/test-utils usage; plugin-vue (vitest.config) compiles the .vue for us.
// =============================================================================

import { describe, it, expect, afterEach, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import MethodTaxonomyPicker from '@/components/shared/MethodTaxonomyPicker.vue'
import { directionLabel, flattenMethods } from '@/utils/methodTaxonomy'
import { getActiveTaxonomy } from '@/api/taxonomy'
import type { PracticeDirection } from '@/api/types'

vi.mock('@/api/taxonomy', async () => {
  const actual = await vi.importActual<typeof import('@/api/taxonomy')>('@/api/taxonomy')
  return { ...actual, getActiveTaxonomy: vi.fn() }
})

let app: App | null = null
let host: HTMLElement | null = null

function mount(modelValue: string[]): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(MethodTaxonomyPicker, {
    modelValue,
    'onUpdate:modelValue': () => {},
  })
  app.mount(host)
  return host
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('MethodTaxonomyPicker (bug 5 leak 1 -- shared cache warmed on mount)', () => {
  it('mounting the picker alone (no primeMethodTaxonomyCatalog call) warms directionLabel for a catalog-only direction', async () => {
    vi.mocked(getActiveTaxonomy).mockResolvedValueOnce({
      directions: [
        {
          id: 'd1',
          value: 'custom_vwxosjci',
          label: 'Гвоздестояние',
          display_order: 0,
          is_active: true,
          source: 'custom',
          styles: [],
        },
      ],
    })

    mount([])
    // Flush the onMounted async fetch + its .then/catch continuation.
    await nextTick()
    await nextTick()

    expect(directionLabel('custom_vwxosjci')).toBe('Гвоздестояние')
  })

  it('mounting the picker also warms flattenMethods for a catalog-only style (leak 2)', async () => {
    vi.mocked(getActiveTaxonomy).mockResolvedValueOnce({
      directions: [
        {
          id: 'd2',
          value: 'custom_abcxyz01',
          label: 'Йога тест',
          display_order: 0,
          is_active: true,
          source: 'custom',
          styles: [
            {
              id: 's1',
              direction_id: 'd2',
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

    mount([])
    await nextTick()
    await nextTick()

    const flattened = flattenMethods({
      directions: ['custom_abcxyz01' as PracticeDirection],
      styles: { custom_abcxyz01: ['custom_l40lb6fj'] },
      customEnabled: false,
      customText: '',
    })

    expect(flattened).toEqual(['Йога тест — Продвинутый'])
  })
})

// =============================================================================
// PROMPT №503 commit 2: a value cold-parsed as "custom" against a not-yet-warm
// catalog must reparse to its real chip once the catalog resolves, even
// though the incoming modelValue TEXT never changes between the cold and
// warm parse (that's the whole trap -- sameSet() alone can't tell the two
// apart). This is the exact mechanism behind the owner's decisive repro:
// "Иглоукалывание" already exists as a real catalog chip, yet renders in the
// free-text box because the picker's own immediate watch always fires before
// its onMounted catalog fetch can resolve.
// =============================================================================
describe('MethodTaxonomyPicker (PROMPT №503 commit 2 -- reparse on catalog warm-up)', () => {
  it('a value that cold-parses as custom becomes the matched, active chip once the catalog resolves', async () => {
    vi.mocked(getActiveTaxonomy).mockResolvedValueOnce({
      directions: [
        {
          id: 'd3',
          value: 'custom_iglo01',
          label: 'Иглоукалывание',
          display_order: 0,
          is_active: true,
          source: 'custom',
          styles: [],
        },
      ],
    })

    const el = mount(['Иглоукалывание'])

    // Immediate watch runs synchronously during setup -- strictly before
    // onMounted's async fetch can have resolved. Must land cold.
    expect(el.querySelector('.mtp__other')).not.toBeNull()

    // Flush onMounted's fetch + its applyTaxonomyCatalog continuation.
    await nextTick()
    await nextTick()
    await nextTick()

    // Reparsed: free-text box gone, the real catalog chip is active instead.
    expect(el.querySelector('.mtp__other')).toBeNull()
    const chips = Array.from(el.querySelectorAll('.v-chip'))
    const matched = chips.find((c) => c.textContent?.trim() === 'Иглоукалывание')
    expect(matched).toBeTruthy()
    expect(matched?.className).toContain('v-chip--active')
  })
})
