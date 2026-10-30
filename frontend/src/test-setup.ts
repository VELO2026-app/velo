// =============================================================================
// VELO Frontend -- Vitest global setup (T1 stage 2)
// =============================================================================
//
// Runs before every test file. Resets the API client's module-level state
// (token, 401 callback, in-flight GET dedupe map) so tests don't leak state
// across files -- api/client.ts:91 already ships resetClientState() for
// exactly this (WARNING-13); this is the first place it's wired in. The
// screen-data cache (composables/useQuery), its persisted copy
// (composables/persistedCache) and sessionStorage are cleared alongside it.
// =============================================================================

import { beforeEach } from 'vitest'
import { config } from '@vue/test-utils'
import { resetClientState } from '@/api/client'
import { queryCache } from '@/composables/useQuery'
import { clearPersisted, setPersistOwner } from '@/composables/persistedCache'
import { createTestI18n } from '@/locales/testing'

// tz-i18n 0.4: every @vue/test-utils mount gets i18n injected -- components
// read translations via `import { t } from '@/locales'` (the project-wide
// composer export) and the template-exposed t(). Raw `createApp(...)` test
// mounts (120 files) take app.use(createTestI18n()) via a codemod, run at
// the start of phase 2.
config.global.plugins = [...config.global.plugins, createTestI18n()]

beforeEach(() => {
  resetClientState()
  // The screen-data cache is module state too: no test may see another's data.
  queryCache.clear()
  // ...and so is the copy that survives reloads (no owner = nothing hydrates).
  clearPersisted()
  setPersistOwner(null)
  sessionStorage.clear()
})
