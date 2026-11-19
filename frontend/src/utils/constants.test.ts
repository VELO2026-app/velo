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

import { describe, it, expect } from 'vitest'
import { masterApprovedSeenKey } from '@/utils/constants'

describe('masterApprovedSeenKey (W18 -- per-user isolation)', () => {
  it('is the stable per-user key (a changed key would re-show the screen to everyone)', () => {
    expect(masterApprovedSeenKey('user_a')).toBe('velo:master-approved-seen:user_a')
    expect(masterApprovedSeenKey('user_b')).toBe('velo:master-approved-seen:user_b')
  })
})
