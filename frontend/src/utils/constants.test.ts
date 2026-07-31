// =============================================================================
// VELO Frontend -- constants.ts Unit Tests
// =============================================================================
//
// W18 fix (PROMPT №408): masterApprovedSeenKey used to be a flat
// MASTER_APPROVED_SEEN_KEY string -- unscoped by user, so on a shared device
// (or after an account switch) person B inherited person A's "seen" state and
// never saw their own approval screen. Mirrors masterRejectionSeenKey's
// existing per-user pattern (constants.ts, added PROMPT №405).
//
// No router guard reads this key (only MasterPendingView.vue /
// RoleSwitchSection.vue do), so it is exercised directly here rather than
// through router/guards.test.ts's roleRedirect-style scenarios.
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest'
import { masterApprovedSeenKey } from '@/utils/constants'

describe('masterApprovedSeenKey (W18 -- per-user isolation)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('produces a distinct key per user', () => {
    expect(masterApprovedSeenKey('user_a')).not.toBe(masterApprovedSeenKey('user_b'))
  })

  it('two users on one device are isolated -- marking user A seen leaves user B unseen', () => {
    localStorage.setItem(masterApprovedSeenKey('user_a'), '1')

    expect(localStorage.getItem(masterApprovedSeenKey('user_a'))).toBe('1')
    expect(localStorage.getItem(masterApprovedSeenKey('user_b'))).toBeNull()
  })
})
