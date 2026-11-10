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
import { skinVirtualModules } from './src/platform/skin-virtual'

export default defineConfig({
  // tz-whitelabel §3: the unit suite ALWAYS runs against the GOLDEN build --
  // the virtual skin modules are served with no skin, whatever sits in
  // public/skin/ of the working tree (a skin demo must not leak into tests).
  plugins: [skinVirtualModules(fileURLToPath(new URL('./public', import.meta.url)), null), vue()],

  // tz-whitelabel §4 (F3): the unit suite ALWAYS runs the GOLDEN feature set
  // (every module on) -- the same philosophy as the golden skin modules above.
  // Route gates in router/index.ts read the __VELO_FEATURE_*__ literals;
  // without this define they would be bare undeclared identifiers under
  // vitest (vitest.config does NOT inherit vite.config).
  define: featureDefines(undefined),

  resolve: {
    // array form: the exact keys must win before the '@' prefix
    alias: [
      // FE-117 batch A: the suite compiles @velo/ui from the kit's SOURCES
      // (exact-match regex, before '@' -- mirrors vite.config.ts).
      {
        find: /^@velo\/ui$/,
        replacement: fileURLToPath(new URL('../packages/velo-ui/src/index.ts', import.meta.url)),
      },
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
