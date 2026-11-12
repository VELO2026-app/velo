// =============================================================================
// VELO Frontend -- Bookings store: client state only (FE-166 step 3)
// =============================================================================
//
// The bookings themselves (list, upcoming, join, skip check-in) are Colada
// queries and mutations since FE-166 step 3 -- composables/queries/
// bookings.test.ts covers them. What is left here is the session-only skip of
// a check-in banner.
// =============================================================================

import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useBookingsStore } from '@/stores/bookings'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('useBookingsStore', () => {
  it('remembers each skipped check-in once', () => {
    const store = useBookingsStore()

    store.dismissCheckin('p1')
    store.dismissCheckin('p1')
    store.dismissCheckin('p2')

    expect(store.dismissedCheckins).toEqual(['p1', 'p2'])
  })

  it('$reset forgets them (a different account starts fresh)', () => {
    const store = useBookingsStore()
    store.dismissCheckin('p1')

    store.$reset()

    expect(store.dismissedCheckins).toEqual([])
  })
})
