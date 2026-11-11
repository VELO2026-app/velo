// =============================================================================
// VELO Frontend -- the mutation -> invalidated keys map (FE-166 step 1)
// =============================================================================
//
// One test per row of INVALIDATES: the keys the row names go stale, the
// others are left alone. A row that grows or shrinks must change its test
// here -- the map is the one place where "who else shows this data" is
// written down, so it is pinned row by row.
//
// The cache is a real Colada cache; entries are written with setQueryData
// (no loader), so "stale" is `when === 0`.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { createPinia } from 'pinia'
import { PiniaColada, useQueryCache, type EntryKey, type QueryCache } from '@pinia/colada'
import { coladaOptions } from '@/composables/queries/setup'
import { keys } from '@/composables/queries/keys'
import { INVALIDATES, invalidateAfter, type MutationName } from '@/composables/queries/invalidation'

let app: App | null = null
let queryCache: QueryCache

/** One entry under each domain the map can name. */
const SAMPLE = {
  bookings: [...keys.bookings.root(), 'list'] as EntryKey,
  practices: keys.practices.schoolFeed('g1', 5) as EntryKey,
  schools: keys.schools.detail('g1') as EntryKey,
  schoolLists: keys.schools.mine('all') as EntryKey,
}
type Domain = keyof typeof SAMPLE

/** Expected stale domains per row -- the map, written out by hand. */
const EXPECTED: Record<MutationName, Domain[]> = {
  cancelBooking: ['bookings', 'practices'],
  purchaseBooking: ['bookings', 'practices'],
  confirmWaitlist: ['bookings', 'practices'],
  joinBooking: ['bookings'],
  skipCheckin: ['bookings'],
  submitCheckin: ['bookings'],
  submitFeedback: ['bookings'],
  submitReflection: ['bookings'],
  changePractice: ['practices'],
  joinSchool: ['schools', 'schoolLists', 'practices'],
  acceptSchoolMasterOffer: ['schoolLists', 'practices'],
  leaveSchool: ['schoolLists'],
  acceptSchoolTransfer: ['schoolLists'],
}

function stale(domain: Domain): boolean {
  return queryCache.get(SAMPLE[domain])?.when === 0
}

beforeEach(() => {
  const Host = defineComponent({
    setup() {
      queryCache = useQueryCache()
      return () => h('div')
    },
  })
  app = createApp(Host).use(createPinia()).use(PiniaColada, coladaOptions)
  app.mount(document.createElement('div'))
  for (const key of Object.values(SAMPLE)) queryCache.setQueryData(key, { cached: true })
})

afterEach(() => {
  app?.unmount()
  app = null
})

describe('INVALIDATES', () => {
  it('has a test row for every mutation of the map', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(INVALIDATES).sort())
  })

  for (const mutation of Object.keys(EXPECTED) as MutationName[]) {
    it(`${mutation}: makes ${EXPECTED[mutation].join(', ')} stale, nothing else`, async () => {
      await invalidateAfter(queryCache, mutation)

      for (const domain of Object.keys(SAMPLE) as Domain[]) {
        expect(stale(domain), domain).toBe(EXPECTED[mutation].includes(domain))
      }
    })
  }
})
