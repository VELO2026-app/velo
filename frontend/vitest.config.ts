// =============================================================================
// VELO Frontend -- Vitest Configuration
// =============================================================================
//
// Separate config file so vite.config.ts stays clean.
// Uses happy-dom for lightweight DOM emulation (needed by Vue composables).
// Path alias @/ -> src/ inherited from resolve.alias.
// =============================================================================

import { configDefaults, defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { globSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { featureDefines } from './src/platform/features'
import { skinVirtualModules } from './src/platform/skin-virtual'

// FE-157 5C: utils/ and platform/ run under plain node, except the tests that
// need a DOM / window / Web Storage / Telegram-or-Zoom globals. Those stay in
// the dom project; a new test there lands in node by default and fails fast
// on the first `window` access -- add it to DOM_TESTS then.
const NODE_DIRS = ['src/utils/**/*.test.ts', 'src/platform/**/*.test.ts']
const DOM_TESTS = [
  'src/platform/browser-login.test.ts',
  'src/platform/chunk-reload.test.ts',
  'src/platform/error-reporter.test.ts',
  'src/platform/launch.test.ts',
  'src/platform/session-token.test.ts',
  'src/platform/sw-caches.test.ts',
  'src/platform/telegram-sdk.test.ts',
  'src/platform/telegram.test.ts',
  'src/platform/zoom-sdk.test.ts',
  'src/utils/audio.test.ts',
  'src/utils/constants.test.ts',
  'src/utils/keyboardViewportState.test.ts',
  'src/utils/practiceOptions.test.ts',
]

// Every utils/platform test file that is NOT in DOM_TESTS runs in node only.
const NODE_ONLY = globSync(NODE_DIRS, { cwd: fileURLToPath(new URL('.', import.meta.url)) }).filter(
  (f) => !DOM_TESTS.includes(f),
)

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
    // Coverage (optional, run with --coverage). Must stay at this top level:
    // Vitest reads coverage from the root config, not from a project.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts', 'src/main.ts'],
    },
    // Two projects (FE-157 5C): the happy-dom environment cost 77 of 99 s.
    // Pure utils/platform tests need no DOM and run under plain node.
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: NODE_ONLY,
          // The DOM setup imports platform/host.ts (reads `window` at load).
          setupFiles: ['./src/test-setup.node.ts'],
          testTimeout: 5000,
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          // happy-dom is faster than jsdom and sufficient for unit tests
          environment: 'happy-dom',
          include: ['src/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...NODE_ONLY],
          // Runs before every test file -- resets api/client.ts module state (T1 stage 2)
          setupFiles: ['./src/test-setup.ts'],
          testTimeout: 5000,
        },
      },
    ],
  },
})
