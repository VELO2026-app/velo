// =============================================================================
// VELO Frontend -- CalendarFilterModal Unit Tests (T2 stage 2, 2026-07-15)
// =============================================================================
//
// Integration-level proof (mirrors MethodTaxonomyPicker.test.ts's pattern:
// dependency-free SFC mount via createApp + happy-dom, no @vue/test-utils,
// no stores/router needed by this component) that the catalog-first wiring
// actually renders: a value in neither source (offline/error fallback) still
// shows the hardcoded chips rather than an empty list, and a catalog-only
// direction appears as a selectable chip whose picking reveals its
// catalog-only style as a chip too.
//
// ORDER-DEPENDENT BY DESIGN (mirrors methodTaxonomy.test.ts's own
// convention): the fetch-failure/fallback case runs FIRST, before any
// successful prime -- ensureTaxonomyCatalog()'s module-level cache is
// session-lifetime (shared across tests within this file), so a later test
// would otherwise just observe an already-warm cache instead of a genuinely
// cold/failed one. Declaration order = execution order (no shuffle
// configured) -- do not reorder these two tests relative to each other.
// =============================================================================

import { describe, it, expect, afterEach, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import CalendarFilterModal from '@/components/shared/CalendarFilterModal.vue'
import { getActiveTaxonomy } from '@/api/taxonomy'
import type { CalendarFacetFilters } from '@/stores/calendar'

vi.mock('@/api/taxonomy', async () => {
  const actual = await vi.importActual<typeof import('@/api/taxonomy')>('@/api/taxonomy')
  return { ...actual, getActiveTaxonomy: vi.fn() }
})

let app: App | null = null
let host: HTMLElement | null = null

function mount(onApply: (filters: CalendarFacetFilters) => void): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(CalendarFilterModal, {
    open: true,
    filters: {},
    onApply,
    onClose: () => {},
  })
  app.mount(host)
}

// VModal teleports its content to <body> (Teleport to="body"), so chips live
// outside the `host` div entirely -- query document.body, not the mount root.
function chipButtons(): HTMLButtonElement[] {
  return Array.from(document.body.querySelectorAll('button'))
}

function findChip(label: string): HTMLButtonElement | undefined {
  return chipButtons().find((b) => b.textContent?.trim() === label)
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('CalendarFilterModal (cold cache, fetch failure -- must run first)', () => {
  it('falls back to the hardcoded direction chips on a failed catalog fetch (never an empty list)', async () => {
    vi.mocked(getActiveTaxonomy).mockRejectedValueOnce(new Error('network error'))

    mount(() => {})
    await nextTick()
    await nextTick()
    await nextTick()

    // A hardcoded direction (config-only path unchanged).
    expect(findChip('Медитация')).toBeTruthy()
  })
})

describe('CalendarFilterModal (catalog-first direction/style chips)', () => {
  it('offers a catalog-only direction, and picking it reveals its catalog-only style', async () => {
    vi.mocked(getActiveTaxonomy).mockResolvedValueOnce({
      directions: [
        {
          id: 'd1',
          value: 'therapy',
          label: 'Терапия',
          display_order: 0,
          is_active: true,
          source: 'custom',
          styles: [
            {
              id: 's1',
              direction_id: 'd1',
              value: 'grounding',
              label: 'Заземление',
              display_order: 0,
              is_active: true,
              source: 'custom',
            },
          ],
        },
      ],
    })

    let applied: CalendarFacetFilters | null = null
    mount((f) => {
      applied = f
    })
    // Flush the onMounted async catalog fetch + its .then continuation.
    await nextTick()
    await nextTick()
    await nextTick()

    const therapyChip = findChip('Терапия')
    expect(therapyChip).toBeTruthy()

    therapyChip!.click()
    await nextTick()

    expect(applied).toEqual({
      direction: ['therapy'],
      difficulty: undefined,
      style: undefined,
      duration_bucket: undefined,
      time_of_day: undefined,
    })

    // Style section for the selected direction now shows the catalog-only style.
    expect(findChip('Заземление')).toBeTruthy()
  })
})
