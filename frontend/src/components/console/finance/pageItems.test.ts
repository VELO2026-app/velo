// =============================================================================
// VELO Frontend -- pageItems tests (FE-267)
// =============================================================================

import { describe, expect, it } from 'vitest'
import { pageItems } from '@/components/console/finance/pageItems'

describe('pageItems', () => {
  it.each([
    { page: 1, count: 1, items: [1] },
    { page: 3, count: 7, items: [1, 2, 3, 4, 5, 6, 7] },
    { page: 1, count: 20, items: [1, 2, null, 20] },
    { page: 10, count: 20, items: [1, null, 9, 10, 11, null, 20] },
    { page: 20, count: 20, items: [1, null, 19, 20] },
    // A gap of one page shows that page instead of a gap.
    { page: 4, count: 10, items: [1, 2, 3, 4, 5, null, 10] },
  ])('page $page of $count: $items', ({ page, count, items }) => {
    expect(pageItems(page, count)).toEqual(items)
  })
})
