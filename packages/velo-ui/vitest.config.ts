// =============================================================================
// @velo/ui -- Vitest Configuration (FE-116, tz-ui-package.md §3.2)
// =============================================================================
//
// The package's OWN suite -- same shape as the frontend's vitest.config.ts:
// happy-dom (lightweight DOM, sufficient for Vue SFC mounts), setupFiles
// pointing at src/test-setup.ts, and no app aliases: the package must not
// import the application (P8's eslint boundary; here it is simply nothing
// to alias to).
// =============================================================================

import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue()],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/test-setup.ts'],
    testTimeout: 5000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.vue'],
      exclude: ['src/**/*.test.ts', 'src/test-setup.ts', 'src/**/*.stories.ts'],
    },
  },
})
