// =============================================================================
// VELO Frontend -- Vitest Configuration
// =============================================================================
//
// Separate config file so vite.config.ts stays clean.
// Uses happy-dom for lightweight DOM emulation (needed by Vue composables).
// Path alias @/ -> src/ inherited from resolve.alias.
// =============================================================================

import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { featureDefines } from './src/platform/features'

// tz-whitelabel §3: the unit suite ALWAYS runs against the GOLDEN build.
// vite.config materializes skin-brand.generated.ts from whatever skin sits in
// public/skin/ -- in a working tree used for a skin demo that is a real
// brand, and the suite must not depend on deploy state. The alias pins the
// golden stub for every test file.
const GOLDEN_BRAND_STUB = fileURLToPath(
  new URL('./src/platform/skin-brand.golden-test-stub.ts', import.meta.url),
)

export default defineConfig({
  plugins: [vue()],

  // tz-whitelabel §4 (F3): the unit suite ALWAYS runs the GOLDEN feature set
  // (every module on) -- the same philosophy as the golden brand stub below.
  // Route gates in router/index.ts read the __VELO_FEATURE_*__ literals;
  // without this define they would be bare undeclared identifiers under
  // vitest (vitest.config does NOT inherit vite.config).
  define: featureDefines(undefined),

  resolve: {
    // array form: the exact skin-brand key must win before the '@' prefix
    alias: [
      { find: '@/platform/skin-brand.generated', replacement: GOLDEN_BRAND_STUB },
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
    ],
  },

  test: {
    // happy-dom is faster than jsdom and sufficient for unit tests
    environment: 'happy-dom',
    // Test file patterns
    include: ['src/**/*.test.ts'],
    // Runs before every test file -- resets api/client.ts module state (T1 stage 2)
    setupFiles: ['./src/test-setup.ts'],
    // Global timeout per test (ms)
    testTimeout: 5000,
    // Coverage (optional, run with --coverage)
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts', 'src/main.ts'],
    },
  },
})
