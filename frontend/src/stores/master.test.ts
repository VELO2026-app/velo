// =============================================================================
// VELO Frontend -- stores/master.ts Unit Tests (probekit sweep #17)
// =============================================================================
//
// The store keeps client state only since FE-166 step 5: the onboarding flag
// of this session, and the applicant marker its $reset drops. The master
// profile and the master's own practices are Colada queries:
// composables/queries/master.test.ts.
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useMasterStore } from '@/stores/master'
import { MASTER_APPLIED_KEY } from '@/utils/constants'

beforeEach(() => {
  setActivePinia(createPinia())
  sessionStorage.clear()
})

describe('useMasterStore', () => {
  it('$reset clears the onboarding flag and the applicant sessionStorage marker', () => {
    sessionStorage.setItem(MASTER_APPLIED_KEY, '1')
    const store = useMasterStore()
    store.onboardingShownThisSession = true

    store.$reset()

    expect(store.onboardingShownThisSession).toBe(false)
    expect(sessionStorage.getItem(MASTER_APPLIED_KEY)).toBeNull()
  })
})
