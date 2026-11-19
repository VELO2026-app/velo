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
import { adminKeys } from '@/composables/queries/adminKeys'
import {
  INVALIDATES,
  invalidateAfter,
  invalidateKeys,
  type MutationName,
} from '@/composables/queries/invalidation'
import { ADMIN_INVALIDATES, type AdminMutationName } from '@/composables/queries/admin'

let app: App | null = null
let queryCache: QueryCache

/** One entry under each domain the map can name. */
const SAMPLE = {
  bookings: [...keys.bookings.root(), 'list'] as EntryKey,
  practices: keys.practices.schoolFeed('g1', 5) as EntryKey,
  schools: keys.schools.detail('g1') as EntryKey,
  schoolLists: keys.schools.mine('all') as EntryKey,
  groupList: keys.groups.list() as EntryKey,
  groupMembers: keys.groups.members('g1', '') as EntryKey,
  // The admin zone (FE-181): no user-zone mutation may reach it.
  adminStats: adminKeys.stats() as EntryKey,
  adminTaxonomy: adminKeys.taxonomy() as EntryKey,
  adminPromos: adminKeys.promos('master') as EntryKey,
  adminSchools: adminKeys.schools() as EntryKey,
  adminUsers: adminKeys.users() as EntryKey,
  adminMasters: adminKeys.masters() as EntryKey,
  adminMaster: adminKeys.master('m1') as EntryKey,
  adminMethodRequests: adminKeys.methodRequests() as EntryKey,
  adminRevokePreview: adminKeys.revokePreview('m1') as EntryKey,
  adminOverview: adminKeys.overview('week', 0) as EntryKey,
  adminMetric: adminKeys.metric('checkin', 'week', 0) as EntryKey,
  adminPractices: adminKeys.practices('all') as EntryKey,
  adminPractice: adminKeys.practice('p1') as EntryKey,
  masterPublic: keys.masters.public('m1') as EntryKey,
  // The admin's own master profile: no admin edit of another master reaches it.
  masterProfile: keys.masters.profile() as EntryKey,
  adminParticipants: adminKeys.participants('all') as EntryKey,
  adminReports: adminKeys.reports('pending') as EntryKey,
  adminReport: adminKeys.report('r1') as EntryKey,
  adminWithdrawals: adminKeys.withdrawals() as EntryKey,
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
  renameGroup: ['groupList'],
  deleteGroup: ['groupList'],
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

/** Expected stale domains per admin row (ADMIN_INVALIDATES, ./admin.ts), written out by hand. */
const ADMIN_EXPECTED: Record<AdminMutationName, Domain[]> = {
  changeTaxonomy: ['adminTaxonomy'],
  deactivatePromo: ['adminPromos'],
  inviteMaster: [],
  makeMaster: [
    'adminUsers',
    'adminMasters',
    'adminMaster',
    'adminStats',
    'adminSchools',
    'schools',
    'schoolLists',
    'masterPublic',
  ],
  verifyMaster: [
    'adminMasters',
    'adminMaster',
    'adminStats',
    'adminSchools',
    'schools',
    'schoolLists',
    'adminTaxonomy',
    'masterPublic',
  ],
  rejectMaster: ['adminMasters', 'adminMaster', 'adminStats'],
  revokeMaster: [
    'adminMasters',
    'adminMaster',
    'adminUsers',
    'adminSchools',
    'schools',
    'schoolLists',
    'masterPublic',
  ],
  editMasterFields: [
    'adminMasters',
    'adminMaster',
    'adminUsers',
    'adminParticipants',
    'adminMethodRequests',
    'adminSchools',
    'adminPractices',
    'adminPractice',
    'masterPublic',
  ],
  setSchoolRight: ['adminMasters', 'adminMaster'],
  approveMethodChange: [
    'adminMethodRequests',
    'adminStats',
    'adminMasters',
    'adminMaster',
    'adminTaxonomy',
    'masterPublic',
  ],
  rejectMethodChange: ['adminMethodRequests', 'adminStats'],
  decideReport: ['adminReports', 'adminReport', 'adminStats'],
  decideWithdrawal: ['adminWithdrawals', 'adminMasters'],
}

describe('ADMIN_INVALIDATES', () => {
  for (const mutation of Object.keys(ADMIN_EXPECTED) as AdminMutationName[]) {
    it(`${mutation}: makes ${ADMIN_EXPECTED[mutation].join(', ') || 'nothing'} stale, nothing else`, async () => {
      await invalidateKeys(queryCache, ADMIN_INVALIDATES[mutation])

      for (const domain of Object.keys(SAMPLE) as Domain[]) {
        expect(stale(domain), domain).toBe(ADMIN_EXPECTED[mutation].includes(domain))
      }
    })
  }
})
