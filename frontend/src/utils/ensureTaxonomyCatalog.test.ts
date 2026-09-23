// =============================================================================
// VELO Frontend -- ensureTaxonomyCatalog() Unit Tests (T2 stage 2, 2026-07-15)
// =============================================================================
//
// "Ride the shared cache; if cold, fetch once and prime it" -- the mechanism
// CreatePracticeView / EditPracticeView / CalendarFilterModal all lean on so
// only the FIRST screen visited this session pays the network round-trip.
//
// Separate test file (not appended to methodTaxonomy.test.ts): that file's
// own tests are deliberately module-state order-dependent (see its header),
// and Vitest gives each test FILE a fresh module registry by default, so a
// new file guarantees a genuinely cold cache here regardless of test order
// elsewhere.
//
// ORDER-DEPENDENT BY DESIGN (mirrors methodTaxonomy.test.ts's own convention):
// the fetch-failure case MUST run before any successful prime, or it would
// just observe an already-warm cache instead of a genuinely cold one.
// Declaration order = execution order (no shuffle configured).
// =============================================================================

import { describe, it, expect, vi } from 'vitest'
import { ensureTaxonomyCatalog, directionLabel } from '@/utils/methodTaxonomy'
import { getActiveTaxonomy } from '@/api/taxonomy'

vi.mock('@/api/taxonomy', async () => {
  const actual = await vi.importActual<typeof import('@/api/taxonomy')>('@/api/taxonomy')
  return { ...actual, getActiveTaxonomy: vi.fn() }
})

describe('ensureTaxonomyCatalog (cold cache, fetch failure -- must run first)', () => {
  it('returns null on a fetch failure rather than throwing, and leaves the cache cold', async () => {
    vi.mocked(getActiveTaxonomy).mockRejectedValueOnce(new Error('network error'))

    const catalog = await ensureTaxonomyCatalog()

    expect(catalog).toBeNull()
  })
})

describe('ensureTaxonomyCatalog (still cold -- previous failure did not leave a stale warm state)', () => {
  it('fetches again and returns the catalog on the next call', async () => {
    vi.mocked(getActiveTaxonomy).mockClear()
    vi.mocked(getActiveTaxonomy).mockResolvedValueOnce({
      directions: [
        {
          id: 'd1',
          value: 'therapy',
          label: 'Терапия',
          display_order: 0,
          is_active: true,
          source: 'custom',
          styles: [],
        },
      ],
    })

    const catalog = await ensureTaxonomyCatalog()

    expect(getActiveTaxonomy).toHaveBeenCalledTimes(1)
    expect(catalog?.directions[0]?.value).toBe('therapy')
    // Also primed the shared label-map cache other consumers read (directionLabel).
    expect(directionLabel('therapy')).toBe('Терапия')
  })
})

describe('ensureTaxonomyCatalog (warm cache)', () => {
  it('returns the already-warm catalog with NO additional fetch', async () => {
    // Cache is warm from the previous test (module-level, session-lifetime).
    vi.mocked(getActiveTaxonomy).mockClear()

    const catalog = await ensureTaxonomyCatalog()

    expect(getActiveTaxonomy).not.toHaveBeenCalled()
    expect(catalog?.directions[0]?.value).toBe('therapy')
  })
})
