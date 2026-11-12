/**
 * The suite's `test` and `expect` (FE-161). Every spec imports them from here,
 * never from `@playwright/test` (an ESLint rule enforces it), so each test
 * runs under the crash detector (./crashes.ts) without asking for it.
 *
 * After the test body the `crashes` auto fixture inspects the screen once more
 * and fails the test with one message listing every signal. A test that
 * expects a signal says so: `crashes.allow({ reason, api: [...] })`.
 */
import { test as base, expect } from '@playwright/test'
import { formatSignals, watchCrashes, type Crashes } from './crashes'

/** testInfo attachment carrying the signals as JSON (read by crash-reporter.ts). */
export const CRASHES_ATTACHMENT = 'crashes.json'

export const test = base.extend<{ crashes: Crashes }>({
  crashes: [
    async ({ page }, use, testInfo) => {
      const watch = await watchCrashes(page)
      await use(watch.crashes)
      const signals = await watch.finish()
      if (signals.length === 0) return
      await testInfo.attach(CRASHES_ATTACHMENT, {
        body: JSON.stringify(signals, null, 2),
        contentType: 'application/json',
      })
      throw new Error(`crash detector: ${signals.length} signal(s)\n${formatSignals(signals)}`)
    },
    { auto: true },
  ],
})

export { expect }
