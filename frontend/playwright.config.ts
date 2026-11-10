// =============================================================================
// VELO Frontend -- Playwright smoke e2e (FE-157 5A.2)
// =============================================================================
//
// The golden production build served by `vite preview`; the API is mocked at
// the network layer (e2e/support/api.ts), no backend is involved. Run:
//   pnpm test:e2e        build, then the scenarios
//   pnpm test:e2e:run    the scenarios against an existing dist/
// Deliberately outside `verify` -- it needs a browser binary and a build.
// =============================================================================

import { defineConfig, devices } from '@playwright/test'

const PORT = 4173

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // The PWA service worker would answer from its precache and bypass the
    // route mocks.
    serviceWorkers: 'block',
    // Fixed locale/zone: scenarios assert on English copy and local dates.
    locale: 'en-US',
    timezoneId: 'UTC',
    actionTimeout: 10_000,
    trace: 'retain-on-failure',
    ...devices['Pixel 7'],
  },
  projects: [{ name: 'chromium', use: {} }],
  webServer: {
    command: `pnpm exec vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
