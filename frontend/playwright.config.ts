// =============================================================================
// VELO Frontend -- Playwright e2e (FE-157 5A.2 smoke, FE-161 sweep)
// =============================================================================
//
// Two contours, one config (docs/agents/e2e.md):
//
//   smoke   e2e/*.spec.ts -- scenarios and the crash-detector self-checks on
//           the golden build under `vite preview`, the API mocked at the
//           network layer (e2e/support/api.ts). No backend.
//             pnpm e2e:smoke        (pnpm test:e2e builds first)
//
//   sweep   e2e/sweep/ -- every route of the router under every role that may
//           open it, against a REAL backend with the `e2e` seed profile. The
//           `sweep-setup` project logs in once per role and collects the ids
//           the parameterized routes need (e2e/stack/stack.setup.ts).
//             pnpm e2e:sweep        (the stack must be up)
//           E2E_BASE_URL picks the frontend: default the `vite preview` below
//           (its /api proxy goes to :8000), http://localhost:5173 for the
//           velo-dev stand. E2E_API_URL is the backend for the setup's own
//           calls (default http://127.0.0.1:8000).
//   sweep-webkit -- the same on WebKit (Telegram on iOS); nightly, or on demand.
//
// Every test of every project runs under the crash detector (e2e/support/test.ts).
// No retries anywhere: a retry would turn a flaky scenario green, and a crash
// that reproduces every other run is a race, not a flake.
// =============================================================================

import { defineConfig, devices } from '@playwright/test'

// VISUAL_DIST: serve another build (e2e/visual/run.sh shoots the base and the
// head build one after the other, on the same port: the HAR matches by URL).
const PORT = 4173
const DIST = process.env.VISUAL_DIST ?? 'dist'
const PREVIEW_URL = `http://127.0.0.1:${PORT}`
const BASE_URL = process.env.E2E_BASE_URL ?? PREVIEW_URL
const CI = !!process.env.CI

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  fullyParallel: true,
  forbidOnly: CI,
  retries: 0,
  reporter: [
    CI ? ['github'] : ['list'],
    ['./e2e/support/crash-reporter.ts'],
    ...(CI ? [] : [['html', { open: 'never' }] as const]),
  ],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    // The PWA service worker would answer from its precache and bypass the
    // route mocks.
    serviceWorkers: 'block',
    // Fixed locale/zone: scenarios assert on English copy and local dates.
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    actionTimeout: 10_000,
    trace: 'retain-on-failure',
    ...devices['Pixel 7'],
  },
  projects: [
    {
      name: 'smoke',
      testMatch: '*.spec.ts',
      testIgnore: ['sweep/**', 'stack/**', 'visual/**'],
      use: { baseURL: PREVIEW_URL },
    },
    {
      name: 'sweep-setup',
      testMatch: 'stack/stack.setup.ts',
    },
    {
      name: 'sweep',
      testMatch: 'sweep/*.spec.ts',
      dependencies: ['sweep-setup'],
    },
    {
      // FE-162: the key screens from recorded API answers, no backend. Run
      // twice by e2e/visual/run.sh (base build, head build).
      name: 'visual',
      testMatch: 'visual/visual.spec.ts',
    },
    {
      // FE-162: re-record the HARs against a running seeded stack.
      name: 'visual-record',
      testMatch: 'visual/record.spec.ts',
      dependencies: ['sweep-setup'],
    },
    {
      name: 'sweep-webkit',
      testMatch: 'sweep/*.spec.ts',
      dependencies: ['sweep-setup'],
      use: { ...devices['iPhone 15'] },
    },
  ],
  // The golden build for smoke, and for the sweep unless E2E_BASE_URL points
  // elsewhere (a dev server already running).
  webServer: {
    command: `pnpm exec vite preview --outDir ${DIST} --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: PREVIEW_URL,
    reuseExistingServer: !CI,
    timeout: 60_000,
  },
})
